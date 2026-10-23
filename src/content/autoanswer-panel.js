/* 自动答题悬浮球与面板（实验）。
 *
 * 弹窗只保留总开关（settings.autoAnswer）；题目列表页（/exam/problems…）挂出悬浮球，
 * 点开为答题面板：模型适配选择（DeepSeek / OpenCode Go）、API Key、覆盖已作答、
 * 开始/中止答题（运行中按钮变身「中止答题」）、运行日志（可清空）。面板用 Shadow DOM 隔离——不吸 PTA 页面的样式，也不把自己的
 * 类名泄进页面；设计令牌与设置弹窗、注入样式同源（PTA 实测令牌，主色 hsl(212,89%,53%)，
 * 暗色跟随 PTA 自己的 .dark 类而不是系统）。
 *
 * 运行本体在 autoanswer.js：面板只是入口与事件流的展示层（setEventSink），
 * 关掉面板 / 翻到别的页面都不打断运行；运行中悬浮球常驻并显示整体进度环。
 */
import { loadSettings, saveSettings } from '../shared/settings.js';
import {
  abortRun, clearPersistedLog, COMPILER_LABELS, EXAM_PROBLEMS_RE, fetchAllowedCompilers,
  handleRun, isRunning, normalizeBaseUrl, persistLogLine, readPersistedLog, setEventSink,
} from './autoanswer.js';

// 模型适配 presets：往这里加即可挂进面板下拉。
// gateway 对应 autoanswer.js chatOnce 的协议分支：opencode 走 background 转发
// （网关不放行页面 CORS）并附加 x-opencode-session 会话头；网关里只有 chat-completions
// 协议的模型系可标 editableModel——GLM / Kimi / DeepSeek / LongCat / MiMo 等走
// /chat/completions（本引擎支持），Claude / MiniMax M3 / Qwen3.8-3.7 走 Messages、
// GPT / Grok / Muse Spark 走 Responses、Gemini 走 generateContent，均暂不解析。
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
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    model: 'glm-5.3-flash',
    gateway: 'opencode',
    editableModel: true, // 网关模型可自填（面板多一行「模型」输入），留空用默认
    hint: 'OpenCode Go · 仅 chat 系模型（glm / kimi / deepseek / longcat / mimo）',
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

// —— 按服务读写的 API Key（autoAnswerApiKeys：键 = PRESETS 键，每个服务各存一把） ——

// 读某服务当前的 Key（键不存在/旧版存储形态皆回空串）
export function currentKey(s, gateway) {
  const gw = PRESETS[gateway] ? gateway : 'deepseek';
  const map = (s || {}).autoAnswerApiKeys;
  return (map && typeof map === 'object' && !Array.isArray(map)) ? String(map[gw] ?? '').trim() : '';
}

// 写：返回把 value 归档到 gateway 名下后的设置对象（只动当前服务的键，其余原样保留；
// 不改传入对象——它可能是与 DEFAULTS 共享引用的合并结果）
export function withKeyFor(s, gateway, value) {
  const gw = PRESETS[gateway] ? gateway : 'deepseek';
  const prior = (s || {}).autoAnswerApiKeys;
  const map = (prior && typeof prior === 'object' && !Array.isArray(prior)) ? { ...prior } : {};
  map[gw] = String(value ?? '').trim();
  return { ...s, autoAnswerApiKeys: map };
}

const MAX_LOG_LINES = 200; // 日志上限：防长跑爆内存，超出丢最旧

