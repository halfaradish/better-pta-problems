/* 自动答题（实验）：在考试题目列表页收集题目 → 调 OpenAI 兼容 LLM → 填表单 → 点「保存」。
 *
 * 流程实测见 docs/自动答题初探.md：一个题型页平铺该题型全部题目，每题容器的 id 就是
 * problemSetProblemId；选项/输入的改动只存在前端内存，点页面原生「保存」按钮才发
 * exam-submissions 请求（协议与 CSRF 头由页面自己带，自动化只负责点按钮）。
 *
 * 运行位置在内容脚本（弹窗只是入口，关弹窗不打断）；编排与收题在同一文档内做
 * 题型切换（点侧栏类型链接走 SPA 路由，不触发整页刷新，运行状态得以保留）。
 * LLM 请求由页面上下文直发（OpenAI 兼容端点普遍允许跨域），不新增 host_permissions。
 *
 * 纯函数（parseChoiceAnswer / normalizeTF / parseFillAnswers / buildPrompt /
 * extractFromRichHtml？——DOM 相关的 collectQuestion 依赖 document，不进单测）
 * 尽量拆出来供 node:test 覆盖。
 */

// 侧栏类型名 → exam-submissions 协议的 problemType
export const TYPE_BY_NAME = {
  '判断题': 'TRUE_OR_FALSE',
  '单选题': 'MULTIPLE_CHOICE',
  '填空题': 'FILL_IN_THE_BLANK',
  '编程题': 'PROGRAMMING',
};

export const EXAM_PROBLEMS_RE = /^\/problem-sets\/(\d+)\/exam\/problems(\/type\/(\d+))?/;

const LETTERS = 'ABCDEFGHIJ';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  if (q.kind === 'PROGRAMMING') {
    lines.push(`题型：编程题。请用「${q.langLabel || '编辑器当前语言'}」写一个完整、可直接提交评测的程序：`);
    lines.push('按题面的输入格式读入数据（不要输出交互式提示语），严格按输出格式打印结果。');
    lines.push('只用该语言的标准库（无把握不要引第三方库）；留意题面给出的时间/内存/代码长度限制。');
    lines.push('输出只包含一个代码围栏块（``` 包裹），围栏内是完整程序源码，不要任何解释文字。');
  } else {
    lines.push('只输出一个 JSON 对象，不要包含任何解释文字或代码围栏。');
  }
  lines.push('');
  if (q.kind === 'PROGRAMMING') {
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
      content: q.kind === 'PROGRAMMING'
        ? '你是严谨的答题助手，只输出一个代码围栏块（``` 包裹的完整程序源码），不要输出任何其他文字。'
        : '你是严谨的答题助手，只输出要求的 JSON，不要输出任何其他文字。',
    },
    { role: 'user', content: lines.join('\n') },
  ];
}

/* ---------- 编程题：语言映射与代码输出解析（纯函数，单测覆盖） ---------- */

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

/* ---------- 页面侧：编程题（CodeMirror 6，一页一题） ---------- */

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
// 当前语言的真实值 = react-select 单值文本（React 实时状态；draft.compiler 只是上次持久值）
function langLabelOf() {
  const form = answerFormEl();
  return form?.querySelector('.select__single-value')?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

// 编程题页题目收集。返回 null 表示当前不是编程题题目页（列表页没有答题表单）。
export function collectProgramming() {
  const mainEl = document.querySelector('main');
  const form = answerFormEl();
  if (!mainEl || !form) return null;
  const cm = [...form.querySelectorAll('.cm-content')].find(x => x.getAttribute('contenteditable') === 'true');
  if (!cm) return null;
  const pspId = (location.search.match(/problemSetProblemId=(\d+)/) || [])[1];
  if (!pspId) return null;
  // 题干图：main 内、答题表单之外的 img（初探 §7.1 同一个数）；
  //parsed src 从活 DOM 取（绝对化），克隆节点不连树时 .src 不解析相对地址
  const stem = [...mainEl.querySelectorAll('img')].filter(i => !form.contains(i))
    .map(i => (i.getAttribute('src') ? i.src : null)).filter(Boolean);
  const imgInfo = { options: {}, stem, total: stem.length };
  const text = cleanText(mainEl, '[class*="CodingProblemAnswerForm"]');
  return {
    id: pspId,
    label: (text.match(/\d+-\d+/) || [])[0] || null, // 例题号形如 7-1（页面标题开头）
    kind: 'PROGRAMMING',
    text,
    langLabel: langLabelOf(),
    hasImg: imgInfo.total > 0,
    imgInfo,
    answered: String(cm.textContent || '').trim().length > 0, // 草稿代码非空视作已答
  };
}

// 该题型的全部题目 id（题目总览数字锚点，href 带 problemSetProblemId；DOM 顺序 = 页面顺序）
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

// 草稿快照与写回（answer.detail 形状来自接口 GET；exam 模式问题 problemId="0"，bundle 组包函数同构）。
// customTestData 原样保留（用户自定义测试数据），写程序时不动它。
export async function getDraftDetail(pspId) {
  const d = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
    headers: { accept: 'application/json' },
    credentials: 'include',
  }).then(r => r.json()).catch(() => null);
  return d?.answer?.detail || null;
}

