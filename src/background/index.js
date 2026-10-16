/* 更好的题目集 · 后台 service worker
 *
 * 两条提醒通道，互相独立、任一开启即工作：
 *
 * 1) 浏览器通知（本地，零配置，v0.10 新增）：内容脚本上报的题目集快照存进
 *    chrome.storage.local，chromium 的 chrome.alarms 每 SCAN_PERIOD_MINUTES 扫一轮，
 *    按档位（截止前 3 天 / 1 天）判定并弹系统通知，点击/按钮打开题目集。
 *    几个刻意的实现约束（都有实测依据）：
 *    - 闹钟只按「缺则建」：alarms.create 会重置下一次触发时刻，每次 SW 启动都
 *      create 会把周期无限往后推（浏览器开着但页面不刷新时永远不触发）；
 *    - 闹钟跨浏览器重启不保证保留，所以每次 SW 启动 + onStartup/onInstalled 都
 *      ensureAlarm 并补一轮扫描（关机期间错过的档位在下次开机补齐）；
 *    - 判定用档位而不是精确触发时刻（见 shared/browser-notify.js 的说明）。
 *    本通道不产生任何网络请求，数据只留在本机。
 *
 * 2) 邮件提醒（可选，需自建后端，v0.6 起）：POST 到用户自己的服务器（全量替换
 *    该邮箱订阅），弹窗的「测试邮件」走 POST /api/test。放在 background 是因为
 *    内容脚本所在页面对跨源 POST 受页面 CSP/CORS 限制，而 service worker 的
 *    fetch 只受后端 CORS 约束（后端返回 Access-Control-Allow-Origin: * 即可，
 *    无需 host_permissions）。服务器地址格式：ip:port 或带 http(s):// 前缀，
 *    后端配置了 TOKEN 时可写成 ip:port/令牌（令牌以 X-Token 头透传）。
 *
 * 另承接图片转取（BPS_FETCH_IMAGE）：pta 的图源 images.ptausercontent.com
 * 不放行页面 fetch（实测 CORS 拒绝），host_permissions 已针对该域，由
 * service worker 带登录态取图转 data URL 交回内容脚本（自动答题含图链路）。
 */
import { loadSettings } from '../shared/settings.js';
import {
  LIST_URL, NOTIFY_ID, NOTIFY_BEFORE_MINUTES, SCAN_PERIOD_MINUTES, STATE_KEY, TEST_NOTIFY_ID,
  buildNotification, computeDue, normalizeState, pruneState, setOverviewUrl, withSnapshot,
} from '../shared/browser-notify.js';

const ALARM_NAME = 'bps-reminder-scan';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- 通用小工具 ---------- */

function normalizeServer(server) {
  const s = String(server || '').trim();
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : 'http://' + s;
  try {
    const u = new URL(withProto);
    if (!u.hostname) return null;
    // 「/令牌」后缀：首段路径作为共享令牌，不做真实路径拼接
    const token = u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : '';
    return { base: u.origin, token };
  } catch (_) {
    return null;
  }
}

async function post(base, token, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// 图片转 data URL：分块 btoa 避免大图 String.fromCharCode.apply 栈溢出
async function toDataUrl(src) {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/* ---------- 本地通知通道 ---------- */

async function readState() {
  try {
    const st = await chrome.storage.local.get(STATE_KEY);
    return normalizeState(st?.[STATE_KEY]);
  } catch (_) {
    return normalizeState(null);
  }
}

async function writeState(state) {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  } catch (err) {
    console.warn('[更好的题目集] 提醒快照写入失败:', err?.message || err);
  }
}

// 闹钟只按「缺则建」：create 会重置下一次触发（见文件头说明）
async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM_NAME);
    if (!existing) chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_PERIOD_MINUTES });
  } catch (_) {
    try { chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_PERIOD_MINUTES }); } catch (_) { /* 环境不支持就算了 */ }
  }
}

async function notifyPermission() {
  try { return await chrome.notifications.getPermissionLevel(); } catch (_) { return 'granted'; }
}

async function showNotification({ id, title, message, buttonTitle }) {
  const options = {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    contextMessage: '更好的题目集',
  };
  if (buttonTitle) options.buttons = [{ title: buttonTitle }];
  try {
    await chrome.notifications.create(id, options);
    return true;
  } catch (err) {
    console.warn('[更好的题目集] 浏览器通知创建失败:', err?.message || err);
    return false;
  }
}

// 扫描一轮：设置闸门（弹窗关掉开关时闹钟可能刚好在跑）→ 档位判定 → 一条汇总通知
// → 去重记账 → 裁剪。系统通知被关时不记账，下一轮再试。
async function scanAndNotify(reason) {
  const settings = await loadSettings();
  if (settings.reminderBrowser === false) return { skipped: 'off' };
  const state = await readState();
  const now = Date.now();
  const { items, marks } = computeDue(state.sets, state.notified, now, NOTIFY_BEFORE_MINUTES);
  if (!items.length) {
    await writeState(pruneState(state, now));
    return { due: 0, notified: 0 };
  }
  if (await notifyPermission() === 'denied') return { skipped: 'denied', due: items.length };
  const plan = buildNotification(items, now);
  const shown = await showNotification({ id: NOTIFY_ID, ...plan });
  if (shown) {
    for (const k of marks) state.notified[k] = now;
    state.lastTarget = plan.targetId;
    console.info(`[更好的题目集] 浏览器通知（${reason}）：「${plan.title}」`);
  }
  await writeState(pruneState(state, now));
  return { due: items.length, notified: shown ? 1 : 0 };
}

