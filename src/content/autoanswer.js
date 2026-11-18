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
import {
  RELAY_SIZE_LIMIT, RELAY_VERSION, SPA_SWITCH_WAIT_MS,
  buildVerifyPlan, classifyProblem, clampConcurrency, failDetails, flattenCodingTypes,
  isFreshStatement, pickCompiler, redoModeOf, resumeAction, runPool, slimDraftDetail, verdictOf,
} from '../shared/coding-batch.js';

// 失败明细的实现下沉到 shared/coding-batch（批量流程与客观题汇总共用）；导出位置保持不变
export { failDetails };

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
      content: q.kind === 'CODE_COMPLETION'
        ? '你是严谨的答题助手，只输出一个代码围栏块（``` 包裹的函数实现源码），不要输出任何其他文字。'
        : isCodingKind(q.kind)
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

// 题集 + 考试场次信息（页面侧带登录态 fetch；必须带 accept: application/json 才回 JSON）。
// exam.id 是判分状态接口的钥匙（2026-11-18 实测：首次进场后 /exams 返回 exam 对象）。
export async function fetchExamInfo(psId, stopSignal = null) {
  const res = await fetchBounded(`/api/problem-sets/${psId}/exams`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
  }, 10000, stopSignal);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const list = data?.problemSet?.problemSetConfig?.compilers;
  return {
    compilers: Array.isArray(list) && list.length ? list : null,
    examId: data?.exam?.id ? String(data.exam.id) : '',
  };
}

// 题集语言白名单（面板语言下拉用）；保留原导出，内部复用 fetchExamInfo
export async function fetchAllowedCompilers(psId) {
  return (await fetchExamInfo(psId)).compilers;
}

// 判分状态快照（仅「仅重做错误」模式用）：problem-status 的 id 就是 pspId
// （2026-11-18 实测 7 题 id 与侧栏 7-1…7-7 一一对应）。一次请求拿全题集，避免逐题取。
async function fetchProblemStatusMap(psId) {
  const info = await fetchExamInfo(psId, runAbort?.signal ?? null);
  if (!info.examId) throw new Error('未取到考试场次（可能尚未进入过本场考试）');
  const res = await fetchBounded(
    `/api/exams/${encodeURIComponent(info.examId)}/problem-sets/${encodeURIComponent(psId)}/problem-status?_bps=autoanswer`,
    { headers: { accept: 'application/json' }, credentials: 'include' },
    10000,
    runAbort?.signal ?? null,
  );
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const map = {};
  for (const it of data?.problemStatus || []) {
    if (it && it.id != null) map[String(it.id)] = String(it.problemSubmissionStatus || '');
  }
  return { map, labels: data?.examLabelByProblemSetProblemId || {} };
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

// 编码题题干配图：main 内、答题表单之外的 img，按 DOM 顺序采集并去重。
// 每张图附带「最近一个前置小节标题」作为语境——编程题题面常整段是图片（2026-11-18 实测
// 7-4 矩阵：6 张图分别给出题目描述/输入格式/输出格式），视觉 prompt 需要让模型知道
// 哪张图属于哪个小节，而不是只给一串编号。src 从活 DOM 取（绝对化），克隆节点不连树时
// .src 不解析相对地址。
function codingFigures(mainEl, form) {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_ELEMENT);
  let section = '题目描述';
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (form && form.contains(el)) continue; // 答题表单（编辑器/测试用例）不是题面
    const tag = el.tagName;
    if (tag === 'H1' || tag === 'H2' || tag === 'H3' || tag === 'H4') {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) section = t;
      continue;
    }
    if (tag !== 'IMG' || !el.getAttribute('src')) continue;
    if (el.closest('button')) continue; // 工具栏按钮里的图标不是题面内容
    const src = el.src || el.getAttribute('src');
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, context: section });
  }
  return out;
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
  // 题干图：main 内、答题表单之外的 img（初探 §7.1 同一个数）
  const figures = codingFigures(mainEl, form);
  const imgInfo = { options: {}, stem: figures.map(f => f.src), contexts: figures.map(f => f.context), total: figures.length };
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

// 草稿快照（严格版）：GET 非 2xx / 解析失败时如实报错，而不是当「没有草稿」——
// 批量流程用它决定是否写草稿：快照拿不到就不写，防止 customTestData 被空值覆盖掉
// 用户的自定义测试数据（v0.12.0 口径，见 pickCompiler/saveDraft 的调用方）。
export async function getDraftDetailStrict(pspId) {
  let res;
  try {
    res = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let data = null;
  try { data = await res.json(); } catch (_) { return { ok: false, error: '响应不是合法 JSON' }; }
  return { ok: true, detail: data?.answer?.detail || null };
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

// 无条件删某题的 codingProblem 缓存键（仅限 verify 撤销/提交失败回滚的时机——此时代码已从
// 服务端草稿撤下，本地键不能留着，否则重跑时会把空编辑器/旧代码当成本题答案）。
// 批量流程只在回滚时删键；正常路径的键由 startVerifyPhase/advanceVerify 在跳转前现种（见下）。
function clearCodingProblemCache(id) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    if ('codingProblem_' + id in raw === false) return;
    delete raw['codingProblem_' + id];
    localStorage.setItem('user-cache', JSON.stringify(raw));
  } catch (_) { /* 结构异常静默 */ }
}

// 本地 codingProblem_<id> 缓存里的 program 是否与服务端草稿不一致（= 用户未保存的手敲输入）。
// 批量收题走 SPA 挂载，编辑器水合源在本地键/服务端草稿之间不完全确定，保守起见在写草稿前
// 显式比对一次（旧逐题 relay 的 prepNextProblemCache 同口径：不能替用户丢未保存输入）。
function localInputDiffers(id, rawDetail) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    const entry = raw['codingProblem_' + id];
    const cacheProgram = String(entry?.program ?? '');
    if (!cacheProgram) return false;
    const prog = rawDetail?.programmingSubmissionDetail?.program
      ?? rawDetail?.codeCompletionSubmissionDetail?.program ?? '';
    return cacheProgram !== String(prog ?? '');
  } catch (_) { return false; }
}

// 种入水合键：PTA 编辑器的可靠水合源是 codingProblem_<id> 本地键（2026-10-15 实测种键→reload→
// 回带+按钮解锁；2026-11-17 复测仍成立）。boot 现在虽会 GET exam-draft，但拿到的是陈旧缓存值
// （刚 POST 的新草稿不回带，SPA 挂载同样如此）——本地键是唯一可靠路径，见初探 §10.10。
// 函数题同键同形状（2026-10-28 真机实证）。形状照抄 PTA 自己写的键（program/testData/saveAt，
// saveAt 为 ISO 字符串）。批量流程在跳转前现种（startVerifyPhase/advanceVerify），键只提前一个
// 5s 等待窗口，避免批量种键被 PTA 后续写 user-cache 覆盖。
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

// 水合探测（批量版）：等到编辑器文本以「本题代码」开头才采信（≤20s）。
// 旧的「按钮解锁 = 已水合」会抢跑——按钮解锁只说明草稿态非空，不代表是本题新代码
// （首轮真机 7-2：恢复后 2s 按钮即解锁、内容却是别的代码 → 水合校验失败）；且旧头部校验用
// includes("#include <stdio.h>")，用户旧 C 代码也含这个串，分不清新旧。比对改用规范化前缀：
// CodeMirror 的 textContent 不带换行、只渲染可视区行，规范化（去全部空白）后取模型代码前
// 160 字符做 startsWith，既避开虚拟化截断，也避开「新旧代码同开头」的弱头部误判。
const normCode = s => String(s || '').replace(/\s+/g, '');
const HYDRATION_PREFIX_LEN = 160;