const CSS = `
:host { all: initial; }
:host * { box-sizing: border-box; } /* all:initial 重置成 content-box，width:100% + padding 会横向溢出 */
.wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  font: 13px/1.5 Harmony, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "Noto Sans", sans-serif; /* PTA 的字体栈 */
  color: var(--text); }
/* 拖拽位置记忆见 js 的 applyPos：right/bottom 被 storage.local 的 {r,b} inline 覆盖，
 * 球不放 left/top —— 窗口变大时球仍贴右下角附近，不会飘去视野外 */

/* ---------- 悬浮球 ---------- */
/* PTA 没有悬浮球这一形制：取它的实心主色按钮 + 浮层投影，去掉原来的渐变与蓝色光晕 */
.ball { position: relative; width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
  cursor: grab; touch-action: none; /* 触屏拖球不滚页面 */
  display: grid; place-items: center; color: #fff;
  background: var(--accent);
  box-shadow: var(--shadow-md);
  transition: filter var(--trs); }
.ball:hover { filter: brightness(.85); }     /* PTA 按钮的悬停口径 */
.ball:active { transform: translateY(1px); } /* PTA 按钮的按下口径 */
.ball:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.ball .glyph { position: relative; z-index: 1; font-size: 18px; font-weight: 700; }
.ring { position: absolute; inset: -1px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .bg { stroke: rgba(255, 255, 255, .28); }
.ring .fg { stroke: var(--ok); stroke-linecap: round; stroke-dasharray: 138.2; stroke-dashoffset: 138.2; transition: stroke-dashoffset .25s ease; }
.wrap.dragging .ball { cursor: grabbing; transition: none; }

/* ---------- 面板 ---------- */
.panel { position: absolute; right: 0; bottom: 56px; width: 324px; max-width: calc(100vw - 24px);
  max-height: calc(100vh - 90px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border: 1px solid var(--hairline); border-radius: 8px; overflow: hidden;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, .1), 0 8px 10px -6px rgba(0, 0, 0, .1); /* PTA 浮层（toast / 下拉菜单）的投影 */
  transform-origin: 100% 100%; animation: aa-pop .18s ease; }
/* 球被拖走后按屏幕象限换边展开（openPanel 挂 pos-left / pos-top）：右半 → 默认朝左开，
 * 左半 → 朝右开；下半 → 默认往上弹，上半 → 往下弹 */
.wrap.pos-left .panel { right: auto; left: 0; transform-origin: 0 100%; }
.wrap.pos-top .panel { bottom: auto; top: 56px; transform-origin: 100% 0; }
.wrap.pos-left.pos-top .panel { transform-origin: 0 0; }
/* display:flex 会盖过 UA 的 [hidden]，必须显式收回（否则收起面板无效、面板常显） */
.panel[hidden] { display: none; }
@keyframes aa-pop { from { transform: scale(.94) translateY(5px); opacity: 0; } }

/* ---------- 分区标签（答题配置 / 模型配置）---------- 
   形制取 PTA 的页签（活跃题目集 / 所有题目集）：2px 下边框 + 主色，非选中项悬停也转主色 */
.tabs { display: flex; gap: 8px; padding: 0 14px; }
.tabs[role="tablist"] { border-bottom: 1px solid var(--hairline); }
.tab { flex: 1; min-height: 38px; padding: 8px; margin-bottom: -1px;
  border: 0; border-bottom: 2px solid transparent; border-radius: 0;
  background: none; color: var(--text); font: inherit; font-size: 15px;
  cursor: pointer; transition: color var(--trs), border-color var(--trs); }
.tab:hover { color: var(--accent); border-bottom-color: var(--accent); }
.tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid var(--hairline); }
.head .title { font-weight: 700; font-size: 15px; }
/* 状态胶囊：PTA 的胶囊配方（12px 圆角 / 13px 字 / 色值 10% 底 / 同色文字） */
.pill { flex: none; font-size: 13px; line-height: 16px; padding: 4px 12px; border-radius: 12px;
  background: var(--accent-soft); color: var(--accent); }
.pill.run { position: relative; padding-left: 24px; }
.pill.run::before { content: ""; position: absolute; left: 12px; top: 50%; width: 6px; height: 6px;
  margin-top: -3px; border-radius: 50%; background: currentColor; animation: aa-pulse 1.1s ease infinite; }
@keyframes aa-pulse { 50% { opacity: .35; } }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.err { background: var(--err-soft); color: var(--err); }
.collapse { flex: none; width: 32px; height: 32px; border: 0; border-radius: 8px;
  background: none; color: var(--text-3); font-size: 16px; line-height: 1; cursor: pointer;
  display: grid; place-items: center; transition: background-color var(--trs), color var(--trs); }
.collapse:hover { background: var(--bg-light); color: var(--text); }
.collapse:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ---------- 分页容器（两个分区共用分页滚动） ---------- */
.pages { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pages > .page[hidden] { display: none; }
.page { flex: 1; min-height: 0; padding: 12px 14px; overflow: auto;
  display: flex; flex-direction: column; gap: 12px; }
/* 分区是可滚动的 flex 列：子项一律不参与收缩，否则定高的按钮/输入框/日志会被压扁
   （实测不写这条时 32px 的主按钮被挤成 24.5px），超出部分交给 overflow 滚动 */
.page > * { flex: none; }

.field .flabel { display: block; margin-bottom: 4px; font-size: 13px; line-height: 16px; color: var(--text-2); }
/* 尺寸取 PTA 的表单控件：32px 高 / 4px 圆角 / #ced4da 边框 / 聚焦「主色边框 + 2px 环」 */
select { appearance: none; -webkit-appearance: none; width: 100%; height: 32px; padding: 0 30px 0 12px;
  border: 1px solid var(--input-border); border-radius: 4px;
  background: var(--bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999999' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 12px center;
  color: var(--text); font: inherit; font-size: 15px; cursor: pointer;
  transition: border-color var(--trs), box-shadow var(--trs); }
select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }
select:disabled { background: var(--bg-light); cursor: not-allowed; }
.hint { margin: 4px 0 0; font-size: 13px; line-height: 16px; color: var(--text-3); }

.keyrow { position: relative; }
.keyrow input, .mrow input { width: 100%; height: 32px; padding: 0 12px; border: 1px solid var(--input-border);
  border-radius: 4px; background: var(--bg); color: var(--text); font: inherit;
  transition: border-color var(--trs), box-shadow var(--trs); }
.keyrow input { padding-right: 56px; /* 右侧留给显示/隐藏按钮 */
  /* 用 text-security 遮罩而不是 type=password：Chrome 密码管理器只盯真密码框，
   * 真密码框的值一变就弹「要更新密码吗？」（把 API Key 当成 PTA 账号的新密码） */
  -webkit-text-security: disc; }
.keyrow input.reveal { -webkit-text-security: none; } /* 「显示」态：明文回显 */
.keyrow input::placeholder, .mrow input::placeholder { color: var(--text-3); font-style: italic; } /* PTA 的占位符样式 */
.keyrow input:focus-visible, .mrow input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }
.keyrow input:disabled, .mrow input:disabled { background: var(--bg-light); cursor: not-allowed; }
.keyrow .peek { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  height: 24px; padding: 0 8px; border: none; border-radius: 4px; background: none;
  color: var(--text-3); font-size: 13px; cursor: pointer;
  transition: background-color var(--trs), color var(--trs); }
.keyrow .peek:hover { color: var(--accent); background: var(--bg-light); }

.switchrow { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  cursor: pointer; min-height: 26px; }
.switchrow .stxt { display: flex; flex-direction: column; }
.switchrow .stxt b { font-weight: 400; font-size: 15px; line-height: 20px; } /* PTA 行标题：15/20、常规字重 */
.switchrow .stxt small { font-size: 13px; line-height: 16px; color: var(--text-3); }
.switch { appearance: none; -webkit-appearance: none; flex: none; width: 36px; height: 20px;
  margin: 0; border-radius: 9999px; background: var(--bg-normal); cursor: pointer; position: relative;
  transition: background var(--trs); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
  transition: transform var(--trs); }
.switch:checked { background: var(--accent); }
.switch:checked::after { transform: translateX(16px); }
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:disabled, button:disabled { opacity: .6; cursor: not-allowed; } /* PTA 的禁用口径 */

/* 主按钮：PTA 的实心按钮（主色底白字 / 2rem 高 / 4px 圆角），悬停压暗、按下 1px */
.start { width: 100%; height: 32px; padding: 0 15px; border: 1px solid transparent; border-radius: 4px;
  background: var(--accent); color: #fff; font: inherit; font-size: 15px; cursor: pointer;
  filter: brightness(var(--brightness, 1));
  transition: filter .2s ease; }
.start:hover:not(:disabled) { --brightness: .85; }
.start:not(:disabled):active { transform: translateY(1px); }
.start:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 运行中同一按钮变身「中止答题」：实心红（PTA danger）与主色开始态一眼可分 */
.start.stop { background: var(--err); color: #fff; }

.logs-head { display: flex; align-items: center; justify-content: space-between; }
.logs-head b { font-size: 13px; line-height: 16px; font-weight: 500; color: var(--text-2); }
.clear { border: 0; border-radius: 4px; background: none; color: var(--text-3);
  font-size: 13px; padding: 3px 8px; cursor: pointer;
  transition: background-color var(--trs), color var(--trs); }
.clear:hover:not(:disabled) { background: var(--bg-light); color: var(--err); }
.clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* 日志是数据面：保留等宽与紧凑行高，外框、底色与级别配色换成 PTA 的令牌 */
.logs { height: 138px; overflow: auto; overscroll-behavior: contain; padding: 8px 10px;
  border: 1px solid var(--hairline); border-radius: 4px; background: var(--bg-light);
  font: 12px/1.7 ui-monospace, "Cascadia Mono", Consolas, monospace;
  white-space: pre-wrap; word-break: break-all; color: var(--text-2); }
.logs .line { margin: 0 0 1px; }
.logs .line::-webkit-scrollbar, .body::-webkit-scrollbar { width: 8px; }
.logs::-webkit-scrollbar-thumb, .body::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 4px; }
.logs .t { color: var(--text-3); font-size: 11px; margin-right: 6px; }
.logs .lv-ok { color: var(--ok); }
.logs .lv-err { color: var(--err); }
.logs .lv-warn { color: var(--warn); }
.foot { margin: 0; font-size: 13px; line-height: 16px; color: var(--text-3); }

@media (prefers-reduced-motion: reduce) {
  .ball, .tab, .collapse, .switch, .peek, .clear { transition: none; }
  .panel { animation: none; }
  .wrap.dragging .ball { transition: none; }
  .pill.run::before { animation: none; }
  .ring .fg { transition: none; }
}

/* ---------- 双主题：令牌与设置弹窗、注入样式同源（2026-10-16 实测自 pintia.cn） ----------
   跟随 **PTA 自己的 .dark 类**（由 js 的 syncTheme 镜像到 host 上）：PTA 用类切换主题，
   这比 prefers-color-scheme 准——系统是暗色但用户在 PTA 里选了浅色时，面板不该自作主张变暗。 */
:host {
  --bg: hsl(0, 0%, 100%);
  --bg-light: hsl(211, 20%, 97%);
  --bg-normal: hsl(211, 20%, 93%);
  --hairline: hsla(0, 0%, 0%, .06);
  --accent: hsl(212, 89%, 53%);
  --accent-soft: rgba(28, 128, 242, .1);
  --accent-ring: rgba(10, 73, 145, .25); /* PTA 输入框聚焦环的原始字面量（明暗同值） */
  --text: hsl(0, 0%, 25%);
  --text-2: hsl(0, 0%, 45%);
  --text-3: hsl(0, 0%, 60%);
  --input-border: #ced4da;
  --ok: hsl(100, 60%, 47%); --ok-soft: rgba(96, 192, 48, .12);
  --err: hsl(3, 68%, 53%); --err-soft: rgba(217, 62, 54, .12);
  --warn: hsl(35, 90%, 50%);
  --scroll: rgba(0, 0, 0, .12);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, .1), 0 2px 4px -2px rgba(0, 0, 0, .1);
  --trs: .15s cubic-bezier(.4, 0, .2, 1);
}
:host(.dark) {
  --bg: hsl(0, 0%, 25%);
  --bg-light: hsl(0, 0%, 28%);
  --bg-normal: hsl(0, 0%, 31%);
  --hairline: hsla(0, 0%, 100%, .06);
  --accent: hsl(212, 100%, 60%);
  --accent-soft: rgba(51, 140, 255, .12);
  --text: hsl(0, 0%, 75%);
  --text-2: hsl(0, 0%, 60%);
  --text-3: hsl(0, 0%, 50%);
  --input-border: hsl(0, 0%, 50%);
  --scroll: rgba(255, 255, 255, .14);
  --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, .3), 0 2px 4px -2px rgba(0, 0, 0, .3);
}
`;