// 收到上报：先落快照再扫描（先落盘保证即使通知这步失败，下一轮闹钟还能补上）
async function storeAndScan(sets) {
  const state = await readState();
  await writeState(withSnapshot(state, sets, Date.now()));
  return scanAndNotify('同步');
}

// 通知点击/按钮：打开对应题目集（点击目标在通知里没带，读状态里的 lastTarget；
// 没有就退到题目集列表页）；打开后把该条通知从系统通知里清掉
async function openTarget(id) {
  let url = null;
  if (id === TEST_NOTIFY_ID) {
    url = LIST_URL;
  } else if (id === NOTIFY_ID) {
    const state = await readState();
    url = state.lastTarget ? setOverviewUrl(state.lastTarget) : LIST_URL;
  }
  if (!url) return;
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    console.warn('[更好的题目集] 打开题目集失败:', err?.message || err);
  }
  try { await chrome.notifications.clear(id); } catch (_) { /* ignore */ }
}

/* ---------- 消息处理 ---------- */

// 弹窗「发送测试通知」：系统级通知被关时如实报错（这是本地通道最常见的失效原因）
async function notifyTest() {
  if (await notifyPermission() === 'denied') {
    return { ok: false, error: '系统已关闭浏览器通知（系统设置或专注助手），请先允许后重试' };
  }
  const ok = await showNotification({
    id: TEST_NOTIFY_ID,
    title: '浏览器通知已开启',
    message: '题目集临近关闭时会这样提醒你（截止前 3 天、1 天各一次）。',
    buttonTitle: '打开题目集列表',
  });
  return ok ? { ok: true } : { ok: false, error: '通知创建失败' };
}

// 内容脚本上报（BPS_SYNC）：按上报里带的通道标记分发。
// 浏览器侧：落快照 + 扫描；邮件侧：地址与邮箱齐备才发，半配置当未开启。
async function syncChannels(msg) {
  if (!Array.isArray(msg.sets)) return { ok: false, error: '上报数据缺失' };
  const out = { ok: false, total: msg.sets.length, browser: null, email: null };

  if (msg.browser) {
    const scan = await storeAndScan(msg.sets);
    out.browser = { stored: msg.sets.length, due: scan?.due || 0, skipped: scan?.skipped || null };
  }

  const server = normalizeServer(msg.server);
  const email = String(msg.email || '').trim();
  if (!msg.server && !msg.email) {
    // 邮件通道关闭：内容脚本上报时空串，不报错
  } else if (!server) {
    out.email = { ok: false, error: '服务器地址无效' };
  } else if (!EMAIL_RE.test(email)) {
    out.email = { ok: false, error: '邮箱格式不正确' };
  } else {
    try {
      const data = await post(server.base, server.token, '/api/subscriptions', { email, sets: msg.sets });
      out.email = { ok: true, total: data.total };
    } catch (err) {
      out.email = { ok: false, error: err?.message || String(err) };
    }
  }

  // ok = 至少一条通道生效；邮件失败但本地成功时仍 ok，由内容脚本按 email.error 单独告警
  out.ok = !!(out.browser || out.email?.ok);
  if (!out.ok && out.email?.error) out.error = out.email.error;
  return out;
}

// 弹窗「发送测试邮件」：显式动作，格式错误如实报错
async function testMail(msg) {
  const base = normalizeServer(msg.server);
  if (!base) return { ok: false, error: '服务器地址无效' };
  const email = String(msg.email || '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: '邮箱格式不正确' };
  await post(base.base, base.token, '/api/test', { email });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'BPS_FETCH_IMAGE') {
    if (typeof msg.src !== 'string' || !/^https?:\/\//i.test(msg.src)) {
      sendResponse({ ok: false, reason: '图片地址无效' });
      return false;
    }
    toDataUrl(msg.src).then(
      dataUrl => sendResponse({ ok: true, dataUrl }),
      err => sendResponse({ ok: false, reason: err?.message || String(err) }),
    );
    return true; // 异步 sendResponse
  }
  if (!msg || (msg.type !== 'BPS_SYNC' && msg.type !== 'BPS_TEST' && msg.type !== 'BPS_NOTIFY_TEST')) return;
  const work = msg.type === 'BPS_NOTIFY_TEST' ? notifyTest()
    : msg.type === 'BPS_TEST' ? testMail(msg)
    : syncChannels(msg);
  work.then(sendResponse, err => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // 异步 sendResponse
});

/* ---------- 生命周期 ---------- */

// 图标点击等事件唤醒 SW 时顺手兜底把闹钟补上（浏览器重启后闹钟不保证还在）
void ensureAlarm();

// 安装/更新、浏览器启动：补闹钟 + 立刻扫一轮（关机期间错过的档位在这里补齐）
chrome.runtime.onInstalled.addListener(() => { void (async () => { await ensureAlarm(); await scanAndNotify('安装/更新'); })(); });
chrome.runtime.onStartup.addListener(() => { void (async () => { await ensureAlarm(); await scanAndNotify('浏览器启动'); })(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM_NAME) void scanAndNotify('定期扫描'); });

chrome.notifications.onClicked.addListener(id => { void openTarget(id); });
chrome.notifications.onButtonClicked.addListener(id => { void openTarget(id); });