async function waitEditorCode(code) {
  const want = normCode(code).slice(0, HYDRATION_PREFIX_LEN);
  for (let i = 0; i < 200; i++) { // ≤20s
    await sleep(100);
    const cm = editableCm();
    const b = submitButton();
    if (!cm || !b || b.disabled) continue; // 按钮解锁 = 草稿态非空
    if (want && normCode(cm.textContent).startsWith(want)) {
      await sleep(250); // 二次确认防抖动
      const cm2 = editableCm();
      const b2 = submitButton();
      if (cm2 && b2 && !b2.disabled && normCode(cm2.textContent).startsWith(want)) return { ok: true };
    }
  }
  return { ok: false, editorHead: normCode(editableCm()?.textContent).slice(0, 60) };
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
export function backgroundChat(msg, { timeoutMs = LLM_TOTAL_TIMEOUT_MS, signal, onProgress } = {}) {
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
    // 无进度兜底：每收到一条 progress（首块/思考中/流式心跳）就重新计时。
    // 长推理模型可能连续出字数分钟，不能被「首个请求的总时长」误杀；
    // 真正卡住由后台 45s 无数据/无响应头判定，这里只防后台静默失联。
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const err = new Error(`后台转发 ${Math.round(timeoutMs / 1000)}s 无进度`);
        err.kind = 'timeout';
        finish(reject, err);
      }, timeoutMs + 5000);
    };
    armTimer();
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
        armTimer(); // 有进度就续命：长思考/长流式生成不能按首个请求的总时长误杀
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
      await waitOnlineIfOffline(label || '重试'); // 断网期间不空烧重试（首轮真机 7-4：Failed to fetch ×2）
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
  } catch (err) {
    if (runAbort?.signal.aborted) throw err; // 用户中止：不再转 background 再等一轮
    /* 页面层（CORS 等）失败 → background 转取 */
  }
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
// OpenAI 兼容视觉格式：user.content = [{type:'text'},{type:'image_url'}] 交替。
// opts.coding=true 用于编码题：题面可能整段都在图片里（公式/矩阵/输入输出格式），
// 输出约定仍是代码围栏而不是 JSON；imgs.contexts 是收题时记录的各图所属小节标题。
export function assembleImgMessage(userContent, imgs, opts = {}) {
  const coding = opts.coding === true;
  const stem = imgs.stem || [];
  const intro = coding
    ? `${userContent}\n\n（本题含配图：题目描述、输入/输出格式与样例可能全部或部分以图片给出。请先逐张阅读配图（包括其中的公式、矩阵和文字），再结合上面的文字题面完成作答；输出约定与上面的题型说明完全一致，仍只输出一个代码围栏块，不要解释。）`
    : `${userContent}\n\n（本题含配图：题干图在前，选项图随后并标注归属选项。请同时依据图片内容作答，仍只输出一个 JSON，不要解释。）`;
  const parts = [{ type: 'text', text: intro }];
  stem.forEach((url, i) => {
    const ctx = (imgs.contexts || [])[i];
    parts.push({ type: 'text', text: ctx ? `（题干配图 ${i + 1}/${stem.length}，所属小节：${ctx}）` : `（题干配图 ${i + 1}/${stem.length}）` });
    parts.push({ type: 'image_url', image_url: { url } });
  });
  for (const [letter, url] of Object.entries(imgs.options || {})) {
    parts.push({ type: 'text', text: `（选项 ${letter} 的配图）` });
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

// 单题图片下载（输入 collectPage/collectCodingProblem 的 imgInfo；串行取图，题内数量少够用）。
// contexts 原样透传，供 assembleImgMessage 标注每张图所属小节。
async function downloadImgs(imgInfo) {
  const out = { stem: [], options: {}, contexts: imgInfo.contexts || [] };
  for (const src of imgInfo.stem) out.stem.push(await toDataUrl(src));
  for (const [letter, src] of Object.entries(imgInfo.options || {})) out.options[letter] = await toDataUrl(src);
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

/* ---------- 运行编排：编码题（批量作答 v0.12.0） ----------
 * 三段式：SPA 收题（题型页逐题切，1.8s/题）→ 列表页 k 路并发作答（草稿串行队列）→
 * 逐题「种本地键 + 整页 reload」水合提交。2026-11-17 真机实验（初探 §10.10）敲定三条铁律：
 * ① SPA 挂载不回带刚 POST 的草稿（陈旧缓存，stripDraftHttpCache 清不掉）→ 验证必须种本地键 + 整页 reload；
 * ② SPA 卸载会把当前编辑器内容自动写回服务端草稿 → 作答阶段必须停在无编辑器的列表页，
 *    任何草稿 POST 都不能发生在「题目挂载中且随后 SPA 切走」的窗口里；
 * ③ 整页卸载不回写服务端 → verify 页之间的整页导航安全。
 * 旧「每题两文档 relay」退役；续跑单升到 v2，旧 v1 单 boot 时作废。
 * 会话单含运行配置（含 API Key），只在当前标签页存活期内有效，关标签即清。
 */

const RELAY_KEY = '__BPS_AA_PROG_RELAY__';
function readRelay() {
  try { return JSON.parse(sessionStorage.getItem(RELAY_KEY)) || null; } catch (_) { return null; }
}
function writeRelay(r) {
  try {
    const json = JSON.stringify(r);
    if (json.length > RELAY_SIZE_LIMIT) {
      fire({ kind: 'log', level: 'err', text: '续跑单体积超出上限（题面/代码过大），批量作答中止；不会静默截断题面' });
      return false;
    }
    sessionStorage.setItem(RELAY_KEY, json);
    return true;
  } catch (_) { return false; }
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
const NAVIGATE_HIDDEN_WAIT_MS = 30000; // 后台标签页下导航观察的加长间隔（定时/导航都会被浏览器拉长）

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
  let retried = false;
  let hiddenWaits = 0;
  const check = delay => setTimeout(() => {
    if (location.pathname + location.search !== from) return; // 已经离开，定时器随旧文档销毁
    // 后台标签页 / 断网：定时与导航都会被拉长（首轮真机：5s 等待拖到 ~1 分钟、watchdog 晚 39s、
    // 断网期间导航挂起被误判「未生效」重发导致重复装载）。先多等观察，不立即重发导航。
    if ((document.hidden || navigator.onLine === false) && hiddenWaits < 4) {
      hiddenWaits += 1;
      const why = navigator.onLine === false ? '当前离线' : '标签页在后台';
      fire({ kind: 'log', level: 'warn', text: `${what}：${why}，导航可能被拉长；再等 30s 观察（${hiddenWaits}/4），不立即重发导航` });
      check(NAVIGATE_HIDDEN_WAIT_MS);
      return;
    }
    if (!retried) {
      retried = true;
      fire({ kind: 'log', level: 'warn', text: `${what}未生效（页面没有跳转），重试一次…` });
      go();
      check(NAVIGATE_CHECK_MS);
      return;
    }
    abortRelay(r, `${what}被拦下：页面始终没有跳转（浏览器离开确认或扩展拦截），请处理后重新开始，已完成的题目不会重做`);
  }, delay);
  go();
  check(NAVIGATE_CHECK_MS);
}

// 每次切题/重载前固定等 5s：随机 1–5s 实测仍会触发限流（用户真机反馈），
// 不再按文档存活时长补足，也不加抖动
async function pacePageLoad(where) {
  fire({ kind: 'log', level: 'info', text: `${where}：等待 ${PAGE_LOAD_WAIT_MS / 1000}s 再切换（避免 PTA 访问频率限制）…` });
  await sleep(PAGE_LOAD_WAIT_MS);
  await waitOnlineIfOffline(where);
}

// 断网守候：离线状态下发导航会挂在 TCP 超时上（老文档存活、watchdog 误判「未生效」重发、
// 网络恢复后重复装载——首轮真机 00:35–00:38 的空白即此）。切题前先等网络恢复。
const OFFLINE_WAIT_MS = 120000;
async function waitOnlineIfOffline(where) {
  if (navigator.onLine !== false) return;
  fire({ kind: 'log', level: 'warn', text: `${where}：当前离线，等待网络恢复后再切换（最多等 ${Math.round(OFFLINE_WAIT_MS / 1000)}s）…` });
  for (let i = 0; i < OFFLINE_WAIT_MS / 1000; i++) {
    await sleep(1000);
    if (navigator.onLine !== false) { fire({ kind: 'log', level: 'ok', text: '网络已恢复，继续' }); return; }
  }
  fire({ kind: 'log', level: 'warn', text: '等待超时仍离线，照常尝试切换（失败由看门狗/限流口径兜底）' });
}

// 返回 true 表示已接管（暂停或中止），调用方不要再推进批量流程。
// 冷却后的重载目标按 phase 决定：collect 回到当前待收题、verify 回到当前待提交题
// （都是整页导航，boot 后 resumeRelay 按 phase/ci/vi 恢复）；answer 停在列表页原地重载。
function pauseBatchForRateLimit(r, where) {
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
  batchPaused = true;
  running = false;
  runAbort = null;
  fire({ kind: 'log', level: 'warn', text: `PTA 限流（${where}）：等待 ${Math.round(wait / 1000)}s 后重载（第 ${tries + 1}/${RATE_LIMIT_WAITS_MS.length} 次）…` });
  let target = location.href;
  if (r.phase === 'collect') {
    const p = r.problems[r.ci];
    if (p) target = `/problem-sets/${r.psId}/exam/problems/type/${p.typeId}?problemSetProblemId=${p.id}`;
  } else if (r.phase === 'verify') {
    const p = r.problems.find(x => x.id === (r.verifyIds || [])[r.vi]);
    if (p) target = `/problem-sets/${r.psId}/exam/problems/type/${p.typeId}?problemSetProblemId=${p.id}`;
  }
  setTimeout(() => navigateRelay(target, r, '限流冷却后重载'), wait);
  return true;
}

/* ---------- 批量·收题（SPA 逐题切，1.8s/题） ---------- */

// 点侧栏「题目总览」的题型链接回到该题型列表页（无编辑器）。收题/收尾阶段在这里卸载编辑器
// 是安全的：此时尚未写任何新草稿，SPA 卸载回写只会覆盖用户的旧内容（初探 §10.10 铁律②）。
async function openTypeList(psId, typeId) {
  const target = `/problem-sets/${psId}/exam/problems/type/${typeId}`;
  if (!(location.pathname === target && !location.search.includes('problemSetProblemId'))) {
    const link = [...document.querySelectorAll('a[href]')].find(a => (a.getAttribute('href') || '') === target);
    if (!link) return false;
    link.click();
  }
  for (let i = 0; i < 60; i++) { // ≤6s：等 SPA 渲染出该题型的题目锚点
    await sleep(100);
    if (location.pathname === target && !location.search.includes('problemSetProblemId')
      && programmingIds(psId, typeId).length > 0) return true;
  }
  return false;
}

function clickProblemAnchor(id) {
  const a = [...document.querySelectorAll('a[href]')]
    .find(x => (x.getAttribute('href') || '').endsWith(`problemSetProblemId=${id}`));
  if (!a) return false;
  a.click();
  return true;
}

// 题面就绪特征：常规小节标题，或题干配图（纯图片题可能只有「输入格式/输出格式」标题，
// 2026-11-18 实测 7-4 矩阵：正文 6 张图 + 标题文本）。两次读数一致防半渲染。
const STATEMENT_READY_RE = /(输入格式|输出格式|输入样例|输出样例|函数接口定义|裁判测试程序|Format|Input|Output|Sample)/i;

// main 内、答题表单之外的题干图（与 collectCodingProblem 同口径，只用于就绪判定）
function hasStatementImg(mainEl, form) {
  return !!(mainEl && [...mainEl.querySelectorAll('img')].some(i => (!form || !form.contains(i)) && i.getAttribute('src')));
}

// SPA 切题就绪判定：URL 命中 + 答题表单挂载 + 编辑器/按钮读数稳定（沿用 settleEditorState 口径）
// + 题干文本稳定且含小节特征/题干图——防把渲染到一半的题面当完整题干（答错题比漏答严重）。
async function settleProblemReady(id) {
  let mounted = false;
  for (let i = 0; i < 50; i++) { // ≤5s：路由先变、内容后到
    await sleep(100);
    if (location.search.includes(`problemSetProblemId=${id}`) && answerFormEl()) { mounted = true; break; }
  }
  if (!mounted) return false;
  if (!(await settleEditorState())) return false;
  const mainEl = document.querySelector('main');
  let prev = null;
  for (let i = 0; i < 30; i++) { // ≤3s：题干两次读数一致才采信
    await sleep(100);
    const text = mainEl ? (mainEl.innerText || '') : '';
    const ready = !!text && text === prev
      && (STATEMENT_READY_RE.test(text) || (text.length >= 20 && hasStatementImg(mainEl, answerFormEl())));
    if (ready) return true;
    prev = text;
  }
  return false;
}

// SPA 切到题目并等待就绪；已在目标题上（限流冷却/刷新恢复）就不再点锚点。一次未生效重试一次。
async function switchToProblem(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(300);
    if (!location.search.includes(`problemSetProblemId=${id}`) && !clickProblemAnchor(id)) return false;
    if (await settleProblemReady(id)) return true;
  }
  return false;
}

async function paceSpaSwitch(where) {
  fire({ kind: 'log', level: 'info', text: `${where}：等待 ${SPA_SWITCH_WAIT_MS / 1000}s 再切下一题（SPA 切题每次 4 个 API，节奏留余量）…` });
  await sleep(SPA_SWITCH_WAIT_MS);
}

// 批量入口：放下 v2 续跑单，然后在本文档内跑完「收题 → 并发作答」，最后跳去第一张 verify 页。
// handleRun 必须 await 本函数：并发 LLM 的中止信号挂在本次运行的 runAbort 上。
async function startCodingBatch(psId, progTypes, cfg) {
  const problems = flattenCodingTypes(progTypes);
  if (!problems.length) throw new Error('「编码题」找不到题目锚点（题目总览收起？点开后重试）');
  // 「仅重做错误」需要服务端判分状态：一次 problem-status 请求拿全题集。
  // 取不到就退化为保守口径（已答跳过、未答照常答），绝不因数据缺失批量覆盖已答题。
  let statusMap = null;
  let statusLabels = null;
  if (redoModeOf(cfg) === 'wrong') {
    fire({ kind: 'log', level: 'info', text: '读取判分状态…（仅重做错误需要，一次请求拿全题集）' });
    try {
      const snap = await fetchProblemStatusMap(psId);
      statusMap = snap.map;
      statusLabels = snap.labels;
      const counts = { accepted: 0, wrong: 0, pending: 0, none: 0, unknown: 0 };
      for (const p of problems) counts[verdictOf(statusMap[p.id])] += 1;
      fire({ kind: 'log', level: 'info', text: `判分状态：通过 ${counts.accepted} · 未通过 ${counts.wrong} · 待判 ${counts.pending} · 未提交 ${counts.none}${counts.unknown ? ` · 未知 ${counts.unknown}` : ''}` });
    } catch (err) {
      if (runAbort?.signal.aborted) throw abortedError();
      statusMap = {};
      fire({ kind: 'log', level: 'warn', text: `判分状态读取失败（${err?.message || err}），已答题按跳过处理；未答题照常作答` });
    }
  }
  const relay = {
    v: RELAY_VERSION,
    cfg: { ...cfg },
    psId,
    statusMap,
    statusLabels,
    problems: problems.map(p => ({ ...p, status: undefined })),
    ci: 0,
    phase: 'collect',
    verifyIds: [],
    vi: 0,
    summary: { applied: 0, skippedAnswered: 0, skippedImage: 0, redoWrong: 0, failed: [] },
    rlTries: 0,
  };
  if (!writeRelay(relay)) throw new Error('sessionStorage 不可写或续跑单超限，无法批量作答编码题');
  const names = [...new Set(progTypes.map(t => t.typeName))].join('、');
  fire({ kind: 'log', level: 'info', text: `${names || '编码题'} ${problems.length} 题：批量模式（收题 → 并发作答 → 逐题提交，日志跨页保留）` });
  if (document.hidden) {
    fire({ kind: 'log', level: 'warn', text: '标签页在后台运行：浏览器的定时/导航节流会拉长等待，建议保持本标签页在前台' });
  }
  suppressLeaveConfirm(); // 收题期间的 SPA 切换也要压住离开确认（本页可能还有未保存的客观题答案）
  batchPaused = false;
  batchAborted = false;
  batchFatal = null;
  batchPrevText = ''; // 新一轮从空比对基准开始（沿用上一轮的文本会误判「与上一题相同」）
  await runCollectPhase(relay);
  // runCollectPhase 返回时：要么已跳去 verify（续跑单 phase=verify，文档即将卸载），要么
  // 在本文档内结束/中止/失败/限流挂起——结果事件都由引擎自己发过，这里只交回结果标志。
  const rr = readRelay();
  return {
    handedOff: !!(rr && rr.phase === 'verify'),
    paused: batchPaused,
    aborted: batchAborted,
    error: batchFatal,
  };
}

// 上一题的题干文本（收题新鲜度比对用）；跨页恢复后为空（URL id 校验兜底）
let batchPrevText = '';
// 批量结果标志（handleRun 据此决定是否重复发结果事件 / 是否恢复离开确认）：
// 引擎自己会发终止/结束事件，handleRun 只补「跨页推进」的坐标行。
let batchPaused = false;   // 限流冷却挂起：稍后由 setTimeout 导航恢复
let batchAborted = false;  // 用户中止（stopBatchByUser）
let batchFatal = null;     // 致命错误原因（abortRelay）

// 收题阶段：SPA 逐题切 → 收题面/语言/已答态 → 分类入单。任何草稿 POST 都不发生在这里。
async function runCollectPhase(r) {
  try {
    while (r.ci < r.problems.length) {
      if (userStopped(r)) { stopBatchByUser(r); return; }
      const p = r.problems[r.ci];
      if (rateLimitedNow()) { pauseBatchForRateLimit(r, '收题'); return; }
      await waitOnlineIfOffline('收题'); // 离线时 SPA 切题会失败，先等网络恢复
      // 不在目标题上：先回该题型列表页（限流页可能顶掉了列表页，识别先于报错）
      if (!location.search.includes(`problemSetProblemId=${p.id}`)) {
        const okList = await openTypeList(r.psId, p.typeId);
        if (!okList) {
          if (rateLimitedNow()) { pauseBatchForRateLimit(r, '收题'); return; }
          relayRecordFail(r, p, null, `回不到「${p.typeName}」列表页（题目总览收起或页面异常）`);
          r.ci += 1;
          continue;
        }
        await paceSpaSwitch('切换题型');
      }
      const switched = await switchToProblem(p.id);
      const q = switched ? collectCodingProblem() : null;
      const fresh = q ? isFreshStatement(batchPrevText, q, p.id) : { ok: false, reason: '页面未就绪' };
      if (!switched || !q || !fresh.ok) {
        if (rateLimitedNow()) { pauseBatchForRateLimit(r, '收题'); return; }
        relayRecordFail(r, p, null, `收题失败：${q ? fresh.reason : '页面未就绪（切题未生效或编辑器未挂载）'}`);
        r.ci += 1;
        continue;
      }
      // 仅重做错误：把服务端判分状态挂到 q 上供纯函数 classifyProblem 使用；
      // 旧续跑单没有 statusMap 时 verdict 为 unknown，classify 自动回退保守口径。
      if (r.statusMap) q.verdict = verdictOf(r.statusMap[q.id]);
      const cls = classifyProblem(q, r.cfg);
      Object.assign(p, {
        label: q.label || (r.statusLabels && r.statusLabels[p.id]) || p.id.slice(-4),
        kind: q.kind,
        text: q.text,
        langLabel: q.langLabel,
        hasImg: q.hasImg,
        imgInfo: q.hasImg ? q.imgInfo : null, // 只存地址与所属小节，data URL 到作答页现取
        status: cls.status,
        redoReason: cls.reason || null, // wrong/unsubmitted 用于作答阶段的覆盖保护放行
      });
      if (cls.status === 'skipped') {
        r.summary.skippedAnswered += 1;
        const why = cls.reason === 'accepted' ? '跳过，判分正确'
          : cls.reason === 'judging' ? '跳过，评测中/待判分'
            : cls.reason === 'unknown' ? '跳过，判分状态未知（按已答处理）'
              : '跳过，已作答';
        fire({ kind: 'log', level: 'info', text: `${p.label}：${why}` });
      } else if (cls.status === 'skippedImage') {
        r.summary.skippedImage = (r.summary.skippedImage || 0) + 1;
        const why = cls.reason === 'wrong-image' || cls.reason === 'unsubmitted-image'
          ? '跳过，判分未通过但题干含图片（未开「作答含图题」）'
          : '跳过，题干含图片（未开「作答含图题」）';
        fire({ kind: 'log', level: 'warn', text: `${p.label}：${why}` });
      } else {
        if (cls.reason === 'wrong') {
          r.summary.redoWrong = (r.summary.redoWrong || 0) + 1;
          fire({ kind: 'log', level: 'info', text: `${p.label}：判分未通过，重做` });
        } else if (cls.reason === 'unsubmitted') {
          r.summary.redoWrong = (r.summary.redoWrong || 0) + 1;
          fire({ kind: 'log', level: 'info', text: `${p.label}：草稿未提交，重做` });
        }
        fire({ kind: 'log', level: 'info', text: `收题 ${r.ci + 1}/${r.problems.length}：${p.label}（${p.typeName}）` });
        if (q.hasImg) fire({ kind: 'log', level: 'info', text: `${p.label}：题干含 ${q.imgInfo.total} 张图片，作答时随题面交给视觉模型` });
      }
      batchPrevText = q.text;
      r.ci += 1;
      if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
      if (r.ci < r.problems.length) await paceSpaSwitch('收题');
    }
    // 收题完成 → 回列表页卸载编辑器（此处还没写过任何新草稿，SPA 卸载回写无害）
    const lastType = r.problems[r.problems.length - 1].typeId;
    if (!(await openTypeList(r.psId, lastType))) {
      if (rateLimitedNow()) { pauseBatchForRateLimit(r, '收题收尾'); return; }
      abortRelay(r, '收题后回不到题目列表页（SPA 未响应），请重试');
      return;
    }
    r.phase = 'answer';
    if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
    await runAnswerPhase(r);
  } catch (err) {
    abortRelay(r, err?.message || String(err));
  }
}

// 同文档恢复锁：同一文档的第二个内容脚本实例（扩展重注入/重复装载）不得再跑一次恢复，
// 否则两份 verifyCurrent 会并发推进同一续跑单。锁按 performance.timeOrigin 绑定文档——
// 合法的整页刷新是新文档（timeOrigin 变了），锁自动失效。
function acquireResumeLock() {
  try {
    const raw = JSON.parse(sessionStorage.getItem('__BPS_AA_RESUME_LOCK__') || 'null');
    if (raw && raw.timeOrigin === performance.timeOrigin && Date.now() - raw.at < 8000) return false;
    sessionStorage.setItem('__BPS_AA_RESUME_LOCK__', JSON.stringify({ at: Date.now(), timeOrigin: performance.timeOrigin }));
    return true;
  } catch (_) { return true; }
}

// boot 后由 init 调用：存在批量续跑单就按阶段恢复（总开关仍要开着）。
// 限流页可能被 PTA 换成别的地址/错误页：先识别再校验 URL，避免把限流误判成「用户导航走了」而弃单。
export async function resumeRelay(settings) {
  const r = readRelay();
  if (!r) return;
  if (!acquireResumeLock()) return; // 同文档第二实例：前一实例已在推进，不能双份推进续跑单
  if (r.v !== RELAY_VERSION) { // v1 旧单（每题两文档 relay）：协议已退役，就地作废
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '检测到旧版编码题续跑单（v1），已作废；请重新开始答题' });
    return;
  }
  if (!(settings && settings.autoAnswer)) {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题批量作答取消：总开关未开启' });
    return;
  }
  if (r.aborted) { // 上一页已按用户要求中止（中止写入续跑单后才翻页的残单）：就地作废
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题批量作答已中止（按你的要求停止）' });
    fire({ kind: 'state', running: false, error: '已中止' });
    return;
  }
  if (rateLimitedNow()) { pauseBatchForRateLimit(r, '页面加载'); return; }
  const act = resumeAction(r, { pathname: location.pathname, search: location.search });
  if (act.action === 'clear') {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编码题批量作答取消：' + act.reason });
    return;
  }
  running = true;
  runAbort = new AbortController(); // 每张恢复页都挂终止信号，面板的中止按钮每页都有效
  suppressLeaveConfirm();
  fire({ kind: 'state', running: true });
  // 每页的进页日志：跨页日志已持久化（见 readPersistedLog），这里只立坐标；
  // 历史日志丢了（用户手动清空）才回放失败清单兜底
  const hadHistory = readPersistedLog().length > 0;
  const phaseText = { collect: '收题', answer: '并发作答', verify: '水合提交' }[r.phase] || r.phase;
  fire({ kind: 'log', level: 'info', text: `编码题批量作答恢复（${phaseText}阶段）` });
  if (document.hidden) {
    // 首轮真机实测：后台标签页的定时器/导航会被浏览器拉长（5s 等待拖到 ~1 分钟、watchdog 晚 39s），
    // 引擎仍能走完但节奏失控，提示用户把标签页放前台
    fire({ kind: 'log', level: 'warn', text: '标签页在后台运行：浏览器的定时/导航节流会拉长等待，建议保持本标签页在前台' });
  }
  if (r.summary.failed.length && !hadHistory) {
    fire({ kind: 'log', level: 'warn', text: `此前已失败 ${r.summary.failed.length} 题：\n${failDetails(r.summary.failed)}` });
  }
  try {
    if (act.action === 'collect') {
      await runCollectPhase(r); // 可能正停在待收题的题目页（限流冷却/刷新恢复），runCollectPhase 内部处理
    } else if (act.action === 'answer') {
      await runAnswerPhase(r);
    } else if (act.action === 'verify') {
      await verifyCurrent(r);
    } else if (act.action === 'seedVerify') { // 刷新停在列表页：种当前待提交题的键再跳过去
      if (seedVerifyProblem(r) && writeRelay(r)) {
        running = false;
        await pacePageLoad('恢复待提交题');
        if (userStopped(r)) { stopBatchByUser(r); return; }
        navigateRelay(verifyUrl(r, r.verifyIds[r.vi]), r, '恢复待提交题');
      }
    } else if (act.action === 'verifyJump') { // 重复装载落在 verify 清单的其他题页：种当前题的键跳回去（自愈，不弃单）
      fire({ kind: 'log', level: 'info', text: '本页是待提交清单里的其他题（重复装载），种当前题的键跳回去继续' });
      if (seedVerifyProblem(r) && writeRelay(r)) {
        running = false;
        await pacePageLoad('回到待提交题');
        if (userStopped(r)) { stopBatchByUser(r); return; }
        navigateRelay(verifyUrl(r, r.verifyIds[r.vi]), r, '回到待提交题');
      }
    }
  } catch (err) {
    abortRelay(r, err?.message || String(err));
  }
}

