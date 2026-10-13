/* 自动答题悬浮球与面板（实验）。
 *
 * 弹窗只保留总开关（settings.autoAnswer）；题目列表页（/exam/problems…）挂出悬浮球，
 * 点开为答题面板：模型适配选择（DeepSeek / OpenCode Go）、API Key、覆盖已作答、开始答题、
 * 运行日志（可清空）。面板用 Shadow DOM 隔离——不吸 PTA 页面的样式，也不把自己的
 * 类名泄进页面；设计令牌与设置弹窗同源（品牌蓝 #0a4991、明暗双主题）。
 *
 * 运行本体在 autoanswer.js：面板只是入口与事件流的展示层（setEventSink），
 * 关掉面板 / 翻到别的页面都不打断运行；运行中悬浮球常驻并显示整体进度环。
 */
import { loadSettings, saveSettings } from '../shared/settings.js';
import { EXAM_PROBLEMS_RE, handleRun, isRunning, normalizeBaseUrl, setEventSink } from './autoanswer.js';

// 模型适配 presets：往这里加即可挂进面板下拉。
// gateway 对应 autoanswer.js chatOnce 的协议分支（opencode 网关需要 x-opencode-session 等头）；
// 网关里只有 chat-completions 协议的模型系可标 editableModel——OpenCode Zen Go 上
// glm / kimi / deepseek 系走 /chat/completions（本引擎支持），claude / minimax 走 /messages、
// grok / gpt 系走 /responses，均暂不解析，不许用户选（选了也是「LLM 响应为空」）。
export const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', // 视觉模型；deepseek-chat 已下架（2026-10-13）
    gateway: 'deepseek',
    hint: '官方 API · api.deepseek.com · 模型 deepseek-flash（视觉）',
  },
  opencode: {
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'glm-5.3-flash',
    gateway: 'opencode',
    editableModel: true, // 网关模型可自填（面板多一行「模型」输入），留空用默认
    hint: 'Zen Go 网关 · glm / kimi / deepseek 系模型可用',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    model: '',
    gateway: 'custom', // chatOnce 只对 'opencode' 附加网关头，自定义端点保持干净
    customEndpoint: true, // 多一行「端点」输入：任意 OpenAI 兼容根地址
    editableModel: true,
    hint: '任意 OpenAI 兼容服务 · 端点与模型 id 均自填',
  },
};

// 面板「模型」输入 → 请求用模型名：固定适配无视输入，可自填网关取输入（空回默认）
export function resolveModel(preset, raw) {
  const v = String(raw || '').trim();
  return preset.editableModel && v ? v : preset.model;
}

const MAX_LOG_LINES = 200; // 日志上限：防长跑爆内存，超出丢最旧

const CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  font: 13px/1.5 system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  color: var(--text); font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif; }