let host = null;        // shadow host（body 直挂，显隐由 sync 控制）
let shadow = null;
let settings = null;
let open = false;
let activePage = 'answer'; // 分区标签：'answer'（答题配置，默认）| 'model'（模型配置）；会话内记忆
let themeObserver = null;  // 跟着 PTA 的 .dark 走：观察 documentElement 的 class 变化

// 悬浮球位置（拖拽记忆）：{r, b} = 距右/下边距 px，存 storage.local——
// 屏幕几何因设备而异，不进 sync；null = 用 CSS 默认（右下 18px）
let ballPos = null;
const BALL_SIZE = 46;
const BALL_MARGIN = 18;   // 拖拽吸附极限：至少留出一半球身在外面
const POS_KEY = 'autoAnswerBallPos';

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

/* ---------- 悬浮球位置：应用 / 夹取 / 记忆 ---------- */

// 位置夹取：保证球整体在视口内，只留 MARGIN 的吸附空间
export function clampBallPos(p, innerW, innerH) {
  const num = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
  const minX = BALL_MARGIN, minY = BALL_MARGIN;
  const maxX = Math.max(minX, innerW - BALL_SIZE - BALL_MARGIN);
  const maxY = Math.max(minY, innerH - BALL_SIZE - BALL_MARGIN);
  return { r: Math.min(Math.max(num(p?.r), minX), maxX), b: Math.min(Math.max(num(p?.b), minY), maxY) };
}