export function relaySummaryLine(r) {
  const s = r.summary;
  const skippedImg = Number(s.skippedImage) || 0;
  const redoWrong = Number(s.redoWrong) || 0;
  const line = `作答 ${s.applied} · 跳过已答 ${s.skippedAnswered}${redoWrong ? ` · 重做错题 ${redoWrong}` : ''}${skippedImg ? ` · 跳过含图 ${skippedImg}` : ''} · 失败 ${s.failed.length}${r.cfg.drySave ? '（dry，未提交）' : ''}`;
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
  batchFatal = reason;
  clearRelay();
  fire({ kind: 'log', level: 'err', text: '编码题批量作答中止：' + reason });
  fire({ kind: 'log', level: 'info', text: relaySummaryLine(r) });
  fire({ kind: 'state', running: false, error: reason });
  running = false;
  runAbort = null;
  restoreLeaveConfirm();
}

/* ---------- 批量·作答（列表页，k 路并发 + 草稿串行队列） ---------- */

// 草稿写入必须串行：pacedDraftPost 的 2.2s 间距靠模块级时间戳，并发调用会同时穿透。
// 队列保证同一时刻只有一个 POST 在飞（重试也整段排队），完成后 Tail 前移。
let draftTail = Promise.resolve();
function saveDraftQueued(pspId, kind, detail, compilerId, program) {
  const run = draftTail.then(
    () => saveDraft(pspId, kind, detail, compilerId, program),
    () => saveDraft(pspId, kind, detail, compilerId, program),
  );
  draftTail = run.then(() => undefined, () => undefined);
  return run;
}