export async function saveDraft(pspId, detail, compilerId, program) {
  if (!compilerId) return { ok: false, status: null };
  const body = JSON.stringify({
    answer: {
      detail: {
        problemId: detail?.problemId ?? '0',
        problemSetProblemId: detail?.problemSetProblemId || pspId,
        customTestData: detail?.customTestData, // 原样保留（可为 null）
        programmingSubmissionDetail: { compiler: compilerId, program },
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

// 无条件删某题的 codingProblem 缓存键（仅限引擎刚改写过该题草稿的时机：collect 写完代码、
// verify 撤销后——此时题内态由服务端草稿说了算，旧缓存只会让水合拿到 boot 时的旧快照）。
function clearCodingProblemCache(id) {
  try {
    const raw = JSON.parse(localStorage.getItem('user-cache') || '{}');
    if ('codingProblem_' + id in raw === false) return;
    delete raw['codingProblem_' + id];
    localStorage.setItem('user-cache', JSON.stringify(raw));
  } catch (_) { /* 结构异常静默 */ }
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

async function chatOnce(cfg, messages) {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + String(cfg.apiKey || '').trim(),
  };
  // OpenCode Go 网关要求：每个会话带稳定的 x-opencode-session（利于路由/缓存，
  // 不带可能被拒 400）。DeepSeek 官方 API 不需要，不附加多余头。
  if (cfg.gateway === 'opencode') {
    headers['x-opencode-session'] = sessionHeader();
    headers['User-Agent'] = 'better-pta-problems/0.9'; // 网关要求自建 UA（浏览器会忽略，仅为直连场景保留）
  }
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, temperature: 0, messages }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('LLM HTTP ' + res.status + (t ? '：' + t.slice(0, 140) : ''));
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('LLM 响应为空');
  return text;
}

// 页面上下文带登录态取图并转 data URL（初探结论：ptausercontent 图源可直接带登录态获取）。
// 页面 fetch 走 CORS——实测 ptausercontent 不放行页面 fetch，因此失败后转取：
// 经 chrome.runtime 让 background fetch（该域已在 host_permissions，含图转取见 background/index.js）。
// 页面世界无 chrome.runtime（真机扩展才可用时 background 可用），两层都失败则该题报失败不拖累其他题。
function toDataUrlPage(src) {
  return fetch(src, { credentials: 'include' }).then(res => {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.blob();
  }).then(blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('FileReader 读取失败'));
    r.readAsDataURL(blob);
  }));
}

const hasBgFetch = typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

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
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = globalThis.__BPS_LLM_MOCK__
        ? await globalThis.__BPS_LLM_MOCK__(messages)
        : await chatOnce(cfg, messages);
      break;
    } catch (err) {
      if (attempt === 2) return { ok: false, reason: 'LLM 调用失败：' + (err?.message || err) };
      await sleep(900);
    }
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

/* ---------- 运行编排：编程题（跨文档续跑 relay） ---------- */
// PTA 只在「整页装载」时从服务端草稿水合代码；SPA remount 会命中它的内存响应缓存拿旧值
// （决策实验记录：写草稿→SPA 往返 = 不回带；写草稿→整页 reload = 必回带。见初探 §10.6）。
// 因此编程题流转改为 sessionStorage 会话标志 + 逐题整页装载：
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