function applyBallPos() {
  if (!shadow || !ballPos) return;
  const wrap = shadow.querySelector('.wrap');
  if (!wrap) return;
  wrap.style.right = `${ballPos.r}px`;
  wrap.style.bottom = `${ballPos.b}px`;
}

// 位置是设备/窗口属性，不随 settings 走 sync；非扩展环境（预览页）无记忆即默认位
function loadBallPos() {
  try {
    return chrome.storage.local.get({ [POS_KEY]: null }).then(v => v?.[POS_KEY] || null);
  } catch (_) { return Promise.resolve(null); }
}

function saveBallPos() {
  try { chrome.storage.local.set({ [POS_KEY]: ballPos }); } catch (_) { /* 记不住就只在本页生效 */ }
}

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

// persist：引擎事件在 fire 时已落 sessionStorage（跨页日志），面板侧只负责展示；
// 面板自己的校验/中止提示没有经过引擎，默认也要落盘，否则切页后消失。
function appendLog(level, text, at = null, persist = true) {
  const t = at || timeStr();
  logLines.push({ level, text, t });
  if (persist) persistLogLine(level, text, t);
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  if (!shadow) return;
  const box = shadow.getElementById('logs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const line = el('div', 'line', box);
  const tag = { ok: '✓', err: '✕', warn: '!' }[level] || '·';
  line.innerHTML = `<span class="t">${t}</span><span class="lv-${level}">${tag}</span> `;
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
  if (ev.kind === 'log-clear') {
    logLines.length = 0;
    renderLogs();
    return;
  }
  if (ev.kind === 'log') return appendLog(ev.level, ev.text, null, false); // 引擎已持久化
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
      if (ev.error) appendLog('err', ev.error, null, false); // 引擎已随日志落盘
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
  // 开始按钮：运行中变身「中止答题」（进度数字在状态胶囊上），随时可叫停，不能只能等它跑完
  if (start) {
    start.disabled = false;
    start.classList.toggle('stop', running);
    start.textContent = running ? '中止答题' : '开始答题';
  }
}

/* ---------- 挂载与卸载 ---------- */

// PTA 用 .dark 类切主题，且**挂在 <body> 上而不是 <html>**（2026-10-16 实测）：
// 把页面主题镜像到 host 上（面板跟随页面，不跟随系统），两处都看，哪个有算哪个
function syncTheme() {
  if (!host) return;
  const dark = document.documentElement.classList.contains('dark') || document.body.classList.contains('dark');
  host.classList.toggle('dark', dark);
}

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

  // —— 分区标签：模型配置（服务/端点/模型/API Key）与答题配置分两页 ——
  const tabbar = el('div', 'tabs', panel);
  tabbar.setAttribute('role', 'tablist');
  tabbar.setAttribute('aria-label', '面板分区');
  const tabAnswer = el('button', 'tab', tabbar);
  tabAnswer.id = 'tab-answer';
  tabAnswer.setAttribute('role', 'tab');
  tabAnswer.setAttribute('aria-controls', 'page-answer');
  tabAnswer.textContent = '答题配置';
  const tabModel = el('button', 'tab', tabbar);
  tabModel.id = 'tab-model';
  tabModel.setAttribute('role', 'tab');
  tabModel.setAttribute('aria-controls', 'page-model');
  tabModel.textContent = '模型配置';

  // —— 分页容器：答题配置（默认）与模型配置 ——
  const pages = el('div', 'pages', panel);
  const pageAnswer = el('div', 'page', pages);
  pageAnswer.id = 'page-answer';
  pageAnswer.setAttribute('role', 'tabpanel');
  pageAnswer.setAttribute('aria-labelledby', 'tab-answer');
  const pageModel = el('div', 'page', pages);
  pageModel.id = 'page-model';
  pageModel.setAttribute('role', 'tabpanel');
  pageModel.setAttribute('aria-labelledby', 'tab-model');

  const fModel = el('div', 'field', pageModel);
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
  const fBase = el('div', 'field', pageModel);
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
  const fModelName = el('div', 'field', pageModel);
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

  // 编程题语言：默认跟随编辑器当前语言；select 选项 = 本题集允许语言（exams 白名单 + 静态显示名映射）
  const fLang = el('div', 'field', pageAnswer);
  el('label', 'flabel', fLang).textContent = '语言（编程题）';
  fLang.querySelector('label').htmlFor = 'aa-lang';
  const lsel = el('select', '', fLang);
  lsel.id = 'aa-lang';
  const oFollow = el('option', '', lsel);
  oFollow.value = '';
  oFollow.textContent = '跟随编辑器当前语言';
  el('p', 'hint', fLang).textContent = '本题集允许的语言；作答按所选语言出码并提交评测';

  const fKey = el('div', 'field', pageModel);
  el('label', 'flabel', fKey).textContent = 'API Key';
  fKey.querySelector('label').htmlFor = 'aa-key';
  const keyrow = el('div', 'keyrow', fKey);
  const key = el('input', '', keyrow);
  key.id = 'aa-key';
  // 必须 type=text：真密码框会触发浏览器密码管理器的「要更新密码吗？」（API Key 被当成
  // PTA 账号新密码）；遮罩走 .keyrow input 的 -webkit-text-security，「显示」切 reveal 类
  key.type = 'text';
  key.placeholder = 'sk-…';
  key.autocomplete = 'off';
  key.spellcheck = false;
  const peek = el('button', 'peek', keyrow);
  peek.type = 'button';
  peek.id = 'aa-peek';
  peek.textContent = '显示';
  peek.setAttribute('aria-label', '显示或隐藏 API Key');
  el('p', 'hint', fKey).textContent = '每个服务各存一把 Key，切服务自动带出；仅保存在本机浏览器';

  const sw = el('label', 'switchrow', pageAnswer);
  sw.htmlFor = 'aa-overwrite';
  const stxt = el('span', 'stxt', sw);
  el('b', '', stxt).textContent = '覆盖已作答';
  el('small', '', stxt).textContent = '默认跳过已答题，保留原有答案';
  const ovw = el('input', 'switch', sw);
  ovw.id = 'aa-overwrite';
  ovw.type = 'checkbox';

  const swImg = el('label', 'switchrow', pageAnswer);
  swImg.htmlFor = 'aa-images';
  const stxtImg = el('span', 'stxt', swImg);
  el('b', '', stxtImg).textContent = '作答含图题';
  el('small', '', stxtImg).textContent = '需视觉模型（如 deepseek-flash），默认跳过；仅客观题';
  const imgs = el('input', 'switch', swImg);
  imgs.id = 'aa-images';
  imgs.type = 'checkbox';

  const start = el('button', 'start', pageAnswer);
  start.id = 'start';
  start.type = 'button';
  start.textContent = '开始答题';

  const logsHead = el('div', 'logs-head', pageAnswer);
  el('b', '', logsHead).textContent = '日志';
  const clear = el('button', 'clear', logsHead);
  clear.id = 'clear';
  clear.type = 'button';
  clear.textContent = '清空';
  const logs = el('div', 'logs', pageAnswer);
  logs.id = 'logs';
  logs.setAttribute('role', 'log');
  logs.setAttribute('aria-live', 'polite');

  el('p', 'foot', pageAnswer).textContent = '实验功能：答题中平台不反馈对错，完成后请自行核对结果。';
  el('p', 'foot', pageAnswer).textContent = '文本模型看不见图片：客观题含图题要么跳过，要么切到视觉模型（如 deepseek-flash）并开启「作答含图题」；编程题不接图片输入，含图题按文字题面作答并照常提交。';
  el('p', 'foot', pageAnswer).textContent = '编程题提交即评测：作答会实时生成提交记录与作答度，成绩由评测结果决定，与客观题判分路径不同。';

  // —— 事件绑定 ——
  // 拖拽与点击共用球：pointer 位移超过阈值才算拖动（拖完抑制紧随的 click，防松手把面板又开合一次）
  let drag = null;
  let suppressClickUntil = 0;
  ball.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !e.isPrimary) return; // 左键拖球；触屏只认单指
    const r = ball.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
    try { ball.setPointerCapture(e.pointerId); } catch (_) { /* 捕获失败退化为球内拖动 */ }
  });
  ball.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return; // 位移阈值内仍是点击
      drag.moved = true;
      wrap.classList.add('dragging');
    }
    ballPos = clampBallPos({
      r: window.innerWidth - (e.clientX - drag.dx) - BALL_SIZE,
      b: window.innerHeight - (e.clientY - drag.dy) - BALL_SIZE,
    }, window.innerWidth, window.innerHeight);
    applyBallPos();
  });
  const endDrag = () => { if (drag) wrap.classList.remove('dragging'); drag = null; };
  ball.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const wasMoved = drag.moved;
    endDrag();
    if (!wasMoved) return; // 没拖动 → 交给下面的 click 开合面板
    suppressClickUntil = Date.now() + 400;
    saveBallPos();
    if (open) placePanel(); // 拖到另一半屏幕后，面板锚点跟着换边（开着时）
  });
  ball.addEventListener('pointercancel', endDrag);
  ball.addEventListener('click', () => {
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
    togglePanel();
  });
  collapse.addEventListener('click', closePanel);
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });
  // 分区标签：点击换页（完整 tabs 语义 = roving tabindex + 方向键/Home/End）
  tabAnswer.addEventListener('click', () => switchTab('answer'));
  tabModel.addEventListener('click', () => switchTab('model'));
  tabbar.addEventListener('keydown', e => {
    const cur = activePage === 'model' ? tabModel : tabAnswer;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = cur === tabAnswer ? tabModel : tabAnswer;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = cur === tabModel ? tabAnswer : tabModel;
    else if (e.key === 'Home') next = tabAnswer;
    else if (e.key === 'End') next = tabModel;
    if (!next || next === cur) return;
    e.preventDefault();
    switchTab(next === tabModel ? 'model' : 'answer');
    next.focus();
  });
  switchTab(activePage); // 恢复上次所在分区（须在两个分页字段建好之后调用）
  peek.addEventListener('click', () => {
    const show = !key.classList.contains('reveal');
    key.classList.toggle('reveal', show);
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
  key.value = currentKey(settings, sel.value); // 按当前服务的映射取回上文 Key
  ovw.checked = !!((settings || {}).autoAnswerOverwrite);
  imgs.checked = !!((settings || {}).autoAnswerImages);
  // 语言选项异步填充（拉本题集白名单后再恢复上次固定值）
  refreshLangOptions();
  applyPreset();
  // 服务切换：手头输入先归档给切换前的服务（keyOwner），再换上新服务的 Key；其余字段照旧 persist
  let keyOwner = sel.value;
  sel.addEventListener('change', async () => {
    await saveKeyFor(keyOwner, key.value);
    keyOwner = sel.value;
    applyPreset();
    const fresh = await loadSettings();
    key.value = currentKey(fresh, sel.value);
    await persist();
  });
  burl.addEventListener('change', persist);
  mname.addEventListener('change', persist);
  key.addEventListener('change', persist);
  lsel.addEventListener('change', persist);
  ovw.addEventListener('change', persist);
  imgs.addEventListener('change', persist);
  clear.addEventListener('click', () => {
    clearPersistedLog(); // 清空要跨页生效，否则下一页又把历史回放回来
    logLines.length = 0;
    renderLogs();
  });
  // 同一按钮双职责：待机点 = 开始答题；运行中点 = 中止（引擎断在途请求、停拉新题）
  start.addEventListener('click', () => {
    if (isRunning()) {
      appendLog('warn', abortRun() ? '已请求中止，正在停止…' : '当前没有正在运行的答题');
      return;
    }
    startRun();
  });

  syncTheme(); // 先把 PTA 当前主题镜像到 host 上再挂载，避免先闪一下亮色
  themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] }); // 实测暗色类在 body 上
  document.body.appendChild(host);
  // 跨页日志：编程题续跑每题整页装载，先把 sessionStorage 里的历史回放出来
  if (!logLines.length) logLines.push(...readPersistedLog().slice(-MAX_LOG_LINES));
  renderLogs();
  updateRunUI();
  // 恢复上次拖拽位置（异步回填；未拖过则保持 CSS 默认右下）
  loadBallPos().then(p => {
    if (!p || !shadow) return;
    ballPos = clampBallPos(p, window.innerWidth, window.innerHeight);
    applyBallPos();
  });
}