/* ---------- 悬浮球 ---------- */
.ball { position: relative; width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
  cursor: pointer; display: grid; place-items: center; color: #fff;
  background: linear-gradient(135deg, #1171cf 0%, #0a4991 100%);
  box-shadow: 0 4px 16px rgba(10, 73, 145, .38), 0 1px 3px rgba(16, 24, 40, .25);
  transition: transform .15s ease, box-shadow .15s ease; }
.ball:hover { transform: translateY(-1px) scale(1.05); box-shadow: 0 6px 20px rgba(10, 73, 145, .45), 0 2px 4px rgba(16, 24, 40, .3); }
.ball:focus-visible { outline: 2px solid #79aaee; outline-offset: 3px; }
.ball .glyph { position: relative; z-index: 1; font-size: 17px; font-weight: 700; letter-spacing: .02em; }
.ring { position: absolute; inset: -1px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .bg { stroke: rgba(255, 255, 255, .28); }
.ring .fg { stroke: #8ff0b4; stroke-linecap: round; stroke-dasharray: 138.2; stroke-dashoffset: 138.2; transition: stroke-dashoffset .25s ease; }

/* ---------- 面板 ---------- */
.panel { position: absolute; right: 0; bottom: 56px; width: 324px; max-width: calc(100vw - 24px);
  max-height: calc(100vh - 90px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border-radius: 14px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(16, 24, 40, .22), 0 3px 10px rgba(16, 24, 40, .1), 0 0 0 1px var(--hairline);
  transform-origin: 100% 100%; animation: aa-pop .18s ease; }
/* display:flex 会盖过 UA 的 [hidden]，必须显式收回（否则收起面板无效、面板常显） */
.panel[hidden] { display: none; }
@keyframes aa-pop { from { transform: scale(.94) translateY(5px); opacity: 0; } }

.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px 11px;
  border-bottom: 1px solid var(--hairline); }
.head .title { font-weight: 650; font-size: 14px; letter-spacing: .01em; }
.pill { font-size: 11px; line-height: 1; padding: 4px 9px 4px; border-radius: 9999px;
  background: var(--accent-soft); color: var(--accent-strong); font-weight: 550; }
.pill.run { position: relative; padding-left: 18px; }
.pill.run::before { content: ""; position: absolute; left: 8px; top: 50%; width: 6px; height: 6px;
  margin-top: -3px; border-radius: 50%; background: currentColor; animation: aa-pulse 1.1s ease infinite; }
@keyframes aa-pulse { 50% { opacity: .35; } }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.err { background: var(--err-soft); color: var(--err); }
.collapse { flex: none; width: 26px; height: 26px; border: 1px solid transparent; border-radius: 8px;
  background: none; color: var(--text-3); font-size: 14px; line-height: 1; cursor: pointer;
  display: grid; place-items: center; transition: background .12s ease, color .12s ease; }
.collapse:hover { background: var(--input-bg); color: var(--text); }
.collapse:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.body { padding: 13px 14px 12px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }

.field .flabel { display: block; margin-bottom: 5px; font-size: 12px; font-weight: 550; color: var(--text-2); }
select { appearance: none; -webkit-appearance: none; width: 100%; padding: 7px 30px 7px 10px;
  border: 1px solid var(--input-border); border-radius: 9px;
  background: var(--input-bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236f7a88' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center;
  color: var(--text); font: inherit; cursor: pointer; }
select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.hint { margin: 5px 0 0; font-size: 11.5px; color: var(--text-3); }

.keyrow { position: relative; }
.keyrow input, .mrow input { width: 100%; padding: 7px 10px; border: 1px solid var(--input-border);
  border-radius: 9px; background: var(--input-bg); color: var(--text); font: inherit; }
.keyrow input { padding-right: 52px; } /* 右侧留给显示/隐藏按钮 */
.keyrow input:focus-visible, .mrow input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
.keyrow .peek { position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  height: 24px; padding: 0 7px; border: none; border-radius: 6px; background: none;
  color: var(--text-3); font-size: 11.5px; cursor: pointer; }
.keyrow .peek:hover { color: var(--accent); background: var(--accent-soft); }

.switchrow { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  cursor: pointer; min-height: 24px; }
.switchrow .stxt { display: flex; flex-direction: column; }
.switchrow .stxt b { font-weight: 550; font-size: 13px; }
.switchrow .stxt small { font-size: 11.5px; color: var(--text-3); }
.switch { appearance: none; -webkit-appearance: none; flex: none; width: 36px; height: 20px;
  margin: 0; border-radius: 9999px; background: var(--switch-off); cursor: pointer; position: relative;
  transition: background .18s ease; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform .18s ease; }
.switch:checked { background: var(--accent-fill); }
.switch:checked::after { transform: translateX(16px); }
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:disabled, button:disabled { opacity: .5; cursor: not-allowed; }

.start { width: 100%; padding: 9px 12px; border: none; border-radius: 10px;
  background: var(--accent-soft); color: var(--accent-strong); font: inherit; font-weight: 600;
  font-size: 13px; cursor: pointer; letter-spacing: .02em;
  transition: filter .15s ease; }
.start:hover:not(:disabled) { filter: brightness(.95); }
.start:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.logs-head { display: flex; align-items: center; justify-content: space-between; }
.logs-head b { font-size: 12px; font-weight: 600; color: var(--text-2); }
.clear { border: 1px solid transparent; border-radius: 6px; background: none; color: var(--text-3);
  font-size: 11.5px; padding: 2px 7px; cursor: pointer; transition: background .12s ease, color .12s ease; }
.clear:hover:not(:disabled) { background: var(--input-bg); color: var(--err); }
.clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.logs { height: 138px; overflow: auto; overscroll-behavior: contain; padding: 8px 10px;
  border: 1px solid var(--hairline); border-radius: 9px; background: var(--input-bg);
  font: 11.5px/1.7 ui-monospace, "Cascadia Mono", Consolas, monospace;
  white-space: pre-wrap; word-break: break-all; color: var(--text-2); }
.logs .line { margin: 0 0 1px; }
.logs .line::-webkit-scrollbar, .body::-webkit-scrollbar { width: 8px; }
.logs::-webkit-scrollbar-thumb, .body::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 4px; }
.logs .t { color: var(--text-3); font-size: 10px; margin-right: 5px; }
.logs .lv-ok { color: var(--ok); }
.logs .lv-err { color: var(--err); }
.logs .lv-warn { color: var(--warn); }
.foot { margin: 0; font-size: 11px; color: var(--text-3); }

@media (prefers-reduced-motion: reduce) {
  .ball { transition: none; }
  .panel { animation: none; }
  .pill.run::before { animation: none; }
  .ring .fg { transition: none; }
}

/* ---------- 双主题（跟随系统，令牌与设置弹窗同源） ---------- */
:host { --bg: #ffffff; --hairline: #eceff2; --text: #242a32; --text-2: #5c6672;
  --text-3: #6f7a88; --accent: #0a4991; --accent-strong: #0a4991; --accent-fill: #0a4991;
  --accent-soft: #e8f0fa; --accent-ring: rgba(10, 73, 145, .16);
  --input-bg: #f6f8fa; --input-border: #dfe3e8; --switch-off: #d6dbe1;
  --ok: #2b8a3e; --ok-soft: #e6f4ea; --err: #e03131; --err-soft: #fdecec;
  --warn: #d9480f; --scroll: rgba(0, 0, 0, .12); }
@media (prefers-color-scheme: dark) {
  .wrap { --bg: #1a1c20; --hairline: #2a2d33; --text: #e9ebee; --text-2: #a8b0bb;
    --text-3: #8d96a3; --accent: #79aaee; --accent-strong: #8fbbf3; --accent-fill: #2b6cb8;
    --accent-soft: rgba(88, 140, 220, .2); --accent-ring: rgba(121, 170, 238, .28);
    --input-bg: #22252b; --input-border: #34383f; --switch-off: #3a3f47;
    --ok: #55c07a; --ok-soft: rgba(85, 192, 122, .16); --err: #f47067; --err-soft: rgba(244, 112, 103, .16);
    --warn: #ffa94d; --scroll: rgba(255, 255, 255, .14); }
}
`;

let host = null;        // shadow host（body 直挂，显隐由 sync 控制）
let shadow = null;
let settings = null;
let open = false;

// 面板会话内状态：日志无论开关都累计（重开面板能接着看）
const logLines = [];
let lastProgress = null;   // { done, total }
let finished = false;      // 最近一次运行是否已结束（用于球/面板的结束态）
let finishedWithError = false;
let unregisterSink = null;

const svgRing = `
  <svg class="ring" viewBox="0 0 48 48" aria-hidden="true">
    <circle class="bg" cx="24" cy="24" r="22"></circle>
    <circle class="fg" cx="24" cy="24" r="22"></circle>
  </svg>`;

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

function timeStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ---------- 日志 ---------- */

function appendLog(level, text) {
  logLines.push({ level, text, t: timeStr() });
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  if (!shadow) return;
  const box = shadow.getElementById('logs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const line = el('div', 'line', box);
  const tag = { ok: '✓', err: '✕', warn: '!' }[level] || '·';
  line.innerHTML = `<span class="t">${timeStr()}</span><span class="lv-${level}">${tag}</span> `;
  line.appendChild(document.createTextNode(text));
  while (box.children.length > MAX_LOG_LINES) box.firstChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  const box = shadow.getElementById('logs');
  if (!box) return;
  box.innerHTML = '';
  for (const l of logLines) {
    const line = el('div', 'line', box);
    const tag = { ok: '✓', err: '✕', warn: '!' }[l.level] || '·';
    line.innerHTML = `<span class="t">${l.t}</span><span class="lv-${l.level}">${tag}</span> `;
    line.appendChild(document.createTextNode(l.text));
  }
  box.scrollTop = box.scrollHeight;
}

/* ---------- 事件流 → 面板/球 ---------- */

function onEvent(ev) {
  if (ev.kind === 'log') return appendLog(ev.level, ev.text);
  if (ev.kind === 'progress') {
    lastProgress = { done: ev.done, total: ev.total };
    if (shadow) updateRunUI();
    return;
  }
  if (ev.kind === 'state') {
    if (ev.running) {
      finished = false;
      finishedWithError = false;
    } else {
      finished = true;
      finishedWithError = !!ev.error;
      if (ev.error) appendLog('err', ev.error);
    }
    if (shadow) {
      updateRunUI();
      // 运行结束时面板若开着，把日志滚到底
      const box = shadow.getElementById('logs');
      if (box && !ev.running) box.scrollTop = box.scrollHeight;
    }
  }
}

function updateRunUI() {
  if (!shadow) return;
  const running = isRunning();
  const ball = shadow.getElementById('ball');
  const pill = shadow.getElementById('pill');
  const start = shadow.getElementById('start');
  const ringFg = ball?.querySelector('.ring .fg');
  const prog = running ? lastProgress : null;

  // 球：运行中常显进度环
  if (ball) {
    ball.classList.toggle('running', running);
    if (ringFg) ringFg.style.strokeDashoffset = prog ? String(138.2 * (1 - prog.done / Math.max(1, prog.total))) : '138.2';
  }
  // 状态胶囊
  if (pill) {
    pill.className = 'pill' + (running ? ' run' : (finished ? (finishedWithError ? ' err' : ' ok') : ''));
    pill.textContent = running ? `答题中 ${prog ? `${prog.done}/${prog.total}` : '…'}` : (finished ? (finishedWithError ? '已中止' : '已完成') : '待机');
  }
  // 开始按钮
  if (start) {
    start.disabled = running;
    start.textContent = running ? `答题中…${prog ? `（${prog.done}/${prog.total}）` : ''}` : '开始答题';
  }
}

/* ---------- 挂载与卸载 ---------- */

function mount() {
  if (host) return;
  host = document.createElement('div');
  host.className = 'bps-aa'; // index.js 的 MutationObserver 据此忽略
  host.dataset.bps = 'autoanswer';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);

  const wrap = el('div', 'wrap', shadow);

  // —— 悬浮球 ——
  const ball = el('button', 'ball', wrap);
  ball.id = 'ball';
  ball.type = 'button';
  ball.setAttribute('aria-label', '自动答题');
  ball.setAttribute('aria-expanded', 'false');
  ball.innerHTML = svgRing + '<span class="glyph">答</span>';

  // —— 面板 ——
  const panel = el('div', 'panel', wrap);
  panel.id = 'panel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', '自动答题面板');

  const head = el('div', 'head', panel);
  el('span', '', head).textContent = '自动答题';
  const pill = el('span', 'pill', head);
  pill.id = 'pill';
  pill.textContent = '待机';
  const collapse = el('button', 'collapse', head);
  collapse.type = 'button';
  collapse.id = 'collapse';
  collapse.setAttribute('aria-label', '收起面板');
  collapse.textContent = '—';

  const body = el('div', 'body', panel);

  const fModel = el('div', 'field', body);
  el('label', 'flabel', fModel).textContent = '服务';
  fModel.querySelector('label').htmlFor = 'aa-model';
  const sel = el('select', '', fModel);
  sel.id = 'aa-model';
  for (const [key, p] of Object.entries(PRESETS)) {
    const o = el('option', '', sel);
    o.value = key;
    o.textContent = p.label;
    if (p.disabled) o.disabled = true;
  }
  el('p', 'hint', fModel); // 文案由 applyPreset 按所选服务填（下拉挪动/新增预设只改 PRESETS）

  // 「自定义」服务多一行「端点」输入（任意 OpenAI 兼容根地址），预设服务不显示
  const fBase = el('div', 'field', body);
  fBase.id = 'aa-base-field';
  fBase.hidden = true;
  el('label', 'flabel', fBase).textContent = '端点';
  fBase.querySelector('label').htmlFor = 'aa-base';
  const brow = el('div', 'mrow', fBase);
  const burl = el('input', '', brow);
  burl.id = 'aa-base';
  burl.type = 'text';
  burl.placeholder = 'https://api.example.com/v1';
  burl.autocomplete = 'off';
  burl.spellcheck = false;
  el('p', 'hint', fBase).textContent = 'OpenAI 兼容根地址，填到 /v1 即可（误粘 /chat/completions 会自动剥掉）';

  // 可自填模型的网关 / 自定义服务（editableModel）多一行「模型」输入，DeepSeek 这类固定适配不显示
  const fModelName = el('div', 'field', body);
  fModelName.id = 'aa-model-field';
  fModelName.hidden = true;
  el('label', 'flabel', fModelName).textContent = '模型';
  fModelName.querySelector('label').htmlFor = 'aa-model-name';
  const mrow = el('div', 'mrow', fModelName);
  const mname = el('input', '', mrow);
  mname.id = 'aa-model-name';
  mname.type = 'text';
  mname.autocomplete = 'off';
  mname.spellcheck = false;
  el('p', 'hint', fModelName).textContent = '留空即用该服务的默认模型';

  const fKey = el('div', 'field', body);
  el('label', 'flabel', fKey).textContent = 'API Key';
  fKey.querySelector('label').htmlFor = 'aa-key';
  const keyrow = el('div', 'keyrow', fKey);
  const key = el('input', '', keyrow);
  key.id = 'aa-key';
  key.type = 'password';
  key.placeholder = 'sk-…';
  key.autocomplete = 'off';
  key.spellcheck = false;
  const peek = el('button', 'peek', keyrow);
  peek.type = 'button';
  peek.id = 'aa-peek';
  peek.textContent = '显示';
  peek.setAttribute('aria-label', '显示或隐藏 API Key');
  el('p', 'hint', fKey).textContent = '仅保存在本机浏览器，答题时页面直连模型服务';

  const sw = el('label', 'switchrow', body);
  sw.htmlFor = 'aa-overwrite';
  const stxt = el('span', 'stxt', sw);
  el('b', '', stxt).textContent = '覆盖已作答';
  el('small', '', stxt).textContent = '默认跳过已答题，保留原有答案';
  const ovw = el('input', 'switch', sw);
  ovw.id = 'aa-overwrite';
  ovw.type = 'checkbox';

  const swImg = el('label', 'switchrow', body);
  swImg.htmlFor = 'aa-images';
  const stxtImg = el('span', 'stxt', swImg);
  el('b', '', stxtImg).textContent = '作答含图题';
  el('small', '', stxtImg).textContent = '需视觉模型（如 deepseek-flash），默认跳过';
  const imgs = el('input', 'switch', swImg);
  imgs.id = 'aa-images';
  imgs.type = 'checkbox';

  const start = el('button', 'start', body);
  start.id = 'start';
  start.type = 'button';
  start.textContent = '开始答题';

  const logsHead = el('div', 'logs-head', body);
  el('b', '', logsHead).textContent = '日志';
  const clear = el('button', 'clear', logsHead);
  clear.id = 'clear';
  clear.type = 'button';
  clear.textContent = '清空';
  const logs = el('div', 'logs', body);
  logs.id = 'logs';
  logs.setAttribute('role', 'log');
  logs.setAttribute('aria-live', 'polite');

  el('p', 'foot', body).textContent = '实验功能：答题中平台不反馈对错，完成后请自行核对结果。';
  el('p', 'foot', body).textContent = '文本模型看不见图片：题干/选项含图的题要么跳过，要么切到视觉模型（如 deepseek-flash）并开启「作答含图题」。';

  // —— 事件绑定 ——
  ball.addEventListener('click', () => togglePanel());
  collapse.addEventListener('click', closePanel);
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
  peek.addEventListener('click', () => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    peek.textContent = show ? '隐藏' : '显示';
  });
  const applyPreset = () => {
    const p = PRESETS[sel.value] || PRESETS.deepseek;
    fModel.querySelector('.hint').textContent = p.hint || '';
    fBase.hidden = !p.customEndpoint;
    fModelName.hidden = !p.editableModel;
    mname.placeholder = p.customEndpoint ? 'gpt-4o-mini' : (p.model || '');
    fModelName.querySelector('.hint').textContent = p.editableModel
      ? (p.customEndpoint ? '填该服务可用的模型 id' : '留空即用该服务的默认模型')
      : '';
  };
  // 恢复上次的选择：sync() 先行传入的 settings 已含全部 autoAnswer* 字段
  if (settings && PRESETS[settings.autoAnswerGateway]) sel.value = settings.autoAnswerGateway;
  burl.value = ((settings || {}).autoAnswerBaseUrl || '').trim();
  mname.value = ((settings || {}).autoAnswerModel || '').trim();
  key.value = ((settings || {}).autoAnswerApiKey || '').trim();
  ovw.checked = !!((settings || {}).autoAnswerOverwrite);
  imgs.checked = !!((settings || {}).autoAnswerImages);
  applyPreset();
  sel.addEventListener('change', () => { applyPreset(); persist(); });
  burl.addEventListener('change', persist);
  mname.addEventListener('change', persist);
  key.addEventListener('change', persist);
  ovw.addEventListener('change', persist);
  imgs.addEventListener('change', persist);
  clear.addEventListener('click', () => {
    logLines.length = 0;
    renderLogs();
  });
  start.addEventListener('click', startRun);

  document.body.appendChild(host);
  renderLogs();
  updateRunUI();
}

function unmount() {
  if (!host) return;
  host.remove();
  host = null;
  shadow = null;
  open = false;
}

/* ---------- 开始答题 ---------- */

async function startRun() {
  if (isRunning()) return;
  if (!shadow) return;
  const sel = shadow.getElementById('aa-model');
  const preset = PRESETS[sel.value] || PRESETS.deepseek;
  if (preset.disabled) { appendLog('err', `${preset.label}：该模型尚未适配`); return; }
  const burl = shadow.getElementById('aa-base');
  const baseUrl = preset.customEndpoint ? normalizeBaseUrl(burl?.value) : preset.baseUrl;
  if (preset.customEndpoint && !baseUrl) {
    appendLog('err', '请先填写 OpenAI 兼容端点（填到 /v1）');
    burl?.focus();
    return;
  }
  const model = resolveModel(preset, shadow.getElementById('aa-model-name')?.value);
  if (preset.customEndpoint && !model) {
    appendLog('err', '请先填写模型 id');
    shadow.getElementById('aa-model-name').focus();
    return;
  }
  const apiKey = shadow.getElementById('aa-key').value.trim();
  if (!apiKey) {
    appendLog('err', '请先填写 API Key（仅保存在本机）');
    shadow.getElementById('aa-key').focus();
    return;
  }
  const overwrite = shadow.getElementById('aa-overwrite').checked;
  const withImages = shadow.getElementById('aa-images').checked;
  await persist();
  const result = await handleRun({
    baseUrl,
    model,
    apiKey,
    overwrite,
    images: withImages,
    gateway: preset.gateway,
  });
  if (!result.ok && result.error === '已有一次答题在运行中') appendLog('warn', '已有一次答题在运行中');
}

/* ---------- 对外：显隐同步 ---------- */

// 由 index.js 驱动：init 后、设置变更后、路由兜底轮询时各调一次
export function sync(s) {
  settings = s || settings;
  const shouldShow = !!settings && !!settings.autoAnswer && EXAM_PROBLEMS_RE.test(location.pathname);
  if (shouldShow && !host) mount();
  if (!shouldShow && host) {
    if (isRunning()) {
      // 运行中不卸载（球上还有进度环）；面板收起即可
      if (shadow) closePanel();
    } else {
      unmount();
    }
  }
}

// 由 index.js 在 init 时注册一次
export function init() {
  setEventSink(onEvent);
  unregisterSink = () => setEventSink(null);
  document.addEventListener('visibilitychange', () => {
    // 文档回到前台时刷新一次状态（运行可能在后台完成）
    if (!document.hidden && shadow) updateRunUI();
  });
}

// 预览页 / 重复注入防御：同一文档只初始化一次
let armed = false;
export function armOnce() {
  if (armed) return;
  armed = true;
  init();
}
