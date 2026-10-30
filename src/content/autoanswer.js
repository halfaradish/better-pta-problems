/* 自动答题（实验）：在考试题目列表页收集题目 → 调 OpenAI 兼容 LLM → 填表单 → 点「保存」。
 *
 * 流程实测见 docs/自动答题初探.md：一个题型页平铺该题型全部题目，每题容器的 id 就是
 * problemSetProblemId；选项/输入的改动只存在前端内存，点页面原生「保存」按钮才发
 * exam-submissions 请求（协议与 CSRF 头由页面自己带，自动化只负责点按钮）。
 *
 * 运行位置在内容脚本（弹窗只是入口，关弹窗不打断）；编排与收题在同一文档内做
 * 题型切换（点侧栏类型链接走 SPA 路由，不触发整页刷新，运行状态得以保留）。
 * LLM 请求：OpenCode Go 经后台端口转发（页面直连被 CORS 拦），其它 OpenAI 兼容
 * 端点由页面上下文直发。
 *
 * 纯函数（parseChoiceAnswer / normalizeTF / parseFillAnswers / buildPrompt /
 * extractFromRichHtml？——DOM 相关的 collectQuestion 依赖 document，不进单测）
 * 尽量拆出来供 node:test 覆盖。
 */

import { LLM_DIRECT_TIMEOUT_MS, LLM_MAX_ATTEMPTS, LLM_MAX_IDLE_ATTEMPTS, LLM_TOTAL_TIMEOUT_MS } from '../shared/llm.js';

// 侧栏类型名 → exam-submissions 协议的 problemType。
// 「函数题」在 PTA 协议层叫 CODE_COMPLETION（2026-10-28 实测：题目集侧栏显示「函数题」，
// problem-summaries 与页面 bundle 用的 problemType 都是 CODE_COMPLETION）；它与编程题同用
// CodingProblemAnswerForm + 一页一题 + exam-draft 草稿，只是 detail 字段与判题模板不同。
export const TYPE_BY_NAME = {
  '判断题': 'TRUE_OR_FALSE',
  '单选题': 'MULTIPLE_CHOICE',
  '填空题': 'FILL_IN_THE_BLANK',
  '编程题': 'PROGRAMMING',
  '函数题': 'CODE_COMPLETION',
};

// 走「跨页续跑」的两类编码题（共用一页一题 + 整页装载水合机制）
const isCodingKind = kind => kind === 'PROGRAMMING' || kind === 'CODE_COMPLETION';

export const EXAM_PROBLEMS_RE = /^\/problem-sets\/(\d+)\/exam\/problems(\/type\/(\d+))?/;

const LETTERS = 'ABCDEFGHIJ';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const abortedError = () => {
  const err = new Error('已中止');
  err.aborted = true;
  return err;
};

// 扩展被重载/更新后，旧内容脚本的 chrome.runtime 立即失效，任何重试都不会成功；
// 单独成类，避免像网络错误一样白试三次（真机 7-10 报过 Extension context invalidated）。
const isInvalidatedMessage = msg => /Extension context invalidated/i.test(String(msg || ''));
const invalidatedError = () => {
  const err = new Error('扩展已被重新加载或更新，当前页面无法继续请求；请刷新 PTA 页面后重跑');
  err.kind = 'invalidated';
  return err;
};

/* ---------- 带时限的 fetch ----------
 * 服务瘫痪的最坏型态是连接挂起不回包：fetch 无内置超时，请求能吊死几分钟，期间引擎
 * 的 worker 全停在 await、事件流一行不出——面板看似死机，发生了什么只能靠猜。
 * 第三方/慢源请求统一套时限，AbortError 转成人话错误，由调用方的前缀拼成完整日志。 */
const IMAGE_TIMEOUT_MS = 30000;  // 题图转取 30s：图源挂起不拖垮整题

async function fetchBounded(url, opts = {}, ms, stopSignal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const stopNow = () => ctl.abort();
  if (stopSignal) {
    if (stopSignal.aborted) { clearTimeout(timer); throw abortedError(); }
    stopSignal.addEventListener('abort', stopNow, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } catch (err) {
    if (stopSignal?.aborted) throw abortedError();
    if (err?.name === 'AbortError') {
      const timeoutErr = new Error(`请求 ${Math.round(ms / 1000)}s 无响应，已按超时中断`);
      timeoutErr.kind = 'timeout';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    stopSignal?.removeEventListener('abort', stopNow);
  }
}

// OpenCode Zen Go 网关要求：每个会话带稳定的 x-opencode-session（利于路由/缓存，
// 不带可能被拒 400）；自建 UA（官方要求勿用 SDK/HTTP 库默认名）
let sessionId = null;
function sessionHeader() {
  if (!sessionId) {
    try { sessionId = sessionStorage.getItem('__bps_aa_session') || null; } catch (_) { /* 隐私模式 */ }
    if (!sessionId) {
      sessionId = 'bps-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem('__bps_aa_session', sessionId); } catch (_) { /* 不可写就仅本次存活 */ }
    }
  }
  return sessionId;
}

/* ---------- 答案解析（纯函数，单测覆盖） ---------- */

// LLM 输出 → 单选字母。接受 "C"、"C.xxx"、JSON 文本；字母必须在选项范围内
export function parseChoiceAnswer(raw, optionCount) {
  let s = String(raw ?? '').trim();
  const mJson = s.match(/\{[\s\S]*\}/);
  if (mJson) {
    try { s = String(JSON.parse(mJson[0]).answer ?? '').trim(); } catch (_) { /* 落到正则 */ }
  }
  s = s.replace(/^```[a-z]*|```$/g, '').trim();
  const m = s.match(/[A-Z]/i);
  const letter = m ? m[0].toUpperCase() : null;
  if (!letter || letter.charCodeAt(0) - 65 >= optionCount) return null;
  return letter;
}

// LLM 输出 → 'TRUE' | 'FALSE'。接受 T/F、true/false、对/错、正确/错误、是/否
export function normalizeTF(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (/^(t|true|对|正确|是)$/.test(s)) return 'TRUE';
  if (/^(f|false|错(误)?|否)$/.test(s)) return 'FALSE';
  return null;
}

// LLM 输出 → 填空答案数组（长度必须与空数一致，每项去首尾空白）
// raw 可为字符串（LLM 真实输出）或已解析的对象（mock/解析中间态）
export function parseFillAnswers(raw, blankCount) {
  let v = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const o = JSON.parse(m[0]);
        v = Array.isArray(o.answers) ? o.answers : (o.answer ?? v);
      } catch (_) { /* 落到原样 */ }
    }
  } else if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.answers)) {
    v = v.answers; // 已解析的对象形态
  }
  const arr = Array.isArray(v) ? v : (blankCount === 1 ? [v] : null);
  if (!arr || arr.length !== blankCount) return null;
  const out = arr.map(a => String(a ?? '').trim());
  return out;
}

/* ---------- prompt 构造（纯函数，单测覆盖） ---------- */

