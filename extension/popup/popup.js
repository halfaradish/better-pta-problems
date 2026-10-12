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
    // 考试型题目集的答题进度（只对未关闭的拉取，见 content/progress.js）
    reminderEnabled: true,
    // 题目关闭邮件提醒总开关（与下面两项配置配合；关闭即暂停同步）
    reminderServer: "",
    // 邮件提醒后端地址（ip:port，可加 /令牌 后缀）；空 = 关闭
    reminderEmail: "",
    // 提醒邮件接收邮箱
    // 自动答题（实验）：OpenAI 兼容接口三项 + 覆盖重答开关，见 docs/自动答题初探.md §9
    autoAnswerBaseUrl: "",
    // 例如 https://api.deepseek.com（端点需允许浏览器跨域）；空 = 未配置
    autoAnswerApiKey: "",
    autoAnswerModel: "",
    autoAnswerOverwrite: false,
    // 覆盖已作答的题目（默认跳过已答，避免把用户的正确答案改错）
    settingsVersion: 0
    // 0 = 旧版设置；v4 起「列表/分组」不再持久化（改为按路由的会话内状态）
  };
  var SETTINGS_VERSION = 5;
  var HAS_CHROME_STORAGE = typeof chrome !== "undefined" && !!chrome.storage?.sync;
  function needsMigration(raw) {
    return (raw?.settingsVersion || 0) < SETTINGS_VERSION;
  }
  function migrate(raw) {
    const s = { ...DEFAULTS, ...raw || {} };
    if (needsMigration(s)) {
      delete s.grouped;
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

  // src/popup/index.js
  var $ = (id) => document.getElementById(id);
  var stored = { ...DEFAULTS };
  var hasChrome = HAS_CHROME_STORAGE;
  async function load() {
    stored = await loadSettings();
    for (const k of ["enabled", "badge", "countdown", "mergeSimilar", "openInNewTab", "progress"]) $(k).checked = !!stored[k];
    $("separators").value = stored.separators;
    $("rules").value = stored.rules || "";
    $("reminderEnabled").checked = stored.reminderEnabled !== false;
    $("reminderServer").value = stored.reminderServer || "";
    $("reminderEmail").value = stored.reminderEmail || "";
    applyReminderEnabled();
    resumeTestCooldown();
    $("autoAnswerBaseUrl").value = stored.autoAnswerBaseUrl || "";
    $("autoAnswerApiKey").value = stored.autoAnswerApiKey || "";
    $("autoAnswerModel").value = stored.autoAnswerModel || "";
    $("autoAnswerOverwrite").checked = !!stored.autoAnswerOverwrite;
    if (!hasChrome) {
      $("autoAnswerStart").disabled = true;
      $("autoAnswerStart").title = "\u9700\u5728\u6269\u5C55\u73AF\u5883\u4F7F\u7528";
    }
  }
  function collect() {
    return {
      ...stored,
      settingsVersion: Math.max(stored.settingsVersion || 0, SETTINGS_VERSION),
      enabled: $("enabled").checked,
      badge: $("badge").checked,
      countdown: $("countdown").checked,
      mergeSimilar: $("mergeSimilar").checked,
      openInNewTab: $("openInNewTab").checked,
      progress: $("progress").checked,
      separators: $("separators").value.trim() || DEFAULTS.separators,
      rules: $("rules").value.trim(),
      reminderEnabled: $("reminderEnabled").checked,
      reminderServer: $("reminderServer").value.trim(),
      reminderEmail: $("reminderEmail").value.trim(),
      autoAnswerBaseUrl: $("autoAnswerBaseUrl").value.trim(),
      autoAnswerApiKey: $("autoAnswerApiKey").value.trim(),
      autoAnswerModel: $("autoAnswerModel").value.trim(),
      autoAnswerOverwrite: $("autoAnswerOverwrite").checked
    };
  }
  function save() {
    if (hasChrome) saveSettings(collect());
  }
  var TEST_COOLDOWN_MS = 60 * 1e3;
  var testCooldownUntil = 0;
  var countdownTimer = null;
  var testBusy = false;
  function applyReminderEnabled() {
    const on = $("reminderEnabled").checked;
    $("reminderServer").disabled = !on;
    $("reminderEmail").disabled = !on;
    $("testReminder").disabled = !on || Date.now() < testCooldownUntil;
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
        $("testReminder").textContent = "\u53D1\u9001\u6D4B\u8BD5\u90AE\u4EF6";
        applyReminderEnabled();
      } else {
        $("testReminder").textContent = `\u51B7\u5374\u4E2D\uFF08${left}s\uFF09`;
      }
    }, 1e3);
    applyReminderEnabled();
  }
  async function resumeTestCooldown() {
    const sentAt = await readTestSentAt();
    const left = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1e3);
    if (left > 0) startTestCooldown(left);
  }
  for (const k of ["enabled", "badge", "countdown", "mergeSimilar", "openInNewTab", "progress", "autoAnswerOverwrite"]) $(k).addEventListener("change", save);
  $("separators").addEventListener("input", save);
  $("rules").addEventListener("input", save);
  $("reminderServer").addEventListener("input", save);
  $("reminderEmail").addEventListener("input", save);
  $("reminderEnabled").addEventListener("change", () => {
    save();
    applyReminderEnabled();
  });
  $("autoAnswerBaseUrl").addEventListener("input", save);
  $("autoAnswerApiKey").addEventListener("input", save);
  $("autoAnswerModel").addEventListener("input", save);
  $("testReminder").addEventListener("click", async () => {
    if (testBusy || $("testReminder").disabled) return;
    testBusy = true;
    try {
      const status = $("reminderStatus");
      const show = (text, cls) => {
        status.textContent = text;
        status.className = "status" + (cls ? " " + cls : "");
      };
      const server = $("reminderServer").value.trim();
      const email = $("reminderEmail").value.trim();
      if (!server) return show("\u8BF7\u5148\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "err");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show("\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E", "err");
      const sentAt = await readTestSentAt();
      const waitLeft = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1e3);
      if (waitLeft > 0) return show(`\u8BF7 ${waitLeft} \u79D2\u540E\u518D\u8BD5`, "err");
      save();
      show("\u53D1\u9001\u4E2D\u2026");
      try {
        await chrome.storage.session.set({ testSentAt: Date.now() });
      } catch (_) {
      }
      startTestCooldown(TEST_COOLDOWN_MS / 1e3);
      const res = await chrome.runtime.sendMessage({ type: "BPS_TEST", server, email });
      if (res?.ok) show("\u5DF2\u53D1\u9001\uFF0C\u8BF7\u67E5\u6536", "ok");
      else show("\u5931\u8D25\uFF1A" + (res?.error || "\u672A\u77E5\u9519\u8BEF"), "err");
    } catch (err) {
      $("reminderStatus").textContent = "\u5931\u8D25\uFF1A" + (err?.message || err);
      $("reminderStatus").className = "status err";
    } finally {
      testBusy = false;
    }
  });
  $("reset").addEventListener("click", async () => {
    if (hasChrome) await saveSettings({ ...DEFAULTS });
    load();
  });
  var aa = {
    status: $("autoAnswerStatus"),
    button: $("autoAnswerStart"),
    show(text, cls) {
      this.status.textContent = text;
      this.status.className = "status status-pre" + (cls ? " " + cls : "");
    }
  };
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== "BPS_AUTOANSWER_EVENT") return;
      if (msg.event === "typedone") {
        const parts = [`\u6210\u529F ${msg.applied}`];
        if (msg.skippedAnswered) parts.push(`\u8DF3\u8FC7\u5DF2\u7B54 ${msg.skippedAnswered}`);
        if (msg.skippedImage) parts.push(`\u8DF3\u8FC7\u542B\u56FE ${msg.skippedImage}`);
        if (msg.failed) parts.push(`\u5931\u8D25 ${msg.failed}`);
        parts.push(msg.saved ? "\u5DF2\u4FDD\u5B58" : "\u672A\u4FDD\u5B58");
        aa.show(`\u300C${msg.typeName}\u300D\u5B8C\u6210\uFF1A${parts.join("\uFF0C")}`);
      } else if (msg.event === "progress") {
        aa.show(`\u6B63\u5728\u7B54\u9898\uFF08${msg.typeName}\uFF09\uFF1A${msg.done}/${msg.total}\u2026`);
      } else if (msg.event === "done") {
        if (msg.error) {
          aa.show("\u5DF2\u4E2D\u6B62\uFF1A" + msg.error, "err");
        } else {
          const fails = (msg.summary.failed || []).map((f) => f.reason).filter(Boolean);
          const lines = [`\u5B8C\u6210\uFF1A\u6210\u529F ${msg.summary.applied}\uFF0C\u5931\u8D25 ${msg.summary.failed.length}${msg.summary.skippedAnswered ? `\uFF0C\u8DF3\u8FC7\u5DF2\u7B54 ${msg.summary.skippedAnswered}` : ""}${msg.summary.skippedImage ? `\uFF0C\u8DF3\u8FC7\u542B\u56FE ${msg.summary.skippedImage}` : ""}`];
          if (msg.summary.saveFails?.length) lines.push("\u4FDD\u5B58\u5931\u8D25\uFF1A" + msg.summary.saveFails.join("\uFF1B"));
          if (fails.length) lines.push("\u5931\u8D25\u539F\u56E0\uFF1A" + fails.join("\uFF1B"));
          aa.show(lines.join("\n"), msg.summary.failed.length || msg.summary.saveFails.length ? "err" : "ok");
        }
      }
    });
  }
  aa.button.addEventListener("click", async () => {
    if (aa.button.disabled) return;
    const show = (t, c) => aa.show(t, c);
    const cfg = {
      baseUrl: $("autoAnswerBaseUrl").value.trim(),
      apiKey: $("autoAnswerApiKey").value.trim(),
      model: $("autoAnswerModel").value.trim(),
      overwrite: $("autoAnswerOverwrite").checked
    };
    if (!cfg.baseUrl.startsWith("http")) return show("\u670D\u52A1\u5668\u5730\u5740\u9700\u4EE5 http(s):// \u5F00\u5934", "err");
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return show("\u8BF7\u5148\u586B\u5199\u670D\u52A1\u5668\u5730\u5740\u3001API Key \u4E0E\u6A21\u578B\u540D", "err");
    save();
    show("\u6B63\u5728\u8FDE\u63A5\u9898\u76EE\u9875\u2026");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https:\/\/(www\.)?pintia\.cn\/problem-sets\/\d+\/exam\/problems\/type\//.test(tab.url || "")) {
        return show("\u8BF7\u5148\u5728\u9898\u76EE\u5217\u8868\u7684\u67D0\u4E2A\u9898\u578B\u9875\uFF08\u5224\u65AD/\u5355\u9009/\u586B\u7A7A\uFF09\u4F7F\u7528", "err");
      }
      const res = await chrome.tabs.sendMessage(tab.id, { type: "BPS_AUTOANSWER_RUN", config: cfg });
      if (res?.ok) show("\u5DF2\u5F00\u59CB\u3002\u4F5C\u7B54\u9010\u9898\u5199\u5728\u9898\u76EE\u9875\u8868\u5355\u4E0A\uFF0C\u53EF\u5173\u95ED\u6B64\u5F39\u7A97\uFF0C\u5B8C\u6210\u540E\u56DE\u5230\u6B64\u5F39\u7A97\u770B\u7ED3\u679C");
      else show("\u65E0\u6CD5\u5F00\u59CB\uFF1A" + (res?.error || "\u672A\u77E5\u9519\u8BEF"), "err");
    } catch (err) {
      const msg = err?.message || String(err);
      show(msg.includes("Could not establish connection") || msg.includes("message port closed") ? "\u9898\u76EE\u9875\u672A\u5C31\u7EEA\uFF1A\u5237\u65B0 PTA \u9875\u9762\u540E\u91CD\u8BD5" : "\u5931\u8D25\uFF1A" + msg, "err");
    }
  });
  try {
    $("version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {
  }
  load();
})();