// 编程题流程入口：往 sessionStorage 里放下续跑单，然后整页跳到第一题（收集委托给 boot）
function startProgrammingRelay(psId, progTypes, cfg) {
  const problems = [];
  for (const t of progTypes) {
    for (const id of programmingIds(psId, t.typeId)) problems.push({ id, typeId: t.typeId, typeName: t.typeName });
  }
  if (!problems.length) throw new Error('「编程题」找不到题目锚点（题目总览收起？点开后重试）');
  const relay = {
    v: 1,
    cfg: { ...cfg },
    psId,
    problems,
    pi: 0,
    phase: 'collect', // collect → verify →（advance）→ collect → …
    summary: { applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [] },
  };
  if (!writeRelay(relay)) throw new Error('sessionStorage 不可写，无法跨页续跑编程题');
  const first = problems[0];
  fire({ kind: 'log', level: 'info', text: `编程题 ${problems.length} 题：转「逐题整页装载」模式，日志随各页出现` });
  pageScript('if (!window.__BPS_CONFIRM__) { window.__BPS_CONFIRM__ = window.confirm; window.confirm = function(){ return true; }; }');
  try { location.href = `/problem-sets/${psId}/exam/problems/type/${first.typeId}?problemSetProblemId=${first.id}`; } catch (_) { /* 导航由浏览器处理 */ }
  return true;
}

