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
  lines.push('只输出一个 JSON 对象，不要包含任何解释文字或代码围栏。');
  lines.push('');
  if (q.kind === 'TRUE_OR_FALSE') {
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
    { role: 'system', content: '你是严谨的答题助手，只输出要求的 JSON，不要输出任何其他文字。' },
    { role: 'user', content: lines.join('\n') },
  ];
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
function fire(event) {
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
  let ret = null;
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
      if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
        const link = [...document.querySelectorAll('a[href]')]
          .find(a => (a.getAttribute('href') || '').match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
        if (!link) throw new Error(`找不到「${t.typeName}」的页面链接`);
        link.click();
        // 等 SPA 渲染出该题型页的题目：URL 与「该题型的容器数」都对才就绪
        // （路由先切内容后到，旧题型页的容器不能拿来充数）
        // 等 SPA 渲染出该题型页的题目：URL 与「该题型的容器数」都对才就绪
        // （路由先切内容后到，旧题型页的容器不能拿来充数）
        const type = TYPE_BY_NAME[t.typeName];
        let ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
          await sleep(100);
          ready = location.pathname.endsWith(`/type/${t.typeId}`)
            && collectPage().filter(q => q.kind === type).length >= t.total;
        }
        if (!ready) throw new Error(`「${t.typeName}」页面未就绪（侧栏统计 ${t.total} 题）`);
      }
      await sleep(300); // 渲染稳定

      const type = TYPE_BY_NAME[t.typeName];
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
  } catch (err) {
    ret = { ok: false, error: err?.message || String(err), summary };
  } finally {
    // 先复位运行标志，再发完成事件——面板收到事件时 isRunning() 必须已是 false，
    // 否则 UI 会永远停在“答题中”。confirm 的恢复同理（面板可能立刻重新打开面板导航）。
    running = false;
    restoreLeaveConfirm();

    if (ret.ok) {
      const failN = ret.summary.failed.length;
      fire({ kind: 'log', level: failN ? 'warn' : 'ok', text: `完成：作答 ${ret.summary.applied} · 跳过已答 ${ret.summary.skippedAnswered} · 跳过含图 ${ret.summary.skippedImage} · 失败 ${failN}${cfg.drySave ? '（未保存）' : ''}` });
      fire({ kind: 'state', running: false });
    } else {
      fire({ kind: 'log', level: 'err', text: '已中止：' + ret.error });
      fire({ kind: 'state', running: false, error: ret.error });
    }
  }
  return ret;
}