function unmount() {
  if (!host) return;
  themeObserver?.disconnect();
  themeObserver = null;
  host.remove();
  host = null;
  shadow = null;
  open = false;
  langPsId = null; // 下次挂载重新拉本题集的语言白名单
}

/* ---------- 语言选项（编程题：本题集允许语言白名单） ---------- */

let langPsId = null; // 已填充过选项的题集 key（3s 轮询防重拉）
async function refreshLangOptions() {
  if (!shadow) return;
  const psId = (location.pathname.match(EXAM_PROBLEMS_RE) || [])[1];
  if (!psId || langPsId === psId) return;
  langPsId = psId;
  const lsel = shadow.getElementById('aa-lang');
  if (!lsel) return;
  const want = (settings || {}).autoAnswerLanguage || '';
  let allowed = null;
  try { allowed = await fetchAllowedCompilers(psId); } catch (_) { /* 拉不到退化静态表 */ }
  if (!shadow) return; // 拉取期间面板可能已被卸载
  const ids = Array.isArray(allowed) && allowed.length ? allowed : Object.keys(COMPILER_LABELS);
  while (lsel.options.length > 1) lsel.remove(1);
  for (const id of ids) {
    const o = el('option', '', lsel);
    o.value = id;
    o.textContent = COMPILER_LABELS[id] || id;
  }
  lsel.value = [...lsel.options].some(o => o.value === want) ? want : '';
  if (want && lsel.value !== want) {
    appendLog('warn', `上次固定语言「${COMPILER_LABELS[want] || want}」不在本题集允许列表，已改回跟随当前`);
  }
}