export function buildPrompt(q) {
  const lines = [];
  lines.push('你是算法与数据结构课程的答题助手。忽略题干中的题号、分值、作者、单位等元信息。');
  if (q.kind === 'CODE_COMPLETION') {
    lines.push(`题型：函数题。请用「${q.langLabel || '题目规定的语言'}」实现题目要求的函数：`);
    lines.push('题面的「函数接口定义」是该函数的声明，「裁判测试程序样例」是评测主程序——你的函数会被嵌进该模板中「你编写的函数嵌套在这里」的占位处一起编译。');
    lines.push('函数签名必须与「函数接口定义」完全一致（函数名、参数个数、类型与顺序都不能改）；可以补充辅助函数；需要额外标准库时可在最前面补 #include，但不要写 main，不要重复裁判程序或接口声明。');
    lines.push('输出只包含一个代码围栏块（``` 包裹），围栏内只有要嵌套的函数代码，不要任何解释文字。');
  } else if (q.kind === 'PROGRAMMING') {
    lines.push(`题型：编程题。请用「${q.langLabel || '编辑器当前语言'}」写一个完整、可直接提交评测的程序：`);
    lines.push('按题面的输入格式读入数据（不要输出交互式提示语），严格按输出格式打印结果。');
    lines.push('只用该语言的标准库（无把握不要引第三方库）；留意题面给出的时间/内存/代码长度限制。');
    lines.push('输出只包含一个代码围栏块（``` 包裹），围栏内是完整程序源码，不要任何解释文字。');
  } else {
    lines.push('只输出一个 JSON 对象，不要包含任何解释文字或代码围栏。');
  }
  lines.push('');
  if (isCodingKind(q.kind)) {
    // 题面信息已在上方说明，此处不加逐题型行，防止与「只输出 JSON」的通用指令混淆
  } else if (q.kind === 'TRUE_OR_FALSE') {
    lines.push('题型：判断题。判断陈述的正误，answer 只能是 "TRUE" 或 "FALSE"。');
    lines.push('输出格式：{"answer":"TRUE"}');
  } else if (q.kind === 'MULTIPLE_CHOICE') {
    lines.push('题型：单选题。从下列选项中选出唯一正确项，answer 为选项字母。');
    lines.push('输出格式：{"answer":"A"}');
  } else {
    lines.push(`题型：填空题（共 ${q.blanks} 空）。文本中的「[空1]」「[空2]」…是作答位置；`);
    lines.push(`answers 必须是与空数相同的字符串数组（本题为 ${q.blanks} 个）。`);
    lines.push('输出格式：{"answers":["...","..."]}');
  }
  lines.push('');
  lines.push('题目：');
  lines.push(q.text);
  if (q.kind === 'TRUE_OR_FALSE') {
    lines.push('（陈述如上，选项 T=正确、F=错误）');
  } else if (q.kind === 'MULTIPLE_CHOICE') {
    lines.push('可选字母：' + q.options.map(o => o.letter).join('、'));
  }
  return [
    {
      role: 'system',
      content: isCodingKind(q.kind)
        ? '你是严谨的答题助手，只输出一个代码围栏块（``` 包裹的完整程序源码），不要输出任何其他文字。'
        : '你是严谨的答题助手，只输出要求的 JSON，不要输出任何其他文字。',
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

/* ---------- 编程题：语言映射与代码输出解析（纯函数，单测覆盖） ---------- */

// 语言下拉的 single-value 在部分题目里会把该语言的限额并排渲染进去（实测 7-8：
// 「C (gcc)」+「100 ms / 64 MB」两段文本拼成 "C (gcc)100 ms / 64 MB"）；语言名只取限额之前。
export function normalizeLangLabel(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.replace(/\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\/\s*\d+(?:\.\d+)?\s*[KMGTP]?i?B\s*$/i, '').trim();
}

// 编译器 id → 菜单显示名。题集白名单来自 exams 接口 problemSet.problemSetConfig.compilers，
// 数组顺序与题目页 react-select 菜单一致（初探 §10.5，PYTHON3/KOTLIN/GCC 三点实证）；
// 换新语言时以界面菜单为准补这张表。
export const COMPILER_LABELS = {
  GCC: 'C (gcc)',
  MODERN_GCC: 'C (gcc c11)',
  GXX: 'C++ (g++)',
  CLANG: 'C (clang)',
  CLANGXX: 'C++ (clang++)',
  JAVAC: 'Java (javac)',
  PYTHON2: 'Python (python2)',
  PYTHON3: 'Python (python3)',
  RUBY: 'Ruby (ruby)',
  BASH: 'Bash (bash)',
  CAT: 'Plaintext (cat)',
  CLISP: 'Common Lisp (sbcl)',
  FPC: 'Pascal (fpc)',
  GO: 'Go (go)',
  GHC: 'Haskell (ghc)',
  LUA: 'Lua (lua)',
  LUAJIT: 'Lua (luajit)',
  MCS: 'C# (dotnet)',
  NODE: 'JavaScript (node)',
  OCAMLC: 'OCaml (ocamlc)',
  PHP: 'PHP (php)',
  PERL: 'Perl (perl)',
  AWK: 'AWK (awk)',
  DMD: 'D (dmd)',
  RKT: 'Racket (racket)',
  VALAC: 'Vala (valac)',
  VBNC: 'Visual Basic (dotnet)',
  KOTLIN: 'Kotlin (kotlinc)',
  SWIFT: 'Swift (swiftc)',
  OBJC: 'Objective-C (clang)',
  FORTRAN: 'Fortran95 (gfortran)',
  OCTAVE: 'Octave (octave-cli)',
  RLANG: 'R (R)',
  ASM: 'ASM (nasm.sh)',
  RUST: 'Rust (rustc)',
  SCALA: 'Scala (scalac)',
  PYPY3: 'Python (pypy3)',
  CANGJIE: '仓颉 (cjc)',
};

// 编程题 LLM 输出 → 源码。主形态是代码围栏；模型偶尔仍包 JSON（{"answer": code}）；
// 两者都没有时，若整体像代码（有换行/分号/花括号）就回退原样（剥残留围栏标记）。
// 注意不能像客观题那样贪婪抓 {…} 当 JSON：代码里的花括号会击穿解析，JSON 分支只在
// 整串能 JSON.parse 的情况下生效（故意选最长围栏块，模型先解释后贴码时解释块更短）。
export function parseCodeAnswer(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const jsonMatch = s.match(/^\{[\s\S]*\}$/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]);
      if (typeof o.answer === 'string' && o.answer.trim()) return o.answer.trim() + '\n';
    } catch (_) { /* 不是合法 JSON，落入围栏分支 */ }
  }
  const fences = [...s.matchAll(/```[A-Za-z0-9+#_.-]*(?:\r?\n)([\s\S]*?)```/g)];
  if (fences.length) {
    const block = fences.map(f => f[1]).sort((a, b) => b.length - a.length)[0];
    return block.replace(/\n+$/, '') + '\n';
  }
  // 没有围栏也没有 JSON：整体像源码就收（防模型忘包围栏）；明显的自然语言拒绝
  if (/[\n;{}]/.test(s) && !/^(抱歉|对不起|无法|这不是)/.test(s)) {
    const stripped = s.replace(/^[A-Za-z0-9+#_.-]*```|^```[A-Za-z0-9+#_.-]*/g, '').replace(/```[A-Za-z0-9+#_.-]*$|```$/g, '').trim();
    return stripped ? stripped + '\n' : null;
  }
  return null;
}

// 题集语言白名单（页面侧带登录态 fetch；必须带 accept: application/json 才回 JSON）
export async function fetchAllowedCompilers(psId) {
  const data = await fetch(`/api/problem-sets/${psId}/exams`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
  }).then(r => r.json());
  const list = data?.problemSet?.problemSetConfig?.compilers;
  return Array.isArray(list) && list.length ? list : null;
}

/* ---------- 页面侧：编码题（编程/函数，CodeMirror 6，一页一题） ---------- */

// 答题编辑器（题面样例展示也是 .cm-editor，但那些 contenteditable=false）
function answerFormEl() {
  return document.querySelector('[class*="CodingProblemAnswerForm"]');
}
function editableCm() {
  const form = answerFormEl();
  return (form && [...form.querySelectorAll('.cm-content')].find(x => x.getAttribute('contenteditable') === 'true')) || null;
}
function submitButton() {
  return [...document.querySelectorAll('main button')].find(b => (b.textContent || '').trim() === '提交本题作答') || null;
}
// 当前语言的真实值 = react-select 单值文本（React 实时状态；draft.compiler 只是上次持久值）。
// 单值里可能并排带出该语言限额（见 normalizeLangLabel），取语言名本身。
function langLabelOf() {
  const form = answerFormEl();
  return normalizeLangLabel(form?.querySelector('.select__single-value')?.textContent || '');
}

// 编码题题型判别（纯函数，单测覆盖）：两类题共用同一答题表单组件，只能靠题面小节标题区分。
// 函数题小节——中文「函数接口定义」（2026-10-28 实测）或英文「Format of function:」（2026-10-31
// 实测：英文题面题集没有中文小节，如算法设计与分析课堂练习2-4）。都不命中按编程题处理。
export function codingKindFromHeadings(headings) {
  const hit = (headings || []).some(h =>
    String(h || '').includes('函数接口定义') || /format of function/i.test(String(h || '')));
  return hit ? 'CODE_COMPLETION' : 'PROGRAMMING';
}

// 编码题页题目收集（编程题与函数题同构）。返回 null 表示当前不是编码题题目页（列表页没有答题表单）。
export function collectCodingProblem() {
  const mainEl = document.querySelector('main');
  const form = answerFormEl();
  if (!mainEl || !form) return null;
  const cm = [...form.querySelectorAll('.cm-content')].find(x => x.getAttribute('contenteditable') === 'true');
  if (!cm) return null;
  const pspId = (location.search.match(/problemSetProblemId=(\d+)/) || [])[1];
  if (!pspId) return null;
  // 题型判别（见 codingKindFromHeadings）
  const kind = codingKindFromHeadings([...mainEl.querySelectorAll('h1,h2,h3')].map(h => h.textContent));
  // 题干图：main 内、答题表单之外的 img（初探 §7.1 同一个数）；
  //parsed src 从活 DOM 取（绝对化），克隆节点不连树时 .src 不解析相对地址
  const stem = [...mainEl.querySelectorAll('img')].filter(i => !form.contains(i))
    .map(i => (i.getAttribute('src') ? i.src : null)).filter(Boolean);
  const imgInfo = { options: {}, stem, total: stem.length };
  const text = cleanText(mainEl, '[class*="CodingProblemAnswerForm"]');
  return {
    id: pspId,
    label: (text.match(/\d+-\d+/) || [])[0] || null, // 例题号形如 7-1（页面标题开头）
    kind,
    text,
    langLabel: langLabelOf(),
    hasImg: imgInfo.total > 0,
    imgInfo,
    answered: String(cm.textContent || '').trim().length > 0, // 草稿代码非空视作已答
  };
}

// 该题型的全部题目 id（题目总览数字锚点，href 带 problemSetProblemId；DOM 顺序 = 页面顺序）。
// 注意：现行 PTA 侧栏只渲染「当前题型」的题目锚点（2026-10-31 实测，切走题型后旧锚点即从
// DOM 消失）——必须在该题型页面就绪的当下调用；跨题型回头收会收空（见 handleRun 编码分支）。
export function programmingIds(psId, typeId) {
  const out = [];
  const seen = new Set();
  const re = new RegExp(`^/problem-sets/${psId}/exam/problems/type/${typeId}\\?problemSetProblemId=(\\d+)$`);
  for (const a of document.querySelectorAll('a[href]')) {
    const m = (a.getAttribute('href') || '').match(re);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
  }
  return out;
}

// LLM 代码按「编译器 id」写入草稿；从界面显示名反查 id（跟随当前模式读实挂标签后用）。纯函数，单测覆盖
export function compilerIdFromLabel(label) {
  const l = String(label || '').replace(/\s+/g, ' ').trim();
  for (const [id, name] of Object.entries(COMPILER_LABELS)) if (name === l) return id;
  return null;
}

export async function getDraftDetail(pspId) {
  const d = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
  }).then(r => r.json()).catch(() => null);
  return d?.answer?.detail || null;
}

// 草稿 detail 的提交子对象（纯函数，单测覆盖）。编程题带 compiler（跟随配置/编辑器语言）；
// 函数题没有 compiler 字段——编译器由题目本身决定（2026-10-28 真机实证：bundle 只写
// {program}，草稿写读回带一致，判题按题目固定编译器执行）。
export function draftSubmissionDetail(kind, compilerId, program) {
  return kind === 'CODE_COMPLETION'
    ? { codeCompletionSubmissionDetail: { program } }
    : { programmingSubmissionDetail: { compiler: compilerId, program } };
}

// 草稿写入（answer.detail 形状来自接口 GET；exam 模式问题 problemId="0"，bundle 组包函数同构）。
// customTestData 原样保留（用户自定义测试数据），写程序时不动它。
export async function saveDraft(pspId, kind, detail, compilerId, program) {
  if (kind !== 'CODE_COMPLETION' && !compilerId) return { ok: false, status: null };
  const body = JSON.stringify({
    answer: {
      detail: {
        problemId: detail?.problemId ?? '0',
        problemSetProblemId: detail?.problemSetProblemId || pspId,
        customTestData: detail?.customTestData, // 原样保留（可为 null）
        ...draftSubmissionDetail(kind, compilerId, program),
      },
    },
  });
  let lastStatus = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await pacedDraftPost(pspId, body);
      lastStatus = res.status;
      if (res.ok) return { ok: true, status: res.status };
    } catch (err) {
      lastErr = err;
      lastStatus = lastStatus ?? null;
    }
    if (attempt < 4) await sleep(lastStatus === 429 ? 3000 : 800); // 接口有速率限制，429 长冷却
  }
  return { ok: false, status: lastStatus, err: lastErr ? String(lastErr.message || lastErr) : null };
}

// draft POST 全局限速（服务端 429 限流）：两次 POST 之间至少隔 2.2s（含我们自己的与页面的契合）
let lastDraftPostAt = 0;
async function pacedDraftPost(pspId, body) {
  const gap = Date.now() - lastDraftPostAt;
  if (gap < 2200) await sleep(2200 - gap);
  const res = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
    method: 'POST',
    headers: { accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'include',
    body,
  });
  lastDraftPostAt = Date.now();
  return res;
}

// PTA 把草稿 GET 响应缓存在 localStorage 的 PAT_HTTP_CACHE（按 URL 键），短窗口内会回放旧值，
// 导致 remount 后编辑器不回带刚写入的代码（dry3 实测：1 题被旧值骗成"已答"、3 题水合失败）。
// 写完草稿后剥掉该题的缓存键，让应用的下次 GET 走网络拿真实草稿。
export function stripDraftHttpCache(pspId) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    const pat = raw.PAT_HTTP_CACHE ? JSON.parse(raw.PAT_HTTP_CACHE) : null;
    if (!pat) return;
    let hit = false;
    for (const k of Object.keys(pat)) if (/\/exam-draft/.test(k) && new RegExp(`/problems/${pspId}/`).test(k)) { delete pat[k]; hit = true; }
    if (hit) {
      raw.PAT_HTTP_CACHE = JSON.stringify(pat);
      localStorage.setItem('user-cache', JSON.stringify(raw));
    }
  } catch (_) { /* 结构变化时静默跳过 */ }
}

