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
  LLM_HEADERS_TIMEOUT_MS, LLM_IDLE_TIMEOUT_MS, LLM_KEEPALIVE_MS, LLM_PROGRESS_EVERY_MS, LLM_TOTAL_TIMEOUT_MS,
} from '../shared/llm.js';
import { createSseParser, sseDeltaText, sseReasoningText } from '../shared/sse.js';
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

/* ---------- OpenCode Go 转发（BPS_LLM_CHAT，端口 bps-llm） ----------
 * opencode.ai 不返回任何 CORS 头（实测预检直接 404），内容脚本所在页面的 fetch
 * 必被浏览器拦在预检阶段；service worker 有 host permission 后可发跨源请求。
 * 只转发 OpenCode Go 的 chat/completions，不做通用代理——避免变成任意 URL 出口。
 * 错误体原样交回内容脚本统一解析（两种形状 + x-opencode-log-id），本层不记 Key。
 *
 * 2026-10-23 起走流式：非流式要等满 120s 才知道网关没回包，也分不清「慢」和「死」；
 * 现在 45s 没有响应头/没有数据就判卡住，每 15s 报一次已收字符数。端口消息本身是
 * 扩展 API 调用，长生成期间顺带把 worker 的 idle 计时器顶住（降低被回收的概率）。
 */
const llmControllers = new Map(); // reqId → { abort }（内容脚本中止按钮按 reqId 断在途 fetch）

function opencodeChatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  let u;
  try { u = new URL(base); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'opencode.ai') return null;
  if (!u.pathname.startsWith('/inference/go/')) return null;
  return u.origin + u.pathname + '/chat/completions';
}

// emit 用于把「首块/生成中」进度经端口送回内容脚本；返回结构与旧版一致，
// 流式成功时把整段文本放在 content 字段（text 字段保留给非流式 JSON 透传）。
async function relayLlmChat(msg, emit = () => {}) {
  const url = opencodeChatUrl(msg.baseUrl);
  if (!url) return { ok: false, status: 400, reason: '仅支持转发 OpenCode Go 的 /inference/go/ 端点' };
  const apiKey = String(msg.apiKey || '').trim();
  if (!apiKey) return { ok: false, status: 400, reason: 'API Key 为空' };
  const session = String(msg.session || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(session)) return { ok: false, status: 400, reason: '缺少或非法的 x-opencode-session' };
  const model = String(msg.model || '').trim();
  if (!model) return { ok: false, status: 400, reason: '模型为空' };
  if (!Array.isArray(msg.messages) || !msg.messages.length) return { ok: false, status: 400, reason: 'messages 为空' };
  const reqId = String(msg.reqId || '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(reqId)) return { ok: false, status: 400, reason: '缺少或非法的 reqId' };

  const ctl = new AbortController();
  let abortReason = '';
  const abortWith = why => {
    if (ctl.signal.aborted) return;
    abortReason = why;
    ctl.abort();
  };
  llmControllers.set(reqId, { abort: () => abortWith('user') });

  const startedAt = Date.now();
  let text = '';
  let reasoning = '';
  let streamError = null;
  let firstAt = 0;
  let firstThinkAt = 0;
  let streamOpen = false;
  let lastProgressAt = 0;
  let headersTimer = setTimeout(() => abortWith('headers'), LLM_HEADERS_TIMEOUT_MS);
  let idleTimer = null;
  const totalTimer = setTimeout(() => abortWith('total'), LLM_TOTAL_TIMEOUT_MS);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortWith('idle'), LLM_IDLE_TIMEOUT_MS);
  };
  const progress = (phase, chars) => {
    const now = Date.now();
    const throttled = phase === 'tick' || phase === 'thinking-tick';
    if (throttled && now - lastProgressAt < LLM_PROGRESS_EVERY_MS) return;
    if (phase !== 'waiting') lastProgressAt = now;
    try { emit({ type: 'progress', phase, chars, elapsedMs: now - startedAt }); } catch (_) { /* 端口已断 */ }
  };

  // 端口模式下「挂起的 fetch」不会重置 worker 的 30s idle 计时器：等首块时没有任何事件，
  // worker 会被回收、端口在 ~30s 断开（7-9/7-10 真机故障）。每 20s 调一次轻量扩展 API
  // 顶住 idle 计时器，同时给内容脚本发一条「仍在等待」进度。
  const keepAliveTimer = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; }); } catch (_) { /* 扩展卸载中 */ }
    if (firstAt) return; // 已经开始出答案，不再刷等待日志
    if (!streamOpen) progress('waiting', 0);
    else if (!firstThinkAt) progress('stream-wait', 0);
  }, LLM_KEEPALIVE_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      // 浏览器禁止脚本设置 User-Agent（禁止头，会被静默丢弃），这里只能保留浏览器自身 UA
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer ' + apiKey,
        'x-opencode-session': session,
      },
      body: JSON.stringify({ model, temperature: 0, stream: true, messages: msg.messages }),
      signal: ctl.signal,
    });
    clearTimeout(headersTimer);
    headersTimer = null;
    const logId = res.headers.get('x-opencode-log-id') || '';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, text: body, logId };
    }

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream') && res.body) {
      armIdle();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser(ev => {
        if (ev.done) return;
        if (ev.data?.error) { streamError = ev.data.error; abortWith('stream'); return; }
        const delta = sseDeltaText(ev.data);
        if (delta) {
          text += delta;
          if (!firstAt) { firstAt = Date.now(); progress('first', text.length); }
          else progress('tick', text.length);
          return;
        }
        // 推理模型在出答案前会持续发 reasoning_content（部分网关叫 reasoning）；
        // 这些字符证明连接在输出，单独记「思考中」，避免看起来像网关卡死。
        const think = sseReasoningText(ev.data);
        if (!think) return;
        reasoning += think;
        if (!firstThinkAt) { firstThinkAt = Date.now(); progress('thinking', reasoning.length); }
        else progress('thinking-tick', reasoning.length);
      });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // 任何字节都算活着（含 keep-alive 注释）
        if (!streamOpen) { streamOpen = true; progress('stream', 0); }
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
      if (streamError) {
        const detail = typeof streamError === 'string' ? streamError : (streamError.message || JSON.stringify(streamError).slice(0, 160));
        return { ok: false, status: 0, reason: '网关流错误：' + detail, kind: 'protocol' };
      }
      if (!text.trim()) return { ok: false, status: 0, reason: '网关流结束但没有内容', kind: 'protocol' };
      return { ok: true, status: res.status, content: text, logId };
    }

    // 网关忽略了 stream:true：退回整段 JSON（这条路径没有中途进度）
    const body = await res.text();
    return { ok: true, status: res.status, text: body, logId };
  } catch (err) {
    const streamDetail = streamError
      ? (typeof streamError === 'string' ? streamError : (streamError.message || ''))
      : '';
    const reason = abortReason === 'headers' ? `网关 ${Math.round(LLM_HEADERS_TIMEOUT_MS / 1000)}s 未返回响应头，判定卡住`
      : abortReason === 'idle' ? `网关 ${Math.round(LLM_IDLE_TIMEOUT_MS / 1000)}s 无数据，判定卡住`
        : abortReason === 'total' ? `生成超过 ${Math.round(LLM_TOTAL_TIMEOUT_MS / 1000)}s 总上限，已中断`
          : abortReason === 'stream' ? ('网关流错误' + (streamDetail ? '：' + streamDetail : ''))
            : abortReason === 'user' ? '已中止'
              : (err?.message || String(err));
    const kind = abortReason === 'headers' || abortReason === 'idle' ? 'idle'
      : abortReason === 'total' ? 'total'
        : abortReason === 'user' ? 'abort'
          : abortReason === 'stream' ? 'protocol'
            : 'network';
    return { ok: false, status: 0, reason, kind };
  } finally {
    clearInterval(keepAliveTimer);
    clearTimeout(headersTimer);
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    llmControllers.delete(reqId);
  }
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
  // 先清掉上一条测试通知：固定 id 直接 create 是「原地更新」，
  // 更新不会重新弹横幅——上一条还躺在通知中心时，用户就会觉得「说已发送但没弹窗」
  try { await chrome.notifications.clear(TEST_NOTIFY_ID); } catch (_) { /* 没清掉也继续 */ }
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