// 作答阶段：停在没有编辑器的列表页，k 路并发请求模型，草稿写入走串行队列。
// 此处绝不发生页面导航——SPA 卸载会把编辑器内容回写服务端草稿（初探 §10.10 铁律②）。
async function runAnswerPhase(r) {
  try {
    // pending 之外还要捡回 'answering'：上一文档刷新/崩溃时在途请求随文档销毁，
    // 这些题既不是 answered 也不是 failed，不重跑就会被静默丢掉
    const pending = r.problems.filter(p => p.status === 'pending' || p.status === 'answering');
    for (const p of pending) p.status = 'pending';
    if (!pending.length) { await startVerifyPhase(r); return; }
    const k = clampConcurrency(r.cfg.concurrency, pending.length);
    fire({ kind: 'log', level: 'info', text: `并发作答 ${pending.length} 题（${k} 路同时请求，${r.cfg.model || '未知模型'}）` });
    await runPool(pending, k, async p => {
      if (userStopped(r)) return;
      p.status = 'answering';
      fire({ kind: 'log', level: 'info', text: `${p.label}：请求模型中…（${r.cfg.model || '未知模型'}）` }); // await 期间的事件流在场日志
      // 严格读草稿快照：拿不到就不写草稿，防止 customTestData 被空值覆盖
      const snap = await getDraftDetailStrict(p.id);
      if (!snap.ok) {
        relayRecordFail(r, p, p.label, `草稿快照读取失败（${snap.error}），为保护自定义测试数据不写入`);
        p.status = 'failed';
        return;
      }
      p.detail = slimDraftDetail(snap.detail, p.id);
      // 用户未保存输入保护：本地键与草稿不一致（瘦身前用原始快照比对），未获准覆盖就保守跳过。
      // 「全部重做」与「仅重做错误」中判分未通过/草稿未提交的题属于用户明确要重做的对象，放行覆盖。
      const redoMode = redoModeOf(r.cfg);
      const allowOverwrite = redoMode === 'all'
        || (redoMode === 'wrong' && (p.redoReason === 'wrong' || p.redoReason === 'unsubmitted'));
      const localDiffers = localInputDiffers(p.id, snap.detail);
      if (!allowOverwrite && localDiffers) {
        r.summary.skippedAnswered += 1;
        p.status = 'skipped';
        fire({ kind: 'log', level: 'warn', text: `${p.label}：本地存在未保存的手敲代码（与服务端草稿不一致），已保守跳过不覆盖` });
        return;
      }
      if (redoMode === 'wrong' && localDiffers) {
        fire({ kind: 'log', level: 'info', text: `${p.label}：本地有未保存改动，但本题${p.redoReason === 'wrong' ? '判分未通过' : '草稿未提交'}，按「仅重做错误」覆盖` });
      }
      const picked = pickCompiler(p, p.detail, r.cfg, {
        labelFor: id => COMPILER_LABELS[id] || '',
        compilerIdFromLabel,
      });
      if (!picked.ok) {
        relayRecordFail(r, p, p.label, picked.reason);
        p.status = 'failed';
        return;
      }
      p.compilerId = picked.compilerId;
      p.wantLangLabel = picked.wantLangLabel;
      const basePrompt = buildPrompt({ ...p, langLabel: p.wantLangLabel || p.langLabel || '' });
      let messages = basePrompt;
      if (p.hasImg) {
        // 开关关着就不作答（含图题按文字题面写代码只会产出与题意无关的代码并真实提交）；
        // 正常路径在收题时已判 skippedImage，这里兜住旧版续跑单/配置漂移。
        if (!r.cfg.images) {
          r.summary.skippedImage = (r.summary.skippedImage || 0) + 1;
          p.status = 'skipped';
          fire({ kind: 'log', level: 'warn', text: `${p.label}：跳过，题干含图片（未开「作答含图题」）` });
          return;
        }
        // 编码题的视觉链路：收题阶段只存图片地址（续跑单不塞 data URL），到没有编辑器、
        // 可安全并发的列表页再取图。取图失败按单题失败处理，不拖垮其余题。
        if (!p.imgInfo || !Array.isArray(p.imgInfo.stem) || !p.imgInfo.stem.length) {
          relayRecordFail(r, p, p.label, '含图题缺少图片地址（旧版续跑单），请重新开始答题');
          p.status = 'failed';
          return;
        }
        let images = null;
        try {
          images = await downloadImgs(p.imgInfo);
        } catch (err) {
          if (userStopped(r)) return;
          relayRecordFail(r, p, p.label, '含图题图片加载失败：' + (err?.message || err));
          p.status = 'failed';
          return;
        }
        fire({ kind: 'log', level: 'info', text: `${p.label}：已取 ${images.stem.length} 张题干图，随题面交给视觉模型` });
        messages = [
          { role: 'system', content: basePrompt[0].content },
          { role: 'user', content: assembleImgMessage(basePrompt[1].content, images, { coding: true }) },
        ];
      }
      let raw = null;
      try {
        raw = globalThis.__BPS_LLM_MOCK__
          ? await globalThis.__BPS_LLM_MOCK__(messages)
          : await chatWithRetry(r.cfg, messages, { label: p.label });
      } catch (err) {
        if (userStopped(r)) return; // 中止来的失败不算题目的失败，别记假账
        relayRecordFail(r, p, p.label, 'LLM 调用失败：' + (err?.message || err));
        p.status = 'failed';
        return;
      }
      const code = parseCodeAnswer(raw);
      if (!code) {
        relayRecordFail(r, p, p.label, 'LLM 输出解析不出代码：' + String(raw).slice(0, 60));
        p.status = 'failed';
        return;
      }
      if (code.length > 16384) {
        relayRecordFail(r, p, p.label, `代码超长（${code.length} 字符，平台限 16KB）`);
        p.status = 'failed';
        return;
      }
      const written = await saveDraftQueued(p.id, p.kind, p.detail, p.compilerId, code);
      if (!written.ok) {
        relayRecordFail(r, p, p.label, `草稿写入失败（HTTP ${written.status ?? '未知'}${written.err ? '：' + written.err : ''}）`);
        p.status = 'failed';
        return;
      }
      stripDraftHttpCache(p.id);
      p.code = code;
      p.status = 'answered';
      fire({ kind: 'log', level: 'ok', text: `${p.label}：草稿已写入（${code.length} 字符），待逐题水合提交` });
    }, () => userStopped(r));
    if (userStopped(r)) { stopBatchByUser(r); return; }
    if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
    await startVerifyPhase(r);
  } catch (err) {
    abortRelay(r, err?.message || String(err));
  }
}