// 每题编辑器还有 localStorage 级缓存（user-cache 的 codingProblem_<id>：program/saveAt/testData），
// boot 时 PTA 会把它自动存回服务端草稿——旧值会伪造「已答」。跳转前清理：只在「缓存为空」或
// 「缓存程序与服务端草稿一致（auto-save 已同步）」时删缓存键；不一致时保留——那是用户未保存的
// 输入，boot 会原样同步，作答态照旧保守跳过，不能替用户丢数据。
export async function prepNextProblemCache(nextId) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    const key = `codingProblem_${nextId}`;
    const entry = raw[key] || null;
    const cacheProgram = String(entry?.program ?? '');
    let detailProgram = null;
    if (cacheProgram) {
      const detail = await getDraftDetail(nextId);
      detailProgram = detail?.programmingSubmissionDetail?.program ?? '';
    }
    if (!cacheProgram || cacheProgram === detailProgram) {
      delete raw[key];
      localStorage.setItem('user-cache', JSON.stringify(raw));
      return { cleaned: true };
    }
    return { cleaned: false, staleUserInput: true }; // 与草稿不一致：保留（boot 会原样同步）
  } catch (_) {
    return { cleaned: false };
  }
}

// 无条件删某题的 codingProblem 缓存键（仅限 verify 撤销/提交失败回滚的时机——此时代码已从
// 服务端草稿撤下，本地键不能留着，否则 collect 会把空编辑器误判成已答/下次 boot 回带旧代码）。
// 注意 collect 写完代码后不再删键（见 seedCodingProblemCache）。
function clearCodingProblemCache(id) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    if ('codingProblem_' + id in raw === false) return;
    delete raw['codingProblem_' + id];
    localStorage.setItem('user-cache', JSON.stringify(raw));
  } catch (_) { /* 结构异常静默 */ }
}

// 种入水合键：现行 PTA 的编码题 boot 只从 codingProblem_<id> 本地键回带编辑器内容，
// 服务端 exam-draft 已不参与水合（2026-10-15 实测：服务端草稿有码的全新文档照样水合成
// 空编辑器，且 boot 连 exam-draft 的 GET 都不发生；种键→真加载→编辑器回带+按钮解锁实证。
// 函数题同键同形状，2026-10-28 真机实证：种键→reload→回带+「提交本题作答」解锁）。
// 形状照抄 PTA 自己写的键（program/testData/saveAt，saveAt 为 ISO 字符串）。collect 写完
// 服务端草稿后立即种键再 reload，verify 文档的 boot 才有码可回带。
export function seedCodingProblemCache(id, program, detail) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    raw['codingProblem_' + id] = {
      program,
      testData: detail?.customTestData?.content ?? '',
      saveAt: new Date().toISOString(),
    };
    localStorage.setItem('user-cache', JSON.stringify(raw));
    return { seeded: true };
  } catch (err) {
    return { seeded: false, err: err ? String(err.message || err) : null };
  }
}

// 水合探测：新文档挂载后按钮禁用态应在预期位（空草稿=禁用、有码=解锁），两次读数一致才采信。
// 注意条件方向：expectEnabled=true 时期望 disabled===false（按钮解锁）。
async function waitHydrate(expectEnabled) {
  for (let i = 0; i < 200; i++) { // ≤20s
    await sleep(100);
    const b = submitButton();
    if (!b) continue;
    if (b.disabled === !expectEnabled) {
      await sleep(250); // 二次确认防抖动
      const b2 = submitButton();
      if (b2 && b2.disabled === b.disabled) return { ok: true, disabled: b.disabled };
    }
  }
  return { ok: false };
}

// 挂载状态稳定探测（collect 前用）：编辑器文本 + 按钮态连续两次读数一致才算就绪
async function settleEditorState() {
  let prev = null;
  for (let i = 0; i < 120; i++) { // ≤12s
    await sleep(100);
    const cm = editableCm();
    if (!cm) continue;
    const sig = `${(cm.textContent || '').slice(0, 40)}|${(submitButton()?.disabled ?? 'none')}`;
    if (sig === prev) return true;
    prev = sig;
  }
  return false;
}

/* ---------- 页面侧：收题（客观题，一页平铺） ---------- */

// 克隆题容器并剥离视觉噪音，返回可直接阅读的纯文本。
// 噪音：按钮（题号/复制/格式/全屏/收起）、CodeMirror 行号列（.cm-gutters）、
// 每空旁的「N 分」分数胶囊、输入框本身（填空位置用 [空N] 标记）。
// 克隆临时挂在 body 上（fixed 移出视口 + bps-clone 类）以获得真实的 innerText，
// index.js 的 MutationObserver 会忽略这类节点。
// extraRemoveSel：额外剔除选择器（编程题用它剔除答题表单子树，只留题干）。
function cleanText(el, extraRemoveSel = '') {
  const clone = el.cloneNode(true);
  clone.classList.add('bps-clone');
  clone.style.cssText = 'position:fixed;left:-99999px;top:0;margin:0;max-width:900px';
  let bi = 0;
  // 注意：填空输入框在 PTA 里有两种渲染（带/不带 type 属性），只能按属性值（.type）判
  for (const inp of [...clone.querySelectorAll('input')].filter(i => i.type === 'text')) {
    bi += 1;
    inp.replaceWith(document.createTextNode(`[空${bi}]`));
  }
  for (const n of clone.querySelectorAll('button, input, textarea, [class*="cm-gutters"]' + (extraRemoveSel ? ', ' + extraRemoveSel : ''))) n.remove();
  for (const n of clone.querySelectorAll('*')) {
    if ((n.textContent || '').trim().match(/^\d+\s*分$/) && !n.querySelector('*')) n.remove();
  }
  document.body.appendChild(clone);
  const text = clone.innerText.replace(/\n{3,}/g, '\n\n').trim();
  clone.remove();
  return text;
}

// 收集当前题型页的全部题目（顺序 = 页面展示顺序）
// 填空输入框不带 type 属性（HTML 隐式 text），一律按 .type 属性值判定
export function collectPage() {
  const out = [];
  const containers = [...document.querySelectorAll('main [id]')]
    .filter(el => /^\d+$/.test(el.id) && (el.querySelector('input[type=radio]') || [...el.querySelectorAll('input')].some(i => i.type === 'text')));
  for (const el of containers) {
    const radios = [...el.querySelectorAll('input[type=radio]')];
    const texts = [...el.querySelectorAll('input')].filter(i => i.type === 'text');
    let kind;
    let options = [];
    let blanks = 0;
    if (radios.length === 2) kind = 'TRUE_OR_FALSE';
    else if (radios.length > 2) {
      kind = 'MULTIPLE_CHOICE';
      options = radios.map((r, i) => {
        const label = r.closest('label');
        const t = (label?.innerText || '').replace(/\s+/g, ' ').trim();
        // 贴在选项 label 里的图属于该选项；src 绝对化（imag 的 .src），便于页面上下文带登录态下载
        const optImg = label?.querySelector('img');
        const imgSrc = optImg && optImg.getAttribute('src') ? optImg.src : null;
        return { idx: i, letter: LETTERS[i] || '?' + i, text: t, imgSrc };
      });
    } else if (texts.length) { kind = 'FILL_IN_THE_BLANK'; blanks = texts.length; }
    else continue;
    // 其余 img 都按题干图处理（初探 §7.1：题干图与选项图在 PTA 都常见）
    const optImg = {};
    for (const o of options) if (o.imgSrc) optImg[o.letter] = o.imgSrc;
    const optSrcs = new Set(Object.values(optImg));
    const imgs = [...el.querySelectorAll('img')]
      .map(i => (i.getAttribute('src') ? i.src : null))
      .filter(s => s && !optSrcs.has(s));
    const imgInfo = { options: optImg, stem: imgs, total: imgs.length + Object.keys(optImg).length };
    out.push({
      id: el.id,
      label: (el.querySelector('button')?.textContent || '').trim(), // 题号（如 2-3），日志里用它指代题目
      kind,
      el,
      radios,
      texts,
      options,
      blanks,
      imgInfo,
      hasImg: imgInfo.total > 0,
      answered: radios.length ? radios.some(r => r.checked) : texts.some(t => String(t.value || '').trim() !== ''),
      text: cleanText(el),
    });
  }
  return out;
}

// 侧栏「题目总览」的类型页链接（含作答度文本，如「单选题 3/10」）
export function sidebarTypes() {
  const psId = (location.pathname.match(EXAM_PROBLEMS_RE) || [])[1];
  if (!psId) return [];
  const out = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const m = (a.getAttribute('href') || '').match(/^\/problem-sets\/(\d+)\/exam\/problems\/type\/(\d+)$/);
    if (!m || m[1] !== psId) continue;
    const mm = (a.innerText || '').replace(/\s+/g, ' ').trim().match(/^(.+?)\s*(\d+)\s*\/\s*(\d+)$/);
    if (!mm) continue;
    out.push({ typeName: mm[1], answered: +mm[2], total: +mm[3], typeId: m[2] });
  }
  return out;
}

/* ---------- 页面侧：填表与保存 ---------- */

function fillRadio(q, letter) {
  const idx = letter.charCodeAt(0) - 65;
  const radio = q.radios[idx];
  if (!radio || radio.disabled) return false;
  radio.click();
  return radio.checked;
}

function fillBlank(q, answers) {
  const setInput = (inp, value) => {
    // React 受控组件：用原生 setter 写值再派发事件，组件 state 才会更新
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, value);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  };
  q.texts.forEach((inp, i) => setInput(inp, answers[i] ?? ''));
  return true;
}

/* ---------- 页面侧：编程题提交（代码经服务端草稿驱动，编辑器只负责被动展示与点按钮） ---------- */

// 点原生「提交本题作答」并确认发出 exam-submissions 请求（与客观题保存同一个端点，
// 成功判定与 saveTypePage 一致：performance resource 出现 /exam-submissions）。
// 编程题脚本里没有 dry 按钮的等价物——提交即真实评测，调用方须先过 cfg.drySave 护栏。
async function submitProgramming() {
  const btn = submitButton();
  if (!btn) return { saved: false, reason: '找不到「提交本题作答」按钮' };
  if (btn.disabled) return { saved: false, reason: '提交按钮不可用（代码为空）' };
  const mark = performance.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    btn.click();
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const hit = performance.getEntriesByType('resource')
        .some(e => e.startTime > mark && /\/exam-submissions(\?|$)/.test(e.name));
      if (hit) { await sleep(300); return { saved: true }; }
    }
  }
  return { saved: false, reason: '点击提交后未见 exam-submissions 请求' };
}

// 点页面原生「保存」按钮并确认发出 exam-submissions 请求（页面会带上 CSRF 等头）
async function saveTypePage() {
  const btn = [...document.querySelectorAll('button')]
    .find(b => (b.textContent || '').trim() === '保存' && !b.disabled);
  if (!btn) return { saved: false, reason: '找不到保存按钮' };
  const mark = performance.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    btn.click();
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const hit = performance.getEntriesByType('resource')
        .some(e => e.startTime > mark && /\/exam-submissions(\?|$)/.test(e.name));
      if (hit) { await sleep(300); return { saved: true }; }
    }
  }
  return { saved: false, reason: '点击保存后未见提交请求' };
}

/* ---------- LLM 调用 ---------- */