/* 一条长请求一个端口：内容脚本用 connect 发请求，后台把首块/进度/最终结果推回去。
 * 单条 sendMessage 等 2 分钟的模式在 worker 被回收时只会留下 message channel closed，
 * 端口模式能显式收到断开并让内容脚本按「可重试」处理；页面关闭/用户中止时后台
 * 通过 onDisconnect 连带取消在途生成，避免服务端空转。 */
chrome.runtime.onConnect.addListener(port => {
  if (!port || port.name !== 'bps-llm') return;
  const jobs = new Set();
  const post = obj => { try { port.postMessage(obj); } catch (_) { /* 端口已断 */ } };
  port.onMessage.addListener(msg => {
    if (!msg || msg.type !== 'BPS_LLM_CHAT' || jobs.size) return; // 一个端口只接一次请求
    const reqId = String(msg.reqId || '');
    jobs.add(reqId);
    relayLlmChat(msg, post).then(
      result => post({ type: 'done', ...result }),
      err => post({ type: 'done', ok: false, status: 0, reason: err?.message || String(err) }),
    ).finally(() => {
      jobs.delete(reqId);
      // 不在这里 disconnect：done 刚 post 出去，端口留给内容脚本收到结果后自己断开，
      // 避免极端时序下最后一条消息被丢弃。
    });
  });
  port.onDisconnect.addListener(() => {
    for (const id of jobs) {
      try { llmControllers.get(id)?.abort(); } catch (_) { /* 已完成 */ }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'BPS_LLM_ABORT') {
    const entry = llmControllers.get(String(msg.reqId || ''));
    if (entry) entry.abort();
    sendResponse({ ok: !!entry });
    return false;
  }
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