// boot 后由 init 调用：存在续跑单就按阶段恢复（总开关仍要开着）
export async function resumeRelay(settings) {
  const r = readRelay();
  if (!r || r.v !== 1) return;
  if (!(settings && settings.autoAnswer)) {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编程题续跑取消：总开关未开启' });
    return;
  }
  const prob = r.problems[r.pi];
  if (!prob) {
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编程题续跑取消：续跑单已越界' });
    return;
  }
  if (!new RegExp(`problemSetProblemId=${prob.id}$`).test(location.search)) {
    // 用户把页面开去了别处 → 弃单（已落位的题目保持各自状态）
    clearRelay();
    fire({ kind: 'log', level: 'warn', text: '编程题续跑取消：页面不在 ' + (prob.id || '').slice(-4) + ' 上（已落位题目保持各自状态）' });
    return;
  }
  running = true;
  suppressLeaveConfirm();
  fire({ kind: 'state', running: true });
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

function relaySummaryLine(r) {
  const s = r.summary;
  return `作答 ${s.applied} · 跳过已答 ${s.skippedAnswered} · 跳过含图 ${s.skippedImage} · 失败 ${s.failed.length}${r.cfg.drySave ? '（dry，未提交）' : ''}`;
}

function abortRelay(r, reason) {
  clearRelay();
  fire({ kind: 'log', level: 'err', text: '编程题续跑中止：' + reason });
  fire({ kind: 'log', level: 'info', text: relaySummaryLine(r) });
  fire({ kind: 'state', running: false, error: reason });
  running = false;
  restoreLeaveConfirm();
}

// 推进到下一题（record: 'ok'|'skip'|'fail'——fail 的失败条目由调用方写好）；最后一题收尾
async function relayNext(r, record, text) {
  if (record === 'ok') {
    r.summary.applied += 1;
    if (text) fire({ kind: 'log', level: 'ok', text });
  }
  if (record === 'skip') {
    r.summary.skippedAnswered += 1;
    if (text) fire({ kind: 'log', level: 'info', text });
  }
  const nextIdx = r.pi + 1;
  if (nextIdx >= r.problems.length) {
    const line = relaySummaryLine(r);
    try { sessionStorage.setItem('__BPS_AA_SUMMARY_DONE__', JSON.stringify({ ok: !r.summary.failed.length, line, failed: r.summary.failed })); } catch (_) {}
    clearRelay();
    running = false;
    restoreLeaveConfirm();
    const lvl = r.summary.failed.length ? 'warn' : 'ok';
    fire({ kind: 'log', level: lvl, text: '编程题跨页续跑结束：' + line });
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
  restoreLeaveConfirm();
  try { location.href = `/problem-sets/${r.psId}/exam/problems/type/${next.typeId}?problemSetProblemId=${next.id}`; } catch (_) { /* 导航交浏览器 */ }
}

// collect 文档：收题 → 守护 → LLM → 写草稿 → 转 verify（整页 reload）
async function relayCollect(r, prob) {
  const q = collectProgramming();
  if (!q) { r.summary.failed.push({ id: prob.id, reason: '编程题页面收不到题目' }); return relayNext(r, 'fail'); }
  const label = q.label || prob.id.slice(-4);
  if (q.answered && !r.cfg.overwrite) return relayNext(r, 'skip', `${label}：跳过，已作答`);
  if (q.hasImg && !r.cfg.images) {
    r.summary.skippedImage += 1;
    fire({ kind: 'log', level: 'warn', text: `${label}：跳过，题干含图片（未开「作答含图题」）` });
    return relayNext(r, 'fail'); // skippedImage 已计入，这里只推进
  }

  const detail = await getDraftDetail(prob.id);
  const compilerId = r.cfg.language
    ? r.cfg.language
    : (compilerIdFromLabel(q.langLabel) || (detail?.programmingSubmissionDetail?.compiler || null));
  if (!compilerId) {
    r.summary.failed.push({ id: prob.id, reason: `读不到当前语言「${q.langLabel || '（空）'}」，无法确定编译器` });
    return relayNext(r, 'fail');
  }
  const wantLangLabel = COMPILER_LABELS[compilerId] || q.langLabel || '';

  const messages = buildPrompt({ ...q, langLabel: wantLangLabel });
  let raw = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      raw = globalThis.__BPS_LLM_MOCK__
        ? await globalThis.__BPS_LLM_MOCK__(messages)
        : await chatOnce(r.cfg, messages);
      break;
    } catch (err) {
      if (attempt === 2) {
        r.summary.failed.push({ id: prob.id, reason: 'LLM 调用失败：' + (err?.message || err) });
        return relayNext(r, 'fail');
      }
      await sleep(900);
    }
  }
  const code = parseCodeAnswer(raw);
  if (!code) {
    r.summary.failed.push({ id: prob.id, reason: 'LLM 输出解析不出代码：' + String(raw).slice(0, 60) });
    return relayNext(r, 'fail');
  }
  if (code.length > 16384) {
    r.summary.failed.push({ id: prob.id, reason: `代码超长（${code.length} 字符，平台限 16KB）` });
    return relayNext(r, 'fail');
  }

  const written = await saveDraft(prob.id, detail, compilerId, code);
  if (!written.ok) {
    r.summary.failed.push({ id: prob.id, reason: `草稿写入失败（HTTP ${written.status ?? '未知'}${written.err ? '：' + written.err : ''}）` });
    return relayNext(r, 'fail');
  }
  stripDraftHttpCache(prob.id);
  clearCodingProblemCache(prob.id); // 收尾必做：不删缓存，verify 文档的 boot 会拿 boot 期旧快照水合（dry11 实锤）
  r.phase = 'verify';
  r.hint = { label, compilerId, wantLangLabel, head: (code.split('\n')[0] || '').trim().slice(0, 24), detail };
  if (!writeRelay(r)) { abortRelay(r, 'sessionStorage 写入失败'); return; }
  running = false; // 文档马上销毁，复位标记避免残留运行态
  try { location.reload(); } catch (_) { /* 交浏览器 */ }
}

