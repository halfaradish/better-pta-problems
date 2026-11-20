/* 自动答题悬浮球与面板（实验）。
 *
 * 弹窗只保留总开关（settings.autoAnswer）；题目列表页（/exam/problems…）挂出悬浮球，
 * 点开为答题面板。面板是单页「行式控制台」：左列 56px 短标签 + 右列 PTA 表单控件，
 * 版面按「模型配置 / 答题配置」两组分界摆开（两类配置不混排，第二组头顶有 hairline）——
 * 模型组：服务 + API Key（自定义服务另出「端点/模型」行）；答题组：已答处理 + 含图题 +
 * 高级设置抽屉（语言/并发这类低频调参收进 <details>，收起态右侧小字常显当前值）。
 * 面板不写说明文字：字段解释放代码注释与 title 悬停提示，运行细节由引擎日志现报
 * （旧版两页签 + 四条灰字 hint + 三段页脚「说明书」已在 v0.12.4 删净）。
 * 面板用 Shadow DOM 隔离——不吸 PTA 页面的样式，也不把自己的类名泄进页面；
 * 设计令牌与设置弹窗、注入样式同源（PTA 实测令牌，主色 hsl(212,89%,53%)，
 * 暗色跟随 PTA 自己的 .dark 类而不是系统）。
 *
 * 运行本体在 autoanswer.js：面板只是入口与事件流的展示层（setEventSink），
 * 关掉面板 / 翻到别的页面都不打断运行；运行中悬浮球常驻并显示整体进度环，
 * 配置控件整体禁用（handleRun 开跑即快照全部配置，中途可改是假象，禁用才诚实）。
 */
import { clampConcurrency } from '../shared/coding-batch.js';
import { ext } from '../shared/ext.js';
import { loadSettings, REDO_MODES, saveSettings } from '../shared/settings.js';
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
// hint 不再进版面，只作服务下拉的 title 悬停提示。
export const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash', // 视觉模型；deepseek-chat 已下架（2026-10-13）
    gateway: 'deepseek',
    hint: '官方 API · api.deepseek.com · 默认模型 deepseek-flash（视觉）',
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

/* ---------- 头部：标题 + 状态胶囊 + 收起 ---------- */
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

/* ---------- 单页行式控制台 ----------
   左列 56px 短标签 + 右列 PTA 表单控件，行高即控件高（32px）；说明不进版面
   （字段解释放代码注释与 title 悬停，运行细节由引擎日志现报）。
   低频调参（语言/并发）收进「高级设置」抽屉，收起态右侧小字常显当前值。 */
.page { flex: 1; min-height: 0; padding: 12px 14px; overflow: auto;
  display: flex; flex-direction: column; gap: 12px; }
/* 页面是可滚动的 flex 列：子项一律不参与收缩，否则定高的按钮/输入框/日志会被压扁
   （实测不写这条时 32px 的主按钮被挤成 24.5px），超出部分交给 overflow 滚动 */
.page > * { flex: none; }

.rows { display: flex; flex-direction: column; gap: 10px; }
/* 组标签：字号与弹窗 .block-head 同档（13/16、次级文字），字重要求加粗（用户指定，
   弹窗的 .block-head 是 500，面板有意加重以撑起分组边界）。
   模型配置与答题配置不是同一类东西，分组分界不混排；分界线只挂第二组（第一组头顶是面板头）。
   分界线取 --bg-normal 而不是 --hairline：后者 6% 黑在面板里几乎不可见，压不住「分界」这层语义 */
.group-label { font-size: 13px; line-height: 16px; font-weight: 700; color: var(--text-2); }
.group-label.divided { padding-top: 8px; border-top: 1px solid var(--bg-normal); }
.row { display: flex; align-items: center; gap: 10px; }
.row > .rl { flex: none; width: 56px; font-size: 13px; line-height: 16px; color: var(--text-2); }
.row > .rc { flex: 1; min-width: 0; }
/* 「端点/模型」行按预设条件显隐：display:flex 会盖过 UA 的 [hidden]，必须显式收回 */
.row[hidden] { display: none; }