/* ---------- 批量·提交（种本地键 + 整页 reload，逐题推进） ---------- */

function verifyUrl(r, id) {
  const p = r.problems.find(x => x.id === id);
  return p
    ? `/problem-sets/${r.psId}/exam/problems/type/${p.typeId}?problemSetProblemId=${p.id}`
    : location.href;
}

// 种当前待提交题的水合键；种子失败记失败跳下一题，全部失败就地收尾。
// 返回 false 表示已收尾/无可提交题，调用方不要再导航。
function seedVerifyProblem(r) {
  for (;;) {
    const id = (r.verifyIds || [])[r.vi];
    if (!id) { finishBatch(r); return false; }
    const p = r.problems.find(x => x.id === id);
    const seeded = seedCodingProblemCache(id, p.code, p.detail);
    if (seeded.seeded) return true;
    relayRecordFail(r, p, p.label, '水合键写入失败' + (seeded.err ? '：' + seeded.err : ''));
    p.status = 'failed';
    r.vi += 1;
  }
}

// 进入提交阶段：先种第一题的键，再整页跳过去（水合是 PTA 自己 boot 干的，键必须先于页面存在）
async function startVerifyPhase(r) {
  r.verifyIds = buildVerifyPlan(r.problems);
  r.vi = 0;
  if (!r.verifyIds.length) { finishBatch(r); return; }
  r.phase = 'verify';
  fire({ kind: 'log', level: 'info', text: `作答完成：${r.verifyIds.length} 题待提交（逐题种键 + 整页水合）` });
  if (!seedVerifyProblem(r)) return;
  if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
  running = false; // 文档即将卸载，复位标记避免残留运行态
  await pacePageLoad('切到第一道待提交题');
  if (userStopped(r)) { stopBatchByUser(r); return; }
  navigateRelay(verifyUrl(r, r.verifyIds[r.vi]), r, '进入第一道待提交题');
}