function parseJsonLoose(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

// 端点规整（纯函数，单测覆盖）：去空白与尾斜杠；用户误粘完整 /chat/completions 时剥掉后缀
// （请求时再统一拼回），如 https://api.x.com/v1/chat/completions → https://api.x.com/v1
export function normalizeBaseUrl(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  return s;
}

// 网关错误体有两种形状（{type,error:{...}} 与 {error:{...}}）；统一成 {type,message}。
// 非 JSON 时退回正文前缀。日志只输出这里的文案，绝不带 Authorization。
export function parseLlmErrorBody(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    const e = o && typeof o === 'object' ? (o.error && typeof o.error === 'object' ? o.error : o) : null;
    if (!e || typeof e !== 'object') return null;
    const type = typeof e.type === 'string' ? e.type : '';
    const message = typeof e.message === 'string' ? e.message : '';
    if (!type && !message) return null;
    return { type, message };
  } catch (_) {
    return { type: '', message: text.slice(0, 160) };
  }
}

// 错误分类决定重试口径（2026-10-23 真机故障后收窄）：
// - 卡死（idle）/ 总超时（timeout）不再连试 3 次，避免每题静默 4–6 分钟；
// - 429/5xx、网络错误、后台通道被回收可重试（最多 3 次）；
// - 400/401/403/404 是配置或凭证问题，重试不会变好；用户中止立即放弃。
export function classifyLlmError(err) {
  if (!err) return 'fatal';
  if (err.aborted || err.kind === 'abort') return 'aborted';
  if (err.kind === 'invalidated') return 'invalidated';
  if (err.channelClosed) return 'channel';
  if (err.kind === 'idle') return 'idle';
  if (err.kind === 'total' || err.kind === 'timeout') return 'timeout';
  if (err.status == null || err.status === 0) return 'network';
  return err.status === 429 || err.status >= 500 ? 'retry' : 'fatal';
}

export function isRetryableLlmError(err) {
  const kind = classifyLlmError(err);
  return kind === 'channel' || kind === 'idle' || kind === 'network' || kind === 'retry';
}

function httpError(status, body, logId) {
  const parsed = parseLlmErrorBody(body);
  const detail = parsed
    ? [parsed.type, parsed.message].filter(Boolean).join('：')
    : String(body || '').trim().slice(0, 160);
  const suffix = logId ? `（x-opencode-log-id: ${logId}）` : '';
  const err = new Error(`LLM HTTP ${status}${detail ? '，' + detail : ''}${suffix}`);
  err.status = status;
  return err;
}

// OpenCode Go 的模型并非都走 chat/completions（官方端点表）：GPT/Grok/Muse Spark 走
// Responses，Claude/Minimax M3/Qwen3.8-3.7 走 Messages，Gemini 走 generateContent。
// 按前缀拒绝而不是维护白名单——官方新增 chat 模型时不用改代码，误填时也能直接说清原因。
const NON_CHAT_MODEL_RULES = [
  { re: /^gpt-/i, protocol: 'OpenAI Responses' },
  { re: /^grok-/i, protocol: 'OpenAI Responses' },
  { re: /^muse-spark-/i, protocol: 'OpenAI Responses' },
  { re: /^claude-/i, protocol: 'Anthropic Messages' },
  { re: /^minimax-m3$/i, protocol: 'Anthropic Messages' }, // m3.1-flash 属 chat 系，不能用前缀
  { re: /^qwen3\.[78]-/i, protocol: 'Anthropic Messages' },
  { re: /^gemini-/i, protocol: 'Google generateContent' },
];

export function nonChatProtocol(modelId) {
  const id = String(modelId || '').trim();
  const hit = NON_CHAT_MODEL_RULES.find(x => x.re.test(id));
  return hit ? hit.protocol : '';
}

export function assertChatModel(cfg) {
  if (!cfg || cfg.gateway !== 'opencode') return;
  const protocol = nonChatProtocol(cfg.model);
  if (!protocol) return;
  const err = new Error(`模型 ${cfg.model} 走 ${protocol} 协议，本引擎只支持 /chat/completions；请改用 glm / kimi / deepseek / longcat / mimo 等 chat 系模型`);
  err.status = 400; // 配置错误，不触发重试
  throw err;
}

// OpenCode 网关不返回 CORS 头（预检直接 404），页面 fetch 必被浏览器拦下；
// 改由 background 转发（manifest host_permissions 已覆盖 opencode.ai）。
const hasBgFetch = typeof chrome !== 'undefined' && !!chrome.runtime?.connect && !!chrome.runtime?.sendMessage;

/* 后台转发走端口（bps-llm）：首块/生成进度是多次消息，最终结果一次 done。
 * 旧的单条 sendMessage 要横跨整段生成，worker 被回收时只剩 message channel closed；
 * 端口模式能显式收到 onDisconnect，内容脚本据此按可重试错误处理，不再丢最后一条日志。
 * 页面关闭/用户中止时断开端口，后台的 onDisconnect 会连带取消在途生成。 */
export function backgroundChat(msg, { timeoutMs, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let port = null;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { port?.disconnect(); } catch (_) { /* 已断 */ }
      fn(value);
    };
    const onAbort = () => {
      try {
        chrome.runtime.sendMessage({ type: 'BPS_LLM_ABORT', reqId: msg.reqId }, () => { void chrome.runtime.lastError; });
      } catch (_) { /* 后台不在也本地放弃 */ }
      finish(reject, abortedError());
    };
    timer = setTimeout(() => {
      const err = new Error(`后台转发 ${Math.round(timeoutMs / 1000)}s 无响应`);
      err.kind = 'timeout';
      finish(reject, err);
    }, timeoutMs + 5000);
    try {
      port = chrome.runtime.connect({ name: 'bps-llm' });
    } catch (err) {
      finish(reject, isInvalidatedMessage(err?.message) ? invalidatedError() : err);
      return;
    }
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    port.onMessage.addListener(m => {
      if (!m || settled) return;
      if (m.type === 'progress') {
        try { onProgress?.(m); } catch (_) { /* 面板异常不阻断 */ }
        return;
      }
      if (m.type === 'done') finish(resolve, m);
    });
    port.onDisconnect.addListener(() => {
      let lastMsg = '';
      try { lastMsg = chrome.runtime.lastError?.message || ''; } catch (_) { lastMsg = 'Extension context invalidated'; }
      if (settled) return;
      if (isInvalidatedMessage(lastMsg)) { finish(reject, invalidatedError()); return; }
      const err = new Error('后台转发连接被回收（service worker 重启或扩展重载）');
      err.channelClosed = true;
      finish(reject, err);
    });
    try { port.postMessage({ ...msg }); } catch (err) {
      finish(reject, isInvalidatedMessage(err?.message) ? invalidatedError() : err);
    }
  });
}

async function chatViaBackground(cfg, messages, opts = {}) {
  if (!hasBgFetch) throw new Error('OpenCode Go 需要扩展后台转发，当前环境不可用');
  const reqId = 'llm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  const rsp = await backgroundChat({
    type: 'BPS_LLM_CHAT',
    reqId,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    session: sessionHeader(),
    messages,
  }, {
    timeoutMs: LLM_TOTAL_TIMEOUT_MS,
    signal: runAbort?.signal ?? null,
    onProgress: opts.onProgress,
  });
  if (!rsp) throw new Error('后台转发无响应');
  if (!rsp.ok) {
    if (rsp.kind === 'abort') throw abortedError();
    if (rsp.status) throw httpError(rsp.status, rsp.text || rsp.reason || '', rsp.logId);
    const err = new Error(rsp.reason || '后台转发无响应');
    if (rsp.kind) err.kind = rsp.kind;
    throw err;
  }
  // 流式成功：后台已把增量拼成整段文本；非流式（网关忽略 stream）仍是整段 JSON
  if (typeof rsp.content === 'string') return rsp.content;
  let data = null;
  try { data = JSON.parse(rsp.text); } catch (_) { throw new Error('LLM 响应不是合法 JSON'); }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM 响应为空');
  return text;
}

async function chatOnce(cfg, messages, opts = {}) {
  assertChatModel(cfg);
  if (cfg.gateway === 'opencode') return chatViaBackground(cfg, messages, opts);
  const base = normalizeBaseUrl(cfg.baseUrl);
  const res = await fetchBounded(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + String(cfg.apiKey || '').trim(),
    },
    body: JSON.stringify({ model: cfg.model, temperature: 0, messages }),
  }, LLM_DIRECT_TIMEOUT_MS, runAbort?.signal ?? null);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw httpError(res.status, t, res.headers.get('x-opencode-log-id') || '');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { throw new Error('LLM 响应不是合法 JSON'); }
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM 响应为空');
  return text;
}

// 有上限的退避（指数 + 抖动）：只对可重试错误生效；卡死/总超时不再连试 3 次。
const retryDelay = attempt => 900 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);

function shortErrText(err) {
  return String(err?.message || err).replace(/^LLM 请求失败：/, '').slice(0, 90);
}

// 逐次尝试都记日志：此前只有首尾两行，网关卡住时中间 4–6 分钟完全静默，无法与死机区分。
// 流式进度（首块 / 每 15s 已收字符数）也由后台经端口送上来，这里转成面板日志。
async function chatWithRetry(cfg, messages, opts = {}) {
  const label = opts.label ? `${opts.label}：` : '';
  const onProgress = evt => {
    if (evt.phase === 'stream') {
      fire({ kind: 'log', level: 'info', text: `${label}网关已建立流，等待首块…` });
    } else if (evt.phase === 'first') {
      fire({ kind: 'log', level: 'info', text: `${label}模型已开始输出（等待 ${(evt.elapsedMs / 1000).toFixed(1)}s）` });
    } else if (evt.phase === 'tick') {
      fire({ kind: 'log', level: 'info', text: `${label}生成中… 已收到 ${evt.chars} 字符（${(evt.elapsedMs / 1000).toFixed(1)}s）` });
    } else if (evt.phase === 'thinking' || evt.phase === 'thinking-tick') {
      fire({ kind: 'log', level: 'info', text: `${label}模型思考中… 已收到 ${evt.chars} 字符推理（${(evt.elapsedMs / 1000).toFixed(1)}s）` });
    } else if (evt.phase === 'stream-wait') {
      fire({ kind: 'log', level: 'info', text: `${label}流已建立，等待生成内容（${(evt.elapsedMs / 1000).toFixed(1)}s）…` });
    } else if (evt.phase === 'waiting') {
      // 后台每 20s 发一次保活进度：既让用户看到没有死机，也证明 worker 还活着
      fire({ kind: 'log', level: 'info', text: `${label}仍在等待网关响应（${(evt.elapsedMs / 1000).toFixed(1)}s）…` });
    }
  };
  const startedAt = Date.now();
  let attempts = 0;
  let lastErr = null;
  for (let attempt = 1; ; attempt++) {
    attempts = attempt;
    const t0 = Date.now();
    try {
      return await chatOnce(cfg, messages, { onProgress });
    } catch (err) {
      lastErr = err;
      const kind = classifyLlmError(err);
      const max = kind === 'idle' ? LLM_MAX_IDLE_ATTEMPTS : LLM_MAX_ATTEMPTS;
      const canRetry = kind !== 'aborted' && kind !== 'fatal' && kind !== 'timeout'
        && kind !== 'invalidated' && attempt < max;
      if (!canRetry) break;
      const delay = retryDelay(attempt);
      const took = ((Date.now() - t0) / 1000).toFixed(1);
      fire({ kind: 'log', level: 'warn', text: `${label}第 ${attempt}/${max} 次请求失败（${shortErrText(err)}，用时 ${took}s），${(delay / 1000).toFixed(1)}s 后重试` });
      await sleep(delay);
    }
  }
  // 最终失败也带上次数与总耗时，避免「4 分钟静默 + 一句报错」看不出发生过重试
  if (attempts > 1 && lastErr?.message && !lastErr.aborted) {
    lastErr.message = `${lastErr.message}（共尝试 ${attempts} 次，总用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`;
  }
  throw lastErr;
}