/* 尺寸取 PTA 的表单控件：32px 高 / 4px 圆角 / #ced4da 边框 / 聚焦「主色边框 + 2px 环」 */
select { appearance: none; -webkit-appearance: none; width: 100%; height: 32px; padding: 0 30px 0 12px;
  border: 1px solid var(--input-border); border-radius: 4px;
  background: var(--bg) url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999999' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 12px center;
  color: var(--text); font: inherit; font-size: 15px; cursor: pointer;
  transition: border-color var(--trs), box-shadow var(--trs); }
select:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }
select:disabled { background: var(--bg-light); cursor: not-allowed; }

.rc input { width: 100%; height: 32px; padding: 0 12px; border: 1px solid var(--input-border);
  border-radius: 4px; background: var(--bg); color: var(--text); font: inherit;
  transition: border-color var(--trs), box-shadow var(--trs); }
.rc input::placeholder { color: var(--text-3); font-style: italic; } /* PTA 的占位符样式 */
.rc input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-ring); }
.rc input:disabled { background: var(--bg-light); cursor: not-allowed; }

.keyrow { position: relative; }
.keyrow input { padding-right: 56px; /* 右侧留给显示/隐藏按钮 */
  /* 用 text-security 遮罩而不是 type=password：Chrome 密码管理器只盯真密码框，
   * 真密码框的值一变就弹「要更新密码吗？」（把 API Key 当成 PTA 账号的新密码） */
  -webkit-text-security: disc; }
.keyrow input.reveal { -webkit-text-security: none; } /* 「显示」态：明文回显 */
.keyrow .peek { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  height: 24px; padding: 0 8px; border: none; border-radius: 4px; background: none;
  color: var(--text-3); font-size: 13px; cursor: pointer;
  transition: background-color var(--trs), color var(--trs); }
.keyrow .peek:hover { color: var(--accent); background: var(--bg-light); }
.keyrow .peek:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.switchrow { display: flex; align-items: center; gap: 10px; cursor: pointer; min-height: 32px; }
.switchrow .rl { flex: none; width: 56px; font-size: 13px; line-height: 16px; color: var(--text-2); }
.switchrow .switch { margin-left: auto; }
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

/* 高级设置抽屉：<details> 自带展开语义；收起态右侧 12px 小字显示语言/并发当前值 */
.adv summary { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 2px 0;
  cursor: pointer; list-style: none; user-select: none;
  color: var(--text-2); font-size: 13px; transition: color var(--trs); }
.adv summary::-webkit-details-marker { display: none; }
.adv summary:hover { color: var(--accent); }
.adv summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
.adv .chev { flex: none; transition: transform var(--trs); }
.adv[open] .chev { transform: rotate(90deg); }
.adv .adv-cur { margin-left: auto; font-size: 12px; line-height: 16px; color: var(--text-3); }
.adv-body { display: flex; flex-direction: column; gap: 10px; padding: 6px 0 2px; }

/* 主按钮：PTA 的实心按钮（主色底白字 / 4px 圆角），悬停压暗、按下 1px；
   36px 比表单控件高一档——面板唯一的重量级元素 */
.start { width: 100%; height: 36px; padding: 0 15px; border: 1px solid transparent; border-radius: 4px;
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
.logs::-webkit-scrollbar { width: 8px; }
.logs::-webkit-scrollbar-thumb { background: var(--scroll); border-radius: 4px; }
.logs .t { color: var(--text-3); font-size: 11px; margin-right: 6px; }
.logs .lv-ok { color: var(--ok); }
.logs .lv-err { color: var(--err); }
.logs .lv-warn { color: var(--warn); }

/* 页脚只留一行必要警示（旧版三段灰字说明已删，细节由引擎日志现报） */
.foot { margin: 0; padding-top: 10px; border-top: 1px solid var(--hairline);
  font-size: 12px; line-height: 16px; color: var(--text-3); }

@media (prefers-reduced-motion: reduce) {
  .ball, .collapse, .switch, .peek, .clear, .adv summary, .adv .chev { transition: none; }
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
    const api = ext();
    if (!api?.storage?.local) return Promise.resolve(null);
    return api.storage.local.get({ [POS_KEY]: null })
      .then(v => v?.[POS_KEY] || null)
      .catch(() => null);
  } catch (_) { return Promise.resolve(null); }
}