function togglePanel() {
  if (!shadow) return;
  open ? closePanel() : openPanel();
}

/* ---------- 分区切换（答题配置 / 模型配置） ---------- */

function switchTab(name) {
  if (!shadow) return;
  activePage = name === 'model' ? 'model' : 'answer';
  const model = activePage === 'model';
  const a = shadow.getElementById('page-answer');
  const m = shadow.getElementById('page-model');
  if (a) a.hidden = model;
  if (m) m.hidden = !model;
  const tA = shadow.getElementById('tab-answer');
  const tM = shadow.getElementById('tab-model');
  if (tA) { tA.setAttribute('aria-selected', String(!model)); tA.tabIndex = model ? -1 : 0; }
  if (tM) { tM.setAttribute('aria-selected', String(model)); tM.tabIndex = model ? 0 : -1; }
}

// 面板随球所在象限换边：球在右半屏 → 默认朝左展开，左半屏 → 朝右；
// 下半屏 → 默认往上弹，上半屏 → 往下弹（CSS 的 pos-left / pos-top）
function placePanel() {
  if (!shadow) return;
  const wrapEl = shadow.querySelector('.wrap');
  if (!wrapEl) return;
  const cx = window.innerWidth - (ballPos?.r ?? 18) - BALL_SIZE / 2;
  const cy = window.innerHeight - (ballPos?.b ?? 18) - BALL_SIZE / 2;
  wrapEl.classList.toggle('pos-left', cx < window.innerWidth / 2);
  wrapEl.classList.toggle('pos-top', cy < window.innerHeight / 2);
}

