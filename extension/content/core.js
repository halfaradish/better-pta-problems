/* 更好的题目集 · PTA 题目集列表增强（构建产物，请勿直接编辑；源码见 src/content/） */
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
    // 含图题作答（需视觉模型如 deepseek-flash：图片下载编码进 prompt；默认关闭=客观题含图跳过；编程题不受此项影响）
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
          const { settings: settings3 } = await chrome.storage.sync.get({ settings: {} });
          return { ...DEFAULTS, ...settings3 };
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
  function saveSettings(next) {
    return storage.set(next);
  }
  function onSettingsChanged(cb) {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.settings) cb({ ...DEFAULTS, ...changes.settings.newValue });
    });
  }
  function reminderChannels(s = {}) {
    const server = String(s.reminderServer || "").trim();
    const emailTo = String(s.reminderEmail || "").trim();
    return {
      browser: s.reminderBrowser !== false,
      email: s.reminderEmailEnabled !== false && !!server && !!emailTo,
      skipDone: s.reminderSkipDone !== false,
      server,
      emailTo
    };
  }

  // src/shared/paths.js
  var LIST_PATH_RE = /^\/problem-sets(?:\/(active|all|finished|mine))?\/?$/;
  var SET_HREF_RE = /^\/problem-sets\/(\d+)\/overview$/;
  var API_URL_RE = /pintia\.cn\/api\/problem-sets(\?|$)/;
  var ACTIVE_PATH_RE = /^\/problem-sets\/active\/?$/;

  // src/content/aggregate.js
  var AGG_TTL = 2 * 60 * 1e3;
  var agg = { key: null, items: null, at: 0, inflight: null, abort: null, retryAt: 0 };
  var routeUrls = /* @__PURE__ */ new Map();
  var lastApiEntryTime = 0;
  var lastPath = null;
  var hooks = {};
  function setAggregateHooks(next) {
    hooks = { ...hooks, ...next };
  }
  function aggregateItems() {
    return agg.items;
  }
  function canonicalApiUrl(raw) {
    if (String(raw).startsWith("mock://")) return raw;
    try {
      const u = new URL(raw);
      if (u.hostname !== "pintia.cn" || u.pathname !== "/api/problem-sets") return null;
      if (u.searchParams.has("_bps")) return null;
      u.searchParams.delete("page");
      u.searchParams.delete("limit");
      return u.toString();
    } catch (_) {
      return null;
    }
  }
  function trackRouteApiUrl() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      hooks.onPathChange?.(path);
    }
    for (const e of performance.getEntriesByType("resource")) {
      if (e.startTime <= lastApiEntryTime || !API_URL_RE.test(e.name)) continue;
      if (e.name.includes("_bps=")) continue;
      lastApiEntryTime = e.startTime;
      const key = canonicalApiUrl(e.name);
      if (!key) continue;
      const rec = routeUrls.get(path);
      if (!rec || e.startTime > rec.entryTime) routeUrls.set(path, { url: key, entryTime: e.startTime });
    }
  }
  function currentRouteApiUrl() {
    trackRouteApiUrl();
    if (window.__BPS_FORCE_LIST__ && window.__BPS_MOCK_API__) return "mock://problem-sets";
    return routeUrls.get(location.pathname)?.url || null;
  }
  async function fetchJson(url, signal) {
    if (window.__BPS_FETCH_JSON__) return window.__BPS_FETCH_JSON__(url);
    const res = await fetch(url, { credentials: "include", headers: { accept: "application/json" }, signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  function normalizeApiItems(list, examMap) {
    const now = Date.now();
    return (list || []).map((p) => {
      const startAt = p.startAt ? new Date(p.startAt) : null;
      const closeAt = p.endAt ? new Date(p.endAt) : null;
      const started = startAt && now >= +startAt;
      const closed = closeAt && now >= +closeAt;
      const isExam = !!(examMap && examMap[p.id]);
      const badges = [];
      if (!started) badges.push(["\u672A\u5F00\u653E", "orange"]);
      else {
        if (isExam && (!closed || now - +closeAt < 7 * 864e5)) badges.push(["\u5DF2\u5F00\u8003", "green"]);
        badges.push([closed ? "\u5DF2\u5173\u95ED" : "\u5DF2\u5F00\u653E", closed ? "grey" : "blue"]);
      }
      return {
        id: String(p.id),
        title: p.name || "",
        startAt,
        closeAt,
        badges,
        examId: examMap && examMap[p.id] ? String(examMap[p.id]) : "",
        // 关联考试，答题进度的取数钥匙
        creator: p.ownerNickname || "",
        org: p.organizationName || ""
      };
    });
  }
  async function aggregateAll(keyUrl, signal) {
    const u = new URL(keyUrl);
    u.searchParams.set("page", "0");
    u.searchParams.set("limit", "100");
    const data = await fetchJson(String(u), signal);
    const examMap = { ...data.examIdByProblemSetId || {} };
    const items = normalizeApiItems(data.problemSets, examMap);
    const total = data.total ?? items.length;
    if (items.length < total) {
      const pageSize = items.length;
      for (let page = 1; items.length < total && page < 60; page++) {
        u.searchParams.set("page", String(page));
        const d = await fetchJson(String(u), signal);
        Object.assign(examMap, d.examIdByProblemSetId || {});
        const batch = normalizeApiItems(d.problemSets, examMap);
        if (!batch.length) break;
        items.push(...batch);
        if (batch.length < pageSize) break;
      }
    }
    const seen = /* @__PURE__ */ new Set();
    for (const it of items) if (!it.examId) it.examId = examMap[it.id] ? String(examMap[it.id]) : "";
    return items.filter((i) => !seen.has(i.id) && seen.add(i.id));
  }
  function startAggregate(key) {
    if (agg.inflight && agg.key === key) return;
    if (agg.key === key && Date.now() < agg.retryAt) return;
    agg.abort?.abort();
    agg.key = key;
    const ctrl = new AbortController();
    agg.abort = ctrl;
    const settled = (p2) => {
      if (agg.inflight === p2) {
        agg.inflight = null;
        agg.abort = null;
      }
      hooks.onSettled?.();
    };
    const p = aggregateAll(key, ctrl.signal).then((items) => {
      if (agg.key !== key) return;
      agg.items = items;
      agg.at = Date.now();
      agg.retryAt = 0;
      hooks.onSuccess?.();
    }).catch((err) => {
      if (agg.key !== key || err?.name === "AbortError") return;
      agg.retryAt = Date.now() + 30 * 1e3;
      console.warn(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u8DE8\u9875\u805A\u5408\u5931\u8D25\uFF08${err?.message || err}\uFF09\uFF0C\u6682\u7528${agg.items ? "\u4E0A\u6B21\u805A\u5408\u7ED3\u679C" : "\u5F53\u524D\u9875\u6570\u636E"}\uFF0C30 \u79D2\u540E\u81EA\u52A8\u91CD\u8BD5`);
    }).finally(() => settled(p));
    agg.inflight = p;
  }
  function ensureAggregate() {
    const key = currentRouteApiUrl();
    if (!key) return null;
    if (agg.key !== key) startAggregate(key);
    if (agg.key === key && agg.items) {
      if (Date.now() - agg.at < AGG_TTL) return agg.items;
      startAggregate(key);
      return agg.items;
    }
    if (Date.now() < agg.retryAt) return null;
    if (!agg.inflight) startAggregate(key);
    return null;
  }

  // src/shared/llm.js
  var LLM_TOTAL_TIMEOUT_MS = 3e5;
  var LLM_DIRECT_TIMEOUT_MS = 12e4;
  var LLM_MAX_ATTEMPTS = 3;
  var LLM_MAX_IDLE_ATTEMPTS = 2;

  // src/content/autoanswer.js
  var TYPE_BY_NAME = {
    "\u5224\u65AD\u9898": "TRUE_OR_FALSE",
    "\u5355\u9009\u9898": "MULTIPLE_CHOICE",
    "\u586B\u7A7A\u9898": "FILL_IN_THE_BLANK",
    "\u7F16\u7A0B\u9898": "PROGRAMMING"
  };
  var EXAM_PROBLEMS_RE = /^\/problem-sets\/(\d+)\/exam\/problems(\/type\/(\d+))?/;
  var LETTERS = "ABCDEFGHIJ";
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  var abortedError = () => {
    const err = new Error("\u5DF2\u4E2D\u6B62");
    err.aborted = true;
    return err;
  };
  var isInvalidatedMessage = (msg) => /Extension context invalidated/i.test(String(msg || ""));
  var invalidatedError = () => {
    const err = new Error("\u6269\u5C55\u5DF2\u88AB\u91CD\u65B0\u52A0\u8F7D\u6216\u66F4\u65B0\uFF0C\u5F53\u524D\u9875\u9762\u65E0\u6CD5\u7EE7\u7EED\u8BF7\u6C42\uFF1B\u8BF7\u5237\u65B0 PTA \u9875\u9762\u540E\u91CD\u8DD1");
    err.kind = "invalidated";
    return err;
  };
  var IMAGE_TIMEOUT_MS = 3e4;
  async function fetchBounded(url, opts = {}, ms, stopSignal) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const stopNow = () => ctl.abort();
    if (stopSignal) {
      if (stopSignal.aborted) {
        clearTimeout(timer);
        throw abortedError();
      }
      stopSignal.addEventListener("abort", stopNow, { once: true });
    }
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } catch (err) {
      if (stopSignal?.aborted) throw abortedError();
      if (err?.name === "AbortError") {
        const timeoutErr = new Error(`\u8BF7\u6C42 ${Math.round(ms / 1e3)}s \u65E0\u54CD\u5E94\uFF0C\u5DF2\u6309\u8D85\u65F6\u4E2D\u65AD`);
        timeoutErr.kind = "timeout";
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", stopNow);
    }
  }
  var sessionId = null;
  function sessionHeader() {
    if (!sessionId) {
      try {
        sessionId = sessionStorage.getItem("__bps_aa_session") || null;
      } catch (_) {
      }
      if (!sessionId) {
        sessionId = "bps-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        try {
          sessionStorage.setItem("__bps_aa_session", sessionId);
        } catch (_) {
        }
      }
    }
    return sessionId;
  }
  function parseChoiceAnswer(raw, optionCount) {
    let s = String(raw ?? "").trim();
    const mJson = s.match(/\{[\s\S]*\}/);
    if (mJson) {
      try {
        s = String(JSON.parse(mJson[0]).answer ?? "").trim();
      } catch (_) {
      }
    }
    s = s.replace(/^```[a-z]*|```$/g, "").trim();
    const m = s.match(/[A-Z]/i);
    const letter = m ? m[0].toUpperCase() : null;
    if (!letter || letter.charCodeAt(0) - 65 >= optionCount) return null;
    return letter;
  }
  function normalizeTF(raw) {
    const s = String(raw ?? "").trim().toLowerCase();
    if (/^(t|true|对|正确|是)$/.test(s)) return "TRUE";
    if (/^(f|false|错(误)?|否)$/.test(s)) return "FALSE";
    return null;
  }
  function parseFillAnswers(raw, blankCount) {
    let v = raw;
    if (typeof raw === "string") {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const o = JSON.parse(m[0]);
          v = Array.isArray(o.answers) ? o.answers : o.answer ?? v;
        } catch (_) {
        }
      }
    } else if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.answers)) {
      v = v.answers;
    }
    const arr = Array.isArray(v) ? v : blankCount === 1 ? [v] : null;
    if (!arr || arr.length !== blankCount) return null;
    const out = arr.map((a) => String(a ?? "").trim());
    return out;
  }
  function buildPrompt(q) {
    const lines = [];
    lines.push("\u4F60\u662F\u7B97\u6CD5\u4E0E\u6570\u636E\u7ED3\u6784\u8BFE\u7A0B\u7684\u7B54\u9898\u52A9\u624B\u3002\u5FFD\u7565\u9898\u5E72\u4E2D\u7684\u9898\u53F7\u3001\u5206\u503C\u3001\u4F5C\u8005\u3001\u5355\u4F4D\u7B49\u5143\u4FE1\u606F\u3002");
    if (q.kind === "PROGRAMMING") {
      lines.push(`\u9898\u578B\uFF1A\u7F16\u7A0B\u9898\u3002\u8BF7\u7528\u300C${q.langLabel || "\u7F16\u8F91\u5668\u5F53\u524D\u8BED\u8A00"}\u300D\u5199\u4E00\u4E2A\u5B8C\u6574\u3001\u53EF\u76F4\u63A5\u63D0\u4EA4\u8BC4\u6D4B\u7684\u7A0B\u5E8F\uFF1A`);
      lines.push("\u6309\u9898\u9762\u7684\u8F93\u5165\u683C\u5F0F\u8BFB\u5165\u6570\u636E\uFF08\u4E0D\u8981\u8F93\u51FA\u4EA4\u4E92\u5F0F\u63D0\u793A\u8BED\uFF09\uFF0C\u4E25\u683C\u6309\u8F93\u51FA\u683C\u5F0F\u6253\u5370\u7ED3\u679C\u3002");
      lines.push("\u53EA\u7528\u8BE5\u8BED\u8A00\u7684\u6807\u51C6\u5E93\uFF08\u65E0\u628A\u63E1\u4E0D\u8981\u5F15\u7B2C\u4E09\u65B9\u5E93\uFF09\uFF1B\u7559\u610F\u9898\u9762\u7ED9\u51FA\u7684\u65F6\u95F4/\u5185\u5B58/\u4EE3\u7801\u957F\u5EA6\u9650\u5236\u3002");
      lines.push("\u8F93\u51FA\u53EA\u5305\u542B\u4E00\u4E2A\u4EE3\u7801\u56F4\u680F\u5757\uFF08``` \u5305\u88F9\uFF09\uFF0C\u56F4\u680F\u5185\u662F\u5B8C\u6574\u7A0B\u5E8F\u6E90\u7801\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002");
    } else {
      lines.push("\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u5305\u542B\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u6216\u4EE3\u7801\u56F4\u680F\u3002");
    }
    lines.push("");
    if (q.kind === "PROGRAMMING") {
    } else if (q.kind === "TRUE_OR_FALSE") {
      lines.push('\u9898\u578B\uFF1A\u5224\u65AD\u9898\u3002\u5224\u65AD\u9648\u8FF0\u7684\u6B63\u8BEF\uFF0Canswer \u53EA\u80FD\u662F "TRUE" \u6216 "FALSE"\u3002');
      lines.push('\u8F93\u51FA\u683C\u5F0F\uFF1A{"answer":"TRUE"}');
    } else if (q.kind === "MULTIPLE_CHOICE") {
      lines.push("\u9898\u578B\uFF1A\u5355\u9009\u9898\u3002\u4ECE\u4E0B\u5217\u9009\u9879\u4E2D\u9009\u51FA\u552F\u4E00\u6B63\u786E\u9879\uFF0Canswer \u4E3A\u9009\u9879\u5B57\u6BCD\u3002");
      lines.push('\u8F93\u51FA\u683C\u5F0F\uFF1A{"answer":"A"}');
    } else {
      lines.push(`\u9898\u578B\uFF1A\u586B\u7A7A\u9898\uFF08\u5171 ${q.blanks} \u7A7A\uFF09\u3002\u6587\u672C\u4E2D\u7684\u300C[\u7A7A1]\u300D\u300C[\u7A7A2]\u300D\u2026\u662F\u4F5C\u7B54\u4F4D\u7F6E\uFF1B`);
      lines.push(`answers \u5FC5\u987B\u662F\u4E0E\u7A7A\u6570\u76F8\u540C\u7684\u5B57\u7B26\u4E32\u6570\u7EC4\uFF08\u672C\u9898\u4E3A ${q.blanks} \u4E2A\uFF09\u3002`);
      lines.push('\u8F93\u51FA\u683C\u5F0F\uFF1A{"answers":["...","..."]}');
    }
    lines.push("");
    lines.push("\u9898\u76EE\uFF1A");
    lines.push(q.text);
    if (q.kind === "TRUE_OR_FALSE") {
      lines.push("\uFF08\u9648\u8FF0\u5982\u4E0A\uFF0C\u9009\u9879 T=\u6B63\u786E\u3001F=\u9519\u8BEF\uFF09");
    } else if (q.kind === "MULTIPLE_CHOICE") {
      lines.push("\u53EF\u9009\u5B57\u6BCD\uFF1A" + q.options.map((o) => o.letter).join("\u3001"));
    }
    return [
      {
        role: "system",
        content: q.kind === "PROGRAMMING" ? "\u4F60\u662F\u4E25\u8C28\u7684\u7B54\u9898\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA\u4E00\u4E2A\u4EE3\u7801\u56F4\u680F\u5757\uFF08``` \u5305\u88F9\u7684\u5B8C\u6574\u7A0B\u5E8F\u6E90\u7801\uFF09\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u6587\u5B57\u3002" : "\u4F60\u662F\u4E25\u8C28\u7684\u7B54\u9898\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA\u8981\u6C42\u7684 JSON\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u6587\u5B57\u3002"
      },
      { role: "user", content: lines.join("\n") }
    ];
  }
  function normalizeLangLabel(text) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    return s.replace(/\s*\d+(?:\.\d+)?\s*(?:ms|s)\s*\/\s*\d+(?:\.\d+)?\s*[KMGTP]?i?B\s*$/i, "").trim();
  }
  var COMPILER_LABELS = {
    GCC: "C (gcc)",
    MODERN_GCC: "C (gcc c11)",
    GXX: "C++ (g++)",
    CLANG: "C (clang)",
    CLANGXX: "C++ (clang++)",
    JAVAC: "Java (javac)",
    PYTHON2: "Python (python2)",
    PYTHON3: "Python (python3)",
    RUBY: "Ruby (ruby)",
    BASH: "Bash (bash)",
    CAT: "Plaintext (cat)",
    CLISP: "Common Lisp (sbcl)",
    FPC: "Pascal (fpc)",
    GO: "Go (go)",
    GHC: "Haskell (ghc)",
    LUA: "Lua (lua)",
    LUAJIT: "Lua (luajit)",
    MCS: "C# (dotnet)",
    NODE: "JavaScript (node)",
    OCAMLC: "OCaml (ocamlc)",
    PHP: "PHP (php)",
    PERL: "Perl (perl)",
    AWK: "AWK (awk)",
    DMD: "D (dmd)",
    RKT: "Racket (racket)",
    VALAC: "Vala (valac)",
    VBNC: "Visual Basic (dotnet)",
    KOTLIN: "Kotlin (kotlinc)",
    SWIFT: "Swift (swiftc)",
    OBJC: "Objective-C (clang)",
    FORTRAN: "Fortran95 (gfortran)",
    OCTAVE: "Octave (octave-cli)",
    RLANG: "R (R)",
    ASM: "ASM (nasm.sh)",
    RUST: "Rust (rustc)",
    SCALA: "Scala (scalac)",
    PYPY3: "Python (pypy3)",
    CANGJIE: "\u4ED3\u9889 (cjc)"
  };
  function parseCodeAnswer(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const jsonMatch = s.match(/^\{[\s\S]*\}$/);
    if (jsonMatch) {
      try {
        const o = JSON.parse(jsonMatch[0]);
        if (typeof o.answer === "string" && o.answer.trim()) return o.answer.trim() + "\n";
      } catch (_) {
      }
    }
    const fences = [...s.matchAll(/```[A-Za-z0-9+#_.-]*(?:\r?\n)([\s\S]*?)```/g)];
    if (fences.length) {
      const block = fences.map((f) => f[1]).sort((a, b) => b.length - a.length)[0];
      return block.replace(/\n+$/, "") + "\n";
    }
    if (/[\n;{}]/.test(s) && !/^(抱歉|对不起|无法|这不是)/.test(s)) {
      const stripped = s.replace(/^[A-Za-z0-9+#_.-]*```|^```[A-Za-z0-9+#_.-]*/g, "").replace(/```[A-Za-z0-9+#_.-]*$|```$/g, "").trim();
      return stripped ? stripped + "\n" : null;
    }
    return null;
  }
  async function fetchAllowedCompilers(psId) {
    const data = await fetch(`/api/problem-sets/${psId}/exams`, {
      headers: { accept: "application/json" },
      credentials: "include"
    }).then((r) => r.json());
    const list = data?.problemSet?.problemSetConfig?.compilers;
    return Array.isArray(list) && list.length ? list : null;
  }
  function answerFormEl() {
    return document.querySelector('[class*="CodingProblemAnswerForm"]');
  }
  function editableCm() {
    const form = answerFormEl();
    return form && [...form.querySelectorAll(".cm-content")].find((x) => x.getAttribute("contenteditable") === "true") || null;
  }
  function submitButton() {
    return [...document.querySelectorAll("main button")].find((b) => (b.textContent || "").trim() === "\u63D0\u4EA4\u672C\u9898\u4F5C\u7B54") || null;
  }
  function langLabelOf() {
    const form = answerFormEl();
    return normalizeLangLabel(form?.querySelector(".select__single-value")?.textContent || "");
  }
  function collectProgramming() {
    const mainEl = document.querySelector("main");
    const form = answerFormEl();
    if (!mainEl || !form) return null;
    const cm = [...form.querySelectorAll(".cm-content")].find((x) => x.getAttribute("contenteditable") === "true");
    if (!cm) return null;
    const pspId = (location.search.match(/problemSetProblemId=(\d+)/) || [])[1];
    if (!pspId) return null;
    const stem = [...mainEl.querySelectorAll("img")].filter((i) => !form.contains(i)).map((i) => i.getAttribute("src") ? i.src : null).filter(Boolean);
    const imgInfo = { options: {}, stem, total: stem.length };
    const text = cleanText(mainEl, '[class*="CodingProblemAnswerForm"]');
    return {
      id: pspId,
      label: (text.match(/\d+-\d+/) || [])[0] || null,
      // 例题号形如 7-1（页面标题开头）
      kind: "PROGRAMMING",
      text,
      langLabel: langLabelOf(),
      hasImg: imgInfo.total > 0,
      imgInfo,
      answered: String(cm.textContent || "").trim().length > 0
      // 草稿代码非空视作已答
    };
  }
  function programmingIds(psId, typeId) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const re = new RegExp(`^/problem-sets/${psId}/exam/problems/type/${typeId}\\?problemSetProblemId=(\\d+)$`);
    for (const a of document.querySelectorAll("a[href]")) {
      const m = (a.getAttribute("href") || "").match(re);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }
  function compilerIdFromLabel(label) {
    const l = String(label || "").replace(/\s+/g, " ").trim();
    for (const [id, name] of Object.entries(COMPILER_LABELS)) if (name === l) return id;
    return null;
  }
  async function getDraftDetail(pspId) {
    const d = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
      headers: { accept: "application/json" },
      credentials: "include"
    }).then((r) => r.json()).catch(() => null);
    return d?.answer?.detail || null;
  }
  async function saveDraft(pspId, detail, compilerId, program) {
    if (!compilerId) return { ok: false, status: null };
    const body = JSON.stringify({
      answer: {
        detail: {
          problemId: detail?.problemId ?? "0",
          problemSetProblemId: detail?.problemSetProblemId || pspId,
          customTestData: detail?.customTestData,
          // 原样保留（可为 null）
          programmingSubmissionDetail: { compiler: compilerId, program }
        }
      }
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
      if (attempt < 4) await sleep(lastStatus === 429 ? 3e3 : 800);
    }
    return { ok: false, status: lastStatus, err: lastErr ? String(lastErr.message || lastErr) : null };
  }
  var lastDraftPostAt = 0;
  async function pacedDraftPost(pspId, body) {
    const gap = Date.now() - lastDraftPostAt;
    if (gap < 2200) await sleep(2200 - gap);
    const res = await fetch(`/api/problem-sets/problems/${pspId}/exam-draft`, {
      method: "POST",
      headers: { accept: "application/json", "Content-Type": "application/json" },
      credentials: "include",
      body
    });
    lastDraftPostAt = Date.now();
    return res;
  }
  function stripDraftHttpCache(pspId) {
    try {
      const raw = JSON.parse(localStorage.getItem("user-cache") || "{}");
      const pat = raw.PAT_HTTP_CACHE ? JSON.parse(raw.PAT_HTTP_CACHE) : null;
      if (!pat) return;
      let hit = false;
      for (const k of Object.keys(pat)) if (/\/exam-draft/.test(k) && new RegExp(`/problems/${pspId}/`).test(k)) {
        delete pat[k];
        hit = true;
      }
      if (hit) {
        raw.PAT_HTTP_CACHE = JSON.stringify(pat);
        localStorage.setItem("user-cache", JSON.stringify(raw));
      }
    } catch (_) {
    }
  }
  async function prepNextProblemCache(nextId) {
    try {
      const raw = JSON.parse(localStorage.getItem("user-cache") || "{}");
      const key = `codingProblem_${nextId}`;
      const entry = raw[key] || null;
      const cacheProgram = String(entry?.program ?? "");
      let detailProgram = null;
      if (cacheProgram) {
        const detail = await getDraftDetail(nextId);
        detailProgram = detail?.programmingSubmissionDetail?.program ?? "";
      }
      if (!cacheProgram || cacheProgram === detailProgram) {
        delete raw[key];
        localStorage.setItem("user-cache", JSON.stringify(raw));
        return { cleaned: true };
      }
      return { cleaned: false, staleUserInput: true };
    } catch (_) {
      return { cleaned: false };
    }
  }
  function clearCodingProblemCache(id) {
    try {
      const raw = JSON.parse(localStorage.getItem("user-cache") || "{}");
      if ("codingProblem_" + id in raw === false) return;
      delete raw["codingProblem_" + id];
      localStorage.setItem("user-cache", JSON.stringify(raw));
    } catch (_) {
    }
  }
  function seedCodingProblemCache(id, program, detail) {
    try {
      const raw = JSON.parse(localStorage.getItem("user-cache") || "{}");
      raw["codingProblem_" + id] = {
        program,
        testData: detail?.customTestData?.content ?? "",
        saveAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      localStorage.setItem("user-cache", JSON.stringify(raw));
      return { seeded: true };
    } catch (err) {
      return { seeded: false, err: err ? String(err.message || err) : null };
    }
  }
  async function waitHydrate(expectEnabled) {
    for (let i = 0; i < 200; i++) {
      await sleep(100);
      const b = submitButton();
      if (!b) continue;
      if (b.disabled === !expectEnabled) {
        await sleep(250);
        const b2 = submitButton();
        if (b2 && b2.disabled === b.disabled) return { ok: true, disabled: b.disabled };
      }
    }
    return { ok: false };
  }
  async function settleEditorState() {
    let prev = null;
    for (let i = 0; i < 120; i++) {
      await sleep(100);
      const cm = editableCm();
      if (!cm) continue;
      const sig = `${(cm.textContent || "").slice(0, 40)}|${submitButton()?.disabled ?? "none"}`;
      if (sig === prev) return true;
      prev = sig;
    }
    return false;
  }
  function cleanText(el2, extraRemoveSel = "") {
    const clone = el2.cloneNode(true);
    clone.classList.add("bps-clone");
    clone.style.cssText = "position:fixed;left:-99999px;top:0;margin:0;max-width:900px";
    let bi = 0;
    for (const inp of [...clone.querySelectorAll("input")].filter((i) => i.type === "text")) {
      bi += 1;
      inp.replaceWith(document.createTextNode(`[\u7A7A${bi}]`));
    }
    for (const n of clone.querySelectorAll('button, input, textarea, [class*="cm-gutters"]' + (extraRemoveSel ? ", " + extraRemoveSel : ""))) n.remove();
    for (const n of clone.querySelectorAll("*")) {
      if ((n.textContent || "").trim().match(/^\d+\s*分$/) && !n.querySelector("*")) n.remove();
    }
    document.body.appendChild(clone);
    const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
    clone.remove();
    return text;
  }
  function collectPage() {
    const out = [];
    const containers = [...document.querySelectorAll("main [id]")].filter((el2) => /^\d+$/.test(el2.id) && (el2.querySelector("input[type=radio]") || [...el2.querySelectorAll("input")].some((i) => i.type === "text")));
    for (const el2 of containers) {
      const radios = [...el2.querySelectorAll("input[type=radio]")];
      const texts = [...el2.querySelectorAll("input")].filter((i) => i.type === "text");
      let kind;
      let options = [];
      let blanks = 0;
      if (radios.length === 2) kind = "TRUE_OR_FALSE";
      else if (radios.length > 2) {
        kind = "MULTIPLE_CHOICE";
        options = radios.map((r, i) => {
          const label = r.closest("label");
          const t = (label?.innerText || "").replace(/\s+/g, " ").trim();
          const optImg2 = label?.querySelector("img");
          const imgSrc = optImg2 && optImg2.getAttribute("src") ? optImg2.src : null;
          return { idx: i, letter: LETTERS[i] || "?" + i, text: t, imgSrc };
        });
      } else if (texts.length) {
        kind = "FILL_IN_THE_BLANK";
        blanks = texts.length;
      } else continue;
      const optImg = {};
      for (const o of options) if (o.imgSrc) optImg[o.letter] = o.imgSrc;
      const optSrcs = new Set(Object.values(optImg));
      const imgs = [...el2.querySelectorAll("img")].map((i) => i.getAttribute("src") ? i.src : null).filter((s) => s && !optSrcs.has(s));
      const imgInfo = { options: optImg, stem: imgs, total: imgs.length + Object.keys(optImg).length };
      out.push({
        id: el2.id,
        label: (el2.querySelector("button")?.textContent || "").trim(),
        // 题号（如 2-3），日志里用它指代题目
        kind,
        el: el2,
        radios,
        texts,
        options,
        blanks,
        imgInfo,
        hasImg: imgInfo.total > 0,
        answered: radios.length ? radios.some((r) => r.checked) : texts.some((t) => String(t.value || "").trim() !== ""),
        text: cleanText(el2)
      });
    }
    return out;
  }
  function sidebarTypes() {
    const psId = (location.pathname.match(EXAM_PROBLEMS_RE) || [])[1];
    if (!psId) return [];
    const out = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const m = (a.getAttribute("href") || "").match(/^\/problem-sets\/(\d+)\/exam\/problems\/type\/(\d+)$/);
      if (!m || m[1] !== psId) continue;
      const mm = (a.innerText || "").replace(/\s+/g, " ").trim().match(/^(.+?)\s*(\d+)\s*\/\s*(\d+)$/);
      if (!mm) continue;
      out.push({ typeName: mm[1], answered: +mm[2], total: +mm[3], typeId: m[2] });
    }
    return out;
  }
  function fillRadio(q, letter) {
    const idx = letter.charCodeAt(0) - 65;
    const radio = q.radios[idx];
    if (!radio || radio.disabled) return false;
    radio.click();
    return radio.checked;
  }
  function fillBlank(q, answers) {
    const setInput = (inp, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(inp, value);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    };
    q.texts.forEach((inp, i) => setInput(inp, answers[i] ?? ""));
    return true;
  }
  async function submitProgramming() {
    const btn = submitButton();
    if (!btn) return { saved: false, reason: "\u627E\u4E0D\u5230\u300C\u63D0\u4EA4\u672C\u9898\u4F5C\u7B54\u300D\u6309\u94AE" };
    if (btn.disabled) return { saved: false, reason: "\u63D0\u4EA4\u6309\u94AE\u4E0D\u53EF\u7528\uFF08\u4EE3\u7801\u4E3A\u7A7A\uFF09" };
    const mark = performance.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      btn.click();
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const hit = performance.getEntriesByType("resource").some((e) => e.startTime > mark && /\/exam-submissions(\?|$)/.test(e.name));
        if (hit) {
          await sleep(300);
          return { saved: true };
        }
      }
    }
    return { saved: false, reason: "\u70B9\u51FB\u63D0\u4EA4\u540E\u672A\u89C1 exam-submissions \u8BF7\u6C42" };
  }
  async function saveTypePage() {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "\u4FDD\u5B58" && !b.disabled);
    if (!btn) return { saved: false, reason: "\u627E\u4E0D\u5230\u4FDD\u5B58\u6309\u94AE" };
    const mark = performance.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
      btn.click();
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        const hit = performance.getEntriesByType("resource").some((e) => e.startTime > mark && /\/exam-submissions(\?|$)/.test(e.name));
        if (hit) {
          await sleep(300);
          return { saved: true };
        }
      }
    }
    return { saved: false, reason: "\u70B9\u51FB\u4FDD\u5B58\u540E\u672A\u89C1\u63D0\u4EA4\u8BF7\u6C42" };
  }
  function parseJsonLoose(text) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
  function normalizeBaseUrl(raw) {
    let s = String(raw || "").trim();
    s = s.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
    return s;
  }
  function parseLlmErrorBody(body) {
    const text = String(body || "").trim();
    if (!text) return null;
    try {
      const o = JSON.parse(text);
      const e = o && typeof o === "object" ? o.error && typeof o.error === "object" ? o.error : o : null;
      if (!e || typeof e !== "object") return null;
      const type = typeof e.type === "string" ? e.type : "";
      const message = typeof e.message === "string" ? e.message : "";
      if (!type && !message) return null;
      return { type, message };
    } catch (_) {
      return { type: "", message: text.slice(0, 160) };
    }
  }
  function classifyLlmError(err) {
    if (!err) return "fatal";
    if (err.aborted || err.kind === "abort") return "aborted";
    if (err.kind === "invalidated") return "invalidated";
    if (err.channelClosed) return "channel";
    if (err.kind === "idle") return "idle";
    if (err.kind === "total" || err.kind === "timeout") return "timeout";
    if (err.status == null || err.status === 0) return "network";
    return err.status === 429 || err.status >= 500 ? "retry" : "fatal";
  }
  function httpError(status, body, logId) {
    const parsed = parseLlmErrorBody(body);
    const detail = parsed ? [parsed.type, parsed.message].filter(Boolean).join("\uFF1A") : String(body || "").trim().slice(0, 160);
    const suffix = logId ? `\uFF08x-opencode-log-id: ${logId}\uFF09` : "";
    const err = new Error(`LLM HTTP ${status}${detail ? "\uFF0C" + detail : ""}${suffix}`);
    err.status = status;
    return err;
  }
  var NON_CHAT_MODEL_RULES = [
    { re: /^gpt-/i, protocol: "OpenAI Responses" },
    { re: /^grok-/i, protocol: "OpenAI Responses" },
    { re: /^muse-spark-/i, protocol: "OpenAI Responses" },
    { re: /^claude-/i, protocol: "Anthropic Messages" },
    { re: /^minimax-m3$/i, protocol: "Anthropic Messages" },
    // m3.1-flash 属 chat 系，不能用前缀
    { re: /^qwen3\.[78]-/i, protocol: "Anthropic Messages" },
    { re: /^gemini-/i, protocol: "Google generateContent" }
  ];
  function nonChatProtocol(modelId) {
    const id = String(modelId || "").trim();
    const hit = NON_CHAT_MODEL_RULES.find((x) => x.re.test(id));
    return hit ? hit.protocol : "";
  }
  function assertChatModel(cfg) {
    if (!cfg || cfg.gateway !== "opencode") return;
    const protocol = nonChatProtocol(cfg.model);
    if (!protocol) return;
    const err = new Error(`\u6A21\u578B ${cfg.model} \u8D70 ${protocol} \u534F\u8BAE\uFF0C\u672C\u5F15\u64CE\u53EA\u652F\u6301 /chat/completions\uFF1B\u8BF7\u6539\u7528 glm / kimi / deepseek / longcat / mimo \u7B49 chat \u7CFB\u6A21\u578B`);
    err.status = 400;
    throw err;
  }
  var hasBgFetch = typeof chrome !== "undefined" && !!chrome.runtime?.connect && !!chrome.runtime?.sendMessage;
  function backgroundChat(msg, { timeoutMs, signal, onProgress } = {}) {
    return new Promise((resolve, reject) => {
      let port = null;
      let settled = false;
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          port?.disconnect();
        } catch (_) {
        }
        fn(value);
      };
      const onAbort = () => {
        try {
          chrome.runtime.sendMessage({ type: "BPS_LLM_ABORT", reqId: msg.reqId }, () => {
            void chrome.runtime.lastError;
          });
        } catch (_) {
        }
        finish(reject, abortedError());
      };
      timer = setTimeout(() => {
        const err = new Error(`\u540E\u53F0\u8F6C\u53D1 ${Math.round(timeoutMs / 1e3)}s \u65E0\u54CD\u5E94`);
        err.kind = "timeout";
        finish(reject, err);
      }, timeoutMs + 5e3);
      try {
        port = chrome.runtime.connect({ name: "bps-llm" });
      } catch (err) {
        finish(reject, isInvalidatedMessage(err?.message) ? invalidatedError() : err);
        return;
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      port.onMessage.addListener((m) => {
        if (!m || settled) return;
        if (m.type === "progress") {
          try {
            onProgress?.(m);
          } catch (_) {
          }
          return;
        }
        if (m.type === "done") finish(resolve, m);
      });
      port.onDisconnect.addListener(() => {
        let lastMsg = "";
        try {
          lastMsg = chrome.runtime.lastError?.message || "";
        } catch (_) {
          lastMsg = "Extension context invalidated";
        }
        if (settled) return;
        if (isInvalidatedMessage(lastMsg)) {
          finish(reject, invalidatedError());
          return;
        }
        const err = new Error("\u540E\u53F0\u8F6C\u53D1\u8FDE\u63A5\u88AB\u56DE\u6536\uFF08service worker \u91CD\u542F\u6216\u6269\u5C55\u91CD\u8F7D\uFF09");
        err.channelClosed = true;
        finish(reject, err);
      });
      try {
        port.postMessage({ ...msg });
      } catch (err) {
        finish(reject, isInvalidatedMessage(err?.message) ? invalidatedError() : err);
      }
    });
  }
  async function chatViaBackground(cfg, messages, opts = {}) {
    if (!hasBgFetch) throw new Error("OpenCode Go \u9700\u8981\u6269\u5C55\u540E\u53F0\u8F6C\u53D1\uFF0C\u5F53\u524D\u73AF\u5883\u4E0D\u53EF\u7528");
    const reqId = "llm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const rsp = await backgroundChat({
      type: "BPS_LLM_CHAT",
      reqId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      session: sessionHeader(),
      messages
    }, {
      timeoutMs: LLM_TOTAL_TIMEOUT_MS,
      signal: runAbort?.signal ?? null,
      onProgress: opts.onProgress
    });
    if (!rsp) throw new Error("\u540E\u53F0\u8F6C\u53D1\u65E0\u54CD\u5E94");
    if (!rsp.ok) {
      if (rsp.kind === "abort") throw abortedError();
      if (rsp.status) throw httpError(rsp.status, rsp.text || rsp.reason || "", rsp.logId);
      const err = new Error(rsp.reason || "\u540E\u53F0\u8F6C\u53D1\u65E0\u54CD\u5E94");
      if (rsp.kind) err.kind = rsp.kind;
      throw err;
    }
    if (typeof rsp.content === "string") return rsp.content;
    let data = null;
    try {
      data = JSON.parse(rsp.text);
    } catch (_) {
      throw new Error("LLM \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("LLM \u54CD\u5E94\u4E3A\u7A7A");
    return text;
  }
  async function chatOnce(cfg, messages, opts = {}) {
    assertChatModel(cfg);
    if (cfg.gateway === "opencode") return chatViaBackground(cfg, messages, opts);
    const base = normalizeBaseUrl(cfg.baseUrl);
    const res = await fetchBounded(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + String(cfg.apiKey || "").trim()
      },
      body: JSON.stringify({ model: cfg.model, temperature: 0, messages })
    }, LLM_DIRECT_TIMEOUT_MS, runAbort?.signal ?? null);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw httpError(res.status, t, res.headers.get("x-opencode-log-id") || "");
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      throw new Error("LLM \u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("LLM \u54CD\u5E94\u4E3A\u7A7A");
    return text;
  }
  var retryDelay = (attempt) => 900 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
  function shortErrText(err) {
    return String(err?.message || err).replace(/^LLM 请求失败：/, "").slice(0, 90);
  }
  async function chatWithRetry(cfg, messages, opts = {}) {
    const label = opts.label ? `${opts.label}\uFF1A` : "";
    const onProgress = (evt) => {
      if (evt.phase === "stream") {
        fire({ kind: "log", level: "info", text: `${label}\u7F51\u5173\u5DF2\u5EFA\u7ACB\u6D41\uFF0C\u7B49\u5F85\u9996\u5757\u2026` });
      } else if (evt.phase === "first") {
        fire({ kind: "log", level: "info", text: `${label}\u6A21\u578B\u5DF2\u5F00\u59CB\u8F93\u51FA\uFF08\u7B49\u5F85 ${(evt.elapsedMs / 1e3).toFixed(1)}s\uFF09` });
      } else if (evt.phase === "tick") {
        fire({ kind: "log", level: "info", text: `${label}\u751F\u6210\u4E2D\u2026 \u5DF2\u6536\u5230 ${evt.chars} \u5B57\u7B26\uFF08${(evt.elapsedMs / 1e3).toFixed(1)}s\uFF09` });
      } else if (evt.phase === "thinking" || evt.phase === "thinking-tick") {
        fire({ kind: "log", level: "info", text: `${label}\u6A21\u578B\u601D\u8003\u4E2D\u2026 \u5DF2\u6536\u5230 ${evt.chars} \u5B57\u7B26\u63A8\u7406\uFF08${(evt.elapsedMs / 1e3).toFixed(1)}s\uFF09` });
      } else if (evt.phase === "stream-wait") {
        fire({ kind: "log", level: "info", text: `${label}\u6D41\u5DF2\u5EFA\u7ACB\uFF0C\u7B49\u5F85\u751F\u6210\u5185\u5BB9\uFF08${(evt.elapsedMs / 1e3).toFixed(1)}s\uFF09\u2026` });
      } else if (evt.phase === "waiting") {
        fire({ kind: "log", level: "info", text: `${label}\u4ECD\u5728\u7B49\u5F85\u7F51\u5173\u54CD\u5E94\uFF08${(evt.elapsedMs / 1e3).toFixed(1)}s\uFF09\u2026` });
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
        const max = kind === "idle" ? LLM_MAX_IDLE_ATTEMPTS : LLM_MAX_ATTEMPTS;
        const canRetry = kind !== "aborted" && kind !== "fatal" && kind !== "timeout" && kind !== "invalidated" && attempt < max;
        if (!canRetry) break;
        const delay = retryDelay(attempt);
        const took = ((Date.now() - t0) / 1e3).toFixed(1);
        fire({ kind: "log", level: "warn", text: `${label}\u7B2C ${attempt}/${max} \u6B21\u8BF7\u6C42\u5931\u8D25\uFF08${shortErrText(err)}\uFF0C\u7528\u65F6 ${took}s\uFF09\uFF0C${(delay / 1e3).toFixed(1)}s \u540E\u91CD\u8BD5` });
        await sleep(delay);
      }
    }
    if (attempts > 1 && lastErr?.message && !lastErr.aborted) {
      lastErr.message = `${lastErr.message}\uFF08\u5171\u5C1D\u8BD5 ${attempts} \u6B21\uFF0C\u603B\u7528\u65F6 ${((Date.now() - startedAt) / 1e3).toFixed(1)}s\uFF09`;
    }
    throw lastErr;
  }
  function toDataUrlPage(src) {
    return fetchBounded(src, { credentials: "include" }, IMAGE_TIMEOUT_MS, runAbort?.signal ?? null).then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.blob();
    }).then((blob) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("FileReader \u8BFB\u53D6\u5931\u8D25"));
      r.readAsDataURL(blob);
    }));
  }
  async function toDataUrl(src) {
    try {
      return await toDataUrlPage(src);
    } catch (_) {
    }
    if (!hasBgFetch) throw new Error("\u9875\u9762 fetch \u88AB\u62D2\u4E14\u65E0 background \u53EF\u8F6C\u53D6");
    const rsp = await new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage({ type: "BPS_FETCH_IMAGE", src }, (rsp2) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          settled = true;
          resolve(rsp2);
        });
      } catch (err) {
        return reject(err);
      }
      setTimeout(() => {
        if (!settled) reject(new Error("background \u8F6C\u53D6\u65E0\u54CD\u5E94"));
      }, 15e3);
    });
    if (!rsp?.ok) throw new Error("background \u8F6C\u53D6\u5931\u8D25\uFF1A" + (rsp?.reason || "no response"));
    return rsp.dataUrl;
  }
  function assembleImgMessage(userContent, imgs) {
    const stem = imgs.stem || [];
    const parts = [{
      type: "text",
      text: `${userContent}

\uFF08\u672C\u9898\u542B\u914D\u56FE\uFF1A\u9898\u5E72\u56FE\u5728\u524D\uFF0C\u9009\u9879\u56FE\u968F\u540E\u5E76\u6807\u6CE8\u5F52\u5C5E\u9009\u9879\u3002\u8BF7\u540C\u65F6\u4F9D\u636E\u56FE\u7247\u5185\u5BB9\u4F5C\u7B54\uFF0C\u4ECD\u53EA\u8F93\u51FA\u4E00\u4E2A JSON\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002\uFF09`
    }];
    stem.forEach((url, i) => {
      parts.push({ type: "text", text: `\uFF08\u9898\u5E72\u914D\u56FE ${i + 1}/${stem.length}\uFF09` });
      parts.push({ type: "image_url", image_url: { url } });
    });
    for (const [letter, url] of Object.entries(imgs.options || {})) {
      parts.push({ type: "text", text: `\uFF08\u9009\u9879 ${letter} \u7684\u914D\u56FE\uFF09` });
      parts.push({ type: "image_url", image_url: { url } });
    }
    return parts;
  }
  async function downloadImgs(imgInfo) {
    const out = { stem: [], options: {} };
    for (const src of imgInfo.stem) out.stem.push(await toDataUrl(src));
    for (const [letter, src] of Object.entries(imgInfo.options)) out.options[letter] = await toDataUrl(src);
    return out;
  }
  async function answerOne(q, cfg) {
    let images = null;
    if (cfg.images && q.hasImg) {
      try {
        images = await downloadImgs(q.imgInfo);
      } catch (err) {
        return { ok: false, reason: "\u542B\u56FE\u9898\u56FE\u7247\u52A0\u8F7D\u5931\u8D25\uFF1A" + (err?.message || err) };
      }
      if (!images.stem.length && !Object.keys(images.options).length) {
        return { ok: false, reason: "\u542B\u56FE\u9898\u672A\u53D6\u5230\u53EF\u7528\u56FE\u7247\u5730\u5740" };
      }
    }
    const basePrompt = buildPrompt(q);
    const messages = images ? [{ role: "system", content: basePrompt[0].content }, { role: "user", content: assembleImgMessage(basePrompt[1].content, images) }] : basePrompt;
    let raw = null;
    try {
      raw = globalThis.__BPS_LLM_MOCK__ ? await globalThis.__BPS_LLM_MOCK__(messages) : await chatWithRetry(cfg, messages, { label: q.label || q.id.slice(-4) });
    } catch (err) {
      if (runAbort?.signal.aborted || err?.aborted) return { ok: false, reason: "\u5DF2\u4E2D\u6B62" };
      return { ok: false, reason: "LLM \u8C03\u7528\u5931\u8D25\uFF1A" + (err?.message || err) };
    }
    const json = parseJsonLoose(raw);
    if (!json) return { ok: false, reason: "LLM \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\uFF1A" + String(raw).slice(0, 60) };
    try {
      if (q.kind === "MULTIPLE_CHOICE") {
        const letter = parseChoiceAnswer(json.answer, q.radios.length);
        if (!letter) return { ok: false, reason: "LLM \u5B57\u6BCD\u7B54\u6848\u65E0\u6548\uFF1A" + String(json.answer).slice(0, 20) };
        if (!fillRadio(q, letter)) return { ok: false, reason: "\u5199\u5165\u9009\u9879\u5931\u8D25" };
        return { ok: true, text: letter };
      } else if (q.kind === "TRUE_OR_FALSE") {
        const tf = normalizeTF(json.answer);
        if (!tf) return { ok: false, reason: "LLM \u5224\u65AD\u7B54\u6848\u65E0\u6548\uFF1A" + String(json.answer).slice(0, 20) };
        if (!fillRadio(q, tf === "TRUE" ? "A" : "B")) return { ok: false, reason: "\u5199\u5165\u9009\u9879\u5931\u8D25" };
        return { ok: true, text: tf };
      } else {
        const answers = parseFillAnswers(json, q.blanks);
        if (!answers) return { ok: false, reason: `LLM \u586B\u7A7A\u7B54\u6848\u6570\u91CF\u4E0D\u7B26\uFF08\u9700 ${q.blanks} \u7A7A\uFF09` };
        fillBlank(q, answers);
        const shown = answers.join("\u3001");
        return { ok: true, text: shown.length > 28 ? shown.slice(0, 28) + "\u2026" : shown };
      }
    } catch (err) {
      return { ok: false, reason: "\u5199\u5165\u5931\u8D25\uFF1A" + (err?.message || err) };
    }
  }
  var RELAY_KEY = "__BPS_AA_PROG_RELAY__";
  function readRelay() {
    try {
      return JSON.parse(sessionStorage.getItem(RELAY_KEY)) || null;
    } catch (_) {
      return null;
    }
  }
  function writeRelay(r) {
    try {
      sessionStorage.setItem(RELAY_KEY, JSON.stringify(r));
      return true;
    } catch (_) {
      return false;
    }
  }
  function clearRelay() {
    try {
      sessionStorage.removeItem(RELAY_KEY);
    } catch (_) {
    }
  }
  var PAGE_LOAD_WAIT_MS = 5e3;
  var RATE_LIMIT_WAITS_MS = [6e4, 12e4, 18e4];
  var NAVIGATE_CHECK_MS = 1e4;
  function isRateLimitedText(text) {
    const s = String(text || "").replace(/\s+/g, "");
    if (s.includes("\u60A8\u8BBF\u95EE\u5F97\u592A\u5FEB\u5566")) return true;
    const shell = s.includes("\u53CD\u9988\u95EE\u9898") || s.includes("\u6D4F\u89C8\u5668\u4FE1\u606F") || s.includes("\u9519\u8BEF\u4FE1\u606F") || s.includes("feedback@pat-edu.com");
    if (!shell) return false;
    return s.includes("\u8BBF\u95EE\u5F97\u592A\u5FEB") || s.includes("\u8BBF\u95EE\u8FC7\u4E8E\u9891\u7E41") || s.includes("\u64CD\u4F5C\u8FC7\u4E8E\u9891\u7E41");
  }
  function rateLimitedNow() {
    try {
      return isRateLimitedText((document.body?.innerText || "").slice(0, 2e4));
    } catch (_) {
      return false;
    }
  }
  function navigateRelay(target, r, what) {
    const from = location.pathname + location.search;
    const go = () => {
      try {
        location.href = target;
      } catch (_) {
      }
    };
    const check = (attempt) => setTimeout(() => {
      if (location.pathname + location.search !== from) return;
      if (attempt === 0) {
        fire({ kind: "log", level: "warn", text: `${what}\u672A\u751F\u6548\uFF08\u9875\u9762\u6CA1\u6709\u8DF3\u8F6C\uFF09\uFF0C\u91CD\u8BD5\u4E00\u6B21\u2026` });
        go();
        check(1);
        return;
      }
      abortRelay(r, `${what}\u88AB\u62E6\u4E0B\uFF1A\u9875\u9762\u59CB\u7EC8\u6CA1\u6709\u8DF3\u8F6C\uFF08\u6D4F\u89C8\u5668\u79BB\u5F00\u786E\u8BA4\u6216\u6269\u5C55\u62E6\u622A\uFF09\uFF0C\u8BF7\u5904\u7406\u540E\u91CD\u65B0\u5F00\u59CB\uFF0C\u5DF2\u5B8C\u6210\u7684\u9898\u76EE\u4E0D\u4F1A\u91CD\u505A`);
    }, NAVIGATE_CHECK_MS);
    go();
    check(0);
  }
  async function pacePageLoad(where) {
    fire({ kind: "log", level: "info", text: `${where}\uFF1A\u7B49\u5F85 ${PAGE_LOAD_WAIT_MS / 1e3}s \u518D\u5207\u6362\uFF08\u907F\u514D PTA \u8BBF\u95EE\u9891\u7387\u9650\u5236\uFF09\u2026` });
    await sleep(PAGE_LOAD_WAIT_MS);
  }
  function pauseForRateLimit(r, where) {
    const tries = Number(r.rlTries) || 0;
    if (tries >= RATE_LIMIT_WAITS_MS.length) {
      abortRelay(r, `\u8FDE\u7EED\u89E6\u53D1 PTA \u8BBF\u95EE\u9891\u7387\u9650\u5236\uFF08${where}\uFF09\uFF0C\u5DF2\u51B7\u5374 ${RATE_LIMIT_WAITS_MS.map((ms) => Math.round(ms / 1e3)).join(" / ")}s \u4ECD\u88AB\u62D2\u7EDD\uFF1B\u8BF7\u4F11\u606F\u51E0\u5206\u949F\u540E\u91CD\u65B0\u5F00\u59CB\uFF0C\u5DF2\u5B8C\u6210\u7684\u9898\u76EE\u4E0D\u4F1A\u91CD\u505A`);
      return true;
    }
    const wait = RATE_LIMIT_WAITS_MS[tries];
    r.rlTries = tries + 1;
    if (!writeRelay(r)) {
      abortRelay(r, "sessionStorage \u5199\u5165\u5931\u8D25\uFF0C\u65E0\u6CD5\u8BB0\u5F55\u9650\u6D41\u51B7\u5374");
      return true;
    }
    running = false;
    runAbort = null;
    fire({ kind: "log", level: "warn", text: `PTA \u9650\u6D41\uFF08${where}\uFF09\uFF1A\u7B49\u5F85 ${Math.round(wait / 1e3)}s \u540E\u91CD\u8F7D\u672C\u9898\uFF08\u7B2C ${tries + 1}/${RATE_LIMIT_WAITS_MS.length} \u6B21\uFF09\u2026` });
    const prob = r.problems?.[r.pi];
    const target = prob ? `/problem-sets/${r.psId}/exam/problems/type/${prob.typeId}?problemSetProblemId=${prob.id}` : location.href;
    setTimeout(() => navigateRelay(target, r, "\u9650\u6D41\u51B7\u5374\u540E\u91CD\u8F7D\u672C\u9898"), wait);
    return true;
  }
  function startProgrammingRelay(psId, progTypes, cfg) {
    const problems = [];
    for (const t of progTypes) {
      for (const id of programmingIds(psId, t.typeId)) problems.push({ id, typeId: t.typeId, typeName: t.typeName });
    }
    if (!problems.length) throw new Error("\u300C\u7F16\u7A0B\u9898\u300D\u627E\u4E0D\u5230\u9898\u76EE\u951A\u70B9\uFF08\u9898\u76EE\u603B\u89C8\u6536\u8D77\uFF1F\u70B9\u5F00\u540E\u91CD\u8BD5\uFF09");
    const relay = {
      v: 1,
      cfg: { ...cfg },
      psId,
      problems,
      pi: 0,
      phase: "collect",
      // collect → verify →（advance）→ collect → …
      summary: { applied: 0, skippedAnswered: 0, failed: [] }
    };
    if (!writeRelay(relay)) throw new Error("sessionStorage \u4E0D\u53EF\u5199\uFF0C\u65E0\u6CD5\u8DE8\u9875\u7EED\u8DD1\u7F16\u7A0B\u9898");
    const first = problems[0];
    fire({ kind: "log", level: "info", text: `\u7F16\u7A0B\u9898 ${problems.length} \u9898\uFF1A\u8F6C\u300C\u9010\u9898\u6574\u9875\u88C5\u8F7D\u300D\u6A21\u5F0F\uFF08\u65E5\u5FD7\u8DE8\u9875\u4FDD\u7559\uFF09` });
    suppressLeaveConfirm();
    navigateRelay(`/problem-sets/${psId}/exam/problems/type/${first.typeId}?problemSetProblemId=${first.id}`, relay, "\u8FDB\u5165\u7B2C\u4E00\u9898");
    return true;
  }
  async function resumeRelay(settings3) {
    const r = readRelay();
    if (!r || r.v !== 1) return;
    if (!(settings3 && settings3.autoAnswer)) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u53D6\u6D88\uFF1A\u603B\u5F00\u5173\u672A\u5F00\u542F" });
      return;
    }
    if (r.aborted) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u5DF2\u4E2D\u6B62\uFF08\u6309\u4F60\u7684\u8981\u6C42\u505C\u6B62\uFF09" });
      fire({ kind: "state", running: false, error: "\u5DF2\u4E2D\u6B62" });
      return;
    }
    const prob = r.problems[r.pi];
    if (!prob) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u53D6\u6D88\uFF1A\u7EED\u8DD1\u5355\u5DF2\u8D8A\u754C" });
      return;
    }
    if (rateLimitedNow()) {
      pauseForRateLimit(r, "\u9875\u9762\u52A0\u8F7D");
      return;
    }
    if (!new RegExp(`problemSetProblemId=${prob.id}$`).test(location.search)) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u53D6\u6D88\uFF1A\u9875\u9762\u4E0D\u5728 " + (prob.id || "").slice(-4) + " \u4E0A\uFF08\u5DF2\u843D\u4F4D\u9898\u76EE\u4FDD\u6301\u5404\u81EA\u72B6\u6001\uFF09" });
      return;
    }
    running = true;
    runAbort = new AbortController();
    suppressLeaveConfirm();
    fire({ kind: "state", running: true });
    const hadHistory = readPersistedLog().length > 0;
    fire({ kind: "log", level: "info", text: `\u7F16\u7A0B\u9898\u7EED\u8DD1\uFF08\u7B2C ${r.pi + 1}/${r.problems.length} \u9898\uFF0C${r.phase === "verify" ? "\u6C34\u5408\u6821\u9A8C/\u63D0\u4EA4" : "\u6536\u96C6\u4F5C\u7B54"}\u9636\u6BB5\uFF09` });
    if (r.summary.failed.length && !hadHistory) {
      fire({ kind: "log", level: "warn", text: `\u6B64\u524D\u5DF2\u5931\u8D25 ${r.summary.failed.length} \u9898\uFF1A
${failDetails(r.summary.failed)}` });
    }
    try {
      stripDraftHttpCache(prob.id);
      if (r.phase === "verify") {
        await relayVerify(r, prob);
      } else {
        await settleEditorState();
        await relayCollect(r, prob);
      }
    } catch (err) {
      abortRelay(r, err?.message || String(err));
    }
  }
  function failDetails(failed) {
    return (failed || []).map((f) => `${f.label || (f.id || "").slice(-4)}\uFF1A${f.reason}`).join("\n");
  }
  function relaySummaryLine(r) {
    const s = r.summary;
    const line = `\u4F5C\u7B54 ${s.applied} \xB7 \u8DF3\u8FC7\u5DF2\u7B54 ${s.skippedAnswered} \xB7 \u5931\u8D25 ${s.failed.length}${r.cfg.drySave ? "\uFF08dry\uFF0C\u672A\u63D0\u4EA4\uFF09" : ""}`;
    if (!s.failed.length) return line;
    return `${line}
\u5931\u8D25\u660E\u7EC6\uFF1A
${failDetails(s.failed)}`;
  }
  function relayRecordFail(r, prob, label, reason) {
    r.summary.failed.push({ id: prob.id, ...label ? { label } : {}, reason });
    fire({ kind: "log", level: "err", text: `${label || prob.id.slice(-4)}\uFF1A${reason}` });
  }
  function abortRelay(r, reason) {
    clearRelay();
    fire({ kind: "log", level: "err", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u4E2D\u6B62\uFF1A" + reason });
    fire({ kind: "log", level: "info", text: relaySummaryLine(r) });
    fire({ kind: "state", running: false, error: reason });
    running = false;
    runAbort = null;
    restoreLeaveConfirm();
  }
  function stopRelayByUser(r) {
    clearRelay();
    running = false;
    runAbort = null;
    restoreLeaveConfirm();
    fire({ kind: "log", level: "warn", text: "\u5DF2\u4E2D\u6B62\uFF1A\u7F16\u7A0B\u9898\u7EED\u8DD1\u6309\u4F60\u7684\u8981\u6C42\u505C\u6B62" });
    fire({ kind: "log", level: "info", text: relaySummaryLine(r) });
    fire({ kind: "state", running: false, error: "\u5DF2\u4E2D\u6B62" });
  }
  async function relayNext(r, record, text) {
    r.rlTries = 0;
    if (record === "ok") {
      r.summary.applied += 1;
      if (text) fire({ kind: "log", level: "ok", text });
    }
    if (record === "skip") {
      r.summary.skippedAnswered += 1;
      if (text) fire({ kind: "log", level: "info", text });
    }
    fire({ kind: "progress", done: r.pi + 1, total: r.problems.length });
    if (userStopped(r)) {
      stopRelayByUser(r);
      return;
    }
    const nextIdx = r.pi + 1;
    if (nextIdx >= r.problems.length) {
      const line = relaySummaryLine(r);
      try {
        sessionStorage.setItem("__BPS_AA_SUMMARY_DONE__", JSON.stringify({ ok: !r.summary.failed.length, line, failed: r.summary.failed }));
      } catch (_) {
      }
      clearRelay();
      running = false;
      runAbort = null;
      restoreLeaveConfirm();
      const lvl = r.summary.failed.length ? "warn" : "ok";
      fire({ kind: "log", level: lvl, text: "\u7F16\u7A0B\u9898\u8DE8\u9875\u7EED\u8DD1\u7ED3\u675F\uFF1A" + line });
      fire({ kind: "state", running: false });
      return;
    }
    r.pi = nextIdx;
    r.phase = "collect";
    r.hint = null;
    const next = r.problems[r.pi];
    await prepNextProblemCache(next.id);
    if (!writeRelay(r)) {
      abortRelay(r, "sessionStorage \u5199\u5165\u5931\u8D25");
      return;
    }
    running = false;
    await pacePageLoad("\u5207\u6362\u4E0B\u4E00\u9898");
    navigateRelay(`/problem-sets/${r.psId}/exam/problems/type/${next.typeId}?problemSetProblemId=${next.id}`, r, "\u5207\u6362\u4E0B\u4E00\u9898");
  }
  async function relayCollect(r, prob) {
    const q = collectProgramming();
    if (!q) {
      if (rateLimitedNow()) {
        pauseForRateLimit(r, "\u6536\u96C6\u9898\u76EE");
        return;
      }
      relayRecordFail(r, prob, null, "\u7F16\u7A0B\u9898\u9875\u9762\u6536\u4E0D\u5230\u9898\u76EE");
      return relayNext(r, "fail");
    }
    r.rlTries = 0;
    const label = q.label || prob.id.slice(-4);
    if (q.answered && !r.cfg.overwrite) return relayNext(r, "skip", `${label}\uFF1A\u8DF3\u8FC7\uFF0C\u5DF2\u4F5C\u7B54`);
    if (q.hasImg) fire({ kind: "log", level: "warn", text: `${label}\uFF1A\u9898\u5E72\u542B\u56FE\u7247\uFF0C\u7F16\u7A0B\u9898\u6682\u4E0D\u652F\u6301\u56FE\u7247\u8F93\u5165\uFF0C\u4EC5\u6309\u6587\u5B57\u9898\u9762\u4F5C\u7B54` });
    const detail = await getDraftDetail(prob.id);
    const compilerId = r.cfg.language ? r.cfg.language : compilerIdFromLabel(q.langLabel) || (detail?.programmingSubmissionDetail?.compiler || null);
    if (!compilerId) {
      relayRecordFail(r, prob, label, `\u8BFB\u4E0D\u5230\u5F53\u524D\u8BED\u8A00\u300C${q.langLabel || "\uFF08\u7A7A\uFF09"}\u300D\uFF0C\u65E0\u6CD5\u786E\u5B9A\u7F16\u8BD1\u5668`);
      return relayNext(r, "fail");
    }
    const wantLangLabel = COMPILER_LABELS[compilerId] || q.langLabel || "";
    const messages = buildPrompt({ ...q, langLabel: wantLangLabel });
    let raw = null;
    fire({ kind: "log", level: "info", text: `${label}\uFF1A\u8BF7\u6C42\u6A21\u578B\u4E2D\u2026\uFF08${r.cfg.model || "\u672A\u77E5\u6A21\u578B"}\uFF09` });
    try {
      raw = globalThis.__BPS_LLM_MOCK__ ? await globalThis.__BPS_LLM_MOCK__(messages) : await chatWithRetry(r.cfg, messages, { label });
    } catch (err) {
      if (userStopped(r)) {
        stopRelayByUser(r);
        return;
      }
      relayRecordFail(r, prob, label, "LLM \u8C03\u7528\u5931\u8D25\uFF1A" + (err?.message || err));
      return relayNext(r, "fail");
    }
    const code = parseCodeAnswer(raw);
    if (!code) {
      relayRecordFail(r, prob, label, "LLM \u8F93\u51FA\u89E3\u6790\u4E0D\u51FA\u4EE3\u7801\uFF1A" + String(raw).slice(0, 60));
      return relayNext(r, "fail");
    }
    if (code.length > 16384) {
      relayRecordFail(r, prob, label, `\u4EE3\u7801\u8D85\u957F\uFF08${code.length} \u5B57\u7B26\uFF0C\u5E73\u53F0\u9650 16KB\uFF09`);
      return relayNext(r, "fail");
    }
    const written = await saveDraft(prob.id, detail, compilerId, code);
    if (!written.ok) {
      if (rateLimitedNow()) {
        pauseForRateLimit(r, "\u5199\u8349\u7A3F");
        return;
      }
      relayRecordFail(r, prob, label, `\u8349\u7A3F\u5199\u5165\u5931\u8D25\uFF08HTTP ${written.status ?? "\u672A\u77E5"}${written.err ? "\uFF1A" + written.err : ""}\uFF09`);
      return relayNext(r, "fail");
    }
    stripDraftHttpCache(prob.id);
    const seeded = seedCodingProblemCache(prob.id, code, detail);
    if (!seeded.seeded) {
      relayRecordFail(r, prob, label, "\u6C34\u5408\u952E\u5199\u5165\u5931\u8D25" + (seeded.err ? "\uFF1A" + seeded.err : ""));
      return relayNext(r, "fail");
    }
    r.phase = "verify";
    r.hint = { label, compilerId, wantLangLabel, head: (code.split("\n")[0] || "").trim().slice(0, 24), detail };
    if (!writeRelay(r)) {
      abortRelay(r, "sessionStorage \u5199\u5165\u5931\u8D25");
      return;
    }
    running = false;
    await pacePageLoad("\u63D0\u4EA4\u8349\u7A3F\u540E\u6821\u9A8C");
    try {
      location.reload();
    } catch (_) {
    }
  }
  async function relayVerify(r, prob) {
    const hint = r.hint;
    if (!hint || !hint.head) {
      abortRelay(r, "verify \u9636\u6BB5\u7F3A\u5C11 hint\uFF08replay \u72B6\u6001\u9519\u4E71\uFF09");
      return;
    }
    if (rateLimitedNow()) {
      pauseForRateLimit(r, "\u6C34\u5408\u6821\u9A8C");
      return;
    }
    const label = hint.label || prob.id.slice(-4);
    const wantLangLabel = hint.wantLangLabel || "";
    const compilerId = hint.compilerId;
    const head = String(hint.head || "").trim();
    const detail = hint.detail || null;
    const hyd = await waitHydrate(true);
    const cmText = editableCm()?.textContent || "";
    if (!hyd.ok || head && !cmText.includes(head)) {
      if (rateLimitedNow()) {
        pauseForRateLimit(r, "\u6C34\u5408\u6821\u9A8C");
        return;
      }
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      relayRecordFail(r, prob, label, "\u6C34\u5408\u6821\u9A8C\u5931\u8D25\uFF08\u7F16\u8F91\u5668\u672A\u56DE\u5E26\u4EE3\u7801\uFF09" + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u9700\u4EBA\u5DE5\u6838\u5BF9"));
      if (!rollback.ok) return abortRelay(r, "\u8349\u7A3F\u64A4\u9500\u5931\u8D25\uFF08\u6B8B\u7559\u4EE3\u7801\uFF09\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u540E\u518D\u8BD5");
      return relayNext(r, "fail");
    }
    r.rlTries = 0;
    const mountedLabel = langLabelOf();
    if (mountedLabel !== wantLangLabel) {
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      relayRecordFail(r, prob, label, `\u8BED\u8A00\u4E0D\u4E00\u81F4\uFF08\u8349\u7A3F ${wantLangLabel}\uFF0C\u5B9E\u6302\u300C${mountedLabel || "\u672A\u77E5"}\u300D\uFF09\uFF0C\u5DF2\u5F03\u7B54\u9632\u9519\u914D` + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u9700\u4EBA\u5DE5\u6838\u5BF9"));
      if (!rollback.ok) return abortRelay(r, "\u8349\u7A3F\u64A4\u9500\u5931\u8D25\uFF08\u6B8B\u7559\u4EE3\u7801\uFF09\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u540E\u518D\u8BD5");
      return relayNext(r, "fail");
    }
    if (r.cfg.drySave) {
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      if (!rollback.ok) return abortRelay(r, "dry\uFF1A\u6C34\u5408\u6821\u9A8C\u901A\u8FC7\u540E\u64A4\u9500\u8349\u7A3F\u5931\u8D25\uFF0C\u6B8B\u7559\u9700\u4EBA\u5DE5\u6838\u5BF9");
      return relayNext(r, "ok", `${label} \u2192 ${head}\u2026\uFF08dry\uFF1A\u8349\u7A3F\u6C34\u5408\u6821\u9A8C\u901A\u8FC7\u540E\u5DF2\u64A4\u9500\uFF0C\u672A\u63D0\u4EA4\uFF09`);
    }
    if (userStopped(r)) {
      stopRelayByUser(r);
      return;
    }
    const saved = await submitProgramming();
    if (!saved.saved || rateLimitedNow()) {
      if (rateLimitedNow()) {
        pauseForRateLimit(r, "\u63D0\u4EA4\u8BC4\u6D4B");
        return;
      }
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      relayRecordFail(r, prob, label, "\u63D0\u4EA4\u5931\u8D25\uFF1A" + saved.reason + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u542B\u672C\u6B21\u4EE3\u7801\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9"));
      if (!rollback.ok) return abortRelay(r, "\u8349\u7A3F\u64A4\u9500\u5931\u8D25\uFF08\u6B8B\u7559\u4EE3\u7801\uFF09\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u540E\u518D\u8BD5");
      return relayNext(r, "fail");
    }
    return relayNext(r, "ok", `${label} \u2192 ${head}\u2026\uFF08\u5DF2\u63D0\u4EA4\u8BC4\u6D4B\uFF09`);
  }
  function pageScript(code) {
    const s = document.createElement("script");
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
          set: function () { /* \u8FD0\u884C\u671F\u95F4\u4E0D\u89E6\u53D1\u539F\u751F\u79BB\u5F00\u786E\u8BA4 */ },
        });
        window.__BPS_UNLOAD_DESC__ = d;
      } catch (_) { /* \u539F\u578B\u88AB\u51BB\u7ED3\u65F6\u9000\u56DE confirm \u515C\u5E95 */ }
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
  var running = false;
  var runAbort = null;
  function isRunning() {
    return running;
  }
  function abortRun() {
    const r = readRelay();
    if (running && runAbort) {
      if (!runAbort.signal.aborted) runAbort.abort();
      if (r && !r.aborted) {
        r.aborted = true;
        writeRelay(r);
      }
      return true;
    }
    if (r && !r.aborted) {
      r.aborted = true;
      writeRelay(r);
      return true;
    }
    return false;
  }
  function userStopped(r) {
    return !!(runAbort?.signal?.aborted || r?.aborted);
  }
  var LOG_KEY = "__BPS_AA_LOG__";
  var LOG_CAP = 200;
  function logTime() {
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function readPersistedLog() {
    try {
      const arr = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
      if (!Array.isArray(arr)) return [];
      return arr.filter((x) => x && typeof x.text === "string").map((x) => ({ level: x.level || "info", text: x.text, t: x.t || "" }));
    } catch (_) {
      return [];
    }
  }
  function persistLogLine(level, text, t) {
    try {
      const arr = readPersistedLog();
      arr.push({ level: level || "info", text: String(text ?? ""), t: t || logTime() });
      if (arr.length > LOG_CAP) arr.splice(0, arr.length - LOG_CAP);
      sessionStorage.setItem(LOG_KEY, JSON.stringify(arr));
    } catch (_) {
    }
  }
  function clearPersistedLog() {
    try {
      sessionStorage.removeItem(LOG_KEY);
    } catch (_) {
    }
  }
  var eventSink = null;
  function setEventSink(fn) {
    eventSink = typeof fn === "function" ? fn : null;
  }
  var debugTrace = [];
  function fire(event) {
    if (event.kind === "log") persistLogLine(event.level, event.text);
    debugTrace.push({ ...event, t: Date.now() });
    if (debugTrace.length > 40) debugTrace.splice(0, debugTrace.length - 40);
    try {
      sessionStorage.setItem("__BPS_AA_TRACE__", JSON.stringify(debugTrace));
    } catch (_) {
    }
    try {
      sessionStorage.setItem("__BPS_AA_LAST_EVENT__", JSON.stringify({ ...event, at: Date.now() }));
    } catch (_) {
    }
    try {
      eventSink?.(event);
    } catch (_) {
    }
  }
  var progressOf = (stats) => ({
    applied: stats.ok.length,
    skippedAnswered: stats.skippedAnswered,
    skippedImage: stats.skippedImage,
    failed: stats.failed.map((f) => f.reason)
  });
  async function handleRun(config = {}) {
    if (running) {
      fire({ kind: "log", level: "warn", text: "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D" });
      return { ok: false, error: "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D" };
    }
    const preRelay = readRelay();
    if (preRelay && !preRelay.aborted) {
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u8DE8\u9875\u7EED\u8DD1\u6B63\u5728\u8FDB\u884C\uFF08\u770B\u5404\u9875\u60AC\u6D6E\u7403\u72B6\u6001\uFF09\uFF1B\u672C\u9875\u82E5\u5DF2\u4E0D\u5728\u9898\u76EE\u4E0A\u5219\u7EED\u8DD1\u4F1A\u81EA\u884C\u53D6\u6D88" });
      return { ok: false, error: "\u7F16\u7A0B\u9898\u8DE8\u9875\u7EED\u8DD1\u6B63\u5728\u8FDB\u884C" };
    }
    if (preRelay) clearRelay();
    const m = location.pathname.match(EXAM_PROBLEMS_RE);
    if (!m || !m[3]) {
      fire({ kind: "log", level: "err", text: "\u8BF7\u5148\u8FDB\u5165\u9898\u578B\u9875\uFF08\u5224\u65AD/\u5355\u9009/\u586B\u7A7A\u6807\u7B7E\uFF09\u518D\u5F00\u59CB" });
      return { ok: false, error: "\u8BF7\u5148\u8FDB\u5165\u9898\u76EE\u5217\u8868\u7684\u67D0\u4E2A\u9898\u578B\u9875\uFF08\u5224\u65AD/\u5355\u9009/\u586B\u7A7A\u6807\u7B7E\uFF09\u518D\u5F00\u59CB" };
    }
    const psId = m[1];
    const cfg = {
      baseUrl: config.baseUrl || "",
      apiKey: config.apiKey || "",
      model: config.model || "",
      gateway: config.gateway || "",
      overwrite: !!config.overwrite,
      images: !!config.images,
      // 作答含图题（需视觉模型；只作用于客观题，编程题恒按文字题面作答）
      language: config.language || "",
      // 编程题固定语言（白名单 id）；空 = 跟随各题编辑器当前语言
      drySave: !!config.drySave
    };
    if (globalThis.__BPS_LLM_MOCK__ && !cfg.drySave) {
      cfg.drySave = true;
      fire({ kind: "log", level: "warn", text: "\u68C0\u6D4B\u5230 __BPS_LLM_MOCK__\uFF1A\u672C\u6B21\u8FD0\u884C\u81EA\u52A8\u6539\u4E3A dry run\uFF08\u4E0D\u70B9\u4FDD\u5B58\uFF09" });
    }
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      fire({ kind: "log", level: "err", text: "\u8BF7\u5148\u9009\u62E9\u6A21\u578B\u5E76\u586B\u5199 API Key" });
      return { ok: false, error: "\u8BF7\u5148\u586B\u5199 API Key" };
    }
    try {
      assertChatModel(cfg);
    } catch (err) {
      fire({ kind: "log", level: "err", text: err.message });
      return { ok: false, error: err.message };
    }
    running = true;
    runAbort = new AbortController();
    suppressLeaveConfirm();
    const summary = { types: [], applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [], savedTypes: 0, saveFails: [] };
    const progTypes = [];
    let ret = null;
    let relayStarted = false;
    try {
      clearPersistedLog();
      fire({ kind: "log-clear" });
      fire({ kind: "state", running: true });
      fire({ kind: "log", level: "info", text: `\u5F00\u59CB\u7B54\u9898\uFF08\u6BCF\u9898\u4E00\u6B21\u8BF7\u6C42\uFF0C${cfg.overwrite ? "\u8986\u76D6\u5DF2\u4F5C\u7B54" : "\u8DF3\u8FC7\u5DF2\u7B54"}${cfg.images ? "\uFF0C\u542B\u56FE\u9898\u4F5C\u7B54" : ""}\uFF09` });
      const types = sidebarTypes().filter((t) => TYPE_BY_NAME[t.typeName] || false).filter((t) => t.total > 0);
      const unknown = sidebarTypes().filter((t) => !(t.typeName in TYPE_BY_NAME) && t.total > 0);
      if (!types.length) throw new Error("\u672C\u9875\u4FA7\u680F\u6CA1\u6709\u53EF\u4F5C\u7B54\u7684\u9898\u578B");
      if (unknown.length) {
        summary.failed.push({ id: "-", reason: `\u6682\u4E0D\u652F\u6301\u9898\u578B\uFF1A${unknown.map((u) => u.typeName).join("\u3001")}\uFF08\u8DF3\u8FC7\uFF09` });
        fire({ kind: "log", level: "warn", text: `\u6682\u4E0D\u652F\u6301\u9898\u578B\uFF1A${unknown.map((u) => u.typeName).join("\u3001")}\uFF0C\u5DF2\u8DF3\u8FC7` });
      }
      const totalOverall = types.reduce((n, t) => n + t.total, 0);
      let processedOverall = 0;
      for (const t of types) {
        if (!EXAM_PROBLEMS_RE.test(location.pathname) || !location.pathname.includes(psId)) {
          throw new Error("\u5DF2\u79BB\u5F00\u539F\u9898\u76EE\u9875\uFF0C\u4E2D\u6B62");
        }
        if (runAbort.signal.aborted) throw new Error("\u5DF2\u4E2D\u6B62");
        const type = TYPE_BY_NAME[t.typeName];
        const isProg = type === "PROGRAMMING";
        if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
          const link = [...document.querySelectorAll("a[href]")].find((a) => (a.getAttribute("href") || "").match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
          if (!link) throw new Error(`\u627E\u4E0D\u5230\u300C${t.typeName}\u300D\u7684\u9875\u9762\u94FE\u63A5`);
          link.click();
          let ready = false;
          for (let i = 0; i < 60 && !ready; i++) {
            if (runAbort.signal.aborted) throw new Error("\u5DF2\u4E2D\u6B62");
            await sleep(100);
            ready = location.pathname.endsWith(`/type/${t.typeId}`) && (isProg ? programmingIds(psId, t.typeId).length > 0 || !!editableCm() : collectPage().filter((q) => q.kind === type).length >= t.total);
          }
          if (!ready) throw new Error(`\u300C${t.typeName}\u300D\u9875\u9762\u672A\u5C31\u7EEA\uFF08\u4FA7\u680F\u7EDF\u8BA1 ${t.total} \u9898\uFF09`);
        }
        await sleep(300);
        if (isProg) {
          progTypes.push(t);
          continue;
        }
        const questions = collectPage().filter((q) => q.kind === type);
        if (!questions.length) throw new Error(`\u300C${t.typeName}\u300D\u9875\u9762\u6536\u96C6\u4E0D\u5230\u9898\u76EE`);
        fire({ kind: "log", level: "info", text: `\u300C${t.typeName}\u300D\u5171 ${questions.length} \u9898\uFF0C\u5F00\u59CB\u4F5C\u7B54` });
        const stats = { ok: [], skippedAnswered: 0, skippedImage: 0, failed: [] };
        let done = 0;
        const queue2 = questions.map((q) => ({ q }));
        let cursor = 0;
        const tick = () => {
          processedOverall += 1;
          fire({ kind: "progress", done: processedOverall, total: totalOverall, typeName: t.typeName });
        };
        const worker = async () => {
          while (cursor < queue2.length && !runAbort.signal.aborted) {
            const { q } = queue2[cursor++];
            done += 1;
            if (q.answered && !cfg.overwrite) {
              stats.skippedAnswered += 1;
              fire({ kind: "log", level: "info", text: `${q.label || q.id.slice(-4)}\uFF1A\u8DF3\u8FC7\uFF0C\u5DF2\u4F5C\u7B54` });
              tick();
              continue;
            }
            if (q.hasImg && !cfg.images) {
              stats.skippedImage += 1;
              fire({ kind: "log", level: "warn", text: `${q.label || q.id.slice(-4)}\uFF1A\u8DF3\u8FC7\uFF0C\u542B\u56FE\u7247\uFF08\u672A\u5F00\u300C\u4F5C\u7B54\u542B\u56FE\u9898\u300D\uFF09` });
              tick();
              continue;
            }
            fire({ kind: "log", level: "info", text: `${q.label || q.id.slice(-4)}\uFF1A\u8BF7\u6C42\u6A21\u578B\u4E2D\u2026\uFF08${cfg.model || "\u672A\u77E5\u6A21\u578B"}\uFF09` });
            const r = await answerOne(q, cfg);
            if (r.ok) {
              stats.ok.push(q.id);
              fire({ kind: "log", level: "ok", text: `${q.label || q.id.slice(-4)} \u2192 ${r.text}` });
            } else {
              stats.failed.push({ id: q.id, reason: r.reason });
              fire({ kind: "log", level: "err", text: `${q.label || q.id.slice(-4)}\uFF1A${r.reason}` });
            }
            tick();
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, queue2.length) }, worker));
        const filled = stats.ok.length > 0;
        let saved = null;
        if (filled && !cfg.drySave) {
          saved = await saveTypePage();
          if (saved.saved) summary.savedTypes += 1;
          else summary.saveFails.push(`${t.typeName}\uFF1A${saved.reason}`);
          fire({ kind: "log", level: saved.saved ? "ok" : "err", text: saved.saved ? `\u300C${t.typeName}\u300D\u5DF2\u4FDD\u5B58` : `\u300C${t.typeName}\u300D\u4FDD\u5B58\u5931\u8D25\uFF1A${saved.reason}` });
        } else if (!filled) {
          saved = { saved: false, reason: "\u672C\u9875\u65E0\u9700\u65B0\u7B54\u6848\uFF0C\u672A\u4FDD\u5B58" };
        }
        const pg = progressOf(stats);
        summary.applied += pg.applied;
        summary.skippedAnswered += pg.skippedAnswered;
        summary.skippedImage += pg.skippedImage;
        summary.failed.push(...stats.failed);
        summary.types.push({ type: t.typeName, total: questions.length, applied: pg.applied, skippedAnswered: pg.skippedAnswered, skippedImage: pg.skippedImage, failed: stats.failed.length, saved: saved?.saved === true });
      }
      if (runAbort.signal.aborted) throw new Error("\u5DF2\u4E2D\u6B62");
      ret = { ok: true, summary };
      if (progTypes.length) {
        if (startProgrammingRelay(psId, progTypes, cfg)) {
          relayStarted = true;
          summary.types.push({ type: "\u7F16\u7A0B\u9898", total: progTypes.reduce((n, x) => n + x.total, 0), applied: 0, skippedAnswered: 0, skippedImage: 0, failed: 0, saved: false });
          ret = { ok: true, relay: true, summary };
        }
      }
    } catch (err) {
      ret = { ok: false, error: err?.message || String(err), summary };
    } finally {
      running = false;
      runAbort = null;
      if (!relayStarted) restoreLeaveConfirm();
      if (ret.ok) {
        const failN = ret.summary.failed.length;
        fire({ kind: "log", level: failN ? "warn" : "ok", text: `${ret.relay ? "\u5BA2\u89C2\u9898\u5B8C\u6210\uFF08\u7F16\u7A0B\u9898\u5DF2\u8F6C\u9010\u9875\u7EED\u8DD1\uFF0C\u65E5\u5FD7\u968F\u5404\u9875\u51FA\u73B0\uFF09" : `\u5B8C\u6210\uFF1A\u4F5C\u7B54 ${ret.summary.applied} \xB7 \u8DF3\u8FC7\u5DF2\u7B54 ${ret.summary.skippedAnswered} \xB7 \u8DF3\u8FC7\u542B\u56FE ${ret.summary.skippedImage} \xB7 \u5931\u8D25 ${failN}${cfg.drySave ? "\uFF08\u672A\u4FDD\u5B58\uFF09" : ""}`}` });
        fire({ kind: "state", running: false });
      } else {
        fire({ kind: "log", level: "err", text: ret.error === "\u5DF2\u4E2D\u6B62" ? "\u5DF2\u4E2D\u6B62" : "\u5DF2\u4E2D\u6B62\uFF1A" + ret.error });
        fire({ kind: "state", running: false, error: ret.error });
      }
    }
    return ret;
  }

  // src/content/autoanswer-panel.js
  var PRESETS = {
    deepseek: {
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      // 视觉模型；deepseek-chat 已下架（2026-10-13）
      gateway: "deepseek",
      hint: "\u5B98\u65B9 API \xB7 api.deepseek.com \xB7 \u6A21\u578B deepseek-flash\uFF08\u89C6\u89C9\uFF09"
    },
    opencode: {
      label: "OpenCode Go",
      baseUrl: "https://opencode.ai/inference/go/openai/v1",
      model: "glm-5.3-flash",
      gateway: "opencode",
      editableModel: true,
      // 网关模型可自填（面板多一行「模型」输入），留空用默认
      hint: "OpenCode Go \xB7 \u4EC5 chat \u7CFB\u6A21\u578B\uFF08glm / kimi / deepseek / longcat / mimo\uFF09"
    },
    custom: {
      label: "\u81EA\u5B9A\u4E49",
      baseUrl: "",
      model: "",
      gateway: "custom",
      // chatOnce 只对 'opencode' 附加网关头，自定义端点保持干净
      customEndpoint: true,
      // 多一行「端点」输入：任意 OpenAI 兼容根地址
      editableModel: true,
      hint: "\u4EFB\u610F OpenAI \u517C\u5BB9\u670D\u52A1 \xB7 \u7AEF\u70B9\u4E0E\u6A21\u578B id \u5747\u81EA\u586B"
    }
  };
  function resolveModel(preset, raw) {
    const v = String(raw || "").trim();
    return preset.editableModel && v ? v : preset.model;
  }
  function currentKey(s, gateway) {
    const gw = PRESETS[gateway] ? gateway : "deepseek";
    const map = (s || {}).autoAnswerApiKeys;
    return map && typeof map === "object" && !Array.isArray(map) ? String(map[gw] ?? "").trim() : "";
  }
  function withKeyFor(s, gateway, value) {
    const gw = PRESETS[gateway] ? gateway : "deepseek";
    const prior = (s || {}).autoAnswerApiKeys;
    const map = prior && typeof prior === "object" && !Array.isArray(prior) ? { ...prior } : {};
    map[gw] = String(value ?? "").trim();
    return { ...s, autoAnswerApiKeys: map };
  }
  var MAX_LOG_LINES = 200;
  var CSS = `
:host { all: initial; }
:host * { box-sizing: border-box; } /* all:initial \u91CD\u7F6E\u6210 content-box\uFF0Cwidth:100% + padding \u4F1A\u6A2A\u5411\u6EA2\u51FA */
.wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  font: 13px/1.5 Harmony, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "Noto Sans", sans-serif; /* PTA \u7684\u5B57\u4F53\u6808 */
  color: var(--text); }
/* \u62D6\u62FD\u4F4D\u7F6E\u8BB0\u5FC6\u89C1 js \u7684 applyPos\uFF1Aright/bottom \u88AB storage.local \u7684 {r,b} inline \u8986\u76D6\uFF0C
 * \u7403\u4E0D\u653E left/top \u2014\u2014 \u7A97\u53E3\u53D8\u5927\u65F6\u7403\u4ECD\u8D34\u53F3\u4E0B\u89D2\u9644\u8FD1\uFF0C\u4E0D\u4F1A\u98D8\u53BB\u89C6\u91CE\u5916 */

/* ---------- \u60AC\u6D6E\u7403 ---------- */
/* PTA \u6CA1\u6709\u60AC\u6D6E\u7403\u8FD9\u4E00\u5F62\u5236\uFF1A\u53D6\u5B83\u7684\u5B9E\u5FC3\u4E3B\u8272\u6309\u94AE + \u6D6E\u5C42\u6295\u5F71\uFF0C\u53BB\u6389\u539F\u6765\u7684\u6E10\u53D8\u4E0E\u84DD\u8272\u5149\u6655 */
.ball { position: relative; width: 46px; height: 46px; border-radius: 50%; border: none; padding: 0;
  cursor: grab; touch-action: none; /* \u89E6\u5C4F\u62D6\u7403\u4E0D\u6EDA\u9875\u9762 */
  display: grid; place-items: center; color: #fff;
  background: var(--accent);
  box-shadow: var(--shadow-md);
  transition: filter var(--trs); }
.ball:hover { filter: brightness(.85); }     /* PTA \u6309\u94AE\u7684\u60AC\u505C\u53E3\u5F84 */
.ball:active { transform: translateY(1px); } /* PTA \u6309\u94AE\u7684\u6309\u4E0B\u53E3\u5F84 */
.ball:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.ball .glyph { position: relative; z-index: 1; font-size: 18px; font-weight: 700; }
.ring { position: absolute; inset: -1px; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 3; }
.ring .bg { stroke: rgba(255, 255, 255, .28); }
.ring .fg { stroke: var(--ok); stroke-linecap: round; stroke-dasharray: 138.2; stroke-dashoffset: 138.2; transition: stroke-dashoffset .25s ease; }
.wrap.dragging .ball { cursor: grabbing; transition: none; }

/* ---------- \u9762\u677F ---------- */
.panel { position: absolute; right: 0; bottom: 56px; width: 324px; max-width: calc(100vw - 24px);
  max-height: calc(100vh - 90px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border: 1px solid var(--hairline); border-radius: 8px; overflow: hidden;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, .1), 0 8px 10px -6px rgba(0, 0, 0, .1); /* PTA \u6D6E\u5C42\uFF08toast / \u4E0B\u62C9\u83DC\u5355\uFF09\u7684\u6295\u5F71 */
  transform-origin: 100% 100%; animation: aa-pop .18s ease; }
/* \u7403\u88AB\u62D6\u8D70\u540E\u6309\u5C4F\u5E55\u8C61\u9650\u6362\u8FB9\u5C55\u5F00\uFF08openPanel \u6302 pos-left / pos-top\uFF09\uFF1A\u53F3\u534A \u2192 \u9ED8\u8BA4\u671D\u5DE6\u5F00\uFF0C
 * \u5DE6\u534A \u2192 \u671D\u53F3\u5F00\uFF1B\u4E0B\u534A \u2192 \u9ED8\u8BA4\u5F80\u4E0A\u5F39\uFF0C\u4E0A\u534A \u2192 \u5F80\u4E0B\u5F39 */
.wrap.pos-left .panel { right: auto; left: 0; transform-origin: 0 100%; }
.wrap.pos-top .panel { bottom: auto; top: 56px; transform-origin: 100% 0; }
.wrap.pos-left.pos-top .panel { transform-origin: 0 0; }
/* display:flex \u4F1A\u76D6\u8FC7 UA \u7684 [hidden]\uFF0C\u5FC5\u987B\u663E\u5F0F\u6536\u56DE\uFF08\u5426\u5219\u6536\u8D77\u9762\u677F\u65E0\u6548\u3001\u9762\u677F\u5E38\u663E\uFF09 */
.panel[hidden] { display: none; }
@keyframes aa-pop { from { transform: scale(.94) translateY(5px); opacity: 0; } }

/* ---------- \u5206\u533A\u6807\u7B7E\uFF08\u7B54\u9898\u914D\u7F6E / \u6A21\u578B\u914D\u7F6E\uFF09---------- 
   \u5F62\u5236\u53D6 PTA \u7684\u9875\u7B7E\uFF08\u6D3B\u8DC3\u9898\u76EE\u96C6 / \u6240\u6709\u9898\u76EE\u96C6\uFF09\uFF1A2px \u4E0B\u8FB9\u6846 + \u4E3B\u8272\uFF0C\u975E\u9009\u4E2D\u9879\u60AC\u505C\u4E5F\u8F6C\u4E3B\u8272 */
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
/* \u72B6\u6001\u80F6\u56CA\uFF1APTA \u7684\u80F6\u56CA\u914D\u65B9\uFF0812px \u5706\u89D2 / 13px \u5B57 / \u8272\u503C 10% \u5E95 / \u540C\u8272\u6587\u5B57\uFF09 */
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

/* ---------- \u5206\u9875\u5BB9\u5668\uFF08\u4E24\u4E2A\u5206\u533A\u5171\u7528\u5206\u9875\u6EDA\u52A8\uFF09 ---------- */
.pages { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pages > .page[hidden] { display: none; }
.page { flex: 1; min-height: 0; padding: 12px 14px; overflow: auto;
  display: flex; flex-direction: column; gap: 12px; }
/* \u5206\u533A\u662F\u53EF\u6EDA\u52A8\u7684 flex \u5217\uFF1A\u5B50\u9879\u4E00\u5F8B\u4E0D\u53C2\u4E0E\u6536\u7F29\uFF0C\u5426\u5219\u5B9A\u9AD8\u7684\u6309\u94AE/\u8F93\u5165\u6846/\u65E5\u5FD7\u4F1A\u88AB\u538B\u6241
   \uFF08\u5B9E\u6D4B\u4E0D\u5199\u8FD9\u6761\u65F6 32px \u7684\u4E3B\u6309\u94AE\u88AB\u6324\u6210 24.5px\uFF09\uFF0C\u8D85\u51FA\u90E8\u5206\u4EA4\u7ED9 overflow \u6EDA\u52A8 */
.page > * { flex: none; }

.field .flabel { display: block; margin-bottom: 4px; font-size: 13px; line-height: 16px; color: var(--text-2); }
/* \u5C3A\u5BF8\u53D6 PTA \u7684\u8868\u5355\u63A7\u4EF6\uFF1A32px \u9AD8 / 4px \u5706\u89D2 / #ced4da \u8FB9\u6846 / \u805A\u7126\u300C\u4E3B\u8272\u8FB9\u6846 + 2px \u73AF\u300D */
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
.keyrow input { padding-right: 56px; /* \u53F3\u4FA7\u7559\u7ED9\u663E\u793A/\u9690\u85CF\u6309\u94AE */
  /* \u7528 text-security \u906E\u7F69\u800C\u4E0D\u662F type=password\uFF1AChrome \u5BC6\u7801\u7BA1\u7406\u5668\u53EA\u76EF\u771F\u5BC6\u7801\u6846\uFF0C
   * \u771F\u5BC6\u7801\u6846\u7684\u503C\u4E00\u53D8\u5C31\u5F39\u300C\u8981\u66F4\u65B0\u5BC6\u7801\u5417\uFF1F\u300D\uFF08\u628A API Key \u5F53\u6210 PTA \u8D26\u53F7\u7684\u65B0\u5BC6\u7801\uFF09 */
  -webkit-text-security: disc; }
.keyrow input.reveal { -webkit-text-security: none; } /* \u300C\u663E\u793A\u300D\u6001\uFF1A\u660E\u6587\u56DE\u663E */
.keyrow input::placeholder, .mrow input::placeholder { color: var(--text-3); font-style: italic; } /* PTA \u7684\u5360\u4F4D\u7B26\u6837\u5F0F */
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
.switchrow .stxt b { font-weight: 400; font-size: 15px; line-height: 20px; } /* PTA \u884C\u6807\u9898\uFF1A15/20\u3001\u5E38\u89C4\u5B57\u91CD */
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
input:disabled, button:disabled { opacity: .6; cursor: not-allowed; } /* PTA \u7684\u7981\u7528\u53E3\u5F84 */

/* \u4E3B\u6309\u94AE\uFF1APTA \u7684\u5B9E\u5FC3\u6309\u94AE\uFF08\u4E3B\u8272\u5E95\u767D\u5B57 / 2rem \u9AD8 / 4px \u5706\u89D2\uFF09\uFF0C\u60AC\u505C\u538B\u6697\u3001\u6309\u4E0B 1px */
.start { width: 100%; height: 32px; padding: 0 15px; border: 1px solid transparent; border-radius: 4px;
  background: var(--accent); color: #fff; font: inherit; font-size: 15px; cursor: pointer;
  filter: brightness(var(--brightness, 1));
  transition: filter .2s ease; }
.start:hover:not(:disabled) { --brightness: .85; }
.start:not(:disabled):active { transform: translateY(1px); }
.start:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* \u8FD0\u884C\u4E2D\u540C\u4E00\u6309\u94AE\u53D8\u8EAB\u300C\u4E2D\u6B62\u7B54\u9898\u300D\uFF1A\u5B9E\u5FC3\u7EA2\uFF08PTA danger\uFF09\u4E0E\u4E3B\u8272\u5F00\u59CB\u6001\u4E00\u773C\u53EF\u5206 */
.start.stop { background: var(--err); color: #fff; }

.logs-head { display: flex; align-items: center; justify-content: space-between; }
.logs-head b { font-size: 13px; line-height: 16px; font-weight: 500; color: var(--text-2); }
.clear { border: 0; border-radius: 4px; background: none; color: var(--text-3);
  font-size: 13px; padding: 3px 8px; cursor: pointer;
  transition: background-color var(--trs), color var(--trs); }
.clear:hover:not(:disabled) { background: var(--bg-light); color: var(--err); }
.clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
/* \u65E5\u5FD7\u662F\u6570\u636E\u9762\uFF1A\u4FDD\u7559\u7B49\u5BBD\u4E0E\u7D27\u51D1\u884C\u9AD8\uFF0C\u5916\u6846\u3001\u5E95\u8272\u4E0E\u7EA7\u522B\u914D\u8272\u6362\u6210 PTA \u7684\u4EE4\u724C */
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

/* ---------- \u53CC\u4E3B\u9898\uFF1A\u4EE4\u724C\u4E0E\u8BBE\u7F6E\u5F39\u7A97\u3001\u6CE8\u5165\u6837\u5F0F\u540C\u6E90\uFF082026-10-16 \u5B9E\u6D4B\u81EA pintia.cn\uFF09 ----------
   \u8DDF\u968F **PTA \u81EA\u5DF1\u7684 .dark \u7C7B**\uFF08\u7531 js \u7684 syncTheme \u955C\u50CF\u5230 host \u4E0A\uFF09\uFF1APTA \u7528\u7C7B\u5207\u6362\u4E3B\u9898\uFF0C
   \u8FD9\u6BD4 prefers-color-scheme \u51C6\u2014\u2014\u7CFB\u7EDF\u662F\u6697\u8272\u4F46\u7528\u6237\u5728 PTA \u91CC\u9009\u4E86\u6D45\u8272\u65F6\uFF0C\u9762\u677F\u4E0D\u8BE5\u81EA\u4F5C\u4E3B\u5F20\u53D8\u6697\u3002 */
:host {
  --bg: hsl(0, 0%, 100%);
  --bg-light: hsl(211, 20%, 97%);
  --bg-normal: hsl(211, 20%, 93%);
  --hairline: hsla(0, 0%, 0%, .06);
  --accent: hsl(212, 89%, 53%);
  --accent-soft: rgba(28, 128, 242, .1);
  --accent-ring: rgba(10, 73, 145, .25); /* PTA \u8F93\u5165\u6846\u805A\u7126\u73AF\u7684\u539F\u59CB\u5B57\u9762\u91CF\uFF08\u660E\u6697\u540C\u503C\uFF09 */
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
  var host = null;
  var shadow = null;
  var settings = null;
  var open = false;
  var activePage = "answer";
  var themeObserver = null;
  var ballPos = null;
  var BALL_SIZE = 46;
  var BALL_MARGIN = 18;
  var POS_KEY = "autoAnswerBallPos";
  var logLines = [];
  var lastProgress = null;
  var finished = false;
  var finishedWithError = false;
  var unregisterSink = null;
  var svgRing = `
  <svg class="ring" viewBox="0 0 48 48" aria-hidden="true">
    <circle class="bg" cx="24" cy="24" r="22"></circle>
    <circle class="fg" cx="24" cy="24" r="22"></circle>
  </svg>`;
  function clampBallPos(p, innerW, innerH) {
    const num = (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? n : 0;
    };
    const minX = BALL_MARGIN, minY = BALL_MARGIN;
    const maxX = Math.max(minX, innerW - BALL_SIZE - BALL_MARGIN);
    const maxY = Math.max(minY, innerH - BALL_SIZE - BALL_MARGIN);
    return { r: Math.min(Math.max(num(p?.r), minX), maxX), b: Math.min(Math.max(num(p?.b), minY), maxY) };
  }
  function applyBallPos() {
    if (!shadow || !ballPos) return;
    const wrap = shadow.querySelector(".wrap");
    if (!wrap) return;
    wrap.style.right = `${ballPos.r}px`;
    wrap.style.bottom = `${ballPos.b}px`;
  }
  function loadBallPos() {
    try {
      return chrome.storage.local.get({ [POS_KEY]: null }).then((v) => v?.[POS_KEY] || null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }
  function saveBallPos() {
    try {
      chrome.storage.local.set({ [POS_KEY]: ballPos });
    } catch (_) {
    }
  }
  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function timeStr() {
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function appendLog(level, text, at = null, persist2 = true) {
    const t = at || timeStr();
    logLines.push({ level, text, t });
    if (persist2) persistLogLine(level, text, t);
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    if (!shadow) return;
    const box = shadow.getElementById("logs");
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    const line = el("div", "line", box);
    const tag = { ok: "\u2713", err: "\u2715", warn: "!" }[level] || "\xB7";
    line.innerHTML = `<span class="t">${t}</span><span class="lv-${level}">${tag}</span> `;
    line.appendChild(document.createTextNode(text));
    while (box.children.length > MAX_LOG_LINES) box.firstChild.remove();
    if (nearBottom) box.scrollTop = box.scrollHeight;
  }
  function renderLogs() {
    const box = shadow.getElementById("logs");
    if (!box) return;
    box.innerHTML = "";
    for (const l of logLines) {
      const line = el("div", "line", box);
      const tag = { ok: "\u2713", err: "\u2715", warn: "!" }[l.level] || "\xB7";
      line.innerHTML = `<span class="t">${l.t}</span><span class="lv-${l.level}">${tag}</span> `;
      line.appendChild(document.createTextNode(l.text));
    }
    box.scrollTop = box.scrollHeight;
  }
  function onEvent(ev) {
    if (ev.kind === "log-clear") {
      logLines.length = 0;
      renderLogs();
      return;
    }
    if (ev.kind === "log") return appendLog(ev.level, ev.text, null, false);
    if (ev.kind === "progress") {
      lastProgress = { done: ev.done, total: ev.total };
      if (shadow) updateRunUI();
      return;
    }
    if (ev.kind === "state") {
      if (ev.running) {
        finished = false;
        finishedWithError = false;
      } else {
        finished = true;
        finishedWithError = !!ev.error;
        if (ev.error) appendLog("err", ev.error, null, false);
      }
      if (shadow) {
        updateRunUI();
        const box = shadow.getElementById("logs");
        if (box && !ev.running) box.scrollTop = box.scrollHeight;
      }
    }
  }
  function updateRunUI() {
    if (!shadow) return;
    const running2 = isRunning();
    const ball = shadow.getElementById("ball");
    const pill = shadow.getElementById("pill");
    const start = shadow.getElementById("start");
    const ringFg = ball?.querySelector(".ring .fg");
    const prog = running2 ? lastProgress : null;
    if (ball) {
      ball.classList.toggle("running", running2);
      if (ringFg) ringFg.style.strokeDashoffset = prog ? String(138.2 * (1 - prog.done / Math.max(1, prog.total))) : "138.2";
    }
    if (pill) {
      pill.className = "pill" + (running2 ? " run" : finished ? finishedWithError ? " err" : " ok" : "");
      pill.textContent = running2 ? `\u7B54\u9898\u4E2D ${prog ? `${prog.done}/${prog.total}` : "\u2026"}` : finished ? finishedWithError ? "\u5DF2\u4E2D\u6B62" : "\u5DF2\u5B8C\u6210" : "\u5F85\u673A";
    }
    if (start) {
      start.disabled = false;
      start.classList.toggle("stop", running2);
      start.textContent = running2 ? "\u4E2D\u6B62\u7B54\u9898" : "\u5F00\u59CB\u7B54\u9898";
    }
  }
  function syncTheme() {
    if (!host) return;
    const dark = document.documentElement.classList.contains("dark") || document.body.classList.contains("dark");
    host.classList.toggle("dark", dark);
  }
  function mount() {
    if (host) return;
    host = document.createElement("div");
    host.className = "bps-aa";
    host.dataset.bps = "autoanswer";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    const wrap = el("div", "wrap", shadow);
    const ball = el("button", "ball", wrap);
    ball.id = "ball";
    ball.type = "button";
    ball.setAttribute("aria-label", "\u81EA\u52A8\u7B54\u9898");
    ball.setAttribute("aria-expanded", "false");
    ball.innerHTML = svgRing + '<span class="glyph">\u7B54</span>';
    const panel = el("div", "panel", wrap);
    panel.id = "panel";
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "\u81EA\u52A8\u7B54\u9898\u9762\u677F");
    const head = el("div", "head", panel);
    el("span", "", head).textContent = "\u81EA\u52A8\u7B54\u9898";
    const pill = el("span", "pill", head);
    pill.id = "pill";
    pill.textContent = "\u5F85\u673A";
    const collapse = el("button", "collapse", head);
    collapse.type = "button";
    collapse.id = "collapse";
    collapse.setAttribute("aria-label", "\u6536\u8D77\u9762\u677F");
    collapse.textContent = "\u2014";
    const tabbar = el("div", "tabs", panel);
    tabbar.setAttribute("role", "tablist");
    tabbar.setAttribute("aria-label", "\u9762\u677F\u5206\u533A");
    const tabAnswer = el("button", "tab", tabbar);
    tabAnswer.id = "tab-answer";
    tabAnswer.setAttribute("role", "tab");
    tabAnswer.setAttribute("aria-controls", "page-answer");
    tabAnswer.textContent = "\u7B54\u9898\u914D\u7F6E";
    const tabModel = el("button", "tab", tabbar);
    tabModel.id = "tab-model";
    tabModel.setAttribute("role", "tab");
    tabModel.setAttribute("aria-controls", "page-model");
    tabModel.textContent = "\u6A21\u578B\u914D\u7F6E";
    const pages = el("div", "pages", panel);
    const pageAnswer = el("div", "page", pages);
    pageAnswer.id = "page-answer";
    pageAnswer.setAttribute("role", "tabpanel");
    pageAnswer.setAttribute("aria-labelledby", "tab-answer");
    const pageModel = el("div", "page", pages);
    pageModel.id = "page-model";
    pageModel.setAttribute("role", "tabpanel");
    pageModel.setAttribute("aria-labelledby", "tab-model");
    const fModel = el("div", "field", pageModel);
    el("label", "flabel", fModel).textContent = "\u670D\u52A1";
    fModel.querySelector("label").htmlFor = "aa-model";
    const sel = el("select", "", fModel);
    sel.id = "aa-model";
    for (const [key2, p] of Object.entries(PRESETS)) {
      const o = el("option", "", sel);
      o.value = key2;
      o.textContent = p.label;
      if (p.disabled) o.disabled = true;
    }
    el("p", "hint", fModel);
    const fBase = el("div", "field", pageModel);
    fBase.id = "aa-base-field";
    fBase.hidden = true;
    el("label", "flabel", fBase).textContent = "\u7AEF\u70B9";
    fBase.querySelector("label").htmlFor = "aa-base";
    const brow = el("div", "mrow", fBase);
    const burl = el("input", "", brow);
    burl.id = "aa-base";
    burl.type = "text";
    burl.placeholder = "https://api.example.com/v1";
    burl.autocomplete = "off";
    burl.spellcheck = false;
    el("p", "hint", fBase).textContent = "OpenAI \u517C\u5BB9\u6839\u5730\u5740\uFF0C\u586B\u5230 /v1 \u5373\u53EF\uFF08\u8BEF\u7C98 /chat/completions \u4F1A\u81EA\u52A8\u5265\u6389\uFF09";
    const fModelName = el("div", "field", pageModel);
    fModelName.id = "aa-model-field";
    fModelName.hidden = true;
    el("label", "flabel", fModelName).textContent = "\u6A21\u578B";
    fModelName.querySelector("label").htmlFor = "aa-model-name";
    const mrow = el("div", "mrow", fModelName);
    const mname = el("input", "", mrow);
    mname.id = "aa-model-name";
    mname.type = "text";
    mname.autocomplete = "off";
    mname.spellcheck = false;
    el("p", "hint", fModelName).textContent = "\u7559\u7A7A\u5373\u7528\u8BE5\u670D\u52A1\u7684\u9ED8\u8BA4\u6A21\u578B";
    const fLang = el("div", "field", pageAnswer);
    el("label", "flabel", fLang).textContent = "\u8BED\u8A00\uFF08\u7F16\u7A0B\u9898\uFF09";
    fLang.querySelector("label").htmlFor = "aa-lang";
    const lsel = el("select", "", fLang);
    lsel.id = "aa-lang";
    const oFollow = el("option", "", lsel);
    oFollow.value = "";
    oFollow.textContent = "\u8DDF\u968F\u7F16\u8F91\u5668\u5F53\u524D\u8BED\u8A00";
    el("p", "hint", fLang).textContent = "\u672C\u9898\u96C6\u5141\u8BB8\u7684\u8BED\u8A00\uFF1B\u4F5C\u7B54\u6309\u6240\u9009\u8BED\u8A00\u51FA\u7801\u5E76\u63D0\u4EA4\u8BC4\u6D4B";
    const fKey = el("div", "field", pageModel);
    el("label", "flabel", fKey).textContent = "API Key";
    fKey.querySelector("label").htmlFor = "aa-key";
    const keyrow = el("div", "keyrow", fKey);
    const key = el("input", "", keyrow);
    key.id = "aa-key";
    key.type = "text";
    key.placeholder = "sk-\u2026";
    key.autocomplete = "off";
    key.spellcheck = false;
    const peek = el("button", "peek", keyrow);
    peek.type = "button";
    peek.id = "aa-peek";
    peek.textContent = "\u663E\u793A";
    peek.setAttribute("aria-label", "\u663E\u793A\u6216\u9690\u85CF API Key");
    el("p", "hint", fKey).textContent = "\u6BCF\u4E2A\u670D\u52A1\u5404\u5B58\u4E00\u628A Key\uFF0C\u5207\u670D\u52A1\u81EA\u52A8\u5E26\u51FA\uFF1B\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u6D4F\u89C8\u5668";
    const sw = el("label", "switchrow", pageAnswer);
    sw.htmlFor = "aa-overwrite";
    const stxt = el("span", "stxt", sw);
    el("b", "", stxt).textContent = "\u8986\u76D6\u5DF2\u4F5C\u7B54";
    el("small", "", stxt).textContent = "\u9ED8\u8BA4\u8DF3\u8FC7\u5DF2\u7B54\u9898\uFF0C\u4FDD\u7559\u539F\u6709\u7B54\u6848";
    const ovw = el("input", "switch", sw);
    ovw.id = "aa-overwrite";
    ovw.type = "checkbox";
    const swImg = el("label", "switchrow", pageAnswer);
    swImg.htmlFor = "aa-images";
    const stxtImg = el("span", "stxt", swImg);
    el("b", "", stxtImg).textContent = "\u4F5C\u7B54\u542B\u56FE\u9898";
    el("small", "", stxtImg).textContent = "\u9700\u89C6\u89C9\u6A21\u578B\uFF08\u5982 deepseek-flash\uFF09\uFF0C\u9ED8\u8BA4\u8DF3\u8FC7\uFF1B\u4EC5\u5BA2\u89C2\u9898";
    const imgs = el("input", "switch", swImg);
    imgs.id = "aa-images";
    imgs.type = "checkbox";
    const start = el("button", "start", pageAnswer);
    start.id = "start";
    start.type = "button";
    start.textContent = "\u5F00\u59CB\u7B54\u9898";
    const logsHead = el("div", "logs-head", pageAnswer);
    el("b", "", logsHead).textContent = "\u65E5\u5FD7";
    const clear = el("button", "clear", logsHead);
    clear.id = "clear";
    clear.type = "button";
    clear.textContent = "\u6E05\u7A7A";
    const logs = el("div", "logs", pageAnswer);
    logs.id = "logs";
    logs.setAttribute("role", "log");
    logs.setAttribute("aria-live", "polite");
    el("p", "foot", pageAnswer).textContent = "\u5B9E\u9A8C\u529F\u80FD\uFF1A\u7B54\u9898\u4E2D\u5E73\u53F0\u4E0D\u53CD\u9988\u5BF9\u9519\uFF0C\u5B8C\u6210\u540E\u8BF7\u81EA\u884C\u6838\u5BF9\u7ED3\u679C\u3002";
    el("p", "foot", pageAnswer).textContent = "\u6587\u672C\u6A21\u578B\u770B\u4E0D\u89C1\u56FE\u7247\uFF1A\u5BA2\u89C2\u9898\u542B\u56FE\u9898\u8981\u4E48\u8DF3\u8FC7\uFF0C\u8981\u4E48\u5207\u5230\u89C6\u89C9\u6A21\u578B\uFF08\u5982 deepseek-flash\uFF09\u5E76\u5F00\u542F\u300C\u4F5C\u7B54\u542B\u56FE\u9898\u300D\uFF1B\u7F16\u7A0B\u9898\u4E0D\u63A5\u56FE\u7247\u8F93\u5165\uFF0C\u542B\u56FE\u9898\u6309\u6587\u5B57\u9898\u9762\u4F5C\u7B54\u5E76\u7167\u5E38\u63D0\u4EA4\u3002";
    el("p", "foot", pageAnswer).textContent = "\u7F16\u7A0B\u9898\u63D0\u4EA4\u5373\u8BC4\u6D4B\uFF1A\u4F5C\u7B54\u4F1A\u5B9E\u65F6\u751F\u6210\u63D0\u4EA4\u8BB0\u5F55\u4E0E\u4F5C\u7B54\u5EA6\uFF0C\u6210\u7EE9\u7531\u8BC4\u6D4B\u7ED3\u679C\u51B3\u5B9A\uFF0C\u4E0E\u5BA2\u89C2\u9898\u5224\u5206\u8DEF\u5F84\u4E0D\u540C\u3002";
    let drag = null;
    let suppressClickUntil = 0;
    ball.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const r = ball.getBoundingClientRect();
      drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
      try {
        ball.setPointerCapture(e.pointerId);
      } catch (_) {
      }
    });
    ball.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
        drag.moved = true;
        wrap.classList.add("dragging");
      }
      ballPos = clampBallPos({
        r: window.innerWidth - (e.clientX - drag.dx) - BALL_SIZE,
        b: window.innerHeight - (e.clientY - drag.dy) - BALL_SIZE
      }, window.innerWidth, window.innerHeight);
      applyBallPos();
    });
    const endDrag = () => {
      if (drag) wrap.classList.remove("dragging");
      drag = null;
    };
    ball.addEventListener("pointerup", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasMoved = drag.moved;
      endDrag();
      if (!wasMoved) return;
      suppressClickUntil = Date.now() + 400;
      saveBallPos();
      if (open) placePanel();
    });
    ball.addEventListener("pointercancel", endDrag);
    ball.addEventListener("click", () => {
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        return;
      }
      togglePanel();
    });
    collapse.addEventListener("click", closePanel);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePanel();
    });
    tabAnswer.addEventListener("click", () => switchTab("answer"));
    tabModel.addEventListener("click", () => switchTab("model"));
    tabbar.addEventListener("keydown", (e) => {
      const cur = activePage === "model" ? tabModel : tabAnswer;
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = cur === tabAnswer ? tabModel : tabAnswer;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = cur === tabModel ? tabAnswer : tabModel;
      else if (e.key === "Home") next = tabAnswer;
      else if (e.key === "End") next = tabModel;
      if (!next || next === cur) return;
      e.preventDefault();
      switchTab(next === tabModel ? "model" : "answer");
      next.focus();
    });
    switchTab(activePage);
    peek.addEventListener("click", () => {
      const show = !key.classList.contains("reveal");
      key.classList.toggle("reveal", show);
      peek.textContent = show ? "\u9690\u85CF" : "\u663E\u793A";
    });
    const applyPreset = () => {
      const p = PRESETS[sel.value] || PRESETS.deepseek;
      fModel.querySelector(".hint").textContent = p.hint || "";
      fBase.hidden = !p.customEndpoint;
      fModelName.hidden = !p.editableModel;
      mname.placeholder = p.customEndpoint ? "gpt-4o-mini" : p.model || "";
      fModelName.querySelector(".hint").textContent = p.editableModel ? p.customEndpoint ? "\u586B\u8BE5\u670D\u52A1\u53EF\u7528\u7684\u6A21\u578B id" : "\u7559\u7A7A\u5373\u7528\u8BE5\u670D\u52A1\u7684\u9ED8\u8BA4\u6A21\u578B" : "";
    };
    if (settings && PRESETS[settings.autoAnswerGateway]) sel.value = settings.autoAnswerGateway;
    burl.value = ((settings || {}).autoAnswerBaseUrl || "").trim();
    mname.value = ((settings || {}).autoAnswerModel || "").trim();
    key.value = currentKey(settings, sel.value);
    ovw.checked = !!(settings || {}).autoAnswerOverwrite;
    imgs.checked = !!(settings || {}).autoAnswerImages;
    refreshLangOptions();
    applyPreset();
    let keyOwner = sel.value;
    sel.addEventListener("change", async () => {
      await saveKeyFor(keyOwner, key.value);
      keyOwner = sel.value;
      applyPreset();
      const fresh = await loadSettings();
      key.value = currentKey(fresh, sel.value);
      await persist();
    });
    burl.addEventListener("change", persist);
    mname.addEventListener("change", persist);
    key.addEventListener("change", persist);
    lsel.addEventListener("change", persist);
    ovw.addEventListener("change", persist);
    imgs.addEventListener("change", persist);
    clear.addEventListener("click", () => {
      clearPersistedLog();
      logLines.length = 0;
      renderLogs();
    });
    start.addEventListener("click", () => {
      if (isRunning()) {
        appendLog("warn", abortRun() ? "\u5DF2\u8BF7\u6C42\u4E2D\u6B62\uFF0C\u6B63\u5728\u505C\u6B62\u2026" : "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684\u7B54\u9898");
        return;
      }
      startRun();
    });
    syncTheme();
    themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    document.body.appendChild(host);
    if (!logLines.length) logLines.push(...readPersistedLog().slice(-MAX_LOG_LINES));
    renderLogs();
    updateRunUI();
    loadBallPos().then((p) => {
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
    langPsId = null;
  }
  var langPsId = null;
  async function refreshLangOptions() {
    if (!shadow) return;
    const psId = (location.pathname.match(EXAM_PROBLEMS_RE) || [])[1];
    if (!psId || langPsId === psId) return;
    langPsId = psId;
    const lsel = shadow.getElementById("aa-lang");
    if (!lsel) return;
    const want = (settings || {}).autoAnswerLanguage || "";
    let allowed = null;
    try {
      allowed = await fetchAllowedCompilers(psId);
    } catch (_) {
    }
    if (!shadow) return;
    const ids = Array.isArray(allowed) && allowed.length ? allowed : Object.keys(COMPILER_LABELS);
    while (lsel.options.length > 1) lsel.remove(1);
    for (const id of ids) {
      const o = el("option", "", lsel);
      o.value = id;
      o.textContent = COMPILER_LABELS[id] || id;
    }
    lsel.value = [...lsel.options].some((o) => o.value === want) ? want : "";
    if (want && lsel.value !== want) {
      appendLog("warn", `\u4E0A\u6B21\u56FA\u5B9A\u8BED\u8A00\u300C${COMPILER_LABELS[want] || want}\u300D\u4E0D\u5728\u672C\u9898\u96C6\u5141\u8BB8\u5217\u8868\uFF0C\u5DF2\u6539\u56DE\u8DDF\u968F\u5F53\u524D`);
    }
  }
  function togglePanel() {
    if (!shadow) return;
    open ? closePanel() : openPanel();
  }
  function switchTab(name) {
    if (!shadow) return;
    activePage = name === "model" ? "model" : "answer";
    const model = activePage === "model";
    const a = shadow.getElementById("page-answer");
    const m = shadow.getElementById("page-model");
    if (a) a.hidden = model;
    if (m) m.hidden = !model;
    const tA = shadow.getElementById("tab-answer");
    const tM = shadow.getElementById("tab-model");
    if (tA) {
      tA.setAttribute("aria-selected", String(!model));
      tA.tabIndex = model ? -1 : 0;
    }
    if (tM) {
      tM.setAttribute("aria-selected", String(model));
      tM.tabIndex = model ? 0 : -1;
    }
  }
  function placePanel() {
    if (!shadow) return;
    const wrapEl = shadow.querySelector(".wrap");
    if (!wrapEl) return;
    const cx = window.innerWidth - (ballPos?.r ?? 18) - BALL_SIZE / 2;
    const cy = window.innerHeight - (ballPos?.b ?? 18) - BALL_SIZE / 2;
    wrapEl.classList.toggle("pos-left", cx < window.innerWidth / 2);
    wrapEl.classList.toggle("pos-top", cy < window.innerHeight / 2);
  }
  function openPanel() {
    if (!shadow) return;
    const panel = shadow.getElementById("panel");
    const ball = shadow.getElementById("ball");
    placePanel();
    panel.hidden = false;
    ball.setAttribute("aria-expanded", "true");
    open = true;
    updateRunUI();
    const pane = shadow.getElementById(activePage === "model" ? "page-model" : "page-answer");
    const first = pane?.querySelector("select, input, button");
    if (first) first.focus();
  }
  function closePanel() {
    if (!shadow) return;
    const panel = shadow.getElementById("panel");
    const ball = shadow.getElementById("ball");
    if (panel) panel.hidden = true;
    if (ball) {
      ball.setAttribute("aria-expanded", "false");
      ball.focus();
    }
    open = false;
  }
  async function saveKeyFor(gateway, value) {
    try {
      const fresh = await loadSettings();
      const next = withKeyFor(fresh, gateway, value);
      await saveSettings(next);
      settings = next;
    } catch (_) {
    }
  }
  async function persist() {
    if (!shadow) return;
    const apiKey = shadow.getElementById("aa-key").value.trim();
    const overwrite = shadow.getElementById("aa-overwrite").checked;
    const withImages = shadow.getElementById("aa-images").checked;
    const gw = shadow.getElementById("aa-model");
    const gateway = PRESETS[gw.value] ? gw.value : "deepseek";
    const baseUrl = (shadow.getElementById("aa-base")?.value || "").trim();
    const model = (shadow.getElementById("aa-model-name")?.value || "").trim();
    const lang = shadow.getElementById("aa-lang");
    const language = lang ? lang.value.trim() : "";
    try {
      const fresh = await loadSettings();
      await saveSettings({ ...withKeyFor(fresh, gateway, apiKey), autoAnswerOverwrite: overwrite, autoAnswerImages: withImages, autoAnswerGateway: gateway, autoAnswerBaseUrl: baseUrl, autoAnswerModel: model, autoAnswerLanguage: language });
    } catch (_) {
    }
  }
  async function startRun() {
    if (isRunning()) return;
    if (!shadow) return;
    const sel = shadow.getElementById("aa-model");
    const preset = PRESETS[sel.value] || PRESETS.deepseek;
    if (preset.disabled) {
      appendLog("err", `${preset.label}\uFF1A\u8BE5\u6A21\u578B\u5C1A\u672A\u9002\u914D`);
      return;
    }
    const burl = shadow.getElementById("aa-base");
    const baseUrl = preset.customEndpoint ? normalizeBaseUrl(burl?.value) : preset.baseUrl;
    if (preset.customEndpoint && !baseUrl) {
      appendLog("err", "\u8BF7\u5148\u586B\u5199 OpenAI \u517C\u5BB9\u7AEF\u70B9\uFF08\u586B\u5230 /v1\uFF09");
      switchTab("model");
      burl?.focus();
      return;
    }
    const model = resolveModel(preset, shadow.getElementById("aa-model-name")?.value);
    if (preset.customEndpoint && !model) {
      appendLog("err", "\u8BF7\u5148\u586B\u5199\u6A21\u578B id");
      switchTab("model");
      shadow.getElementById("aa-model-name").focus();
      return;
    }
    const apiKey = shadow.getElementById("aa-key").value.trim();
    if (!apiKey) {
      appendLog("err", "\u8BF7\u5148\u586B\u5199 API Key\uFF08\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\uFF09");
      switchTab("model");
      shadow.getElementById("aa-key").focus();
      return;
    }
    const overwrite = shadow.getElementById("aa-overwrite").checked;
    const withImages = shadow.getElementById("aa-images").checked;
    const language = (shadow.getElementById("aa-lang")?.value || "").trim();
    await persist();
    const result = await handleRun({
      baseUrl,
      model,
      apiKey,
      overwrite,
      images: withImages,
      gateway: preset.gateway,
      language
    });
    if (!result.ok && result.error === "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D") appendLog("warn", "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D");
  }
  function sync(s) {
    settings = s || settings;
    const shouldShow = !!settings && !!settings.autoAnswer && EXAM_PROBLEMS_RE.test(location.pathname);
    if (shouldShow && !host) mount();
    if (shouldShow) refreshLangOptions();
    if (!shouldShow && host) {
      if (isRunning()) {
        if (shadow) closePanel();
      } else {
        unmount();
      }
    }
  }
  function init() {
    setEventSink(onEvent);
    unregisterSink = () => setEventSink(null);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && shadow) updateRunUI();
    });
    window.addEventListener("resize", () => {
      if (!ballPos || !shadow) return;
      ballPos = clampBallPos(ballPos, window.innerWidth, window.innerHeight);
      applyBallPos();
      if (open) placePanel();
    });
  }
  var armed = false;
  function armOnce() {
    if (armed) return;
    armed = true;
    init();
  }

  // src/content/classify.js
  function parseRules(settings3) {
    return (settings3.rules || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf("=>");
      if (i <= 0) return null;
      const key = l.slice(0, i).trim();
      const course = l.slice(i + 2).trim();
      return key && course ? { key, course } : null;
    }).filter(Boolean);
  }
  function tidyCourse(s) {
    s = String(s).trim();
    for (; ; ) {
      const before = s;
      s = s.replace(/(?:--|｜|\||—|-|·)+$/, "").trim();
      if (s === before) break;
    }
    if (!s || /^[\d\s.\-—·｜|]+$/.test(s)) return null;
    return s;
  }
  function splitCourse(title, separators) {
    let best = -1;
    for (const sep of separators) {
      const i = title.indexOf(sep);
      if (i > 0 && (best === -1 || i < best)) best = i;
    }
    if (best > 0) {
      const c = tidyCourse(title.slice(0, best));
      if (c) return c;
    }
    const keywordRe = /(课堂练习|课堂测试|课堂作业|课堂测验|随堂练习|复习题|上机|随堂|实验|作业|测验|考试|测试|练习|期中|期末|项目|Lab|HW)/gi;
    let m;
    while (m = keywordRe.exec(title)) {
      if (m.index >= 3) {
        const c = tidyCourse(title.slice(0, m.index));
        if (c) return c;
      }
    }
    const ym = /^(\d{4})[-—·]/.exec(title);
    if (ym) return ym[1];
    return null;
  }
  function classifyDetailed(title, settings3) {
    for (const r of parseRules(settings3)) {
      if (title.includes(r.key)) return { course: r.course, locked: true };
    }
    return {
      course: splitCourse(title, settings3.separators.split(",").map((x) => x.trim()).filter(Boolean)),
      locked: false
    };
  }
  function lcsLength(a, b) {
    let prev = new Array(b.length + 1).fill(0);
    let best = 0;
    for (let i = 1; i <= a.length; i++) {
      const cur = [0];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
        if (cur[j] > best) best = cur[j];
      }
      prev = cur;
    }
    return best;
  }
  function shouldMergeCourses(a, b) {
    const min = Math.min(a.length, b.length);
    return lcsLength(a, b) >= Math.max(4, Math.ceil(min * 0.6));
  }
  function buildCourseRenameMap(pairs, settings3) {
    const cls = pairs.map((p) => ({ ...classifyDetailed(p.title, settings3), teacher: p.teacher }));
    const counts = /* @__PURE__ */ new Map();
    const byTeacher = /* @__PURE__ */ new Map();
    for (const c of cls) {
      if (!c.course) continue;
      counts.set(c.course, (counts.get(c.course) || 0) + 1);
      if (c.locked || !c.teacher) continue;
      (byTeacher.get(c.teacher) || byTeacher.set(c.teacher, []).get(c.teacher)).push(c.course);
    }
    const nameMap = /* @__PURE__ */ new Map();
    for (const names of byTeacher.values()) {
      const uniq = [...new Set(names)];
      if (uniq.length < 2) continue;
      const parent = uniq.map((_, i) => i);
      const find = (i) => parent[i] === i ? i : parent[i] = find(parent[i]);
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          if (shouldMergeCourses(uniq[i], uniq[j])) parent[find(i)] = find(j);
        }
      }
      const clusters = /* @__PURE__ */ new Map();
      uniq.forEach((n, i) => {
        const r = find(i);
        (clusters.get(r) || clusters.set(r, []).get(r)).push(n);
      });
      for (const members of clusters.values()) {
        if (members.length < 2) continue;
        const canonical = members.map((n) => ({ n, count: counts.get(n) || 0 })).sort((a, b) => b.count - a.count || a.n.length - b.n.length)[0].n;
        for (const n of members) if (n !== canonical) nameMap.set(n, canonical);
      }
    }
    return nameMap;
  }

  // src/shared/time.js
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function parseCloseTime(text) {
    const m = /关闭时间[:：]\s*(?:(\d{4})-(\d{1,2})-(\d{1,2}))?\s*(?:(\d{1,2}):(\d{2}))?/.exec(text || "");
    if (!m || !m[1] && !m[4]) return null;
    if (m[1]) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const d = /* @__PURE__ */ new Date();
    d.setHours(+m[4], +m[5], 0, 0);
    return d;
  }
  function fmtCloseLocal(d) {
    if (!d) return "";
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return hm === "00:00" ? date : `${date} ${hm}`;
  }
  function fmtCountdown(closeAt, now = Date.now()) {
    const ms = closeAt - now;
    if (ms <= 0) return null;
    const min = Math.floor(ms / 6e4);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (hr < 1) return { text: `\u5269 ${min} \u5206\u949F`, level: 3 };
    if (hr < 24) return { text: `\u5269 ${hr} \u5C0F\u65F6`, level: 3 };
    if (hr < 48) return { text: `\u5269 ${day} \u5929 ${hr - day * 24} \u5C0F\u65F6`, level: 2 };
    if (day <= 7) return { text: `\u5269 ${day} \u5929`, level: 1 };
    return null;
  }

  // src/shared/util.js
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function hashHue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  // src/content/progress.js
  var OK_TTL = 2 * 60 * 1e3;
  var FAIL_TTL = 10 * 60 * 1e3;
  var CONCURRENCY = 3;
  var NO_ANSWER_STATUS = "PROBLEM_NO_ANSWER";
  var cache = /* @__PURE__ */ new Map();
  var queued = /* @__PURE__ */ new Set();
  var queue = [];
  var waiters = [];
  var active = 0;
  var hooks2 = {};
  function setProgressHooks(next) {
    hooks2 = { ...hooks2, ...next };
  }
  function progressUrl(examId, problemSetId) {
    return `/api/exams/${encodeURIComponent(examId)}/problem-sets/${encodeURIComponent(problemSetId)}/problem-status?_bps=progress`;
  }
  function hasSubmission(p) {
    const st = p?.problemSubmissionStatus;
    return typeof st === "string" && st !== "" && st !== NO_ANSWER_STATUS;
  }
  function countAnswered(json) {
    const list = json?.problemStatus || [];
    return { answered: list.filter(hasSubmission).length, total: list.length };
  }
  function inAnswerWindow(it, now = Date.now()) {
    return !!(it?.startAt && it.closeAt && +it.startAt <= now && +it.closeAt > now);
  }
  function wantsProgress(it, now = Date.now()) {
    return !!(it?.examId && inAnswerWindow(it, now));
  }
  function readProgress(rec, now = Date.now()) {
    if (!rec || !rec.ok) return null;
    if (now - rec.at > OK_TTL) return null;
    if (!rec.total) return null;
    return { answered: rec.answered, total: rec.total };
  }
  function progressOf2(id) {
    return readProgress(cache.get(id));
  }
  function reminderDone(rec, now = Date.now()) {
    const p = readProgress(rec, now);
    return !!p && p.answered >= p.total;
  }
  function isReminderDone(id, now = Date.now()) {
    return reminderDone(cache.get(id), now);
  }
  function ensureProgressAsync(items, now = Date.now()) {
    const pending = /* @__PURE__ */ new Set();
    for (const it of (items || []).filter((x) => wantsProgress(x, now))) {
      const rec = cache.get(it.id);
      if (rec && (rec.ok ? now - rec.at <= OK_TTL : now - rec.at <= FAIL_TTL)) continue;
      pending.add(it.id);
      if (!queued.has(it.id)) {
        queued.add(it.id);
        queue.push({ id: it.id, examId: it.examId });
      }
    }
    pump();
    if (!pending.size) return Promise.resolve();
    return new Promise((resolve) => waiters.push({ pending, resolve }));
  }
  function ensureProgress(items, now = Date.now()) {
    void ensureProgressAsync(items, now);
  }
  function settleWaiter(id) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      w.pending.delete(id);
      if (!w.pending.size) {
        waiters.splice(i, 1);
        w.resolve();
      }
    }
  }
  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      fetchJson(progressUrl(job.examId, job.id)).then((json) => {
        cache.set(job.id, { at: Date.now(), ok: true, ...countAnswered(json) });
      }).catch((err) => {
        cache.set(job.id, { at: Date.now(), ok: false });
        console.warn(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u7B54\u9898\u8FDB\u5EA6\u83B7\u53D6\u5931\u8D25\uFF08\u9898\u76EE\u96C6 ${job.id}\uFF09: ${err?.message || err}`);
      }).finally(() => {
        active--;
        queued.delete(job.id);
        settleWaiter(job.id);
        hooks2.onUpdate?.();
        pump();
      });
    }
  }

  // src/content/decorate.js
  function extractItems(settings3) {
    const anchors = [...document.querySelectorAll("main a[href]")].filter((a) => SET_HREF_RE.test(a.getAttribute("href") || "") && !a.closest(".bps-root"));
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    for (const el2 of anchors) {
      const id = el2.getAttribute("href").match(SET_HREF_RE)[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const titleEl = el2.querySelector("div[title]");
      const title = (titleEl?.getAttribute("title") || titleEl?.textContent || el2.textContent || "").trim();
      const fullText = el2.textContent || "";
      items.push({
        id,
        el: el2,
        title,
        ...classifyDetailed(title, settings3),
        closeText: (/关闭时间[:：]\s*[\d: -]+/.exec(fullText)?.[0] || "").trim(),
        closeAt: parseCloseTime(fullText)
      });
    }
    return items;
  }
  function metaLine(scopeEl) {
    return [...scopeEl.querySelectorAll(".text-xs")].find((n) => /关闭时间/.test(n.textContent) && n.querySelector(".flex"));
  }
  function updateCountdown(scopeEl, it, s) {
    const line = metaLine(scopeEl);
    if (!line) return;
    const target = line.querySelector(".flex .flex") || line.querySelector(".flex");
    let c = scopeEl.querySelector(".bps-countdown");
    const native = /距离关闭/.test(scopeEl.textContent || "");
    const cd = s.countdown && it.closeAt && !native ? fmtCountdown(it.closeAt) : null;
    if (!cd) {
      c?.remove();
      return;
    }
    if (!c) {
      c = document.createElement("span");
      c.className = "bps-countdown";
      target.append(c);
    }
    const stamp = `${cd.text}|${cd.level}`;
    if (c.dataset.stamp !== stamp) {
      c.dataset.stamp = stamp;
      c.textContent = cd.text;
      c.dataset.level = String(cd.level);
      c.title = `\u5173\u95ED\u65F6\u95F4 ${fmtCloseLocal(it.closeAt)}`;
    }
  }
  function pillRow(scopeEl) {
    const pill = scopeEl.querySelector('div[class~="rounded-xl"][class*="bg-opacity-10"]');
    return pill ? pill.parentElement : null;
  }
  function openPillIn(row) {
    return [...row?.children || []].find(
      (n) => !n.classList.contains("bps-done") && /已开放/.test(n.textContent)
    );
  }
  function hideOpenPill(row) {
    const native = openPillIn(row);
    if (!native) return;
    native.dataset.bpsSwapOpen = "1";
    if (native.style.display !== "none") native.style.display = "none";
  }
  function restoreOpenPill(row) {
    const native = openPillIn(row);
    if (native?.dataset.bpsSwapOpen) {
      delete native.dataset.bpsSwapOpen;
      native.style.display = "";
    }
  }
  var STATUS_PILL = {
    done: { bg: "bg-green-500", color: "pc-color-pass", label: "\u5DF2\u5B8C\u6210" },
    todo: { bg: "bg-orange-500", color: "pc-color-warning", label: "\u672A\u5B8C\u6210" },
    none: { bg: "bg-blue-500", color: "pc-color-primary", label: "\u672A\u7B54\u9898" }
  };
  function statusPillHtml(level) {
    const t = STATUS_PILL[level];
    return `<div class="rounded-xl ${t.bg} bg-opacity-10 px-3 py-1 inline-block whitespace-nowrap flex-none"><div class="flex items-center space-x-1"><div class="pc-text ${t.color} pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>${t.label}</span></div></div></div></div>`;
  }
  function buildStatusPill(level) {
    const tpl = document.createElement("template");
    tpl.innerHTML = statusPillHtml(level);
    const el2 = tpl.content.firstElementChild;
    el2.classList.add("bps-done");
    el2.dataset.stamp = level;
    el2.dataset.level = level;
    return el2;
  }
  function updateProgress(scopeEl, it, s) {
    const p = s.progress && it.progress && it.progress.total > 0 ? it.progress : null;
    const openNoExam = s.progress && !it.examId && inAnswerWindow(it);
    const pill = scopeEl.querySelector(".bps-done");
    const text = scopeEl.querySelector(".bps-answered");
    if (!p && !openNoExam) {
      pill?.remove();
      text?.remove();
      restoreOpenPill(pillRow(scopeEl));
      return;
    }
    const level = p ? p.answered >= p.total ? "done" : "todo" : "none";
    const row = pillRow(scopeEl);
    if (row) {
      hideOpenPill(row);
      if (!pill || pill.dataset.stamp !== level) {
        const next = buildStatusPill(level);
        if (pill) pill.replaceWith(next);
        else row.append(next);
      }
    }
    const line = metaLine(scopeEl);
    const target = line && (line.querySelector(".flex .flex") || line.querySelector(".flex"));
    if (target && p) {
      const el2 = text || document.createElement("span");
      if (!text) {
        el2.className = "bps-answered";
        target.append(el2);
      }
      const label = `\u5DF2\u4F5C\u7B54 ${p.answered}/${p.total}`;
      if (el2.textContent !== label) el2.textContent = label;
    } else if (text) {
      text.remove();
    }
  }
  function decorate(it, s) {
    const el2 = it.el;
    if (s.badge && it.course) {
      const line = metaLine(el2);
      if (line) {
        const target = line.querySelector(".flex .flex") || line.querySelector(".flex");
        let b = el2.querySelector(".bps-badge");
        if (!b) {
          b = document.createElement("span");
          b.className = "bps-badge";
          target.prepend(b);
        }
        if (b.textContent !== it.course) {
          b.textContent = it.course;
          b.style.setProperty("--h", String(hashHue(it.course)));
        }
      }
    }
    updateCountdown(el2, it, s);
    updateProgress(el2, it, s);
  }

  // src/content/reminders.js
  var PUSH_MIN_INTERVAL = 30 * 60 * 1e3;
  var DIRECT_MIN_INTERVAL = 5 * 60 * 1e3;
  var PROGRESS_WAIT_MS = 15 * 1e3;
  var lastPush = { sig: null, at: 0 };
  var lastRemindCfg = { browser: null, email: null, skipDone: null, server: null, emailTo: null };
  var lastDirectAt = 0;
  function reminderCfg(settings3) {
    const ch = reminderChannels(settings3);
    return { browser: ch.browser, email: ch.email, skipDone: ch.skipDone, server: ch.server, emailTo: ch.emailTo };
  }
  function anyChannel(cfg) {
    return cfg.browser || cfg.email;
  }
  function consumeRemindCfgChange(settings3) {
    const cfg = reminderCfg(settings3);
    const changed = cfg.browser !== lastRemindCfg.browser || cfg.email !== lastRemindCfg.email || cfg.skipDone !== lastRemindCfg.skipDone || cfg.server !== lastRemindCfg.server || cfg.emailTo !== lastRemindCfg.emailTo;
    lastRemindCfg = cfg;
    return changed;
  }
  function buildSyncSets(items, { skipDone = false, isDone = isReminderDone } = {}) {
    const now = Date.now();
    return (items || []).filter((i) => i.closeAt && +i.closeAt > now).filter((i) => !skipDone || !isDone(i.id)).map((i) => ({ id: i.id, title: i.title, endAt: i.closeAt.toISOString(), owner: i.creator, org: i.org })).sort((a, b) => a.endAt.localeCompare(b.endAt));
  }
  function logSyncResult(res, count) {
    if (!res?.ok) {
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u63D0\u9192\u540C\u6B65\u5931\u8D25:", res?.error || "\u672A\u77E5\u9519\u8BEF");
    } else {
      const parts = [];
      if (res.browser) parts.push(`\u6D4F\u89C8\u5668\u901A\u77E5 ${res.browser.stored} \u4E2A${res.browser.skipped ? "\uFF08\u8DF3\u8FC7\uFF1A" + res.browser.skipped + "\uFF09" : ""}`);
      if (res.email?.ok) parts.push(`\u90AE\u4EF6 ${res.email.total} \u4E2A`);
      console.info(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u63D0\u9192\u540C\u6B65\u5B8C\u6210\uFF08${parts.join("\u3001") || count + " \u4E2A"}\uFF09`);
    }
    if (res?.email && res.email.ok === false) {
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u90AE\u4EF6\u63D0\u9192\u540C\u6B65\u5931\u8D25:", res.email.error);
    }
  }
  function pushReminders(cfg, items, force = false) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    if (!anyChannel(cfg)) return;
    const now = Date.now();
    const sets = buildSyncSets(items, cfg);
    const sig = JSON.stringify([cfg.browser, cfg.email, sets]);
    if (!force && sig === lastPush.sig && now - lastPush.at < PUSH_MIN_INTERVAL) return;
    lastPush = { sig, at: now };
    chrome.runtime.sendMessage({
      type: "BPS_SYNC",
      browser: cfg.browser,
      // 邮件通道关闭时不上报服务器/邮箱（内容脚本是外发数据的唯一出口，这里做减法）
      server: cfg.email ? cfg.server : "",
      email: cfg.email ? cfg.emailTo : "",
      sets
    }).then((res) => logSyncResult(res, sets.length)).catch((err) => console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u63D0\u9192\u540C\u6B65\u5931\u8D25:", err?.message || err));
  }
  async function pushWithProgress(cfg, items, force) {
    if (cfg.skipDone) {
      await Promise.race([
        ensureProgressAsync(items),
        new Promise((resolve) => setTimeout(resolve, PROGRESS_WAIT_MS))
      ]);
    }
    pushReminders(cfg, items, force);
  }
  function armDirectCooldown() {
    lastDirectAt = Date.now();
  }
  function syncRemindersDirect(settings3) {
    const changed = consumeRemindCfgChange(settings3);
    const cfg = reminderCfg(settings3);
    if (!anyChannel(cfg)) return;
    const now = Date.now();
    if (!changed && now - lastDirectAt < DIRECT_MIN_INTERVAL) return;
    lastDirectAt = now;
    const u = new URL("/api/problem-sets", location.origin);
    u.searchParams.set("filter", JSON.stringify({ endAtAfter: (/* @__PURE__ */ new Date()).toISOString() }));
    u.searchParams.set("page", "0");
    u.searchParams.set("limit", "100");
    u.searchParams.set("order_by", "END_AT");
    u.searchParams.set("asc", "true");
    u.searchParams.set("_bps", "reminder");
    aggregateAll(String(u)).then((items) => pushWithProgress(cfg, items, changed)).catch((err) => console.warn(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u63D0\u9192\u540C\u6B65\u5931\u8D25\uFF08\u62C9\u53D6\u8FDB\u884C\u4E2D\u9898\u76EE\u96C6\uFF09: ${err?.message || err}`));
  }
  function pushAggregatedReminders(settings3) {
    const cfg = reminderCfg(settings3);
    if (!anyChannel(cfg) || !ACTIVE_PATH_RE.test(location.pathname)) return;
    const changed = consumeRemindCfgChange(settings3);
    void pushWithProgress(cfg, aggregateItems(), changed);
  }

  // src/content/list-view.js
  var PAGE_SIZE = 30;
  function defaultGroupedFor() {
    return false;
  }
  var state = {
    filter: "ALL",
    grouped: false,
    // 当前路由的视图模式（进入路由时取默认，会话内可切换，不持久化）
    page: 1,
    // 分组视图的当前页（整组分页）
    collapsed: /* @__PURE__ */ new Set(),
    // 已折叠的课程名（仅分组视图）
    sig: "",
    root: null,
    bar: null,
    // 原生列表模式下筛选条独立插入（不包在 .bps-root 里）
    items: []
  };
  var hooks3 = {};
  function setViewHooks(next) {
    hooks3 = { ...hooks3, ...next };
  }
  function resetForRoute() {
    state.filter = "ALL";
    state.grouped = defaultGroupedFor();
    state.page = 1;
  }
  function pillHtml([label, tone]) {
    const bg = { green: "bg-green-500", blue: "bg-blue-500", orange: "bg-orange-500", grey: "bg-bg-light" }[tone] || "bg-bg-light";
    const color = { green: "pc-color-pass", blue: "pc-color-primary", orange: "pc-color-warning", grey: "pc-color-light" }[tone] || "pc-color-light";
    return `<div class="rounded-xl ${bg} bg-opacity-10 px-3 py-1 inline-block whitespace-nowrap flex-none"><div class="flex items-center space-x-1"><div class="pc-text ${color} pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>${escapeHtml(label)}</span></div></div></div></div>`;
  }
  function buildApiCard(ai) {
    const a = document.createElement("a");
    a.href = `/problem-sets/${ai.id}/overview`;
    a.className = "flex py-3 px-4 items-center space-x-2 rounded-lg bg-bg-base shadow-sm hover:shadow-md transition-shadow hover:no-underline";
    a.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24" style="width:34px;height:34px;color:#adb5bd;flex:none"><rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <div class="flex items-center space-x-2 flex-1"><div class="flex-1 space-y-1">
        <div title="${escapeHtml(ai.title)}" class="text-sm text-normal font-bold ellipsis-m">${escapeHtml(ai.title)}</div>
        <div class="text-xs text-light ellipsis whitespace-nowrap"><div class="flex space-x-2"><div class="flex space-x-2">\u5173\u95ED\u65F6\u95F4:<span>${fmtCloseLocal(ai.closeAt)}</span></div></div></div>
      </div></div>
      <div class="flex-none flex-col items-end space-y-1 flex"><div><div class="flex space-x-2 items-center">${ai.badges.map(pillHtml).join("")}</div></div></div>
      <div class="text-xs text-light flex-none hidden md:flex">${escapeHtml(ai.creator)}</div>`;
    return a;
  }
  function unifiedItems(domItems, settings3, renameMap, aggItems) {
    if (!aggItems) return domItems.map((d) => ({ ...d, fromDom: true }));
    const domById = new Map(domItems.map((i) => [i.id, i.el]));
    return aggItems.map((ai) => {
      const el2 = domById.get(ai.id);
      const det = classifyDetailed(ai.title, settings3);
      return {
        id: ai.id,
        title: ai.title,
        course: det.locked ? det.course : renameMap.get(det.course) || det.course,
        startAt: ai.startAt,
        closeAt: ai.closeAt,
        closeText: fmtCloseLocal(ai.closeAt),
        examId: ai.examId || "",
        // 答题进度的取数钥匙（入口据此挂 it.progress）
        el: el2 || buildApiCard(ai),
        fromDom: !!el2
      };
    });
  }
  function collectGroups(items) {
    const groups = /* @__PURE__ */ new Map();
    for (const it of items) {
      const key = it.course || "\u672A\u5206\u7C7B";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    return groups;
  }
  function buildChipBar(groups) {
    const bar = document.createElement("div");
    bar.className = "bps-chips";
    const now = Date.now();
    const mk = (key, label, list) => {
      const total = list.length;
      const isCourse = key !== "ALL";
      const openCount = isCourse ? list.filter((i) => !i.closeAt || +i.closeAt > now).length : 0;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bps-chip" + (state.filter === key ? " bps-on" : "");
      if (isCourse && openCount === 0) chip.classList.add("bps-off");
      const name = document.createElement("span");
      name.className = "bps-chip-name";
      name.textContent = label;
      const num = document.createElement("span");
      num.className = "bps-chip-num";
      if (isCourse && openCount > 0 && openCount < total) {
        num.classList.add("bps-num-open");
        num.textContent = `${openCount}/${total}`;
      } else {
        if (isCourse && openCount > 0) num.classList.add("bps-num-open");
        num.textContent = String(total);
      }
      if (isCourse) {
        chip.title = openCount > 0 ? `\u8FD8\u6709 ${openCount} \u4E2A\u9898\u76EE\u96C6\u672A\u5173\u95ED\uFF08\u5171 ${total} \u4E2A\uFF09` : "\u8BE5\u8BFE\u7A0B\u7684\u9898\u76EE\u96C6\u5DF2\u5168\u90E8\u5173\u95ED";
      }
      chip.append(name, num);
      chip.addEventListener("click", () => {
        if (state.filter === key) return;
        state.filter = key;
        state.page = 1;
        hooks3.rerender?.();
      });
      return chip;
    };
    bar.appendChild(mk("ALL", "\u5168\u90E8", state.items));
    for (const [course, list] of groups) bar.appendChild(mk(course, course, list));
    if (state.filter === "ALL") {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "bps-chip bps-mode";
      toggle.textContent = state.grouped ? "\u5207\u6362\u4E3A\u5217\u8868" : "\u5207\u6362\u4E3A\u5206\u7EC4";
      toggle.addEventListener("click", () => {
        state.grouped = !state.grouped;
        state.page = 1;
        hooks3.rerender?.();
      });
      bar.appendChild(toggle);
    }
    return bar;
  }
  function buildGroup(course, list) {
    const sec = document.createElement("section");
    sec.className = "bps-group";
    sec.dataset.course = course;
    const times = list.map((i) => i.closeAt?.getTime()).filter(Boolean);
    const earliest = times.length ? new Date(Math.min(...times)) : null;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "bps-head";
    head.innerHTML = `
      <span class="bps-caret${state.collapsed.has(course) ? " bps-folded" : ""}"></span>
      <span class="bps-dot" style="--h:${hashHue(course)}"></span>
      <span class="bps-name"></span>
      <span class="bps-count"></span>
      <span class="bps-space"></span>
      ${earliest ? '<span class="bps-deadline"></span>' : ""}`;
    head.querySelector(".bps-name").textContent = course;
    head.querySelector(".bps-count").textContent = `${list.length} \u4E2A`;
    if (earliest) {
      head.querySelector(".bps-deadline").textContent = `\u6700\u8FD1\u5173\u95ED ${pad(earliest.getMonth() + 1)}-${pad(earliest.getDate())} ${pad(earliest.getHours())}:${pad(earliest.getMinutes())}`;
    }
    const box = document.createElement("div");
    box.className = "bps-items";
    const folded = state.collapsed.has(course);
    if (folded) box.classList.add("bps-hidden");
    const frag = document.createDocumentFragment();
    for (const it of list) {
      const c = it.el.cloneNode(true);
      c.classList.add("bps-clone");
      frag.appendChild(c);
    }
    box.appendChild(frag);
    head.addEventListener("click", () => {
      const next = !state.collapsed.has(course);
      if (next) state.collapsed.add(course);
      else state.collapsed.delete(course);
      head.querySelector(".bps-caret").classList.toggle("bps-folded", next);
      box.classList.toggle("bps-hidden", next);
    });
    sec.append(head, box);
    return sec;
  }
  function packPages(groups) {
    const pages = [];
    let cur = null;
    for (const [course, list] of groups) {
      if (!cur || cur.count + list.length > PAGE_SIZE) {
        cur = { groups: [], count: 0 };
        pages.push(cur);
      }
      cur.groups.push([course, list]);
      cur.count += list.length;
    }
    return pages;
  }
  function buildPager(total, totalPages) {
    const card = document.createElement("div");
    card.className = "bps-pager";
    const summary = document.createElement("div");
    summary.className = "bps-pager-summary";
    summary.textContent = `\u5171 ${total} \u6761\u6570\u636E`;
    const nav = document.createElement("div");
    nav.className = "bps-pager-nav";
    const go = (p) => {
      if (p < 1 || p > totalPages || p === state.page) return;
      state.page = p;
      hooks3.rerender?.();
      const anchor = state.root;
      if (anchor) anchor.scrollIntoView({ block: "start", behavior: "instant" });
    };
    const btn = (label, page, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "bps-pager-btn" + (page === state.page ? " bps-on" : "");
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener("click", () => go(page));
      return b;
    };
    nav.append(btn("\u2039", state.page - 1, state.page <= 1));
    for (let p = 1; p <= totalPages; p++) nav.append(btn(String(p), p, false));
    nav.append(btn("\u203A", state.page + 1, state.page >= totalPages));
    card.append(summary, nav);
    return card;
  }
  function renderContent(listEl, items) {
    const groups = collectGroups(items);
    const bar = buildChipBar(groups);
    const nativeListMode = state.filter === "ALL" && !state.grouped;
    if (nativeListMode) {
      bar.dataset.bpsBar = "1";
      listEl.before(bar);
      state.root = null;
      state.bar = bar;
      return;
    }
    const root = document.createElement("div");
    root.className = "bps-root";
    root.appendChild(bar);
    if (state.grouped && state.filter === "ALL") {
      const pages = packPages(groups);
      if (state.page > pages.length) state.page = pages.length;
      const page = pages[state.page - 1];
      for (const [course, list] of page.groups) root.appendChild(buildGroup(course, list));
      if (pages.length > 1) root.appendChild(buildPager(items.length, pages.length));
    } else {
      const shown = items.filter((i) => (i.course || "\u672A\u5206\u7C7B") === state.filter);
      const box = document.createElement("div");
      box.className = "bps-flat";
      const frag = document.createDocumentFragment();
      for (const it of shown) {
        const c = it.el.cloneNode(true);
        c.classList.add("bps-clone");
        frag.appendChild(c);
      }
      box.appendChild(frag);
      root.appendChild(box);
    }
    listEl.before(root);
    listEl.style.display = "none";
    setPagingHidden(true);
    state.root = root;
    state.bar = null;
  }
  function setPagingHidden(hide) {
    for (const w of document.querySelectorAll('main [class*="paginationWrapper"], main [class*="paginationSummary"]')) {
      const card = w.closest("div.bg-bg-base") || w;
      const want = hide ? "none" : "";
      if (card.style.display !== want) card.style.display = want;
    }
  }
  function removeRoot() {
    document.querySelectorAll(".bps-root").forEach((n) => n.remove());
    document.querySelectorAll("[data-bps-bar]").forEach((n) => n.remove());
    document.querySelectorAll("main .pc-list").forEach((n) => {
      if (n.style.display) n.style.display = "";
    });
    setPagingHidden(false);
    state.root = null;
    state.bar = null;
  }
  function teardown() {
    removeRoot();
    document.querySelectorAll(".bps-badge, .bps-countdown, .bps-done, .bps-answered").forEach((n) => n.remove());
    document.querySelectorAll("[data-bps-swap-open]").forEach((n) => {
      delete n.dataset.bpsSwapOpen;
      n.style.display = "";
    });
    state.sig = "";
    state.items = [];
  }
  function refreshCountdowns(settings3) {
    for (const it of state.items) updateCountdown(it.el, it, settings3);
    for (const c of document.querySelectorAll(".bps-countdown")) {
      const a = c.closest("a[href]");
      const id = a && (a.getAttribute("href").match(SET_HREF_RE) || [])[1];
      const it = state.items.find((i) => i.id === id);
      if (it) updateCountdown(a, it, settings3);
    }
  }

  // src/content/index.js
  var settings2 = { ...DEFAULTS };
  setAggregateHooks({
    onPathChange: () => resetForRoute(),
    onSuccess: () => pushAggregatedReminders(settings2),
    onSettled: () => sync2(true)
  });
  setViewHooks({ rerender: () => sync2(true) });
  setProgressHooks({ onUpdate: () => scheduleSync() });
  function sync2(force = false) {
    try {
      if (!settings2.enabled || !window.__BPS_FORCE_LIST__ && !LIST_PATH_RE.test(location.pathname)) {
        if (state.sig) teardown();
        return;
      }
      const domItems = extractItems(settings2);
      if (!domItems.length) {
        if (state.root) removeRoot();
        return;
      }
      let listEl = document.querySelector("main .pc-list");
      if (!listEl) {
        const parent = domItems[0].el.parentElement;
        listEl = domItems.every((i) => i.el.parentElement === parent) ? parent : null;
      }
      if (!listEl) {
        if (state.root) removeRoot();
        return;
      }
      const aggItems = ensureAggregate();
      const renameMap = settings2.mergeSimilar && aggItems ? buildCourseRenameMap(aggItems.map((ai) => ({ title: ai.title, teacher: ai.creator })), settings2) : /* @__PURE__ */ new Map();
      const renamed = domItems.map((d) => ({
        ...d,
        course: d.locked ? d.course : renameMap.get(d.course) || d.course
      }));
      if (settings2.progress) ensureProgress(aggItems || []);
      const attachProgress = (list) => list.forEach((it) => {
        it.progress = progressOf2(it.id);
      });
      attachProgress(renamed);
      renamed.forEach((it) => decorate(it, settings2));
      const uni = unifiedItems(renamed, settings2, renameMap, aggItems);
      state.items = uni;
      attachProgress(uni);
      uni.forEach((it) => decorate(it, settings2));
      const domSig = domItems.map((i) => i.id).join(",");
      const sig = `${state.grouped}#${state.filter}#${state.page}#${domSig}#${uni.map((i) => `${i.id}|${i.course}|${i.closeText}|${i.progress ? `${i.progress.answered}/${i.progress.total}` : "-"}`).join(";")}`;
      const nativeListMode = state.filter === "ALL" && !state.grouped;
      const hiddenOk = nativeListMode ? listEl.style.display !== "none" : listEl.style.display === "none";
      const anchor = state.root || state.bar;
      if (!force && anchor && state.sig === sig && hiddenOk && document.contains(anchor)) {
        refreshCountdowns(settings2);
        setPagingHidden(!nativeListMode);
        return;
      }
      state.sig = sig;
      removeRoot();
      renderContent(listEl, uni);
    } catch (err) {
      console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] sync \u5931\u8D25:", err);
    }
  }
  var syncTimer = 0;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync2(), 200);
  }
  async function init2() {
    settings2 = await loadSettings({ persistMigration: true });
    onSettingsChanged((s) => {
      settings2 = s;
      sync2(true);
      syncRemindersDirect(settings2);
      sync(s);
    });
    try {
      performance.setResourceTimingBufferSize(1e3);
    } catch (_) {
    }
    armOnce();
    sync(settings2);
    void resumeRelay(settings2).catch(() => {
    });
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const relevant = [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && !n.closest?.(".bps-root") && !n.closest?.(".bps-clone") && !n.closest?.(".bps-aa"));
        if (relevant) {
          scheduleSync();
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (e) => {
      if (!settings2.enabled || !settings2.openInNewTab) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target?.closest?.("a[href]");
      if (!a || !SET_HREF_RE.test(a.getAttribute("href") || "")) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener");
    }, true);
    setInterval(() => sync2(), 3e3);
    setInterval(() => {
      if (state.root) refreshCountdowns(settings2);
      sync(settings2);
    }, 3e3);
    armDirectCooldown();
    setTimeout(() => syncRemindersDirect(settings2), 2e3);
    sync2(true);
  }
  window.BPS = {
    init: init2,
    sync: sync2,
    teardown,
    DEFAULTS,
    // 自动答题调试与回归入口：run 走完整流程（配合 __BPS_LLM_MOCK__ 可 mock LLM），
    // collect 收集客观题、programming 收集编程题（一页一题形态，验证提取纯度用）；
    // resumeRelay 手动触发编程题跨文档续跑的恢复（真机回归用）
    autoAnswer: {
      run: (config = {}) => handleRun(config),
      collect: () => collectPage(),
      types: () => sidebarTypes(),
      programming: () => collectProgramming()
    },
    resumeRelay: () => resumeRelay(settings2),
    // 手动触发提醒订阅同步（真机上配置变更走 storage.onChanged 自动触发；预览页/回归用这个）
    syncReminders: () => syncRemindersDirect(settings2),
    setSettings: async (patch) => {
      settings2 = { ...settings2, ...patch };
      await saveSettings(settings2);
      sync2(true);
    },
    // 会话内视图模式（等同于点筛选条上的「切换为分组/列表」），预览页与自动化测试用
    setView: (patch) => {
      Object.assign(state, patch);
      state.page = 1;
      sync2(true);
    }
  };
  function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        init2();
      });
    } else {
      init2();
    }
  }
  if (!window.__BPS_LOADED__) {
    window.__BPS_LOADED__ = true;
    boot();
  }
})();
