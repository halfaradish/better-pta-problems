/* 更好的题目集 · 设置弹窗（构建产物，请勿直接编辑；源码见 src/popup/） */
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
  function saveSettings(next) {
    return storage.set(next);
  }
  function unwrapExport(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
      return raw.settings;
    }
    return raw;
  }
  function sanitizeSettings(raw) {
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const next = {};
    for (const [k, dv] of Object.entries(DEFAULTS)) {
      const v = src[k];
      if (typeof dv === "boolean") next[k] = typeof v === "boolean" ? v : dv;
      else if (typeof dv === "string") next[k] = typeof v === "string" ? v : dv;
      else if (typeof dv === "number") next[k] = typeof v === "number" && Number.isFinite(v) ? v : dv;
      else if (k === "autoAnswerApiKeys") {
        const map = v && typeof v === "object" && !Array.isArray(v) ? v : {};
        next[k] = {};
        for (const [gk, gv] of Object.entries(map)) if (typeof gv === "string") next[k][gk] = gv;
      } else next[k] = v && typeof v === "object" && !Array.isArray(v) ? v : dv;
    }
    next.settingsVersion = SETTINGS_VERSION;
    return next;
  }

  // src/popup/index.js
  var $ = (id) => document.getElementById(id);
  var stored = { ...DEFAULTS };
  var hasChrome = HAS_CHROME_STORAGE;
  var PAGE_TITLES = {
    reminders: "\u9898\u76EE\u5173\u95ED\u5012\u8BA1\u65F6\u63D0\u9192",
    rules: "\u8BFE\u7A0B\u8BC6\u522B\u4E0E\u9AD8\u7EA7\u89C4\u5219",
    backup: "\u914D\u7F6E\u5BFC\u5165\u5BFC\u51FA"
  };
  var pageEls = {
    main: $("page-main"),
    reminders: $("page-reminders"),
    rules: $("page-rules"),
    backup: $("page-backup")
  };
  var pagesBox = $("pages");
  var currentPage = "main";
  var entryFocus = null;
  function syncPageHeight() {
    const el = pageEls[currentPage];
    if (el) pagesBox.style.height = el.offsetHeight + "px";
  }
  function showPage(name, { focusBack = true } = {}) {
    const next = pageEls[name] ? name : "main";
    if (next === currentPage) return;
    currentPage = next;
    const isMain = next === "main";
    $("headMain").hidden = !isMain;
    $("headPage").hidden = isMain;
    if (!isMain) $("pageTitle").textContent = PAGE_TITLES[next];
    for (const [k, el] of Object.entries(pageEls)) el.classList.toggle("is-active", k === next);
    syncPageHeight();
    if (isMain) {
      if (entryFocus && document.contains(entryFocus)) entryFocus.focus({ preventScroll: true });
    } else if (focusBack) {
      $("pageBack").focus({ preventScroll: true });
    }
  }
  for (const el of document.querySelectorAll(".entry")) {
    el.addEventListener("click", () => {
      entryFocus = el;
      showPage(el.dataset.goto);
    });
  }
  $("pageBack").addEventListener("click", () => showPage("main"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && currentPage !== "main") {
      e.preventDefault();
      showPage("main");
    }
  });
  for (const el of Object.values(pageEls)) {
    new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === pageEls[currentPage])) syncPageHeight();
    }).observe(el);
  }
  window.addEventListener("resize", syncPageHeight);
  pagesBox.classList.add("js-ready");
  syncPageHeight();
  var notifyDenied = false;
  function renderRemindersSummary() {
    const el = $("remindersSummary");
    if (notifyDenied && $("reminderBrowser").checked) {
      el.textContent = "\u7CFB\u7EDF\u901A\u77E5\u5DF2\u5173";
      el.classList.add("warn");
      return;
    }
    el.classList.remove("warn");
    const on = [];
    if ($("reminderBrowser").checked) on.push("\u6D4F\u89C8\u5668\u63D0\u9192");
    if ($("reminderEmailEnabled").checked && $("reminderServer").value.trim() && $("reminderEmail").value.trim()) on.push("\u90AE\u4EF6\u63D0\u9192");
    el.textContent = on.length ? on.join(" \xB7 ") : "\u4E24\u4E2A\u901A\u9053\u90FD\u5DF2\u5173\u95ED";
  }
  function renderRulesSummary() {
    const n = $("rules").value.split("\n").filter((line) => line.trim()).length;
    $("rulesSummary").textContent = n ? `${n} \u6761\u81EA\u5B9A\u4E49\u89C4\u5219` : "\u81EA\u52A8\u8BC6\u522B";
  }
  function renderEntrySummaries() {
    renderRemindersSummary();
    renderRulesSummary();
  }
  async function load() {
    stored = await loadSettings();
    for (const k of ["enabled", "badge", "countdown", "mergeSimilar", "openInNewTab", "progress"]) $(k).checked = !!stored[k];
    $("separators").value = stored.separators;
    $("rules").value = stored.rules || "";
    $("reminderBrowser").checked = stored.reminderBrowser !== false;
    $("reminderEmailEnabled").checked = stored.reminderEmailEnabled !== false;
    $("reminderSkipDone").checked = stored.reminderSkipDone !== false;
    $("reminderServer").value = stored.reminderServer || "";
    $("reminderEmail").value = stored.reminderEmail || "";
    applyReminderSwitches();
    resumeTestCooldown();
    checkNotifyPermission();
    renderEntrySummaries();
    $("autoAnswer").checked = !!stored.autoAnswer;
  }
  function collect() {
    return {
      enabled: $("enabled").checked,
      badge: $("badge").checked,
      countdown: $("countdown").checked,
      mergeSimilar: $("mergeSimilar").checked,
      openInNewTab: $("openInNewTab").checked,
      progress: $("progress").checked,
      separators: $("separators").value.trim() || DEFAULTS.separators,
      rules: $("rules").value.trim(),
      reminderBrowser: $("reminderBrowser").checked,
      reminderEmailEnabled: $("reminderEmailEnabled").checked,
      reminderSkipDone: $("reminderSkipDone").checked,
      reminderServer: $("reminderServer").value.trim(),
      reminderEmail: $("reminderEmail").value.trim(),
      autoAnswer: $("autoAnswer").checked
    };
  }
  async function save() {
    if (!hasChrome) return;
    const fresh = await loadSettings();
    await saveSettings({ ...fresh, ...collect(), settingsVersion: Math.max(fresh.settingsVersion || 0, SETTINGS_VERSION) });
  }
  var TEST_COOLDOWN_MS = 60 * 1e3;
  var testCooldownUntil = 0;
  var countdownTimer = null;
  var testBusy = false;
  var notifyBusy = false;
  function applyReminderSwitches() {
    const emailOn = $("reminderEmailEnabled").checked;
    const anyOn = emailOn || $("reminderBrowser").checked;
    $("reminderSkipDone").disabled = !anyOn;
    $("reminderServer").disabled = !emailOn;
    $("reminderEmail").disabled = !emailOn;
    $("testReminder").disabled = !emailOn || Date.now() < testCooldownUntil;
    $("testNotify").disabled = !$("reminderBrowser").checked;
  }
  function readTestSentAt() {
    try {
      return chrome.storage?.session?.get({ testSentAt: 0 }).then((v) => v.testSentAt || 0).catch(() => 0);
    } catch (_) {
      return Promise.resolve(0);
    }
  }
  function startTestCooldown(seconds) {
    testCooldownUntil = Date.now() + seconds * 1e3;
    clearInterval(countdownTimer);
    $("testReminder").textContent = `\u51B7\u5374\u4E2D\uFF08${seconds}s\uFF09`;
    countdownTimer = setInterval(() => {
      const left = Math.ceil((testCooldownUntil - Date.now()) / 1e3);
      if (left <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        testCooldownUntil = 0;
        $("testReminder").textContent = "\u6D4B\u8BD5\u90AE\u4EF6";
        applyReminderSwitches();
      } else {
        $("testReminder").textContent = `\u51B7\u5374\u4E2D\uFF08${left}s\uFF09`;
      }
    }, 1e3);
    applyReminderSwitches();
  }
  async function resumeTestCooldown() {
    const sentAt = await readTestSentAt();
    const left = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1e3);
    if (left > 0) startTestCooldown(left);
  }
  async function checkNotifyPermission() {
    const state = $("notifyState");
    notifyDenied = false;
    try {
      notifyDenied = await chrome.notifications.getPermissionLevel() === "denied";
    } catch (_) {
    }
    if (notifyDenied) {
      state.textContent = "\u7CFB\u7EDF\u901A\u77E5\u5DF2\u5173";
      state.classList.add("warn");
      state.title = "\u7CFB\u7EDF\u672A\u5141\u8BB8\u6D4F\u89C8\u5668\u53D1\u9001\u901A\u77E5\uFF08\u7CFB\u7EDF\u8BBE\u7F6E\u6216\u4E13\u6CE8\u52A9\u624B\uFF09\uFF0C\u901A\u77E5\u4E0D\u4F1A\u5F39\u51FA";
    } else {
      state.textContent = "\u96F6\u914D\u7F6E \xB7 \u672C\u673A\u5F39\u7A97";
      state.classList.remove("warn");
      state.title = "\u96F6\u914D\u7F6E\uFF1A\u6570\u636E\u53EA\u7559\u5728\u672C\u673A\uFF0C\u6D4F\u89C8\u5668\u5728\u8FD0\u884C\u5C31\u80FD\u5F39\u51FA";
    }
    renderRemindersSummary();
  }
  var setStatus = (el, text, cls) => {
    el.textContent = text;
    el.className = "status" + (cls ? " " + cls : "");
  };
  var showNotifyStatus = (text, cls) => setStatus($("notifyStatus"), text, cls);
  var showReminderStatus = (text, cls) => setStatus($("reminderStatus"), text, cls);
  function sendToBackground(msg, ms = 12e3) {
    return Promise.race([
      chrome.runtime.sendMessage(msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error("\u540E\u53F0\u6CA1\u6709\u54CD\u5E94\uFF0C\u8BF7\u91CD\u8BD5")), ms))
    ]);
  }
  $("testNotify").addEventListener("click", async () => {
    if (notifyBusy || $("testNotify").disabled) return;
    notifyBusy = true;
    try {
      showNotifyStatus("\u53D1\u9001\u4E2D\u2026");
      const res = await sendToBackground({ type: "BPS_NOTIFY_TEST" });
      if (res?.ok) {
        showNotifyStatus("\u5DF2\u53D1\u9001\uFF1B\u6CA1\u5F39\u6A2A\u5E45\u5C31\u53BB\u7CFB\u7EDF\u901A\u77E5\u4E2D\u5FC3\u627E", "ok");
        checkNotifyPermission();
      } else {
        showNotifyStatus("\u5931\u8D25\uFF1A" + (res?.error || "\u672A\u77E5\u9519\u8BEF"), "err");
      }
    } catch (err) {
      showNotifyStatus("\u5931\u8D25\uFF1A" + (err?.message || err), "err");
    } finally {
      notifyBusy = false;
    }
  });
  for (const k of ["enabled", "badge", "countdown", "mergeSimilar", "openInNewTab", "progress", "autoAnswer"]) $(k).addEventListener("change", save);
  $("separators").addEventListener("input", save);
  $("rules").addEventListener("input", () => {
    save();
    renderRulesSummary();
  });
  $("reminderServer").addEventListener("input", () => {
    save();
    renderRemindersSummary();
  });
  $("reminderEmail").addEventListener("input", () => {
    save();
    renderRemindersSummary();
  });
  $("reminderBrowser").addEventListener("change", () => {
    save();
    applyReminderSwitches();
    renderRemindersSummary();
  });
  $("reminderEmailEnabled").addEventListener("change", () => {
    save();
    applyReminderSwitches();
    renderRemindersSummary();
  });
  $("reminderSkipDone").addEventListener("change", save);
  $("testReminder").addEventListener("click", async () => {
    if (testBusy || $("testReminder").disabled) return;
    testBusy = true;
    try {
      const server = $("reminderServer").value.trim();
      const email = $("reminderEmail").value.trim();
      if (!server) return showReminderStatus("\u8BF7\u5148\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "err");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showReminderStatus("\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E", "err");
      const sentAt = await readTestSentAt();
      const waitLeft = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1e3);
      if (waitLeft > 0) return showReminderStatus(`\u8BF7 ${waitLeft} \u79D2\u540E\u518D\u8BD5`, "err");
      save();
      showReminderStatus("\u53D1\u9001\u4E2D\u2026");
      try {
        await chrome.storage.session.set({ testSentAt: Date.now() });
      } catch (_) {
      }
      startTestCooldown(TEST_COOLDOWN_MS / 1e3);
      const res = await sendToBackground({ type: "BPS_TEST", server, email });
      if (res?.ok) showReminderStatus("\u5DF2\u53D1\u9001\uFF0C\u8BF7\u67E5\u6536", "ok");
      else showReminderStatus("\u5931\u8D25\uFF1A" + (res?.error || "\u672A\u77E5\u9519\u8BEF"), "err");
    } catch (err) {
      showReminderStatus("\u5931\u8D25\uFF1A" + (err?.message || err), "err");
    } finally {
      testBusy = false;
    }
  });
  $("reset").addEventListener("click", async () => {
    if (!confirm("\u6062\u590D\u9ED8\u8BA4\u5C06\u628A\u5168\u90E8\u8BBE\u7F6E\u91CD\u7F6E\u4E3A\u521D\u59CB\u503C\uFF08\u542B\u5404\u670D\u52A1 API Key\uFF09\uFF0C\u786E\u5B9A\uFF1F")) return;
    if (hasChrome) await saveSettings({ ...DEFAULTS });
    load();
  });
  var backupStatus = $("backupStatus");
  var showBackup = (text, cls) => {
    backupStatus.textContent = text;
    backupStatus.className = "status" + (cls ? " " + cls : "");
  };
  $("exportSettings").addEventListener("click", async () => {
    if (!hasChrome) return showBackup("\u65E0\u6269\u5C55\u73AF\u5883\u4E0D\u53EF\u5BFC\u51FA", "err");
    try {
      const settings = await loadSettings();
      const d = /* @__PURE__ */ new Date();
      const p = (n) => String(n).padStart(2, "0");
      const payload = {
        app: "better-pta-problems",
        settingsVersion: SETTINGS_VERSION,
        exportedAt: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
        settings
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `better-pta-settings-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showBackup("\u5DF2\u5BFC\u51FA\uFF08\u542B API Key\uFF0C\u8BF7\u59A5\u5584\u4FDD\u7BA1\uFF09", "ok");
    } catch (err) {
      showBackup("\u5BFC\u51FA\u5931\u8D25\uFF1A" + (err?.message || err), "err");
    }
  });
  $("importSettings").addEventListener("click", () => {
    if (!hasChrome) return showBackup("\u65E0\u6269\u5C55\u73AF\u5883\u4E0D\u53EF\u5BFC\u5165", "err");
    $("importFile").click();
  });
  $("importFile").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!confirm("\u5BFC\u5165\u5C06\u8986\u76D6\u5F53\u524D\u5168\u90E8\u8BBE\u7F6E\uFF08\u542B\u5404\u670D\u52A1 API Key\uFF09\uFF0C\u786E\u5B9A\uFF1F")) return;
    try {
      const parsed = JSON.parse(await file.text());
      const next = sanitizeSettings(migrate(unwrapExport(parsed)));
      await saveSettings(next);
      await load();
      showBackup("\u5DF2\u5BFC\u5165\u5E76\u751F\u6548", "ok");
    } catch (err) {
      showBackup("\u5BFC\u5165\u5931\u8D25\uFF1A" + (err?.message || "\u6587\u4EF6\u4E0D\u662F\u6709\u6548\u7684\u914D\u7F6E"), "err");
    }
  });
  try {
    $("version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {
  }
  load();
})();