// 推进：记账 + 进度 + 中止检查 + 种下一题的键（就在当前页种，只提前一个 5s 等待窗口）+ 整页跳转
async function advanceVerify(r) {
  r.rlTries = 0; // 能走到推进 = 不是限流页：下次限流重新从 60s 冷却开始
  fire({ kind: 'progress', done: r.vi + 1, total: r.verifyIds.length });
  if (userStopped(r)) { stopBatchByUser(r); return; }
  r.vi += 1;
  if (r.vi >= r.verifyIds.length) { finishBatch(r); return; }
  if (!seedVerifyProblem(r)) return;
  if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
  running = false;
  await pacePageLoad('切到下一道待提交题');
  if (userStopped(r)) { stopBatchByUser(r); return; }
  navigateRelay(verifyUrl(r, r.verifyIds[r.vi]), r, '切到下一道待提交题');
}

function finishBatch(r) {
  const line = relaySummaryLine(r);
  try { sessionStorage.setItem('__BPS_AA_SUMMARY_DONE__', JSON.stringify({ ok: !r.summary.failed.length, line, failed: r.summary.failed })); } catch (_) {}
  clearRelay();
  running = false;
  runAbort = null;
  restoreLeaveConfirm();
  const lvl = r.summary.failed.length ? 'warn' : 'ok';
  fire({ kind: 'log', level: lvl, text: '编码题批量作答结束：' + line });
  fire({ kind: 'state', running: false });
}

