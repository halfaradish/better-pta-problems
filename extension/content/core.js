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
    return form?.querySelector(".select__single-value")?.textContent?.replace(/\s+/g, " ").trim() || "";
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
  async function chatOnce(cfg, messages) {
    const base = normalizeBaseUrl(cfg.baseUrl);
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + String(cfg.apiKey || "").trim()
    };
    if (cfg.gateway === "opencode") {
      headers["x-opencode-session"] = sessionHeader();
      headers["User-Agent"] = "better-pta-problems/0.9";
    }
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, temperature: 0, messages })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("LLM HTTP " + res.status + (t ? "\uFF1A" + t.slice(0, 140) : ""));
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("LLM \u54CD\u5E94\u4E3A\u7A7A");
    return text;
  }
  function toDataUrlPage(src) {
    return fetch(src, { credentials: "include" }).then((res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.blob();
    }).then((blob) => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("FileReader \u8BFB\u53D6\u5931\u8D25"));
      r.readAsDataURL(blob);
    }));
  }
  var hasBgFetch = typeof chrome !== "undefined" && !!chrome.runtime?.sendMessage;
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
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = globalThis.__BPS_LLM_MOCK__ ? await globalThis.__BPS_LLM_MOCK__(messages) : await chatOnce(cfg, messages);
        break;
      } catch (err) {
        if (attempt === 2) return { ok: false, reason: "LLM \u8C03\u7528\u5931\u8D25\uFF1A" + (err?.message || err) };
        await sleep(900);
      }
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
      summary: { applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [] }
    };
    if (!writeRelay(relay)) throw new Error("sessionStorage \u4E0D\u53EF\u5199\uFF0C\u65E0\u6CD5\u8DE8\u9875\u7EED\u8DD1\u7F16\u7A0B\u9898");
    const first = problems[0];
    fire({ kind: "log", level: "info", text: `\u7F16\u7A0B\u9898 ${problems.length} \u9898\uFF1A\u8F6C\u300C\u9010\u9898\u6574\u9875\u88C5\u8F7D\u300D\u6A21\u5F0F\uFF0C\u65E5\u5FD7\u968F\u5404\u9875\u51FA\u73B0` });
    pageScript("if (!window.__BPS_CONFIRM__) { window.__BPS_CONFIRM__ = window.confirm; window.confirm = function(){ return true; }; }");
    try {
      location.href = `/problem-sets/${psId}/exam/problems/type/${first.typeId}?problemSetProblemId=${first.id}`;
    } catch (_) {
    }
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
    const prob = r.problems[r.pi];
    if (!prob) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u53D6\u6D88\uFF1A\u7EED\u8DD1\u5355\u5DF2\u8D8A\u754C" });
      return;
    }
    if (!new RegExp(`problemSetProblemId=${prob.id}$`).test(location.search)) {
      clearRelay();
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u53D6\u6D88\uFF1A\u9875\u9762\u4E0D\u5728 " + (prob.id || "").slice(-4) + " \u4E0A\uFF08\u5DF2\u843D\u4F4D\u9898\u76EE\u4FDD\u6301\u5404\u81EA\u72B6\u6001\uFF09" });
      return;
    }
    running = true;
    suppressLeaveConfirm();
    fire({ kind: "state", running: true });
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
  function relaySummaryLine(r) {
    const s = r.summary;
    return `\u4F5C\u7B54 ${s.applied} \xB7 \u8DF3\u8FC7\u5DF2\u7B54 ${s.skippedAnswered} \xB7 \u8DF3\u8FC7\u542B\u56FE ${s.skippedImage} \xB7 \u5931\u8D25 ${s.failed.length}${r.cfg.drySave ? "\uFF08dry\uFF0C\u672A\u63D0\u4EA4\uFF09" : ""}`;
  }
  function abortRelay(r, reason) {
    clearRelay();
    fire({ kind: "log", level: "err", text: "\u7F16\u7A0B\u9898\u7EED\u8DD1\u4E2D\u6B62\uFF1A" + reason });
    fire({ kind: "log", level: "info", text: relaySummaryLine(r) });
    fire({ kind: "state", running: false, error: reason });
    running = false;
    restoreLeaveConfirm();
  }
  async function relayNext(r, record, text) {
    if (record === "ok") {
      r.summary.applied += 1;
      if (text) fire({ kind: "log", level: "ok", text });
    }
    if (record === "skip") {
      r.summary.skippedAnswered += 1;
      if (text) fire({ kind: "log", level: "info", text });
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
    restoreLeaveConfirm();
    try {
      location.href = `/problem-sets/${r.psId}/exam/problems/type/${next.typeId}?problemSetProblemId=${next.id}`;
    } catch (_) {
    }
  }
  async function relayCollect(r, prob) {
    const q = collectProgramming();
    if (!q) {
      r.summary.failed.push({ id: prob.id, reason: "\u7F16\u7A0B\u9898\u9875\u9762\u6536\u4E0D\u5230\u9898\u76EE" });
      return relayNext(r, "fail");
    }
    const label = q.label || prob.id.slice(-4);
    if (q.answered && !r.cfg.overwrite) return relayNext(r, "skip", `${label}\uFF1A\u8DF3\u8FC7\uFF0C\u5DF2\u4F5C\u7B54`);
    if (q.hasImg && !r.cfg.images) {
      r.summary.skippedImage += 1;
      fire({ kind: "log", level: "warn", text: `${label}\uFF1A\u8DF3\u8FC7\uFF0C\u9898\u5E72\u542B\u56FE\u7247\uFF08\u672A\u5F00\u300C\u4F5C\u7B54\u542B\u56FE\u9898\u300D\uFF09` });
      return relayNext(r, "fail");
    }
    const detail = await getDraftDetail(prob.id);
    const compilerId = r.cfg.language ? r.cfg.language : compilerIdFromLabel(q.langLabel) || (detail?.programmingSubmissionDetail?.compiler || null);
    if (!compilerId) {
      r.summary.failed.push({ id: prob.id, reason: `\u8BFB\u4E0D\u5230\u5F53\u524D\u8BED\u8A00\u300C${q.langLabel || "\uFF08\u7A7A\uFF09"}\u300D\uFF0C\u65E0\u6CD5\u786E\u5B9A\u7F16\u8BD1\u5668` });
      return relayNext(r, "fail");
    }
    const wantLangLabel = COMPILER_LABELS[compilerId] || q.langLabel || "";
    const messages = buildPrompt({ ...q, langLabel: wantLangLabel });
    let raw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = globalThis.__BPS_LLM_MOCK__ ? await globalThis.__BPS_LLM_MOCK__(messages) : await chatOnce(r.cfg, messages);
        break;
      } catch (err) {
        if (attempt === 2) {
          r.summary.failed.push({ id: prob.id, reason: "LLM \u8C03\u7528\u5931\u8D25\uFF1A" + (err?.message || err) });
          return relayNext(r, "fail");
        }
        await sleep(900);
      }
    }
    const code = parseCodeAnswer(raw);
    if (!code) {
      r.summary.failed.push({ id: prob.id, reason: "LLM \u8F93\u51FA\u89E3\u6790\u4E0D\u51FA\u4EE3\u7801\uFF1A" + String(raw).slice(0, 60) });
      return relayNext(r, "fail");
    }
    if (code.length > 16384) {
      r.summary.failed.push({ id: prob.id, reason: `\u4EE3\u7801\u8D85\u957F\uFF08${code.length} \u5B57\u7B26\uFF0C\u5E73\u53F0\u9650 16KB\uFF09` });
      return relayNext(r, "fail");
    }
    const written = await saveDraft(prob.id, detail, compilerId, code);
    if (!written.ok) {
      r.summary.failed.push({ id: prob.id, reason: `\u8349\u7A3F\u5199\u5165\u5931\u8D25\uFF08HTTP ${written.status ?? "\u672A\u77E5"}${written.err ? "\uFF1A" + written.err : ""}\uFF09` });
      return relayNext(r, "fail");
    }
    stripDraftHttpCache(prob.id);
    clearCodingProblemCache(prob.id);
    r.phase = "verify";
    r.hint = { label, compilerId, wantLangLabel, head: (code.split("\n")[0] || "").trim().slice(0, 24), detail };
    if (!writeRelay(r)) {
      abortRelay(r, "sessionStorage \u5199\u5165\u5931\u8D25");
      return;
    }
    running = false;
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
    const label = hint.label || prob.id.slice(-4);
    const wantLangLabel = hint.wantLangLabel || "";
    const compilerId = hint.compilerId;
    const head = String(hint.head || "").trim();
    const detail = hint.detail || null;
    const hyd = await waitHydrate(true);
    const cmText = editableCm()?.textContent || "";
    if (!hyd.ok || head && !cmText.includes(head)) {
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      r.summary.failed.push({ id: prob.id, reason: "\u6C34\u5408\u6821\u9A8C\u5931\u8D25\uFF08\u7F16\u8F91\u5668\u672A\u56DE\u5E26\u4EE3\u7801\uFF09" + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u9700\u4EBA\u5DE5\u6838\u5BF9") });
      if (!rollback.ok) return abortRelay(r, "\u8349\u7A3F\u64A4\u9500\u5931\u8D25\uFF08\u6B8B\u7559\u4EE3\u7801\uFF09\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9\u540E\u518D\u8BD5");
      return relayNext(r, "fail");
    }
    const mountedLabel = langLabelOf();
    if (mountedLabel !== wantLangLabel) {
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      r.summary.failed.push({ id: prob.id, reason: `\u8BED\u8A00\u4E0D\u4E00\u81F4\uFF08\u8349\u7A3F ${wantLangLabel}\uFF0C\u5B9E\u6302\u300C${mountedLabel || "\u672A\u77E5"}\u300D\uFF09\uFF0C\u5DF2\u5F03\u7B54\u9632\u9519\u914D` + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u9700\u4EBA\u5DE5\u6838\u5BF9") });
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
    const saved = await submitProgramming();
    if (!saved.saved) {
      const rollback = await saveDraft(prob.id, detail, compilerId, "");
      stripDraftHttpCache(prob.id);
      clearCodingProblemCache(prob.id);
      r.summary.failed.push({ id: prob.id, reason: "\u63D0\u4EA4\u5931\u8D25\uFF1A" + saved.reason + (rollback.ok ? "\uFF0C\u8349\u7A3F\u5DF2\u64A4\u9500" : "\uFF0C\u8349\u7A3F\u6B8B\u7559\u542B\u672C\u6B21\u4EE3\u7801\uFF0C\u9700\u4EBA\u5DE5\u6838\u5BF9") });
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
    pageScript("window.__BPS_CONFIRM__ = window.confirm; window.confirm = () => true;");
  }
  function restoreLeaveConfirm() {
    pageScript("if (window.__BPS_CONFIRM__) { window.confirm = window.__BPS_CONFIRM__; delete window.__BPS_CONFIRM__; }");
  }
  var running = false;
  function isRunning() {
    return running;
  }
  var eventSink = null;
  function setEventSink(fn) {
    eventSink = typeof fn === "function" ? fn : null;
  }
  var debugTrace = [];
  function fire(event) {
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
    if (readRelay()) {
      fire({ kind: "log", level: "warn", text: "\u7F16\u7A0B\u9898\u8DE8\u9875\u7EED\u8DD1\u6B63\u5728\u8FDB\u884C\uFF08\u770B\u5404\u9875\u60AC\u6D6E\u7403\u72B6\u6001\uFF09\uFF1B\u672C\u9875\u82E5\u5DF2\u4E0D\u5728\u9898\u76EE\u4E0A\u5219\u7EED\u8DD1\u4F1A\u81EA\u884C\u53D6\u6D88" });
      return { ok: false, error: "\u7F16\u7A0B\u9898\u8DE8\u9875\u7EED\u8DD1\u6B63\u5728\u8FDB\u884C" };
    }
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
      // 作答含图题（需视觉模型；未开则含图题照旧跳过）
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
    running = true;
    suppressLeaveConfirm();
    const summary = { types: [], applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [], savedTypes: 0, saveFails: [] };
    const progTypes = [];
    let ret = null;
    let relayStarted = false;
    try {
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
        const type = TYPE_BY_NAME[t.typeName];
        const isProg = type === "PROGRAMMING";
        if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
          const link = [...document.querySelectorAll("a[href]")].find((a) => (a.getAttribute("href") || "").match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
          if (!link) throw new Error(`\u627E\u4E0D\u5230\u300C${t.typeName}\u300D\u7684\u9875\u9762\u94FE\u63A5`);
          link.click();
          let ready = false;
          for (let i = 0; i < 60 && !ready; i++) {
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
          while (cursor < queue2.length) {
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
      if (!relayStarted) restoreLeaveConfirm();
      if (ret.ok) {
        const failN = ret.summary.failed.length;
        fire({ kind: "log", level: failN ? "warn" : "ok", text: `${ret.relay ? "\u5BA2\u89C2\u9898\u5B8C\u6210\uFF08\u7F16\u7A0B\u9898\u5DF2\u8F6C\u9010\u9875\u7EED\u8DD1\uFF0C\u65E5\u5FD7\u968F\u5404\u9875\u51FA\u73B0\uFF09" : `\u5B8C\u6210\uFF1A\u4F5C\u7B54 ${ret.summary.applied} \xB7 \u8DF3\u8FC7\u5DF2\u7B54 ${ret.summary.skippedAnswered} \xB7 \u8DF3\u8FC7\u542B\u56FE ${ret.summary.skippedImage} \xB7 \u5931\u8D25 ${failN}${cfg.drySave ? "\uFF08\u672A\u4FDD\u5B58\uFF09" : ""}`}` });
        fire({ kind: "state", running: false });
      } else {
        fire({ kind: "log", level: "err", text: "\u5DF2\u4E2D\u6B62\uFF1A" + ret.error });
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
      baseUrl: "https://opencode.ai/zen/go/v1",
      model: "glm-5.3-flash",
      gateway: "opencode",
      editableModel: true,
      // 网关模型可自填（面板多一行「模型」输入），留空用默认
      hint: "Zen Go \u7F51\u5173 \xB7 glm / kimi / deepseek \u7CFB\u6A21\u578B\u53EF\u7528"
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
  var MAX_LOG_LINES = 200;
  var CSS = `
:host { all: initial; }
.wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  font: 13px/1.5 system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
  color: var(--text); font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif; }

/* ---------- \u60AC\u6D6E\u7403 ---------- */
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

/* ---------- \u9762\u677F ---------- */
.panel { position: absolute; right: 0; bottom: 56px; width: 324px; max-width: calc(100vw - 24px);
  max-height: calc(100vh - 90px); display: flex; flex-direction: column;
  background: var(--bg); color: var(--text); border-radius: 14px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(16, 24, 40, .22), 0 3px 10px rgba(16, 24, 40, .1), 0 0 0 1px var(--hairline);
  transform-origin: 100% 100%; animation: aa-pop .18s ease; }
/* display:flex \u4F1A\u76D6\u8FC7 UA \u7684 [hidden]\uFF0C\u5FC5\u987B\u663E\u5F0F\u6536\u56DE\uFF08\u5426\u5219\u6536\u8D77\u9762\u677F\u65E0\u6548\u3001\u9762\u677F\u5E38\u663E\uFF09 */
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
.keyrow input { padding-right: 52px; } /* \u53F3\u4FA7\u7559\u7ED9\u663E\u793A/\u9690\u85CF\u6309\u94AE */
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

/* ---------- \u53CC\u4E3B\u9898\uFF08\u8DDF\u968F\u7CFB\u7EDF\uFF0C\u4EE4\u724C\u4E0E\u8BBE\u7F6E\u5F39\u7A97\u540C\u6E90\uFF09 ---------- */
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
  var host = null;
  var shadow = null;
  var settings = null;
  var open = false;
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
  function appendLog(level, text) {
    logLines.push({ level, text, t: timeStr() });
    if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
    if (!shadow) return;
    const box = shadow.getElementById("logs");
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
    const line = el("div", "line", box);
    const tag = { ok: "\u2713", err: "\u2715", warn: "!" }[level] || "\xB7";
    line.innerHTML = `<span class="t">${timeStr()}</span><span class="lv-${level}">${tag}</span> `;
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
    if (ev.kind === "log") return appendLog(ev.level, ev.text);
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
        if (ev.error) appendLog("err", ev.error);
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
      start.disabled = running2;
      start.textContent = running2 ? `\u7B54\u9898\u4E2D\u2026${prog ? `\uFF08${prog.done}/${prog.total}\uFF09` : ""}` : "\u5F00\u59CB\u7B54\u9898";
    }
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
    const body = el("div", "body", panel);
    const fModel = el("div", "field", body);
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
    const fBase = el("div", "field", body);
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
    const fModelName = el("div", "field", body);
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
    const fLang = el("div", "field", body);
    el("label", "flabel", fLang).textContent = "\u8BED\u8A00\uFF08\u7F16\u7A0B\u9898\uFF09";
    fLang.querySelector("label").htmlFor = "aa-lang";
    const lsel = el("select", "", fLang);
    lsel.id = "aa-lang";
    const oFollow = el("option", "", lsel);
    oFollow.value = "";
    oFollow.textContent = "\u8DDF\u968F\u7F16\u8F91\u5668\u5F53\u524D\u8BED\u8A00";
    el("p", "hint", fLang).textContent = "\u672C\u9898\u96C6\u5141\u8BB8\u7684\u8BED\u8A00\uFF1B\u4F5C\u7B54\u6309\u6240\u9009\u8BED\u8A00\u51FA\u7801\u5E76\u63D0\u4EA4\u8BC4\u6D4B";
    const fKey = el("div", "field", body);
    el("label", "flabel", fKey).textContent = "API Key";
    fKey.querySelector("label").htmlFor = "aa-key";
    const keyrow = el("div", "keyrow", fKey);
    const key = el("input", "", keyrow);
    key.id = "aa-key";
    key.type = "password";
    key.placeholder = "sk-\u2026";
    key.autocomplete = "off";
    key.spellcheck = false;
    const peek = el("button", "peek", keyrow);
    peek.type = "button";
    peek.id = "aa-peek";
    peek.textContent = "\u663E\u793A";
    peek.setAttribute("aria-label", "\u663E\u793A\u6216\u9690\u85CF API Key");
    el("p", "hint", fKey).textContent = "\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u6D4F\u89C8\u5668\uFF0C\u7B54\u9898\u65F6\u9875\u9762\u76F4\u8FDE\u6A21\u578B\u670D\u52A1";
    const sw = el("label", "switchrow", body);
    sw.htmlFor = "aa-overwrite";
    const stxt = el("span", "stxt", sw);
    el("b", "", stxt).textContent = "\u8986\u76D6\u5DF2\u4F5C\u7B54";
    el("small", "", stxt).textContent = "\u9ED8\u8BA4\u8DF3\u8FC7\u5DF2\u7B54\u9898\uFF0C\u4FDD\u7559\u539F\u6709\u7B54\u6848";
    const ovw = el("input", "switch", sw);
    ovw.id = "aa-overwrite";
    ovw.type = "checkbox";
    const swImg = el("label", "switchrow", body);
    swImg.htmlFor = "aa-images";
    const stxtImg = el("span", "stxt", swImg);
    el("b", "", stxtImg).textContent = "\u4F5C\u7B54\u542B\u56FE\u9898";
    el("small", "", stxtImg).textContent = "\u9700\u89C6\u89C9\u6A21\u578B\uFF08\u5982 deepseek-flash\uFF09\uFF0C\u9ED8\u8BA4\u8DF3\u8FC7";
    const imgs = el("input", "switch", swImg);
    imgs.id = "aa-images";
    imgs.type = "checkbox";
    const start = el("button", "start", body);
    start.id = "start";
    start.type = "button";
    start.textContent = "\u5F00\u59CB\u7B54\u9898";
    const logsHead = el("div", "logs-head", body);
    el("b", "", logsHead).textContent = "\u65E5\u5FD7";
    const clear = el("button", "clear", logsHead);
    clear.id = "clear";
    clear.type = "button";
    clear.textContent = "\u6E05\u7A7A";
    const logs = el("div", "logs", body);
    logs.id = "logs";
    logs.setAttribute("role", "log");
    logs.setAttribute("aria-live", "polite");
    el("p", "foot", body).textContent = "\u5B9E\u9A8C\u529F\u80FD\uFF1A\u7B54\u9898\u4E2D\u5E73\u53F0\u4E0D\u53CD\u9988\u5BF9\u9519\uFF0C\u5B8C\u6210\u540E\u8BF7\u81EA\u884C\u6838\u5BF9\u7ED3\u679C\u3002";
    el("p", "foot", body).textContent = "\u6587\u672C\u6A21\u578B\u770B\u4E0D\u89C1\u56FE\u7247\uFF1A\u9898\u5E72/\u9009\u9879\u542B\u56FE\u7684\u9898\u8981\u4E48\u8DF3\u8FC7\uFF0C\u8981\u4E48\u5207\u5230\u89C6\u89C9\u6A21\u578B\uFF08\u5982 deepseek-flash\uFF09\u5E76\u5F00\u542F\u300C\u4F5C\u7B54\u542B\u56FE\u9898\u300D\u3002";
    el("p", "foot", body).textContent = "\u7F16\u7A0B\u9898\u63D0\u4EA4\u5373\u8BC4\u6D4B\uFF1A\u4F5C\u7B54\u4F1A\u5B9E\u65F6\u751F\u6210\u63D0\u4EA4\u8BB0\u5F55\u4E0E\u4F5C\u7B54\u5EA6\uFF0C\u6210\u7EE9\u7531\u8BC4\u6D4B\u7ED3\u679C\u51B3\u5B9A\uFF0C\u4E0E\u5BA2\u89C2\u9898\u5224\u5206\u8DEF\u5F84\u4E0D\u540C\u3002";
    ball.addEventListener("click", () => togglePanel());
    collapse.addEventListener("click", closePanel);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePanel();
    });
    peek.addEventListener("click", () => {
      const show = key.type === "password";
      key.type = show ? "text" : "password";
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
    key.value = ((settings || {}).autoAnswerApiKey || "").trim();
    ovw.checked = !!(settings || {}).autoAnswerOverwrite;
    imgs.checked = !!(settings || {}).autoAnswerImages;
    refreshLangOptions();
    applyPreset();
    sel.addEventListener("change", () => {
      applyPreset();
      persist();
    });
    burl.addEventListener("change", persist);
    mname.addEventListener("change", persist);
    key.addEventListener("change", persist);
    lsel.addEventListener("change", persist);
    ovw.addEventListener("change", persist);
    imgs.addEventListener("change", persist);
    clear.addEventListener("click", () => {
      logLines.length = 0;
      renderLogs();
    });
    start.addEventListener("click", startRun);
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
  function openPanel() {
    if (!shadow) return;
    const panel = shadow.getElementById("panel");
    const ball = shadow.getElementById("ball");
    panel.hidden = false;
    ball.setAttribute("aria-expanded", "true");
    open = true;
    updateRunUI();
    const first = shadow.getElementById("aa-model");
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
      await saveSettings({ ...fresh, autoAnswerApiKey: apiKey, autoAnswerOverwrite: overwrite, autoAnswerImages: withImages, autoAnswerGateway: gateway, autoAnswerBaseUrl: baseUrl, autoAnswerModel: model, autoAnswerLanguage: language });
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
      burl?.focus();
      return;
    }
    const model = resolveModel(preset, shadow.getElementById("aa-model-name")?.value);
    if (preset.customEndpoint && !model) {
      appendLog("err", "\u8BF7\u5148\u586B\u5199\u6A21\u578B id");
      shadow.getElementById("aa-model-name").focus();
      return;
    }
    const apiKey = shadow.getElementById("aa-key").value.trim();
    if (!apiKey) {
      appendLog("err", "\u8BF7\u5148\u586B\u5199 API Key\uFF08\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\uFF09");
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
        nativeCountdown: /距离关闭/.test(fullText),
        // PTA 自带精确倒计时的卡片不再叠加我们的
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
    const cd = s.countdown && it.closeAt && !it.nativeCountdown ? fmtCountdown(it.closeAt) : null;
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
  function updateProgress(scopeEl, it, s) {
    const p = s.progress && it.progress && it.progress.total > 0 ? it.progress : null;
    const pill = scopeEl.querySelector(".bps-done");
    const text = scopeEl.querySelector(".bps-answered");
    if (!p) {
      pill?.remove();
      text?.remove();
      return;
    }
    const done = p.answered >= p.total;
    const row = pillRow(scopeEl);
    if (row) {
      const el2 = pill || document.createElement("span");
      if (!pill) {
        el2.className = "bps-done";
        row.append(el2);
      }
      if (el2.dataset.stamp !== (done ? "done" : "todo")) {
        el2.dataset.stamp = done ? "done" : "todo";
        el2.dataset.level = done ? "done" : "todo";
        el2.textContent = done ? "\u5DF2\u5B8C\u6210" : "\u672A\u5B8C\u6210";
      }
    }
    const line = metaLine(scopeEl);
    const target = line && (line.querySelector(".flex .flex") || line.querySelector(".flex"));
    if (target) {
      const el2 = text || document.createElement("span");
      if (!text) {
        el2.className = "bps-answered";
        target.append(el2);
      }
      const label = `\u5DF2\u4F5C\u7B54 ${p.answered}/${p.total}`;
      if (el2.textContent !== label) el2.textContent = label;
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

  // src/content/progress.js
  var OK_TTL = 2 * 60 * 1e3;
  var FAIL_TTL = 10 * 60 * 1e3;
  var CONCURRENCY = 3;
  var cache = /* @__PURE__ */ new Map();
  var queued = /* @__PURE__ */ new Set();
  var queue = [];
  var active = 0;
  var hooks2 = {};
  function setProgressHooks(next) {
    hooks2 = { ...hooks2, ...next };
  }
  function progressUrl(examId, problemSetId) {
    return `/api/exams/${encodeURIComponent(examId)}/problem-sets/${encodeURIComponent(problemSetId)}/problem-status?_bps=progress`;
  }
  function countAnswered(json) {
    const list = json?.problemStatus || [];
    return {
      answered: list.filter((p) => p.problemSubmissionStatus === "PROBLEM_SUBMITTED").length,
      total: list.length
    };
  }
  function wantsProgress(it, now = Date.now()) {
    return !!(it?.examId && it.startAt && it.closeAt && +it.startAt <= now && +it.closeAt > now);
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
  function ensureProgress(items, now = Date.now()) {
    for (const it of (items || []).filter((x) => wantsProgress(x, now))) {
      const rec = cache.get(it.id);
      if (rec && (rec.ok ? now - rec.at <= OK_TTL : now - rec.at <= FAIL_TTL)) continue;
      if (queued.has(it.id)) continue;
      queued.add(it.id);
      queue.push({ id: it.id, examId: it.examId });
    }
    pump();
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
        hooks2.onUpdate?.();
        pump();
      });
    }
  }

  // src/content/reminders.js
  var PUSH_MIN_INTERVAL = 30 * 60 * 1e3;
  var DIRECT_MIN_INTERVAL = 5 * 60 * 1e3;
  var lastPush = { sig: null, at: 0 };
  var lastRemindCfg = { enabled: null, server: null, email: null };
  var lastDirectAt = 0;
  function reminderCfg(settings3) {
    return {
      enabled: settings3.reminderEnabled !== false,
      server: settings3.reminderServer || "",
      email: settings3.reminderEmail || ""
    };
  }
  function consumeRemindCfgChange(settings3) {
    const cfg = reminderCfg(settings3);
    const changed = cfg.enabled !== lastRemindCfg.enabled || cfg.server !== lastRemindCfg.server || cfg.email !== lastRemindCfg.email;
    lastRemindCfg = cfg;
    return changed;
  }
  function pushReminders(server, email, items, force = false) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    const now = Date.now();
    const sets = (items || []).filter((i) => i.closeAt && +i.closeAt > now).map((i) => ({ id: i.id, title: i.title, endAt: i.closeAt.toISOString(), owner: i.creator, org: i.org })).sort((a, b) => a.endAt.localeCompare(b.endAt));
    const sig = JSON.stringify(sets);
    if (!force && sig === lastPush.sig && now - lastPush.at < PUSH_MIN_INTERVAL) return;
    lastPush = { sig, at: now };
    chrome.runtime.sendMessage({ type: "BPS_SYNC", server, email, sets }).then((res) => {
      if (res?.ok) console.info(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u90AE\u4EF6\u63D0\u9192\u8BA2\u9605\u5DF2\u540C\u6B65\uFF08${sets.length} \u4E2A\u9898\u76EE\u96C6\uFF09`);
      else console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u90AE\u4EF6\u63D0\u9192\u540C\u6B65\u5931\u8D25:", res?.error || "\u672A\u77E5\u9519\u8BEF");
    }).catch((err) => console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u90AE\u4EF6\u63D0\u9192\u540C\u6B65\u5931\u8D25:", err?.message || err));
  }
  function armDirectCooldown() {
    lastDirectAt = Date.now();
  }
  function syncRemindersDirect(settings3) {
    const changed = consumeRemindCfgChange(settings3);
    const cfg = reminderCfg(settings3);
    if (!cfg.enabled || !cfg.server || !cfg.email) return;
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
    aggregateAll(String(u)).then((items) => pushReminders(cfg.server, cfg.email, items, changed)).catch((err) => console.warn(`[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u90AE\u4EF6\u63D0\u9192\u540C\u6B65\u5931\u8D25\uFF08\u62C9\u53D6\u8FDB\u884C\u4E2D\u9898\u76EE\u96C6\uFF09: ${err?.message || err}`));
  }
  function pushAggregatedReminders(settings3) {
    const changed = consumeRemindCfgChange(settings3);
    const cfg = reminderCfg(settings3);
    if (!cfg.enabled || !cfg.server || !cfg.email || !ACTIVE_PATH_RE.test(location.pathname)) return;
    pushReminders(cfg.server, cfg.email, aggregateItems(), changed);
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