// 页面上下文带登录态取图并转 data URL（初探结论：ptausercontent 图源可直接带登录态获取）。
// 页面 fetch 走 CORS——实测 ptausercontent 不放行页面 fetch，因此失败后转取：
// 经 chrome.runtime 让 background fetch（该域已在 host_permissions，含图转取见 background/index.js）。
// 页面世界无 chrome.runtime（真机扩展才可用时 background 可用），两层都失败则该题报失败不拖累其他题。
function toDataUrlPage(src) {
  return fetchBounded(src, { credentials: 'include' }, IMAGE_TIMEOUT_MS, runAbort?.signal ?? null).then(res => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }).then(blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('FileReader 读取失败'));
    r.readAsDataURL(blob);
  }));
}

async function toDataUrl(src) {
  try {
    return await toDataUrlPage(src);
  } catch (_) { /* 页面层（CORS 等）失败 → background 转取 */ }
  if (!hasBgFetch) throw new Error('页面 fetch 被拒且无 background 可转取');
  const rsp = await new Promise((resolve, reject) => {
    let settled = false;
    try {
      chrome.runtime.sendMessage({ type: 'BPS_FETCH_IMAGE', src }, rsp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        settled = true;
        resolve(rsp);
      });
    } catch (err) { return reject(err); }
    setTimeout(() => { if (!settled) reject(new Error('background 转取无响应')); }, 15000);
  });
  if (!rsp?.ok) throw new Error('background 转取失败：' + (rsp?.reason || 'no response'));
  return rsp.dataUrl;
}