// 用户中止：就地收摊；已写入的草稿/已提交的题目保持各自状态
function stopBatchByUser(r) {
  batchAborted = true;
  clearRelay();
  running = false;
  runAbort = null;
  restoreLeaveConfirm();
  fire({ kind: 'log', level: 'warn', text: '已中止：编码题批量作答按你的要求停止' });
  fire({ kind: 'log', level: 'info', text: relaySummaryLine(r) });
  fire({ kind: 'state', running: false, error: '已中止' });
}

// verify 页：水合探测 → 语言守护（仅编程题） → dry 撤销 / 点「提交本题作答」→ 种下一题的键并整页跳转。
// 键由上一张页面种好（只提前一个 5s 等待窗口），本页 boot 直接回带代码、按钮解锁。
async function verifyCurrent(r) {
  const id = (r.verifyIds || [])[r.vi];
  const p = r.problems.find(x => x.id === id);
  if (!p || !p.code) { abortRelay(r, 'verify 阶段找不到待提交题（续跑单状态错乱）'); return; }
  if (p.status === 'submitted') { // 重复装载（导航重发/扩展重注入落回旧题页）：该题已提交，直接推进
    fire({ kind: 'log', level: 'info', text: `${p.label}：本页重复装载，该题已提交过，直接推进下一题` });
    return advanceVerify(r);
  }
  if (rateLimitedNow()) { pauseBatchForRateLimit(r, '水合校验'); return; }
  const hyd = await waitEditorCode(p.code);
  if (!hyd.ok) {
    if (rateLimitedNow()) { pauseBatchForRateLimit(r, '水合校验'); return; }
    const rollback = await saveDraftQueued(p.id, p.kind, p.detail, p.compilerId, '');
    stripDraftHttpCache(p.id);
    clearCodingProblemCache(p.id);
    relayRecordFail(r, p, p.label, `水合校验失败（编辑器未回带本题代码${hyd.editorHead ? `，实际开头「${hyd.editorHead}」` : ''}）` + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对'));
    if (!rollback.ok) { abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试'); return; }
    p.status = 'failed';
    return advanceVerify(r);
  }
  const head = normCode(p.code).slice(0, 24);
  r.rlTries = 0; // 水合通过 = 真实题目页，限流冷却计数清零

  // 语言一致性守卫（仅编程题）：实挂语言 != 代码语言时不提交（提交载荷的 compiler 由页面
  // 默认链决定，可能不理会草稿 compiler——不能拿错配代码冒险）。函数题的编译器由题目固定、
  // 草稿不带 compiler 字段，不存在错配，直接跳过。
  if (p.kind !== 'CODE_COMPLETION') {
    const mountedLabel = langLabelOf();
    if (mountedLabel !== p.wantLangLabel) {
      const rollback = await saveDraftQueued(p.id, p.kind, p.detail, p.compilerId, '');
      stripDraftHttpCache(p.id);
      clearCodingProblemCache(p.id);
      relayRecordFail(r, p, p.label, `语言不一致（草稿 ${p.wantLangLabel}，实挂「${mountedLabel || '未知'}」），已弃答防错配` + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对'));
      if (!rollback.ok) { abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试'); return; }
      p.status = 'failed';
      return advanceVerify(r);
    }
  }

  if (r.cfg.drySave) {
    const rollback = await saveDraftQueued(p.id, p.kind, p.detail, p.compilerId, '');
    stripDraftHttpCache(p.id);
    clearCodingProblemCache(p.id);
    if (!rollback.ok) { abortRelay(r, 'dry：水合校验通过后撤销草稿失败，残留需人工核对'); return; }
    p.status = 'submitted'; // dry 也算走完流程（汇总仍标注未提交）
    r.summary.applied += 1;
    fire({ kind: 'log', level: 'ok', text: `${p.label} → ${head}…（dry：草稿水合校验通过后已撤销，未提交）` });
    return advanceVerify(r);
  }

  // 中止检查必须卡在真实评测提交之前：提交即写提交记录，不能替用户「再补一枪」
  if (userStopped(r)) { stopBatchByUser(r); return; }
  const saved = await submitProgramming();
  if (!saved.saved || rateLimitedNow()) {
    // 限流页可能替换在提交之后：不记账、不回滚草稿，冷却后重载本题再试
    if (rateLimitedNow()) { pauseBatchForRateLimit(r, '提交评测'); return; }
    const rollback = await saveDraftQueued(p.id, p.kind, p.detail, p.compilerId, '');
    stripDraftHttpCache(p.id);
    clearCodingProblemCache(p.id);
    relayRecordFail(r, p, p.label, '提交失败：' + saved.reason + (rollback.ok ? '，草稿已撤销' : '，草稿残留含本次代码，需人工核对'));
    if (!rollback.ok) { abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试'); return; }
    p.status = 'failed';
    return advanceVerify(r);
  }
  p.status = 'submitted';
  r.summary.applied += 1;
  fire({ kind: 'log', level: 'ok', text: `${p.label} → ${head}…（已提交评测）` });
  return advanceVerify(r);
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

// 请求中止：本页在跑就拉响终止信号（在途 fetch 立断、并发 worker 停拉新题，已填答案所在页
// 照常保存）；编码题批量作答滚动中时（哪怕本页还没接上）把中止写进续跑单，
// 由本页就地收摊、或下一页 boot 直接作废残单。返回是否受理。
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
    // 编码题批量作答进行中（各页由 boot 的 resumeRelay 恢复阶段）；页面漂移时续跑会自行弃单
    fire({ kind: 'log', level: 'warn', text: '编码题批量作答正在进行（看悬浮球/日志状态）；本页若已不在题目上则续跑会自行取消' });
    return { ok: false, error: '编码题批量作答正在进行' };
  }
  if (preRelay) clearRelay(); // 已中止的续跑残单：作废，不拦新运行
  const m = location.pathname.match(EXAM_PROBLEMS_RE);
  if (!m || !m[3]) { fire({ kind: 'log', level: 'err', text: '请先进入题型页（判断/单选/填空标签）再开始' }); return { ok: false, error: '请先进入题目列表的某个题型页（判断/单选/填空标签）再开始' }; }
  const psId = m[1];
  const redo = redoModeOf({ redo: config.redo, overwrite: config.overwrite }); // 兼容旧调用方只传布尔 overwrite
  const cfg = {
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    model: config.model || '',
    gateway: config.gateway || '',
    redo, // 已答题处理：skip / wrong / all
    overwrite: redo === 'all', // 兼容仍按布尔口径读 cfg.overwrite 的旧分支与在途续跑单
    images: !!config.images, // 作答含图题（需视觉模型；客观题与编码题均生效，编码题的图片随题面交给模型）
    language: config.language || '', // 编程题固定语言（白名单 id）；空 = 跟随各题编辑器当前语言；函数题忽略（编译器由题目固定）
    concurrency: clampConcurrency(config.concurrency, 6), // 编码题并发作答路数（1–6）；收题/提交仍是串行页面操作
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
  const progTypes = []; // 编码题（编程/函数）：转批量作答（SPA 收题 → 并发 LLM → 种键整页提交），统一在客观题之后触发
  let ret = null;
  let relayStarted = false;
  let batchOutcome = null; // 编码题批量结果（handedOff/paused/aborted/error）：finally 据此决定事件归属
  try {
    clearPersistedLog(); // 新一轮从空日志开始（跨页续跑属于同一轮，不会走到这里）
    fire({ kind: 'log-clear' });
    fire({ kind: 'state', running: true });
    const redoLabel = cfg.redo === 'wrong' ? '仅重做错误' : cfg.redo === 'all' ? '全部重做' : '跳过已答';
    fire({ kind: 'log', level: 'info', text: `开始答题（每题一次请求，${redoLabel}${cfg.images ? '，含图题作答' : ''}）` });
    if (cfg.redo === 'wrong') {
      fire({ kind: 'log', level: 'info', text: '仅重做错误：只作用于编码题；客观题答题中不判分，按跳过已答处理' });
    }
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
        // 编码题转批量作答（收题/提交与整页装载机制耦合，作答在列表页并发跑）；
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
          if (q.answered && redoModeOf(cfg) !== 'all') { stats.skippedAnswered += 1; fire({ kind: 'log', level: 'info', text: `${q.label || q.id.slice(-4)}：跳过，已作答` }); tick(); continue; }
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
      // 编码题统一推迟到所有客观题之后；批量模式 = SPA 收题 → 列表页并发作答 → 逐题种键 reload 提交。
      // 必须 await：并发 LLM 的中止信号挂在本次运行的 runAbort 上；startCodingBatch 返回时
      // 要么已跳去第一张 verify 页（文档即将卸载），要么整轮在本文档内结束/中止/限流挂起。
      batchOutcome = await startCodingBatch(psId, progTypes, cfg);
      relayStarted = batchOutcome.handedOff || batchOutcome.paused;
      const relayNames = [...new Set(progTypes.map(t => t.typeName))].join('、');
      summary.types.push({ type: relayNames || '编码题', total: progTypes.reduce((n, x) => n + x.total, 0), applied: 0, skippedAnswered: 0, skippedImage: 0, failed: 0, saved: false });
      // 中止/致命错误时 ok=false 交给调用方，但结果事件由引擎自己发过（见 finally 注释）
      ret = batchOutcome.aborted
        ? { ok: false, error: '已中止', summary, relay: true }
        : batchOutcome.error
          ? { ok: false, error: batchOutcome.error, summary, relay: true }
          : { ok: true, relay: true, summary };
    }
  } catch (err) {
    ret = { ok: false, error: err?.message || String(err), summary };
  } finally {
    // 先复位运行标志，再发完成事件——面板收到事件时 isRunning() 必须已是 false，
    // 否则 UI 会永远停在“答题中”。confirm 的恢复同理（面板可能立刻重新打开面板导航）。
    // 编码题批量跨页推进后 confirm 不能恢复（verify 页的导航还要压未保存弹窗）。
    running = false;
    runAbort = null;
    if (!relayStarted) restoreLeaveConfirm();

    if (ret.relay && batchOutcome) {
      // 批量路径：结束/中止/失败的叙述已由引擎自己发过（finishBatch / stopBatchByUser /
      // abortRelay，以及限流冷却后的恢复页），这里只补「跨页推进」坐标行并复位面板状态。
      if (batchOutcome.handedOff || batchOutcome.paused) {
        const failN = ret.summary.failed.length;
        fire({ kind: 'log', level: failN ? 'warn' : 'ok', text: '客观题完成；编码题批量作答已推进（收题 → 并发作答 → 逐题提交，日志随各页出现）' });
      }
      fire(ret.ok ? { kind: 'state', running: false } : { kind: 'state', running: false, error: ret.error });
    } else if (ret.ok) {
      const failN = ret.summary.failed.length;
      fire({ kind: 'log', level: failN ? 'warn' : 'ok', text: `完成：作答 ${ret.summary.applied} · 跳过已答 ${ret.summary.skippedAnswered} · 跳过含图 ${ret.summary.skippedImage} · 失败 ${failN}${cfg.drySave ? '（未保存）' : ''}` });
      fire({ kind: 'state', running: false });
    } else {
      // 用户中止不带「原因前缀」重复（错误路径才需要「已中止：<原因>」）
      fire({ kind: 'log', level: 'err', text: ret.error === '已中止' ? '已中止' : '已中止：' + ret.error });
      fire({ kind: 'state', running: false, error: ret.error });
    }
  }
  return ret;
}