// verify 文档：水合探测 → 语言守护 → dry 撤销 / 点「提交本题作答」→ 推进下一题（或收尾）
async function relayVerify(r, prob) {
  const hint = r.hint;
  if (!hint || !hint.head) { abortRelay(r, 'verify 阶段缺少 hint（replay 状态错乱）'); return; }
  const label = hint.label || prob.id.slice(-4);
  const wantLangLabel = hint.wantLangLabel || '';
  const compilerId = hint.compilerId;
  const head = String(hint.head || '').trim();
  const detail = hint.detail || null;

  const hyd = await waitHydrate(true);
  const cmText = editableCm()?.textContent || '';
  if (!hyd.ok || (head && !cmText.includes(head))) {
    const rollback = await saveDraft(prob.id, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    r.summary.failed.push({ id: prob.id, reason: '水合校验失败（编辑器未回带代码）' + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对') });
    if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
    return relayNext(r, 'fail');
  }

  // 语言一致性守卫：实挂语言 != 代码语言时不提交（提交载荷的 compiler 由页面默认链决定，
  // 可能不理会草稿 compiler——不能拿错配代码冒险）
  const mountedLabel = langLabelOf();
  if (mountedLabel !== wantLangLabel) {
    const rollback = await saveDraft(prob.id, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    r.summary.failed.push({ id: prob.id, reason: `语言不一致（草稿 ${wantLangLabel}，实挂「${mountedLabel || '未知'}」），已弃答防错配` + (rollback.ok ? '，草稿已撤销' : '，草稿残留需人工核对') });
    if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
    return relayNext(r, 'fail');
  }

  if (r.cfg.drySave) {
    const rollback = await saveDraft(prob.id, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    if (!rollback.ok) return abortRelay(r, 'dry：水合校验通过后撤销草稿失败，残留需人工核对');
    return relayNext(r, 'ok', `${label} → ${head}…（dry：草稿水合校验通过后已撤销，未提交）`);
  }

  const saved = await submitProgramming();
  if (!saved.saved) {
    const rollback = await saveDraft(prob.id, detail, compilerId, '');
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    r.summary.failed.push({ id: prob.id, reason: '提交失败：' + saved.reason + (rollback.ok ? '，草稿已撤销' : '，草稿残留含本次代码，需人工核对') });
    if (!rollback.ok) return abortRelay(r, '草稿撤销失败（残留代码），需人工核对后再试');
    return relayNext(r, 'fail');
  }
  return relayNext(r, 'ok', `${label} → ${head}…（已提交评测）`);
}

/* ---------- 运行编排 ---------- */

// PTA 在题目页有未保存改动时，切换题型会弹 confirm() 离开确认。真实流程每题型答完
// 即点保存、此框少见，但部分题目 LLM 失败留下草稿时仍会触发并卡住自动化——
// 运行期间在页面主世界临时禁用（主世界注入可行，实测 PTA 无 CSP meta），结束后恢复。
function pageScript(code) {
  const s = document.createElement('script');
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}
function suppressLeaveConfirm() {
  pageScript('window.__BPS_CONFIRM__ = window.confirm; window.confirm = () => true;');
}
function restoreLeaveConfirm() {
  pageScript('if (window.__BPS_CONFIRM__) { window.confirm = window.__BPS_CONFIRM__; delete window.__BPS_CONFIRM__; }');
}

let running = false;

export function isRunning() {
  return running;
}

/* ---------- 事件流（悬浮面板消费） ---------- */
// 面板注册 sink 接收结构化事件；无面板时引擎照常运行（sink 未注册则丢弃）
// 事件：{kind:'log', level:'info'|'ok'|'warn'|'err', text}
//       {kind:'progress', done, total, typeName}
//       {kind:'state', running, error?}
let eventSink = null;
export function setEventSink(fn) {
  eventSink = typeof fn === 'function' ? fn : null;
}
const debugTrace = [];
function fire(event) {
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
  if (readRelay()) {
    // 编程题跨文档续跑滚动中（每页由 boot 的 resumeRelay 恢复阶段）；该页不在题目页时续跑已弃单
    fire({ kind: 'log', level: 'warn', text: '编程题跨页续跑正在进行（看各页悬浮球状态）；本页若已不在题目上则续跑会自行取消' });
    return { ok: false, error: '编程题跨页续跑正在进行' };
  }
  const m = location.pathname.match(EXAM_PROBLEMS_RE);
  if (!m || !m[3]) { fire({ kind: 'log', level: 'err', text: '请先进入题型页（判断/单选/填空标签）再开始' }); return { ok: false, error: '请先进入题目列表的某个题型页（判断/单选/填空标签）再开始' }; }
  const psId = m[1];
  const cfg = {
    baseUrl: config.baseUrl || '',
    apiKey: config.apiKey || '',
    model: config.model || '',
    gateway: config.gateway || '',
    overwrite: !!config.overwrite,
    images: !!config.images, // 作答含图题（需视觉模型；未开则含图题照旧跳过）
    language: config.language || '', // 编程题固定语言（白名单 id）；空 = 跟随各题编辑器当前语言
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

  running = true;
  suppressLeaveConfirm();
  const summary = { types: [], applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [], savedTypes: 0, saveFails: [] };
  const progTypes = []; // 编程题：转跨文档续跑（整页装载才有真草稿水合），统一在客观题之后触发
  let ret = null;
  let relayStarted = false;
  try {
    fire({ kind: 'state', running: true });
    fire({ kind: 'log', level: 'info', text: `开始答题（每题一次请求，${cfg.overwrite ? '覆盖已作答' : '跳过已答'}${cfg.images ? '，含图题作答' : ''}）` });
    const types = sidebarTypes().filter(t => TYPE_BY_NAME[t.typeName] || false).filter(t => t.total > 0);
    const unknown = sidebarTypes().filter(t => !(t.typeName in TYPE_BY_NAME) && t.total > 0);
    if (!types.length) throw new Error('本页侧栏没有可作答的题型');
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
      const type = TYPE_BY_NAME[t.typeName];
      const isProg = type === 'PROGRAMMING';
      if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
        const link = [...document.querySelectorAll('a[href]')]
          .find(a => (a.getAttribute('href') || '').match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
        if (!link) throw new Error(`找不到「${t.typeName}」的页面链接`);
        link.click();
        // 等 SPA 渲染出该题型页的题目：URL 与「该题型的容器数」都对才就绪
        // （路由先切内容后到，旧题型页的容器不能拿来充数）
        let ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
          await sleep(100);
          ready = location.pathname.endsWith(`/type/${t.typeId}`)
            && (isProg
              ? (programmingIds(psId, t.typeId).length > 0 || !!editableCm())
              : collectPage().filter(q => q.kind === type).length >= t.total);
        }
        if (!ready) throw new Error(`「${t.typeName}」页面未就绪（侧栏统计 ${t.total} 题）`);
      }
      await sleep(300); // 渲染稳定
      if (isProg) {
        // 编程题只与整页装载的水合机制兼容（SPA remount 命中内存响应缓存），转跨文档续跑；
        // 为让客观题在本文档内先处理完，编程题统一推迟到本轮所有客观题之后触发
        progTypes.push(t);
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
        while (cursor < queue.length) {
          const { q } = queue[cursor++];
          done += 1;
          if (q.answered && !cfg.overwrite) { stats.skippedAnswered += 1; fire({ kind: 'log', level: 'info', text: `${q.label || q.id.slice(-4)}：跳过，已作答` }); tick(); continue; }
          if (q.hasImg && !cfg.images) { stats.skippedImage += 1; fire({ kind: 'log', level: 'warn', text: `${q.label || q.id.slice(-4)}：跳过，含图片（未开「作答含图题」）` }); tick(); continue; }
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
    ret = { ok: true, summary };
    if (progTypes.length) {
      // 编程题统一推迟到所有客观题之后；启动续跑后 ret 语义是「客观题已完成、编程题滚动中」
      if (startProgrammingRelay(psId, progTypes, cfg)) {
        relayStarted = true;
        summary.types.push({ type: '编程题', total: progTypes.reduce((n, x) => n + x.total, 0), applied: 0, skippedAnswered: 0, skippedImage: 0, failed: 0, saved: false });
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
    if (!relayStarted) restoreLeaveConfirm();

    if (ret.ok) {
      const failN = ret.summary.failed.length;
      fire({ kind: 'log', level: failN ? 'warn' : 'ok', text: `${ret.relay ? '客观题完成（编程题已转逐页续跑，日志随各页出现）' : `完成：作答 ${ret.summary.applied} · 跳过已答 ${ret.summary.skippedAnswered} · 跳过含图 ${ret.summary.skippedImage} · 失败 ${failN}${cfg.drySave ? '（未保存）' : ''}`}` });
      fire({ kind: 'state', running: false });
    } else {
      fire({ kind: 'log', level: 'err', text: '已中止：' + ret.error });
      fire({ kind: 'state', running: false, error: ret.error });
    }
  }
  return ret;
}