// 带图 content 组装（纯函数，单测覆盖）：原文本在前、题干图逐张标注、选项图按字母映射。
// OpenAI 兼容视觉格式：user.content = [{type:'text'},{type:'image_url'}] 交替
export function assembleImgMessage(userContent, imgs) {
  const stem = imgs.stem || [];
  const parts = [{
    type: 'text',
    text: `${userContent}\n\n（本题含配图：题干图在前，选项图随后并标注归属选项。请同时依据图片内容作答，仍只输出一个 JSON，不要解释。）`,
  }];
  stem.forEach((url, i) => {
    parts.push({ type: 'text', text: `（题干配图 ${i + 1}/${stem.length}）` });
    parts.push({ type: 'image_url', image_url: { url } });
  });
  for (const [letter, url] of Object.entries(imgs.options || {})) {
    parts.push({ type: 'text', text: `（选项 ${letter} 的配图）` });
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

// 单题图片下载（输入 collectPage 的 imgInfo；串行取图，题内数量少够用）
async function downloadImgs(imgInfo) {
  const out = { stem: [], options: {} };
  for (const src of imgInfo.stem) out.stem.push(await toDataUrl(src));
  for (const [letter, src] of Object.entries(imgInfo.options)) out.options[letter] = await toDataUrl(src);
  return out;
}

// 单题作答：调用（每题独立请求，失败重试 1 次）→ 解析 → 填表。
// 返回 { ok: true, text: 作答内容展示串 } 或 { ok: false, reason }
async function answerOne(q, cfg) {
  // 含图题仅在「作答含图题」开启时走视觉链路；下载失败按单题失败处理，不拖垮整页
  let images = null;
  if (cfg.images && q.hasImg) {
    try {
      images = await downloadImgs(q.imgInfo);
    } catch (err) {
      return { ok: false, reason: '含图题图片加载失败：' + (err?.message || err) };
    }
    if (!images.stem.length && !Object.keys(images.options).length) {
      return { ok: false, reason: '含图题未取到可用图片地址' };
    }
  }
  const basePrompt = buildPrompt(q);
  const messages = images
    ? [{ role: 'system', content: basePrompt[0].content }, { role: 'user', content: assembleImgMessage(basePrompt[1].content, images) }]
    : basePrompt;
  let raw = null;
  try {
    raw = globalThis.__BPS_LLM_MOCK__
      ? await globalThis.__BPS_LLM_MOCK__(messages)
      : await chatWithRetry(cfg, messages, { label: q.label || q.id.slice(-4) });
  } catch (err) {
    if (runAbort?.signal.aborted || err?.aborted) return { ok: false, reason: '已中止' };
    return { ok: false, reason: 'LLM 调用失败：' + (err?.message || err) };
  }
  const json = parseJsonLoose(raw);
  if (!json) return { ok: false, reason: 'LLM 输出无法解析：' + String(raw).slice(0, 60) };
  try {
    if (q.kind === 'MULTIPLE_CHOICE') {
      const letter = parseChoiceAnswer(json.answer, q.radios.length);
      if (!letter) return { ok: false, reason: 'LLM 字母答案无效：' + String(json.answer).slice(0, 20) };
      if (!fillRadio(q, letter)) return { ok: false, reason: '写入选项失败' };
      return { ok: true, text: letter };
    } else if (q.kind === 'TRUE_OR_FALSE') {
      const tf = normalizeTF(json.answer);
      if (!tf) return { ok: false, reason: 'LLM 判断答案无效：' + String(json.answer).slice(0, 20) };
      if (!fillRadio(q, tf === 'TRUE' ? 'A' : 'B')) return { ok: false, reason: '写入选项失败' }; // DOM 顺序固定 [T, F]
      return { ok: true, text: tf };
    } else {
      const answers = parseFillAnswers(json, q.blanks);
      if (!answers) return { ok: false, reason: `LLM 填空答案数量不符（需 ${q.blanks} 空）` };
      fillBlank(q, answers);
      const shown = answers.join('、');
      return { ok: true, text: shown.length > 28 ? shown.slice(0, 28) + '…' : shown };
    }
  } catch (err) {
    return { ok: false, reason: '写入失败：' + (err?.message || err) };
  }
}

/* ---------- 运行编排：编码题（跨文档续跑 relay） ---------- */
// PTA 只在「整页装载」时从服务端草稿水合代码；SPA remount 会命中它的内存响应缓存拿旧值
// （决策实验记录：写草稿→SPA 往返 = 不回带；写草稿→整页 reload = 必回带。见初探 §10.6）。
// 因此编码题（编程/函数）流转改为 sessionStorage 会话标志 + 逐题整页装载：
//   collect 文档（收题 → LLM → 写草稿）→ reload 到 verify 文档（水合 → 守护 → dry 撤销/真实提交）
//   → assign 下一题文档 → … → 最后一题收尾。每个文档由内容脚本重启恢复阶段。
// 会话标志含运行配置（含 API Key），只在当前标签页存活期内有效，关标签即清。

const RELAY_KEY = '__BPS_AA_PROG_RELAY__';
function readRelay() {
  try { return JSON.parse(sessionStorage.getItem(RELAY_KEY)) || null; } catch (_) { return null; }
}
function writeRelay(r) {
  try { sessionStorage.setItem(RELAY_KEY, JSON.stringify(r)); return true; } catch (_) { return false; }
}
function clearRelay() {
  try { sessionStorage.removeItem(RELAY_KEY); } catch (_) {}
}

/* ---------- PTA 访问频率限制 ----------
 * PTA 在请求过快时会把整页换成错误页（「您访问得太快啦，不如休息一会儿吧」）。
 * 续跑每题要整页装载两次（collect → reload verify），连续翻页容易触发，因此：
 * 1) 每次切题/重载前固定等 5s（PAGE_LOAD_WAIT_MS；实测 1–5s 随机仍会触发限流）；
 * 2) 一旦识别到限流页就暂停重载本题，冷却按 60/120/180s 递增，仍不行才中止。
 * 冷却次数存进续跑单（rlTries），跨页保留；处理到真实题目页后清零。
 */
const PAGE_LOAD_WAIT_MS = 5000; // 切题/重载前的固定等待（1–5s 随机实测仍会撞限流）
const RATE_LIMIT_WAITS_MS = [60000, 120000, 180000];
const NAVIGATE_CHECK_MS = 10000; // 翻页后多久检查「是不是还停在原页」，失败重试一次再收摊

export function isRateLimitedText(text) {
  const s = String(text || '').replace(/\s+/g, '');
  // 「您访问得太快啦」是 PTA 错误页的专有文案，单独命中即可；
  // 其余泛化词（访问过于频繁等）必须同时出现错误页外壳，避免把限流器题面当成限流页
  if (s.includes('您访问得太快啦')) return true;
  const shell = s.includes('反馈问题') || s.includes('浏览器信息') || s.includes('错误信息') || s.includes('feedback@pat-edu.com');
  if (!shell) return false;
  return s.includes('访问得太快') || s.includes('访问过于频繁') || s.includes('操作过于频繁');
}

function rateLimitedNow() {
  try { return isRateLimitedText((document.body?.innerText || '').slice(0, 20000)); } catch (_) { return false; }
}

// 整页导航（续跑每次翻页/重载都走这里）：成功时本文档立即销毁、定时器随之消失；
// 若页面始终没跳走（浏览器离开确认被取消、扩展拦截等），重试一次后明确收摊——
// 不能把续跑单悬在空中，让面板停在「待机」却再也不动。
function navigateRelay(target, r, what) {
  const from = location.pathname + location.search;
  const go = () => { try { location.href = target; } catch (_) { /* 导航交浏览器 */ } };
  const check = attempt => setTimeout(() => {
    if (location.pathname + location.search !== from) return; // 已经离开，定时器随旧文档销毁
    if (attempt === 0) {
      fire({ kind: 'log', level: 'warn', text: `${what}未生效（页面没有跳转），重试一次…` });
      go();
      check(1);
      return;
    }
    abortRelay(r, `${what}被拦下：页面始终没有跳转（浏览器离开确认或扩展拦截），请处理后重新开始，已完成的题目不会重做`);
  }, NAVIGATE_CHECK_MS);
  go();
  check(0);
}

// 每次切题/重载前固定等 5s：随机 1–5s 实测仍会触发限流（用户真机反馈），
// 不再按文档存活时长补足，也不加抖动
async function pacePageLoad(where) {
  fire({ kind: 'log', level: 'info', text: `${where}：等待 ${PAGE_LOAD_WAIT_MS / 1000}s 再切换（避免 PTA 访问频率限制）…` });
  await sleep(PAGE_LOAD_WAIT_MS);
}

// 返回 true 表示已接管（暂停或中止），调用方不要再推进续跑
function pauseForRateLimit(r, where) {
  const tries = Number(r.rlTries) || 0;
  if (tries >= RATE_LIMIT_WAITS_MS.length) {
    abortRelay(r, `连续触发 PTA 访问频率限制（${where}），已冷却 ${RATE_LIMIT_WAITS_MS.map(ms => Math.round(ms / 1000)).join(' / ')}s 仍被拒绝；请休息几分钟后重新开始，已完成的题目不会重做`);
    return true;
  }
  const wait = RATE_LIMIT_WAITS_MS[tries];
  r.rlTries = tries + 1;
  if (!writeRelay(r)) {
    abortRelay(r, 'sessionStorage 写入失败，无法记录限流冷却');
    return true;
  }
  running = false;
  runAbort = null;
  fire({ kind: 'log', level: 'warn', text: `PTA 限流（${where}）：等待 ${Math.round(wait / 1000)}s 后重载本题（第 ${tries + 1}/${RATE_LIMIT_WAITS_MS.length} 次）…` });
  // 不 reload 当前地址：限流页可能已被换成错误页地址，直接回到续跑单里这一题的 URL
  const prob = r.problems?.[r.pi];
  const target = prob
    ? `/problem-sets/${r.psId}/exam/problems/type/${prob.typeId}?problemSetProblemId=${prob.id}`
    : location.href;
  setTimeout(() => navigateRelay(target, r, '限流冷却后重载本题'), wait);
  return true;
}

// 编码题流程入口：往 sessionStorage 里放下续跑单，然后整页跳到第一题（收集委托给 boot）。
// 题目清单用 progTypes 里现成的 ids（handleRun 在各题型页面就绪时当场收的，见彼处注释）——
// 此处文档已不在各题型页上，不能回头再收。
function startProgrammingRelay(psId, progTypes, cfg) {
  const problems = [];
  for (const t of progTypes) {
    for (const id of t.ids) problems.push({ id, typeId: t.typeId, typeName: t.typeName });
  }
  if (!problems.length) throw new Error('「编码题」找不到题目锚点（题目总览收起？点开后重试）');
  const relay = {
    v: 1,
    cfg: { ...cfg },
    psId,
    problems,
    pi: 0,
    phase: 'collect', // collect → verify →（advance）→ collect → …
    summary: { applied: 0, skippedAnswered: 0, failed: [] },
  };
  if (!writeRelay(relay)) throw new Error('sessionStorage 不可写，无法跨页续跑编码题');
  const first = problems[0];
  const names = [...new Set(progTypes.map(t => t.typeName))].join('、');
  fire({ kind: 'log', level: 'info', text: `${names || '编码题'} ${problems.length} 题：转「逐题整页装载」模式（日志跨页保留）` });
  suppressLeaveConfirm(); // 首次跳题也要压住离开确认（本页可能还有未保存的客观题答案）
  navigateRelay(`/problem-sets/${psId}/exam/problems/type/${first.typeId}?problemSetProblemId=${first.id}`, relay, '进入第一题');
  return true;
}

// boot 后由 init 调用：存在续跑单就按阶段恢复（总开关仍要开着）
export async function resumeRelay(settings) {
  const r = readRelay();
  if (!r || r.v !== 1) return;
  if (!(settings && settings.autoAnswer)) {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题续跑取消：总开关未开启' });
    return;
  }
  if (r.aborted) { // 上一页已按用户要求中止（中止写入续跑单后才翻页的残单）：就地作废
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题续跑已中止（按你的要求停止）' });
    fire({ kind: 'state', running: false, error: '已中止' });
    return;
  }
  const prob = r.problems[r.pi];
  if (!prob) {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题续跑取消：续跑单已越界' });
    return;
  }
  // 限流页可能被 PTA 换成别的地址/错误页：先识别再校验 URL，避免把限流误判成「用户导航走了」而弃单
  if (rateLimitedNow()) { pauseForRateLimit(r, '页面加载'); return; }
  if (!new RegExp(`problemSetProblemId=${prob.id}$`).test(location.search)) {
    // 用户把页面开去了别处 → 弃单（已落位的题目保持各自状态）
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题续跑取消：页面不在 ' + (prob.id || '').slice(-4) + ' 上（已落位题目保持各自状态）' });
    return;
  }
  running = true;
  runAbort = new AbortController(); // 续跑页也挂终止信号，面板的中止按钮每页都有效
  suppressLeaveConfirm();
  fire({ kind: 'state', running: true });
  // 每页的进页日志：跨页日志已持久化（见 readPersistedLog），这里只立坐标；
  // 历史日志丢了（用户手动清空）才回放失败清单兜底
  const hadHistory = readPersistedLog().length > 0;
  fire({ kind: 'log', level: 'info', text: `编码题续跑（第 ${r.pi + 1}/${r.problems.length} 题，${r.phase === 'verify' ? '水合校验/提交' : '收集作答'}阶段）` });
  if (r.summary.failed.length && !hadHistory) {
    fire({ kind: 'log', level: 'warn', text: `此前已失败 ${r.summary.failed.length} 题：\n${failDetails(r.summary.failed)}` });
  }
  try {
    stripDraftHttpCache(prob.id); // PAT 旧响应会伪造「已答」/旧代码，挂载读值前先剥
    if (r.phase === 'verify') {
      await relayVerify(r, prob);
    } else {
      await settleEditorState();
      await relayCollect(r, prob);
    }
  } catch (err) {
    abortRelay(r, err?.message || String(err));
  }
}

// 失败明细的纯函数（failDetails，单测覆盖）：label 缺省回退服务端题 id 后四位
export function failDetails(failed) {
  return (failed || []).map(f => `${f.label || (f.id || '').slice(-4)}：${f.reason}`).join('\n');
}

export function relaySummaryLine(r) {
  const s = r.summary;
  const line = `作答 ${s.applied} · 跳过已答 ${s.skippedAnswered} · 失败 ${s.failed.length}${r.cfg.drySave ? '（dry，未提交）' : ''}`;
  if (!s.failed.length) return line;
  return `${line}\n失败明细：\n${failDetails(s.failed)}`;
}

// 单题失败记账 + 当场报错：失败必须立刻在日志里留痕（跨页日志会保留），
// 不能只进汇总等全部结束才现形。label 缺省用题 id 后四位兜底。
function relayRecordFail(r, prob, label, reason) {
  r.summary.failed.push({ id: prob.id, ...(label ? { label } : {}), reason });
  fire({ kind: 'log', level: 'err', text: `${label || prob.id.slice(-4)}：${reason}` });
}

function abortRelay(r, reason) {
  clearRelay();
  fire({ kind: 'log', level: 'err', text: '编码题续跑中止：' + reason });
  fire({ kind: 'log', level: 'info', text: relaySummaryLine(r) });
  fire({ kind: 'state', running: false, error: reason });
  running = false;
  runAbort = null;
  restoreLeaveConfirm();
}

// 用户中止（跨页续跑）：不再翻页，就地收摊；已落位题目保持各自状态（草稿/提交不动）
function stopRelayByUser(r) {
  clearRelay();
  running = false;
  runAbort = null;
  restoreLeaveConfirm();
  fire({ kind: 'log', level: 'warn', text: '已中止：编码题续跑按你的要求停止' });
  fire({ kind: 'log', level: 'info', text: relaySummaryLine(r) });
  fire({ kind: 'state', running: false, error: '已中止' });
}

// 推进到下一题（record: 'ok'|'skip'|'fail'——fail 的失败条目由调用方写好）；最后一题收尾
async function relayNext(r, record, text) {
  r.rlTries = 0; // 能走到这里说明不是限流页：下一次限流重新从 60s 冷却开始
  if (record === 'ok') {
    r.summary.applied += 1;
    if (text) fire({ kind: 'log', level: 'ok', text });
  }
  if (record === 'skip') {
    r.summary.skippedAnswered += 1;
    if (text) fire({ kind: 'log', level: 'info', text });
  }
  // 进度随球：此刻 r.pi 指刚完成的那题，pi+1 = 已完成数（收尾分支 pi 也停在最后一题位）
  fire({ kind: 'progress', done: r.pi + 1, total: r.problems.length });
  // 用户已请求中止：不再翻页，就地收摊（记账已先行，刚完成的题计入汇总）
  if (userStopped(r)) { stopRelayByUser(r); return; }
  const nextIdx = r.pi + 1;
  if (nextIdx >= r.problems.length) {
    const line = relaySummaryLine(r);
    try { sessionStorage.setItem('__BPS_AA_SUMMARY_DONE__', JSON.stringify({ ok: !r.summary.failed.length, line, failed: r.summary.failed })); } catch (_) {}
    clearRelay();
    running = false;
    runAbort = null;
    restoreLeaveConfirm();
    const lvl = r.summary.failed.length ? 'warn' : 'ok';
    fire({ kind: 'log', level: lvl, text: '编码题跨页续跑结束：' + line });
    fire({ kind: 'state', running: false });
    return;
  }
  r.pi = nextIdx;
  r.phase = 'collect'; // 下一题重新从 collect 开始（否则带着上一题的 verify 状态/hint 会误杀）
  r.hint = null;       // hint 必须由下一题的 collect 重写，不能复用上一题的（head/草稿都不属于本题）
  const next = r.problems[r.pi];
  await prepNextProblemCache(next.id); // PAT 剥离在函数内会一起做；不一致缓存保留（用户代码签名）
  if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
  running = false;
  await pacePageLoad('切换下一题');
  navigateRelay(`/problem-sets/${r.psId}/exam/problems/type/${next.typeId}?problemSetProblemId=${next.id}`, r, '切换下一题');
}

// collect 文档：收题 → 守护 → LLM → 写草稿 → 转 verify（整页 reload）
async function relayCollect(r, prob) {
  const q = collectCodingProblem();
  if (!q) {
    if (rateLimitedNow()) { pauseForRateLimit(r, '收集题目'); return; }
    relayRecordFail(r, prob, null, '编码题页面收不到题目');
    return relayNext(r, 'fail');
  }
  r.rlTries = 0; // 真实题目页已打开：限流冷却计数清零
  const label = q.label || prob.id.slice(-4);
  if (q.answered && !r.cfg.overwrite) return relayNext(r, 'skip', `${label}：跳过，已作答`);
  // 编码题的视觉链路未接（取图与带图消息组装只做在客观题上）：含图题照常按文字题面
  // 作答并提交，只在日志写明这一局限，避免用户以为模型看过图。
  if (q.hasImg) fire({ kind: 'log', level: 'warn', text: `${label}：题干含图片，编码题暂不支持图片输入，仅按文字题面作答` });

  const detail = await getDraftDetail(prob.id);
  let compilerId = null;
  let wantLangLabel = '';
  if (q.kind !== 'CODE_COMPLETION') {
    // 编程题需要确定编译器（草稿带 compiler 字段）；函数题编译器由题目固定，草稿无此字段
    compilerId = r.cfg.language
      ? r.cfg.language
      : (compilerIdFromLabel(q.langLabel) || (detail?.programmingSubmissionDetail?.compiler || null));
    if (!compilerId) {
      relayRecordFail(r, prob, label, `读不到当前语言「${q.langLabel || '（空）'}」，无法确定编译器`);
      return relayNext(r, 'fail');
    }
    wantLangLabel = COMPILER_LABELS[compilerId] || q.langLabel || '';
  }

  const messages = buildPrompt({ ...q, langLabel: wantLangLabel || q.langLabel || '' });
  let raw = null;
  fire({ kind: 'log', level: 'info', text: `${label}：请求模型中…（${r.cfg.model || '未知模型'}）` }); // await 期间的事件流在场日志
  try {
    raw = globalThis.__BPS_LLM_MOCK__
      ? await globalThis.__BPS_LLM_MOCK__(messages)
      : await chatWithRetry(r.cfg, messages, { label });
  } catch (err) {
    if (userStopped(r)) { stopRelayByUser(r); return; } // 中止来的失败不算题目的失败，别记假账
    relayRecordFail(r, prob, label, 'LLM 调用失败：' + (err?.message || err));
    return relayNext(r, 'fail');
  }
  const code = parseCodeAnswer(raw);
  if (!code) {
    relayRecordFail(r, prob, label, 'LLM 输出解析不出代码：' + String(raw).slice(0, 60));
    return relayNext(r, 'fail');
  }
  if (code.length > 16384) {
    relayRecordFail(r, prob, label, `代码超长（${code.length} 字符，平台限 16KB）`);
    return relayNext(r, 'fail');
  }

  const written = await saveDraft(prob.id, q.kind, detail, compilerId, code);
  if (!written.ok) {
    if (rateLimitedNow()) { pauseForRateLimit(r, '写草稿'); return; }
    relayRecordFail(r, prob, label, `草稿写入失败（HTTP ${written.status ?? '未知'}${written.err ? '：' + written.err : ''}）`);
    return relayNext(r, 'fail');
  }
  stripDraftHttpCache(prob.id);
  // 服务端草稿已不参与 boot 水合（2026-10-15 实测），清键改为种键：verify 文档 boot 从该键
  // 回带本题代码。种入失败则 verify 必挂水合校验，这里直接记失败不翻页白耗一轮。
  const seeded = seedCodingProblemCache(prob.id, code, detail);
  if (!seeded.seeded) {
    relayRecordFail(r, prob, label, '水合键写入失败' + (seeded.err ? '：' + seeded.err : ''));
    return relayNext(r, 'fail');
  }
  r.phase = 'verify';
  r.hint = { label, kind: q.kind, compilerId, wantLangLabel, head: (code.split('\n')[0] || '').trim().slice(0, 24), detail };
  if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
  running = false; // 文档马上销毁，复位标记避免残留运行态
  await pacePageLoad('提交草稿后校验');
  try { location.reload(); } catch (_) { /* 交浏览器 */ }
}

// verify 文档：水合探测 → 语言守护（仅编程题） → dry 撤销 / 点「提交本题作答」→ 推进下一题（或收尾）
async function relayVerify(r, prob) {
  const hint = r.hint;
  if (!hint || !hint.head) { abortRelay(r, 'verify 阶段缺少 hint（replay 状态错乱）'); return; }
  if (rateLimitedNow()) { pauseForRateLimit(r, '水合校验'); return; }
  const label = hint.label || prob.id.slice(-4);
  const kind = hint.kind || 'PROGRAMMING'; // 旧续跑单没有 kind 字段：只可能是编程题
  const wantLangLabel = hint.wantLangLabel || '';
  const compilerId = hint.compilerId;
  const head = String(hint.head || '').trim();
  const detail = hint.detail || null;

  const hyd = await waitHydrate(true);
  const cmText = editableCm()?.textContent || '';
  if (!hyd.ok || (head && !cmText.includes(head))) {
    if (rateLimitedNow()) { pauseForRateLimit(r, '水合校验'); return; }
    const rollback = await saveDraft(prob.id, kind, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    relayRecordFail(r, prob, label, '水合校验失败（编辑器未回带代码）' + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对'));
    if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
    return relayNext(r, 'fail');
  }
  r.rlTries = 0; // 水合通过 = 真实题目页，限流冷却计数清零

  // 语言一致性守卫（仅编程题）：实挂语言 != 代码语言时不提交（提交载荷的 compiler 由页面
  // 默认链决定，可能不理会草稿 compiler——不能拿错配代码冒险）。函数题的编译器由题目固定、
  // 草稿不带 compiler 字段，不存在错配，直接跳过。
  if (kind !== 'CODE_COMPLETION') {
    const mountedLabel = langLabelOf();
    if (mountedLabel !== wantLangLabel) {
      const rollback = await saveDraft(prob.id, kind, detail, compilerId, '');
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      relayRecordFail(r, prob, label, `语言不一致（草稿 ${wantLangLabel}，实挂「${mountedLabel || '未知'}」），已弃答防错配` + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对'));
      if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
      return relayNext(r, 'fail');
    }
  }

  if (r.cfg.drySave) {
    const rollback = await saveDraft(prob.id, kind, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    if (!rollback.ok) return abortRelay(r, 'dry：水合校验通过后撤销草稿失败，残留需人工核对');
    return relayNext(r, 'ok', `${label} → ${head}…（dry：草稿水合校验通过后已撤销，未提交）`);
  }

  // 中止检查必须卡在真实评测提交之前：提交即写提交记录，不能替用户「再补一枪」
  if (userStopped(r)) { stopRelayByUser(r); return; }
  const saved = await submitProgramming();
  if (!saved.saved || rateLimitedNow()) {
    // 限流页可能替换在提交之后：不记账、不回滚草稿，冷却后重载本题再试
    if (rateLimitedNow()) { pauseForRateLimit(r, '提交评测'); return; }
    const rollback = await saveDraft(prob.id, kind, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    relayRecordFail(r, prob, label, '提交失败：' + saved.reason + (rollback.ok ? '，草稿已撤销' : '，草稿残留含本次代码，需人工核对'));
    if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
    return relayNext(r, 'fail');
  }
  return relayNext(r, 'ok', `${label} → ${head}…（已提交评测）`);
}

/* ---------- 运行编排 ---------- */

// PTA 在题目页有未保存改动时有两种离开确认：SPA 切换题型走 confirm()，整页卸载走
// beforeunload 监听器（它的 handler 在 props.dirty 时设置 event.returnValue，浏览器据此
// 弹「离开此网站？」原生框）。续跑每次翻页/重载都是整页导航，两道都要在运行期间压住：
// confirm 直接替换；beforeunload 把 BeforeUnloadEvent.prototype.returnValue 的 setter
// 置空（监听器是 PTA 自己 addEventListener 注册的，拿不到引用删不掉，只能让触发对话框的
// 那一步失效）。主世界注入可行，实测 PTA 无 CSP meta；运行结束后恢复。
function pageScript(code) {
  const s = document.createElement('script');
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}
function suppressLeaveConfirm() {
  pageScript(`(function () {
    if (!window.__BPS_CONFIRM__) { window.__BPS_CONFIRM__ = window.confirm; window.confirm = () => true; }
    if (!window.__BPS_UNLOAD_DESC__ && typeof BeforeUnloadEvent !== 'undefined') {
      var d = Object.getOwnPropertyDescriptor(BeforeUnloadEvent.prototype, 'returnValue');
      try {
        Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', {
          configurable: true,
          enumerable: d ? d.enumerable : true,
          get: function () { return ''; },
          set: function () { /* 运行期间不触发原生离开确认 */ },
        });
        window.__BPS_UNLOAD_DESC__ = d;
      } catch (_) { /* 原型被冻结时退回 confirm 兜底 */ }
    }
  })();`);
}
function restoreLeaveConfirm() {
  pageScript(`(function () {
    if (window.__BPS_CONFIRM__) { window.confirm = window.__BPS_CONFIRM__; delete window.__BPS_CONFIRM__; }
    if (window.__BPS_UNLOAD_DESC__) {
      try { Object.defineProperty(BeforeUnloadEvent.prototype, 'returnValue', window.__BPS_UNLOAD_DESC__); } catch (_) {}
      delete window.__BPS_UNLOAD_DESC__;
    }
  })();`);
}

let running = false;
let runAbort = null; // 当前运行的终止信号：面板中止按钮触发；null = 本页没有在跑的运行

export function isRunning() {
  return running;
}

// 请求中止：本页在跑就拉响终止信号（在途 fetch 立断、worker 停拉新题，已填答案所在页
// 照常保存）；编程题跨页续跑滚动中时（哪怕本页还没接上）把中止写进续跑单，
// 由本页 relayNext 就地收摊、或下一页 boot 直接作废残单。返回是否受理。
export function abortRun() {
  const r = readRelay();
  if (running && runAbort) {
    if (!runAbort.signal.aborted) runAbort.abort();
    if (r && !r.aborted) { r.aborted = true; writeRelay(r); }
    return true;
  }
  if (r && !r.aborted) { r.aborted = true; writeRelay(r); return true; }
  return false;
}

// 是否已请求中止：本页看终止信号；跨页续跑还要看单子上的标记（可能在别的页面/时点写入）
function userStopped(r) {
  return !!(runAbort?.signal?.aborted || r?.aborted);
}

/* ---------- 事件流（悬浮面板消费） ---------- */
// 面板注册 sink 接收结构化事件；无面板时引擎照常运行（sink 未注册则丢弃）
// 事件：{kind:'log', level:'info'|'ok'|'warn'|'err', text}
//       {kind:'progress', done, total, typeName}
//       {kind:'state', running, error?}
/* ---------- 跨页日志 ----------
 * 编程题续跑每题整页装载，面板内存里的日志随文档销毁；把日志同时写进 sessionStorage
 * （同标签页跨 reload 存活），下一页挂载时先回放，整轮日志才看得全。
 * 由引擎统一落盘（面板只展示）：日志发出时面板可能还没挂载，放在面板层会丢。
 */
const LOG_KEY = '__BPS_AA_LOG__';
const LOG_CAP = 200; // 与面板 MAX_LOG_LINES 一致

function logTime() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function readPersistedLog() {
  try {
    const arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(x => x && typeof x.text === 'string')
      .map(x => ({ level: x.level || 'info', text: x.text, t: x.t || '' }));
  } catch (_) {
    return [];
  }
}

export function persistLogLine(level, text, t) {
  try {
    const arr = readPersistedLog();
    arr.push({ level: level || 'info', text: String(text ?? ''), t: t || logTime() });
    if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
    sessionStorage.setItem(LOG_KEY, JSON.stringify(arr));
  } catch (_) { /* 隐私模式/配额满：跨页日志失效不阻断运行 */ }
}

export function clearPersistedLog() {
  try { sessionStorage.removeItem(LOG_KEY); } catch (_) {}
}

let eventSink = null;
export function setEventSink(fn) {
  eventSink = typeof fn === 'function' ? fn : null;
}
const debugTrace = [];
function fire(event) {
  if (event.kind === 'log') persistLogLine(event.level, event.text);
  // 事件轨迹（调试/回归用黑匣子）：保留最近 40 条，同一文档内按时间序可读
  debugTrace.push({ ...event, t: Date.now() });
  if (debugTrace.length > 40) debugTrace.splice(0, debugTrace.length - 40);
  try { sessionStorage.setItem('__BPS_AA_TRACE__', JSON.stringify(debugTrace)); } catch (_) { /* 轨迹失败不阻断 */ }
  try { sessionStorage.setItem('__BPS_AA_LAST_EVENT__', JSON.stringify({ ...event, at: Date.now() })); } catch (_) { /* 黑匣子失败不阻断 */ }
  try { eventSink?.(event); } catch (_) { /* 面板异常不阻断运行 */ }
}

const progressOf = stats => ({
  applied: stats.ok.length,
  skippedAnswered: stats.skippedAnswered,
  skippedImage: stats.skippedImage,
  failed: stats.failed.map(f => f.reason),
});

export async function handleRun(config = {}) {
  if (running) { fire({ kind: 'log', level: 'warn', text: '已有一次答题在运行中' }); return { ok: false, error: '已有一次答题在运行中' }; }
  const preRelay = readRelay();
  if (preRelay && !preRelay.aborted) {
    // 编码题跨页续跑滚动中（每页由 boot 的 resumeRelay 恢复阶段）；该页不在题目页时续跑已弃单
    fire({ kind: 'log', level: 'warn', text: '编码题跨页续跑正在进行（看各页悬浮球状态）；本页若已不在题目上则续跑会自行取消' });
    return { ok: false, error: '编码题跨页续跑正在进行' };
  }
  if (preRelay) clearRelay(); // 已中止的续跑残单：作废，不拦新运行
  const m = location.pathname.match(EXAM_PROBLEMS_RE);
  if (!m || !m[3]) { fire({ kind: 'log', level: 'err', text: '请先进入题型页（判断/单选/填空标签）再开始' }); return { ok: false, error: '请先进入题目列表的某个题型页（判断/单选/填空标签）再开始' }; }
  const psId = m[1];
  const cfg = {
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    model: config.model || '',
    gateway: config.gateway || '',
    overwrite: !!config.overwrite,
    images: !!config.images, // 作答含图题（需视觉模型；只作用于客观题，编程题恒按文字题面作答）
    language: config.language || '', // 编程题固定语言（白名单 id）；空 = 跟随各题编辑器当前语言；函数题忽略（编译器由题目固定）
    drySave: !!config.drySave,
  };
  if (globalThis.__BPS_LLM_MOCK__ && !cfg.drySave) {
    // mock + 真保存 = 测试误入真实题集。面板按钮对真实用户没有 mock，此护栏只拦调试场景
    cfg.drySave = true;
    fire({ kind: 'log', level: 'warn', text: '检测到 __BPS_LLM_MOCK__：本次运行自动改为 dry run（不点保存）' });
  }
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    fire({ kind: 'log', level: 'err', text: '请先选择模型并填写 API Key' });
    return { ok: false, error: '请先填写 API Key' };
  }
  try {
    assertChatModel(cfg); // 非 chat 系模型在开跑前就明确拒绝，不白耗每道题的一次 400
  } catch (err) {
    fire({ kind: 'log', level: 'err', text: err.message });
    return { ok: false, error: err.message };
  }

  running = true;
  runAbort = new AbortController(); // 中止按钮的终止信号：请求与各循环按它收摊
  suppressLeaveConfirm();
  const summary = { types: [], applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [], savedTypes: 0, saveFails: [] };
  const progTypes = []; // 编程题：转跨文档续跑（整页装载才有真草稿水合），统一在客观题之后触发
  let ret = null;
  let relayStarted = false;
  try {
    clearPersistedLog(); // 新一轮从空日志开始（跨页续跑属于同一轮，不会走到这里）
    fire({ kind: 'log-clear' });
    fire({ kind: 'state', running: true });
    fire({ kind: 'log', level: 'info', text: `开始答题（每题一次请求，${cfg.overwrite ? '覆盖已作答' : '跳过已答'}${cfg.images ? '，含图题作答' : ''}）` });
    const types = sidebarTypes().filter(t => TYPE_BY_NAME[t.typeName] || false).filter(t => t.total > 0);
    const unknown = sidebarTypes().filter(t => !(t.typeName in TYPE_BY_NAME) && t.total > 0);
    if (!types.length) throw new Error('本页侧栏没有可作答的题型（若「题目总览」收起请先展开再重试）');
    if (unknown.length) {
      summary.failed.push({ id: '-', reason: `暂不支持题型：${unknown.map(u => u.typeName).join('、')}（跳过）` });
      fire({ kind: 'log', level: 'warn', text: `暂不支持题型：${unknown.map(u => u.typeName).join('、')}，已跳过` });
    }
    const totalOverall = types.reduce((n, t) => n + t.total, 0);
    let processedOverall = 0;

    for (const t of types) {
      // 用户在运行中点了别的题目集 → 中止，绝不跨题集作答
      if (!EXAM_PROBLEMS_RE.test(location.pathname) || !location.pathname.includes(psId)) {
        throw new Error('已离开原题目页，中止');
      }
      if (runAbort.signal.aborted) throw new Error('已中止');
      const type = TYPE_BY_NAME[t.typeName];
      const isCoding = isCodingKind(type);
      if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
        const link = [...document.querySelectorAll('a[href]')]
          .find(a => (a.getAttribute('href') || '').match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
        if (!link) throw new Error(`找不到「${t.typeName}」的页面链接`);
        link.click();
        // 等 SPA 渲染出该题型页的题目：URL 与「该题型的容器数」都对才就绪
        // （路由先切内容后到，旧题型页的容器不能拿来充数）
        let ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
          if (runAbort.signal.aborted) throw new Error('已中止');
          await sleep(100);
          ready = location.pathname.endsWith(`/type/${t.typeId}`)
            && (isCoding
              ? (programmingIds(psId, t.typeId).length > 0 || !!editableCm())
              : collectPage().filter(q => q.kind === type).length >= t.total);
        }
        if (!ready) throw new Error(`「${t.typeName}」页面未就绪（侧栏统计 ${t.total} 题）`);
      }
      await sleep(300); // 渲染稳定
      if (isCoding) {
        // 编码题只与整页装载的水合机制兼容（SPA remount 命中内存响应缓存），转跨文档续跑；
        // 为让客观题在本文档内先处理完，编码题统一推迟到本轮所有客观题之后触发。
        // 锚点必须在本题型页面就绪的当下收：侧栏只渲染当前题型的题目锚点，循环结束后文档
        // 已停在最后一个编码题型页，回头统一收会把先遍历的题型收空、静默漏出续跑单
        // （2026-10-31 实测：函数题+编程题并存时函数题被整题跳过，汇总还显示成功）。
        let ids = programmingIds(psId, t.typeId);
        for (let i = 0; i < 30 && !ids.length; i++) { // 锚点晚到兜底 ≤3s（在题详情页开跑时侧栏可能还在渲染）
          if (runAbort.signal.aborted) throw new Error('已中止');
          await sleep(100);
          ids = programmingIds(psId, t.typeId);
        }
        if (!ids.length) throw new Error(`「${t.typeName}」找不到题目锚点（题目总览收起？点开后重试）`);
        progTypes.push({ ...t, ids });
        continue;
      }
      const questions = collectPage().filter(q => q.kind === type);
      if (!questions.length) throw new Error(`「${t.typeName}」页面收集不到题目`);
      fire({ kind: 'log', level: 'info', text: `「${t.typeName}」共 ${questions.length} 题，开始作答` });

      const stats = { ok: [], skippedAnswered: 0, skippedImage: 0, failed: [] };
      let done = 0;
      const queue = questions.map(q => ({ q }));
      let cursor = 0;
      const tick = () => {
        processedOverall += 1;
        fire({ kind: 'progress', done: processedOverall, total: totalOverall, typeName: t.typeName });
      };
      const worker = async () => {
        while (cursor < queue.length && !runAbort.signal.aborted) {
          const { q } = queue[cursor++];
          done += 1;
          if (q.answered && !cfg.overwrite) { stats.skippedAnswered += 1; fire({ kind: 'log', level: 'info', text: `${q.label || q.id.slice(-4)}：跳过，已作答` }); tick(); continue; }
          if (q.hasImg && !cfg.images) { stats.skippedImage += 1; fire({ kind: 'log', level: 'warn', text: `${q.label || q.id.slice(-4)}：跳过，含图片（未开「作答含图题」）` }); tick(); continue; }
          // 请求在途的在场日志：服务挂起时 worker 停在 await，没有这行日志就与死机无法区分
          fire({ kind: 'log', level: 'info', text: `${q.label || q.id.slice(-4)}：请求模型中…（${cfg.model || '未知模型'}）` });
          const r = await answerOne(q, cfg);
          if (r.ok) { stats.ok.push(q.id); fire({ kind: 'log', level: 'ok', text: `${q.label || q.id.slice(-4)} → ${r.text}` }); }
          else { stats.failed.push({ id: q.id, reason: r.reason }); fire({ kind: 'log', level: 'err', text: `${q.label || q.id.slice(-4)}：${r.reason}` }); }
          tick();
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));

      // 该页有新写入的答案才点保存（保存会新增一条提交记录，空点没有意义）
      const filled = stats.ok.length > 0;
      let saved = null;
      if (filled && !cfg.drySave) {
        saved = await saveTypePage();
        if (saved.saved) summary.savedTypes += 1;
        else summary.saveFails.push(`${t.typeName}：${saved.reason}`);
        fire({ kind: 'log', level: saved.saved ? 'ok' : 'err', text: saved.saved ? `「${t.typeName}」已保存` : `「${t.typeName}」保存失败：${saved.reason}` });
      } else if (!filled) {
        saved = { saved: false, reason: '本页无需新答案，未保存' };
      }

      const pg = progressOf(stats);
      summary.applied += pg.applied;
      summary.skippedAnswered += pg.skippedAnswered;
      summary.skippedImage += pg.skippedImage;
      summary.failed.push(...stats.failed);
      summary.types.push({ type: t.typeName, total: questions.length, applied: pg.applied, skippedAnswered: pg.skippedAnswered, skippedImage: pg.skippedImage, failed: stats.failed.length, saved: saved?.saved === true });
    }
    if (runAbort.signal.aborted) throw new Error('已中止'); // 最后一页答完才按中止也要如实报
    ret = { ok: true, summary };
    if (progTypes.length) {
      // 编码题统一推迟到所有客观题之后；启动续跑后 ret 语义是「客观题已完成、编码题滚动中」
      if (startProgrammingRelay(psId, progTypes, cfg)) {
        relayStarted = true;
        const relayNames = [...new Set(progTypes.map(t => t.typeName))].join('、');
        summary.types.push({ type: relayNames || '编码题', total: progTypes.reduce((n, x) => n + x.total, 0), applied: 0, skippedAnswered: 0, skippedImage: 0, failed: 0, saved: false });
        ret = { ok: true, relay: true, summary };
      }
    }
  } catch (err) {
    ret = { ok: false, error: err?.message || String(err), summary };
  } finally {
    // 先复位运行标志，再发完成事件——面板收到事件时 isRunning() 必须已是 false，
    // 否则 UI 会永远停在“答题中”。confirm 的恢复同理（面板可能立刻重新打开面板导航）。
    // 编程题续跑启动后 confirm 不能恢复（续跑的下一页还要压未保存弹窗）。
    running = false;
    runAbort = null;
    if (!relayStarted) restoreLeaveConfirm();

    if (ret.ok) {
      const failN = ret.summary.failed.length;
      fire({ kind: 'log', level: failN ? 'warn' : 'ok', text: `${ret.relay ? '客观题完成（编码题已转逐页续跑，日志随各页出现）' : `完成：作答 ${ret.summary.applied} · 跳过已答 ${ret.summary.skippedAnswered} · 跳过含图 ${ret.summary.skippedImage} · 失败 ${failN}${cfg.drySave ? '（未保存）' : ''}`}` });
      fire({ kind: 'state', running: false });
    } else {
      // 用户中止不带「原因前缀」重复（错误路径才需要「已中止：<原因>」）
      fire({ kind: 'log', level: 'err', text: ret.error === '已中止' ? '已中止' : '已中止：' + ret.error });
      fire({ kind: 'state', running: false, error: ret.error });
    }
  }
  return ret;
}
