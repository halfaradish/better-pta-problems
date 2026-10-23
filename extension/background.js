/* 更好的题目集 · 后台消息转发（构建产物，请勿直接编辑；源码见 src/background/） */
(() => {
  // src/shared/settings.js
  var DEFAULTS = {
    enabled: true,
    // 总开关
    badge: true,
    // 卡片上的课程徽章
    countdown: true,
    // 截止倒计时（仅剩 ≤7 天时显示）
    separators: "--,\uFF5C,|",
    // 课程名分隔符：取首个分隔符之前的部分作为课程名
    rules: "",
    // 自定义规则，每行一条：关键词=>课程名（包含匹配，优先于自动识别）
    mergeSimilar: true,
    // 同一教师下相似课程名自动归并为同一门课
    openInNewTab: true,
    // 点开题目集在新标签页打开（绕过 PTA 的 SPA 同页跳转）
    progress: true,
    // 考试型题目集的答题状态胶囊（顶替原生「已开放」，见 content/progress.js）
    // 题目关闭提醒的两个通道（v7 起拆开）：浏览器通知零配置，邮件需自建后端。
    // 注意：v6 及以前的「启用邮件提醒」总开关（reminderEnabled）由迁移更名为 reminderEmailEnabled
    reminderBrowser: true,
    // 浏览器通知通道（纯本地；关闭即不再落盘与弹通知）
    reminderEmailEnabled: true,
    // 邮件提醒通道开关；需服务器地址与邮箱齐备才真正生效
    reminderSkipDone: true,
    // 已完成的题目集不再提醒：推送时剔除已全部提交/判分的条目（口径见 content/reminders.js）
    reminderServer: "",
    // 邮件提醒后端地址（ip:port，可加 /令牌 后缀）；空 = 邮件通道未配置
    reminderEmail: "",
    // 提醒邮件接收邮箱
    // 自动答题（实验）：入口为题目页的悬浮球面板（弹窗只留总开关），见 docs/自动答题初探.md §9
    autoAnswer: false,
    // 题目列表页显示悬浮答题球（实验功能，默认关）
    autoAnswerApiKeys: {},
    // 每个模型服务各存一把 Key（键 = PRESETS 键），切服务不互相覆盖
    autoAnswerGateway: "deepseek",
    // 悬浮面板选中的模型适配（content/autoanswer-panel.js 的 PRESETS 键）
    autoAnswerModel: "",
    // 可自填网关的模型名（OpenCode Go / 自定义）；空 = 用适配预设的默认模型
    autoAnswerBaseUrl: "",
    // 「自定义」服务的 OpenAI 兼容端点（填到 /v1；仅选自定义时用）
    autoAnswerOverwrite: false,
    // 覆盖已作答的题目（默认跳过已答，避免把用户的正确答案改错）
    autoAnswerImages: false,
    // 含图题作答（需视觉模型如 deepseek-flash：图片下载编码进 prompt；默认关闭=含图题跳过）
    autoAnswerLanguage: "",
    // 编程题固定语言（exams 接口白名单的编译器 id）；空 = 跟随各题编辑器当前语言
    settingsVersion: 0
    // 0 = 旧版设置；v4 起「列表/分组」不再持久化（改为按路由的会话内状态）
  };
  var SETTINGS_VERSION = 7;
  var HAS_CHROME_STORAGE = typeof chrome !== "undefined" && !!chrome.storage?.sync;
  function needsMigration(raw) {
    return (raw?.settingsVersion || 0) < SETTINGS_VERSION;
  }
  function migrate(raw) {
    const s = { ...DEFAULTS, ...raw || {} };
    if (needsMigration(s)) {
      delete s.grouped;
      if (typeof s.autoAnswerApiKey === "string" && s.autoAnswerApiKey) {
        s.autoAnswerApiKeys = { ...s.autoAnswerApiKeys || {}, [s.autoAnswerGateway || "deepseek"]: s.autoAnswerApiKey };
      }
      delete s.autoAnswerApiKey;
      s.reminderEmailEnabled = typeof raw?.reminderEnabled === "boolean" ? raw.reminderEnabled : s.reminderEmailEnabled !== false;
      delete s.reminderEnabled;
      s.settingsVersion = SETTINGS_VERSION;
    }
    return s;
  }
  var storage = {
    async get() {
      try {
        if (HAS_CHROME_STORAGE) {
          const { settings } = await chrome.storage.sync.get({ settings: {} });
          return { ...DEFAULTS, ...settings };
        }
      } catch (_) {
      }
      return { ...DEFAULTS, ...globalThis.__BPS_SETTINGS__ || {} };
    },
    async set(next) {
      try {
        if (HAS_CHROME_STORAGE) {
          await chrome.storage.sync.set({ settings: next });
          return;
        }
      } catch (_) {
      }
      globalThis.__BPS_SETTINGS__ = next;
    }
  };
  async function loadSettings({ persistMigration = false } = {}) {
    const raw = await storage.get();
    const next = migrate(raw);
    if (persistMigration && needsMigration(raw)) await storage.set(next);
    return next;
  }

  // src/shared/browser-notify.js
  var NOTIFY_BEFORE_MINUTES = [4320, 1440];
  var SCAN_PERIOD_MINUTES = 30;
  var STATE_KEY = "bpsNotifyState";
  var NOTIFY_ID = "bps-reminder";
  var TEST_NOTIFY_ID = "bps-notify-test";
  var PRUNE_NOTIFIED_MS = 90 * 864e5;
  var PRUNE_SET_MS = 7 * 864e5;
  var DAY_MS = 864e5;
  var LIST_URL = "https://pintia.cn/problem-sets";
  var setOverviewUrl = (id) => `https://pintia.cn/problem-sets/${id}/overview`;
  var notifiedKey = (setId, offsetMin) => `${setId}|${offsetMin}`;
  function normalizeState(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    return {
      sets: Array.isArray(s.sets) ? s.sets : [],
      notified: s.notified && typeof s.notified === "object" && !Array.isArray(s.notified) ? s.notified : {},
      lastTarget: typeof s.lastTarget === "string" ? s.lastTarget : "",
      syncedAt: Number.isFinite(s.syncedAt) ? s.syncedAt : 0
    };
  }
  function normalizeSets(sets) {
    const out = [];
    for (const s of sets || []) {
      const endAt = typeof s?.endAt === "number" ? s.endAt : Date.parse(s?.endAt ?? "");
      const id = String(s?.id ?? "");
      if (!id || !Number.isFinite(endAt)) continue;
      out.push({
        id,
        title: String(s?.title ?? ""),
        endAt,
        owner: String(s?.owner ?? ""),
        org: String(s?.org ?? "")
      });
    }
    return out;
  }
  function withSnapshot(state, sets, now = Date.now()) {
    return { ...state, sets: normalizeSets(sets), syncedAt: now };
  }
  function computeDue(sets, notified = {}, now = Date.now(), tiers = NOTIFY_BEFORE_MINUTES) {
    const items = [];
    const marks = [];
    for (const s of sets || []) {
      if (!Number.isFinite(s?.endAt) || s.endAt <= now) continue;
      const offsets = tiers.filter((t) => s.endAt - now <= t * 6e4 && !notified[notifiedKey(s.id, t)]);
      if (!offsets.length) continue;
      items.push({ ...s, offsets });
      for (const t of offsets) marks.push(notifiedKey(s.id, t));
    }
    items.sort((a, b) => a.endAt - b.endAt);
    return { items, marks };
  }
  function pruneState(state, now = Date.now()) {
    const notified = {};
    for (const [k, ts] of Object.entries(state.notified || {})) {
      if (Number.isFinite(ts) && now - ts < PRUNE_NOTIFIED_MS) notified[k] = ts;
    }
    const sets = (state.sets || []).filter((s) => Number.isFinite(s?.endAt) && s.endAt > now - PRUNE_SET_MS);
    return { ...state, notified, sets };
  }
  function fmtLeft(ms) {
    const m = Math.max(1, Math.round(ms / 6e4));
    if (m >= 2880) return `\u7EA6 ${Math.round(m / 1440)} \u5929`;
    if (m >= 120) return `\u7EA6 ${Math.round(m / 60)} \u5C0F\u65F6`;
    return `\u7EA6 ${m} \u5206\u949F`;
  }
  function fmtTime(ms, now = Date.now()) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    const dayStart = (t) => {
      const x = new Date(t);
      x.setHours(0, 0, 0, 0);
      return x.getTime();
    };
    const diff = Math.round((dayStart(ms) - dayStart(now)) / DAY_MS);
    if (diff === 0) return `\u4ECA\u5929 ${hm}`;
    if (diff === 1) return `\u660E\u5929 ${hm}`;
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }
  function buildNotification(items, now = Date.now()) {
    if (!items?.length) return null;
    const first = items[0];
    const left = fmtLeft(first.endAt - now);
    if (items.length === 1) {
      return {
        title: `\u300A${first.title}\u300B${left}\u540E\u5173\u95ED`,
        message: `\u622A\u6B62 ${fmtTime(first.endAt, now)}\uFF0C\u70B9\u51FB\u6253\u5F00\u9898\u76EE\u96C6`,
        buttonTitle: "\u6253\u5F00\u9898\u76EE\u96C6",
        targetId: first.id
      };
    }
    return {
      title: `${items.length} \u4E2A\u9898\u76EE\u96C6\u5373\u5C06\u5173\u95ED`,
      message: `\u6700\u65E9\u300A${first.title}\u300B${left}\u540E\u5173\u95ED\uFF08${fmtTime(first.endAt, now)}\uFF09`,
      buttonTitle: "\u6253\u5F00\u6700\u65E9\u5173\u95ED\u7684",
      targetId: first.id
    };
  }

  // src/background/index.js
  var ALARM_NAME = "bps-reminder-scan";
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function normalizeServer(server) {
    const s = String(server || "").trim();
    if (!s) return null;
    const withProto = /^https?:\/\//i.test(s) ? s : "http://" + s;
    try {
      const u = new URL(withProto);
      if (!u.hostname) return null;
      const token = u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : "";
      return { base: u.origin, token };
    } catch (_) {
      return null;
    }
  }
  async function post(base, token, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Token"] = token;
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  var LLM_TIMEOUT_MS = 12e4;
  var llmControllers = /* @__PURE__ */ new Map();
  function opencodeChatUrl(baseUrl) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
    let u;
    try {
      u = new URL(base);
    } catch (_) {
      return null;
    }
    if (u.protocol !== "https:" || u.hostname !== "opencode.ai") return null;
    if (!u.pathname.startsWith("/inference/go/")) return null;
    return u.origin + u.pathname + "/chat/completions";
  }
  async function relayLlmChat(msg) {
    const url = opencodeChatUrl(msg.baseUrl);
    if (!url) return { ok: false, status: 400, reason: "\u4EC5\u652F\u6301\u8F6C\u53D1 OpenCode Go \u7684 /inference/go/ \u7AEF\u70B9" };
    const apiKey = String(msg.apiKey || "").trim();
    if (!apiKey) return { ok: false, status: 400, reason: "API Key \u4E3A\u7A7A" };
    const session = String(msg.session || "").trim();
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(session)) return { ok: false, status: 400, reason: "\u7F3A\u5C11\u6216\u975E\u6CD5\u7684 x-opencode-session" };
    const model = String(msg.model || "").trim();
    if (!model) return { ok: false, status: 400, reason: "\u6A21\u578B\u4E3A\u7A7A" };
    if (!Array.isArray(msg.messages) || !msg.messages.length) return { ok: false, status: 400, reason: "messages \u4E3A\u7A7A" };
    const reqId = String(msg.reqId || "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(reqId)) return { ok: false, status: 400, reason: "\u7F3A\u5C11\u6216\u975E\u6CD5\u7684 reqId" };
    const ctl = new AbortController();
    let userAborted = false;
    llmControllers.set(reqId, { abort: () => {
      userAborted = true;
      ctl.abort();
    } });
    const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        // 浏览器禁止脚本设置 User-Agent（禁止头，会被静默丢弃），这里只能保留浏览器自身 UA
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
          "x-opencode-session": session
        },
        body: JSON.stringify({ model, temperature: 0, messages: msg.messages }),
        signal: ctl.signal
      });
      const text = await res.text().catch(() => "");
      return { ok: res.ok, status: res.status, text, logId: res.headers.get("x-opencode-log-id") || "" };
    } catch (err) {
      const timeout = err?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        reason: userAborted ? "\u5DF2\u4E2D\u6B62" : timeout ? `\u8BF7\u6C42 ${Math.round(LLM_TIMEOUT_MS / 1e3)}s \u65E0\u54CD\u5E94\uFF0C\u5DF2\u6309\u8D85\u65F6\u4E2D\u65AD` : err?.message || String(err)
      };
    } finally {
      clearTimeout(timer);
      llmControllers.delete(reqId);
    }
  }
  async function toDataUrl(src) {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
  }
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
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u63D0\u9192\u5FEB\u7167\u5199\u5165\u5931\u8D25:", err?.message || err);
    }
  }
  async function ensureAlarm() {
    try {
      const existing = await chrome.alarms.get(ALARM_NAME);
      if (!existing) chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_PERIOD_MINUTES });
    } catch (_) {
      try {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: SCAN_PERIOD_MINUTES });
      } catch (_2) {
      }
    }
  }
  async function notifyPermission() {
    try {
      return await chrome.notifications.getPermissionLevel();
    } catch (_) {
      return "granted";
    }
  }
  async function showNotification({ id, title, message, buttonTitle }) {
    const options = {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      contextMessage: "\u66F4\u597D\u7684\u9898\u76EE\u96C6"
    };
    if (buttonTitle) options.buttons = [{ title: buttonTitle }];
    try {
      await chrome.notifications.create(id, options);
      return true;
    } catch (err) {
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u6D4F\u89C8\u5668\u901A\u77E5\u521B\u5EFA\u5931\u8D25:", err?.message || err);
      return false;
    }
  }
  async function scanAndNotify(reason) {
    const settings = await loadSettings();
    if (settings.reminderBrowser === false) return { skipped: "off" };
    const state = await readState();
    const now = Date.now();
    const { items, marks } = computeDue(state.sets, state.notified, now, NOTIFY_BEFORE_MINUTES);
    if (!items.length) {
      await writeState(pruneState(state, now));
      return { due: 0, notified: 0 };
    }
    if (await notifyPermission() === "denied") return { skipped: "denied", due: items.length };
    const plan = buildNotification(items, now);
    const shown = await showNotification({ id: NOTIFY_ID, ...plan });
    if (shown) {
      for (const k of marks) state.notified[k] = now;
      state.lastTarget = plan.targetId;
      console.info(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u6D4F\u89C8\u5668\u901A\u77E5\uFF08${reason}\uFF09\uFF1A\u300C${plan.title}\u300D`);
    }
    await writeState(pruneState(state, now));
    return { due: items.length, notified: shown ? 1 : 0 };
  }
  async function storeAndScan(sets) {
    const state = await readState();
    await writeState(withSnapshot(state, sets, Date.now()));
    return scanAndNotify("\u540C\u6B65");
  }
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
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u6253\u5F00\u9898\u76EE\u96C6\u5931\u8D25:", err?.message || err);
    }
    try {
      await chrome.notifications.clear(id);
    } catch (_) {
    }
  }
  async function notifyTest() {
    if (await notifyPermission() === "denied") {
      return { ok: false, error: "\u7CFB\u7EDF\u5DF2\u5173\u95ED\u6D4F\u89C8\u5668\u901A\u77E5\uFF08\u7CFB\u7EDF\u8BBE\u7F6E\u6216\u4E13\u6CE8\u52A9\u624B\uFF09\uFF0C\u8BF7\u5148\u5141\u8BB8\u540E\u91CD\u8BD5" };
    }
    try {
      await chrome.notifications.clear(TEST_NOTIFY_ID);
    } catch (_) {
    }
    const ok = await showNotification({
      id: TEST_NOTIFY_ID,
      title: "\u6D4F\u89C8\u5668\u901A\u77E5\u5DF2\u5F00\u542F",
      message: "\u9898\u76EE\u96C6\u4E34\u8FD1\u5173\u95ED\u65F6\u4F1A\u8FD9\u6837\u63D0\u9192\u4F60\uFF08\u622A\u6B62\u524D 3 \u5929\u30011 \u5929\u5404\u4E00\u6B21\uFF09\u3002",
      buttonTitle: "\u6253\u5F00\u9898\u76EE\u96C6\u5217\u8868"
    });
    return ok ? { ok: true } : { ok: false, error: "\u901A\u77E5\u521B\u5EFA\u5931\u8D25" };
  }
  async function syncChannels(msg) {
    if (!Array.isArray(msg.sets)) return { ok: false, error: "\u4E0A\u62A5\u6570\u636E\u7F3A\u5931" };
    const out = { ok: false, total: msg.sets.length, browser: null, email: null };
    if (msg.browser) {
      const scan = await storeAndScan(msg.sets);
      out.browser = { stored: msg.sets.length, due: scan?.due || 0, skipped: scan?.skipped || null };
    }
    const server = normalizeServer(msg.server);
    const email = String(msg.email || "").trim();
    if (!msg.server && !msg.email) {
    } else if (!server) {
      out.email = { ok: false, error: "\u670D\u52A1\u5668\u5730\u5740\u65E0\u6548" };
    } else if (!EMAIL_RE.test(email)) {
      out.email = { ok: false, error: "\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E" };
    } else {
      try {
        const data = await post(server.base, server.token, "/api/subscriptions", { email, sets: msg.sets });
        out.email = { ok: true, total: data.total };
      } catch (err) {
        out.email = { ok: false, error: err?.message || String(err) };
      }
    }
    out.ok = !!(out.browser || out.email?.ok);
    if (!out.ok && out.email?.error) out.error = out.email.error;
    return out;
  }
  async function testMail(msg) {
    const base = normalizeServer(msg.server);
    if (!base) return { ok: false, error: "\u670D\u52A1\u5668\u5730\u5740\u65E0\u6548" };
    const email = String(msg.email || "").trim();
    if (!EMAIL_RE.test(email)) return { ok: false, error: "\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E" };
    await post(base.base, base.token, "/api/test", { email });
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "BPS_LLM_ABORT") {
      const entry = llmControllers.get(String(msg.reqId || ""));
      if (entry) entry.abort();
      sendResponse({ ok: !!entry });
      return false;
    }
    if (msg && msg.type === "BPS_LLM_CHAT") {
      relayLlmChat(msg).then(
        sendResponse,
        (err) => sendResponse({ ok: false, status: 0, reason: err?.message || String(err) })
      );
      return true;
    }
    if (msg && msg.type === "BPS_FETCH_IMAGE") {
      if (typeof msg.src !== "string" || !/^https?:\/\//i.test(msg.src)) {
        sendResponse({ ok: false, reason: "\u56FE\u7247\u5730\u5740\u65E0\u6548" });
        return false;
      }
      toDataUrl(msg.src).then(
        (dataUrl) => sendResponse({ ok: true, dataUrl }),
        (err) => sendResponse({ ok: false, reason: err?.message || String(err) })
      );
      return true;
    }
    if (!msg || msg.type !== "BPS_SYNC" && msg.type !== "BPS_TEST" && msg.type !== "BPS_NOTIFY_TEST") return;
    const work = msg.type === "BPS_NOTIFY_TEST" ? notifyTest() : msg.type === "BPS_TEST" ? testMail(msg) : syncChannels(msg);
    work.then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
  void ensureAlarm();
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
      await ensureAlarm();
      await scanAndNotify("\u5B89\u88C5/\u66F4\u65B0");
    })();
  });
  chrome.runtime.onStartup.addListener(() => {
    void (async () => {
      await ensureAlarm();
      await scanAndNotify("\u6D4F\u89C8\u5668\u542F\u52A8");
    })();
  });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) void scanAndNotify("\u5B9A\u671F\u626B\u63CF");
  });
  chrome.notifications.onClicked.addListener((id) => {
    void openTarget(id);
  });
  chrome.notifications.onButtonClicked.addListener((id) => {
    void openTarget(id);
  });
})();