function saveBallPos() {
  try {
    const api = ext();
    const p = api?.storage?.local?.set({ [POS_KEY]: ballPos });
    p?.catch?.(() => { /* 记不住就只在本页生效 */ });
  } catch (_) { /* 记不住就只在本页生效 */ }
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

/* 运行中锁配置：handleRun 开跑即对全部配置做快照，中途改动不生效——禁用比
 * 「能改但不生效」诚实；中止后按钮回「开始答题」时原样恢复 */
const LOCK_IDS = ['aa-model', 'aa-key', 'aa-peek', 'aa-base', 'aa-model-name', 'aa-redo', 'aa-images', 'aa-lang', 'aa-concurrency'];
function lockConfig(running) {
  if (!shadow) return;
  for (const id of LOCK_IDS) {
    const n = shadow.getElementById(id);
    if (n) n.disabled = running;
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
  lockConfig(running);
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

  // —— 面板（单页：配置瘦身后的总量一屏放得下，不再分区页签） ——
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

  const page = el('div', 'page', panel);

  // —— 行式配置区：模型配置（服务/Key/端点/模型）与答题配置（已答处理/含图题/调参）
  //    是两类东西，分组分界，不混排 ——
  el('div', 'group-label', page).textContent = '模型配置';
  const rowsModel = el('div', 'rows', page);

  // 服务：PRESETS 的一项；服务解释放 select 的 title 悬停（applyPreset 按所选填）
  const rowSvc = el('div', 'row', rowsModel);
  const svcLabel = el('label', 'rl', rowSvc);
  svcLabel.textContent = '服务';
  svcLabel.htmlFor = 'aa-model';
  const rcSvc = el('div', 'rc', rowSvc);
  const sel = el('select', '', rcSvc);
  sel.id = 'aa-model';
  for (const [key, p] of Object.entries(PRESETS)) {
    const o = el('option', '', sel);
    o.value = key;
    o.textContent = p.label;
    if (p.disabled) o.disabled = true;
  }

  // API Key：type=text + text-security 遮罩（真密码框会触发密码管理器「要更新密码吗？」）
  const rowKey = el('div', 'row', rowsModel);
  const keyLabel = el('label', 'rl', rowKey);
  keyLabel.textContent = 'API Key';
  keyLabel.htmlFor = 'aa-key';
  const rcKey = el('div', 'rc keyrow', rowKey);
  const key = el('input', '', rcKey);
  key.id = 'aa-key';
  key.type = 'text';
  key.placeholder = 'sk-…';
  key.autocomplete = 'off';
  key.spellcheck = false;
  key.title = '每个服务各存一把，切换服务自动带出；仅保存在本机浏览器';
  const peek = el('button', 'peek', rcKey);
  peek.type = 'button';
  peek.id = 'aa-peek';
  peek.textContent = '显示';
  peek.setAttribute('aria-label', '显示或隐藏 API Key');

  // 「自定义」服务多一行「端点」（任意 OpenAI 兼容根地址），预设服务隐藏（applyPreset 翻）
  const rowBase = el('div', 'row', rowsModel);
  rowBase.id = 'row-base';
  rowBase.hidden = true;
  const baseLabel = el('label', 'rl', rowBase);
  baseLabel.textContent = '端点';
  baseLabel.htmlFor = 'aa-base';
  const rcBase = el('div', 'rc', rowBase);
  const burl = el('input', '', rcBase);
  burl.id = 'aa-base';
  burl.type = 'text';
  burl.placeholder = 'https://api.example.com/v1';
  burl.autocomplete = 'off';
  burl.spellcheck = false;
  burl.title = 'OpenAI 兼容根地址，填到 /v1 即可（误粘 /chat/completions 会自动剥掉）';

  // 可自填模型的网关 / 自定义服务（editableModel）多一行「模型」，DeepSeek 这类固定适配隐藏
  const rowMname = el('div', 'row', rowsModel);
  rowMname.id = 'row-model';
  rowMname.hidden = true;
  const mNameLabel = el('label', 'rl', rowMname);
  mNameLabel.textContent = '模型';
  mNameLabel.htmlFor = 'aa-model-name';
  const rcMname = el('div', 'rc', rowMname);
  const mname = el('input', '', rcMname);
  mname.id = 'aa-model-name';
  mname.type = 'text';
  mname.autocomplete = 'off';
  mname.spellcheck = false;

  el('div', 'group-label divided', page).textContent = '答题配置';
  const rowsAnswer = el('div', 'rows', page);

  // 已答处理：三态（v0.12.2）。判分口径细节放 title 与引擎日志，不占版面
  const rowRedo = el('div', 'row', rowsAnswer);
  const redoLabel = el('label', 'rl', rowRedo);
  redoLabel.textContent = '已答处理';
  redoLabel.htmlFor = 'aa-redo';
  const rcRedo = el('div', 'rc', rowRedo);
  const rsel = el('select', '', rcRedo);
  rsel.id = 'aa-redo';
  rsel.title = '「仅重做错误题」按平台判分只重做答错的编码题（未提交草稿也重做）；客观题答题中不判分，一律按跳过处理';
  for (const [value, label] of [
    ['skip', '跳过已答'],
    ['wrong', '仅重做错误题'],
    ['all', '全部重做'],
  ]) {
    const o = el('option', '', rsel);
    o.value = value;
    o.textContent = label;
  }

  // 含图题：默认开（默认服务 DeepSeek 的 deepseek-flash 是视觉模型，默认组合开箱即用；
  // 非视觉模型会逐题报错，此时关掉开关或换模型）。要求写在 title 悬停里。
  const swImg = el('label', 'switchrow', rowsAnswer);
  swImg.htmlFor = 'aa-images';
  swImg.title = '开启后题干图片随题面交给模型作答，需要能看图的模型（DeepSeek 官方默认模型支持）；看不了图的模型会逐题报错';
  const imgLabel = el('span', 'rl', swImg);
  imgLabel.textContent = '含图题';
  const imgs = el('input', 'switch', swImg);
  imgs.id = 'aa-images';
  imgs.type = 'checkbox';

  // —— 高级设置抽屉：低频调参默认收起，右侧小字常显当前值（renderAdvCur） ——
  const adv = el('details', 'adv', rowsAnswer);
  const advSummary = el('summary', '', adv);
  advSummary.innerHTML = '<svg class="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 7.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  el('span', '', advSummary).textContent = '高级设置';
  const advCur = el('span', 'adv-cur', advSummary);
  advCur.id = 'aa-adv-cur';
  const advBody = el('div', 'adv-body', adv);

  // 编程题语言：默认跟随编辑器当前语言；选项 = 本题集允许语言（exams 白名单 + 静态显示名
  // 映射），异步填充（refreshLangOptions）。函数题编译器由题目固定，此配置不生效。
  const rowLang = el('div', 'row', advBody);
  const langLabel = el('label', 'rl', rowLang);
  langLabel.textContent = '语言';
  langLabel.htmlFor = 'aa-lang';
  const rcLang = el('div', 'rc', rowLang);
  const lsel = el('select', '', rcLang);
  lsel.id = 'aa-lang';
  lsel.title = '编程题按此语言出码并提交评测；函数题的编译器由题目固定。选项为本题集允许的语言';
  const oFollow = el('option', '', lsel);
  oFollow.value = '';
  oFollow.textContent = '跟随编辑器';

  // 编码题并发数（v0.12.0）：同时向模型发起的请求数。收题/提交仍是串行页面操作，
  // 并发只加速「等模型」这段；被限流时引擎按自己的口径自动退避重试。
  const rowConc = el('div', 'row', advBody);
  const concLabel = el('label', 'rl', rowConc);
  concLabel.textContent = '并发';
  concLabel.htmlFor = 'aa-concurrency';
  const rcConc = el('div', 'rc', rowConc);
  const csel = el('select', '', rcConc);
  csel.id = 'aa-concurrency';
  csel.title = '编码题同时请求模型的路数，越高越快；对限流严格的服务建议 1–3 路';
  for (const n of [1, 2, 3, 4, 5, 6]) {
    const o = el('option', '', csel);
    o.value = String(n);
    o.textContent = `${n} 路`;
  }

  // —— 主行动 + 运行监视 ——
  const start = el('button', 'start', page);
  start.id = 'start';
  start.type = 'button';
  start.textContent = '开始答题';

  const logsHead = el('div', 'logs-head', page);
  el('b', '', logsHead).textContent = '日志';
  const clear = el('button', 'clear', logsHead);
  clear.id = 'clear';
  clear.type = 'button';
  clear.textContent = '清空';
  const logs = el('div', 'logs', page);
  logs.id = 'logs';
  logs.setAttribute('role', 'log');
  logs.setAttribute('aria-live', 'polite');

  el('p', 'foot', page).textContent = '实验功能 · 编程题提交即评测，成绩以评测结果为准';

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
  peek.addEventListener('click', () => {
    const show = !key.classList.contains('reveal');
    key.classList.toggle('reveal', show);
    peek.textContent = show ? '隐藏' : '显示';
  });
  const applyPreset = () => {
    const p = PRESETS[sel.value] || PRESETS.deepseek;
    sel.title = p.hint || '';
    rowBase.hidden = !p.customEndpoint;
    rowMname.hidden = !p.editableModel;
    mname.placeholder = p.customEndpoint ? 'gpt-4o-mini' : `留空用默认 ${p.model || ''}`;
    mname.title = p.customEndpoint ? '填该服务可用的模型 id' : '留空用该服务的默认模型';
  };
  // 恢复上次的选择：sync() 先行传入的 settings 已含全部 autoAnswer* 字段
  if (settings && PRESETS[settings.autoAnswerGateway]) sel.value = settings.autoAnswerGateway;
  burl.value = ((settings || {}).autoAnswerBaseUrl || '').trim();
  mname.value = ((settings || {}).autoAnswerModel || '').trim();
  key.value = currentKey(settings, sel.value); // 按当前服务的映射取回上文 Key
  const savedRedo = (settings || {}).autoAnswerRedo;
  rsel.value = REDO_MODES.includes(savedRedo) ? savedRedo : 'skip';
  imgs.checked = !!((settings || {}).autoAnswerImages);
  csel.value = String(clampConcurrency((settings || {}).autoAnswerConcurrency, 6));
  // 语言选项异步填充（拉本题集白名单后再恢复上次固定值）
  refreshLangOptions();
  renderAdvCur();
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
  rsel.addEventListener('change', persist);
  imgs.addEventListener('change', persist);
  lsel.addEventListener('change', () => { persist(); renderAdvCur(); });
  csel.addEventListener('change', () => { persist(); renderAdvCur(); });
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
  // __BPS_FORCE_PANEL__（preview.html 面板预览钩子）：没有真实路由，给假 psId
  // 让 fetch 落到 mock 上、取不到 compilers 时退化静态语言表
  const psId = (location.pathname.match(EXAM_PROBLEMS_RE) || [])[1]
    || (window.__BPS_FORCE_PANEL__ ? 'preview' : null);
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
  renderAdvCur();
}

/* 高级设置抽屉收起态的当前值摘要：语言显示名 · 并发 N 路。
 * 收起时也看得见「里面是什么、现在选了什么」，不必展开翻找。 */
function renderAdvCur() {
  if (!shadow) return;
  const cur = shadow.getElementById('aa-adv-cur');
  const lsel = shadow.getElementById('aa-lang');
  const csel = shadow.getElementById('aa-concurrency');
  if (!cur || !lsel || !csel) return;
  const lang = lsel.options[lsel.selectedIndex]?.textContent?.trim() || '跟随编辑器';
  cur.textContent = `${lang} · ${csel.value} 路`;
}

function togglePanel() {
  if (!shadow) return;
  open ? closePanel() : openPanel();
}

// 面板随球所在象限换边：球在右半屏 → 默认朝左展开，左半屏 → 朝右；
// 下半屏 → 默认往上弹，上半屏 → 往下弹（CSS 的 pos-left / pos-top）。
// 单页版面板比旧页签版高（~550px），球拖到中上部时向上弹会顶出视口——
// 按展开方向的可用空间夹 inline max-height（面板底/顶缘距球心 33px，再留 12px 边距），
// 内容超出交给 .page 内部滚动；默认右下角时算出的空间大于 CSS 的 100vh-90px 上限，不生效。
function placePanel() {
  if (!shadow) return;
  const wrapEl = shadow.querySelector('.wrap');
  if (!wrapEl) return;
  const cx = window.innerWidth - (ballPos?.r ?? 18) - BALL_SIZE / 2;
  const cy = window.innerHeight - (ballPos?.b ?? 18) - BALL_SIZE / 2;
  wrapEl.classList.toggle('pos-left', cx < window.innerWidth / 2);
  const opensDown = wrapEl.classList.toggle('pos-top', cy < window.innerHeight / 2);
  const up = cy - 45; // 向上弹：面板底缘在球心上方 33px
  const down = window.innerHeight - cy - 45; // 向下弹：面板顶缘在球心下方 33px
  const panel = shadow.getElementById('panel');
  if (panel) panel.style.maxHeight = `${Math.max(240, Math.floor(opensDown ? down : up))}px`;
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
  const first = shadow.getElementById('aa-model'); // 第一个配置控件 = 服务下拉
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
  const redoPick = shadow.getElementById('aa-redo')?.value;
  const redo = REDO_MODES.includes(redoPick) ? redoPick : 'skip';
  const withImages = shadow.getElementById('aa-images').checked;
  const gw = shadow.getElementById('aa-model');
  const gateway = PRESETS[gw.value] ? gw.value : 'deepseek';
  const baseUrl = (shadow.getElementById('aa-base')?.value || '').trim(); // 「自定义」才用得上，存着无妨
  const model = (shadow.getElementById('aa-model-name')?.value || '').trim();
  const lang = shadow.getElementById('aa-lang');
  const language = lang ? lang.value.trim() : '';
  const concurrency = clampConcurrency(shadow.getElementById('aa-concurrency')?.value, 6);
  try {
    const fresh = await loadSettings();
    // Key 归档进当前服务的名下（withKeyFor 只动这一个键，其他服务的 Key 原样保留）
    await saveSettings({ ...withKeyFor(fresh, gateway, apiKey), autoAnswerRedo: redo, autoAnswerImages: withImages, autoAnswerGateway: gateway, autoAnswerBaseUrl: baseUrl, autoAnswerModel: model, autoAnswerLanguage: language, autoAnswerConcurrency: concurrency });
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
    burl?.focus(); // 单页后必填字段都在可见处，缺哪个聚焦哪个
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
  const redoPick = shadow.getElementById('aa-redo')?.value;
  const redo = REDO_MODES.includes(redoPick) ? redoPick : 'skip';
  const withImages = shadow.getElementById('aa-images').checked;
  const language = (shadow.getElementById('aa-lang')?.value || '').trim();
  const concurrency = clampConcurrency(shadow.getElementById('aa-concurrency')?.value, 6);
  await persist();
  const result = await handleRun({
    baseUrl,
    model,
    apiKey,
    redo,
    images: withImages,
    gateway: preset.gateway,
    language,
    concurrency,
  });
  if (!result.ok && result.error === '已有一次答题在运行中') appendLog('warn', '已有一次答题在运行中');
}

/* ---------- 对外：显隐同步 ---------- */

// 由 index.js 驱动：init 后、设置变更后、路由兜底轮询时各调一次
export function sync(s) {
  settings = s || settings;
  // __BPS_FORCE_PANEL__：preview.html 的面板预览钩子（预览路由匹配不到 exam/problems）
  const forced = !!window.__BPS_FORCE_PANEL__;
  const shouldShow = !!settings && !!settings.autoAnswer && (forced || EXAM_PROBLEMS_RE.test(location.pathname));
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