function openPanel() {
  if (!shadow) return;
  const panel = shadow.getElementById('panel');
  const ball = shadow.getElementById('ball');
  placePanel();
  panel.hidden = false;
  ball.setAttribute('aria-expanded', 'true');
  open = true;
  updateRunUI();
  // 聚焦当前分区页的第一个控件（答题配置=语言 select，模型配置=服务 select）
  const pane = shadow.getElementById(activePage === 'model' ? 'page-model' : 'page-answer');
  const first = pane?.querySelector('select, input, button');
  if (first) first.focus();
}

function closePanel() {
  if (!shadow) return;
  const panel = shadow.getElementById('panel');
  const ball = shadow.getElementById('ball');
  if (panel) panel.hidden = true;
  if (ball) {
    ball.setAttribute('aria-expanded', 'false');
    ball.focus();
  }
  open = false;
}

/* ---------- 配置持久化（与弹窗/其他入口合并写，避免互相抹掉） ---------- */

// 把 value 归档到指定服务名下（切换服务时先把切换前的输入归回去用）
async function saveKeyFor(gateway, value) {
  try {
    const fresh = await loadSettings();
    const next = withKeyFor(fresh, gateway, value);
    await saveSettings(next);
    settings = next; // 面板闭包里的 settings 同步，后续 currentKey 读到一致的映射
  } catch (_) { /* 存储失败不阻断 UI */ }
}

