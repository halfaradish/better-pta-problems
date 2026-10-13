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
    // 自动答题（实验）：入口为题目页的悬浮球面板（弹窗只留总开关），见 docs/自动答题初探.md §9
    autoAnswer: false,
    // 题目列表页显示悬浮答题球（实验功能，默认关）
    autoAnswerApiKey: "",
    // 模型服务 API Key（DeepSeek / OpenCode Go），仅存本机扩展存储，答题时页面上下文直连
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
      reminderEnabled: $("reminderEnabled").checked,
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
  for (const k of ["enabled", "badge", "countdown", "mergeSimilar", "openInNewTab", "progress", "autoAnswer"]) $(k).addEventListener("change", save);
  $("separators").addEventListener("input", save);
  $("rules").addEventListener("input", save);
  $("reminderServer").addEventListener("input", save);
  $("reminderEmail").addEventListener("input", save);
  $("reminderEnabled").addEventListener("change", () => {
    save();
    applyReminderEnabled();
  });
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
  try {
    $("version").textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {
  }
  load();
})();