async function persist() {
  if (!shadow) return;
  const apiKey = shadow.getElementById('aa-key').value.trim();
  const overwrite = shadow.getElementById('aa-overwrite').checked;
  const withImages = shadow.getElementById('aa-images').checked;
  const gw = shadow.getElementById('aa-model');
  const gateway = PRESETS[gw.value] ? gw.value : 'deepseek';
  const baseUrl = (shadow.getElementById('aa-base')?.value || '').trim(); // 「自定义」才用得上，存着无妨
  const model = (shadow.getElementById('aa-model-name')?.value || '').trim();
  const lang = shadow.getElementById('aa-lang');
  const language = lang ? lang.value.trim() : '';
  try {
    const fresh = await loadSettings();
    // Key 归档进当前服务的名下（withKeyFor 只动这一个键，其他服务的 Key 原样保留）
    await saveSettings({ ...withKeyFor(fresh, gateway, apiKey), autoAnswerOverwrite: overwrite, autoAnswerImages: withImages, autoAnswerGateway: gateway, autoAnswerBaseUrl: baseUrl, autoAnswerModel: model, autoAnswerLanguage: language });
  } catch (_) { /* 存储失败不阻断 UI */ }
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
    switchTab('model'); // 出错字段在模型配置页：先切过去再聚焦
    burl?.focus();
    return;
  }
  const model = resolveModel(preset, shadow.getElementById('aa-model-name')?.value);
  if (preset.customEndpoint && !model) {
    appendLog('err', '请先填写模型 id');
    switchTab('model');
    shadow.getElementById('aa-model-name').focus();
    return;
  }
  const apiKey = shadow.getElementById('aa-key').value.trim();
  if (!apiKey) {
    appendLog('err', '请先填写 API Key（仅保存在本机）');
    switchTab('model');
    shadow.getElementById('aa-key').focus();
    return;
  }
  const overwrite = shadow.getElementById('aa-overwrite').checked;
  const withImages = shadow.getElementById('aa-images').checked;
  const language = (shadow.getElementById('aa-lang')?.value || '').trim();
  await persist();
  const result = await handleRun({
    baseUrl,
    model,
    apiKey,
    overwrite,
    images: withImages,
    gateway: preset.gateway,
    language,
  });
  if (!result.ok && result.error === '已有一次答题在运行中') appendLog('warn', '已有一次答题在运行中');
}

/* ---------- 对外：显隐同步 ---------- */

// 由 index.js 驱动：init 后、设置变更后、路由兜底轮询时各调一次
export function sync(s) {
  settings = s || settings;
  const shouldShow = !!settings && !!settings.autoAnswer && EXAM_PROBLEMS_RE.test(location.pathname);
  if (shouldShow && !host) mount();
  if (shouldShow) refreshLangOptions(); // 换题集后语言白名单要重拉（内部有 psId 防抖）
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
  // 窗口缩放后球可能被挤出视口，重新夹取（面板开着的话锚点也跟着重算）
  window.addEventListener('resize', () => {
    if (!ballPos || !shadow) return;
    ballPos = clampBallPos(ballPos, window.innerWidth, window.innerHeight);
    applyBallPos();
    if (open) placePanel();
  });
}

// 预览页 / 重复注入防御：同一文档只初始化一次
let armed = false;
export function armOnce() {
  if (armed) return;
  armed = true;
  init();
}
