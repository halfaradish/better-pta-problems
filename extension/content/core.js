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
          const { settings: settings2 } = await chrome.storage.sync.get({ settings: {} });
          return { ...DEFAULTS, ...settings2 };
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
    "\u586B\u7A7A\u9898": "FILL_IN_THE_BLANK"
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
    lines.push("\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF0C\u4E0D\u8981\u5305\u542B\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u6216\u4EE3\u7801\u56F4\u680F\u3002");
    lines.push("");
    if (q.kind === "TRUE_OR_FALSE") {
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
      { role: "system", content: "\u4F60\u662F\u4E25\u8C28\u7684\u7B54\u9898\u52A9\u624B\uFF0C\u53EA\u8F93\u51FA\u8981\u6C42\u7684 JSON\uFF0C\u4E0D\u8981\u8F93\u51FA\u4EFB\u4F55\u5176\u4ED6\u6587\u5B57\u3002" },
      { role: "user", content: lines.join("\n") }
    ];
  }
  function cleanText(el) {
    const clone = el.cloneNode(true);
    clone.classList.add("bps-clone");
    clone.style.cssText = "position:fixed;left:-99999px;top:0;margin:0;max-width:900px";
    let bi = 0;
    for (const inp of [...clone.querySelectorAll("input")].filter((i) => i.type === "text")) {
      bi += 1;
      inp.replaceWith(document.createTextNode(`[\u7A7A${bi}]`));
    }
    for (const n of clone.querySelectorAll('button, input, textarea, [class*="cm-gutters"]')) n.remove();
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
    const containers = [...document.querySelectorAll("main [id]")].filter((el) => /^\d+$/.test(el.id) && (el.querySelector("input[type=radio]") || [...el.querySelectorAll("input")].some((i) => i.type === "text")));
    for (const el of containers) {
      const radios = [...el.querySelectorAll("input[type=radio]")];
      const texts = [...el.querySelectorAll("input")].filter((i) => i.type === "text");
      let kind;
      let options = [];
      let blanks = 0;
      if (radios.length === 2) kind = "TRUE_OR_FALSE";
      else if (radios.length > 2) {
        kind = "MULTIPLE_CHOICE";
        options = radios.map((r, i) => {
          const label = r.closest("label");
          const t = (label?.innerText || "").replace(/\s+/g, " ").trim();
          return { idx: i, letter: LETTERS[i] || "?" + i, text: t };
        });
      } else if (texts.length) {
        kind = "FILL_IN_THE_BLANK";
        blanks = texts.length;
      } else continue;
      out.push({
        id: el.id,
        kind,
        el,
        radios,
        texts,
        options,
        blanks,
        hasImg: !!el.querySelector("img"),
        answered: radios.length ? radios.some((r) => r.checked) : texts.some((t) => String(t.value || "").trim() !== ""),
        text: cleanText(el)
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
  async function chatOnce(cfg, messages) {
    const base = String(cfg.baseUrl || "").trim().replace(/\/+$/, "");
    const res = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + String(cfg.apiKey || "").trim(),
        "x-opencode-session": sessionHeader(),
        "User-Agent": "better-pta-problems/0.9"
      },
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
  async function answerOne(q, cfg, overwrite) {
    const messages = buildPrompt(q);
    let raw = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = globalThis.__BPS_LLM_MOCK__ ? await globalThis.__BPS_LLM_MOCK__(messages) : await chatOnce(cfg, messages);
        break;
      } catch (err) {
        if (attempt === 2) return "LLM \u8C03\u7528\u5931\u8D25\uFF1A" + (err?.message || err);
        await sleep(900);
      }
    }
    const json = parseJsonLoose(raw);
    if (!json) return "LLM \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\uFF1A" + String(raw).slice(0, 60);
    try {
      if (q.kind === "MULTIPLE_CHOICE") {
        const letter = parseChoiceAnswer(json.answer, q.radios.length);
        if (!letter) return "LLM \u5B57\u6BCD\u7B54\u6848\u65E0\u6548\uFF1A" + String(json.answer).slice(0, 20);
        if (!fillRadio(q, letter)) return "\u5199\u5165\u9009\u9879\u5931\u8D25";
      } else if (q.kind === "TRUE_OR_FALSE") {
        const tf = normalizeTF(json.answer);
        if (!tf) return "LLM \u5224\u65AD\u7B54\u6848\u65E0\u6548\uFF1A" + String(json.answer).slice(0, 20);
        if (!fillRadio(q, tf === "TRUE" ? "A" : "B")) return "\u5199\u5165\u9009\u9879\u5931\u8D25";
      } else {
        const answers = parseFillAnswers(json, q.blanks);
        if (!answers) return `LLM \u586B\u7A7A\u7B54\u6848\u6570\u91CF\u4E0D\u7B26\uFF08\u9700 ${q.blanks} \u7A7A\uFF09`;
        fillBlank(q, answers);
      }
    } catch (err) {
      return "\u5199\u5165\u5931\u8D25\uFF1A" + (err?.message || err);
    }
    return null;
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
  function emit(event) {
    try {
      chrome.runtime?.sendMessage?.({ type: "BPS_AUTOANSWER_EVENT", ...event }).catch?.(() => {
      });
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
    if (running) return { ok: false, error: "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D" };
    const m = location.pathname.match(EXAM_PROBLEMS_RE);
    if (!m || !m[3]) return { ok: false, error: "\u8BF7\u5148\u8FDB\u5165\u9898\u76EE\u5217\u8868\u7684\u67D0\u4E2A\u9898\u578B\u9875\uFF08\u5224\u65AD/\u5355\u9009/\u586B\u7A7A\u6807\u7B7E\uFF09\u518D\u5F00\u59CB" };
    const psId = m[1];
    const cfg = {
      baseUrl: config.baseUrl || config.autoAnswerBaseUrl || "",
      apiKey: config.apiKey || config.autoAnswerApiKey || "",
      model: config.model || config.autoAnswerModel || "",
      overwrite: !!(config.overwrite ?? config.autoAnswerOverwrite),
      drySave: !!config.drySave
    };
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      return { ok: false, error: "\u8BF7\u5148\u5728\u5F39\u7A97\u586B\u5199\u670D\u52A1\u5668\u5730\u5740\u3001API Key \u4E0E\u6A21\u578B\u540D" };
    }
    running = true;
    suppressLeaveConfirm();
    const summary = { types: [], applied: 0, skippedAnswered: 0, skippedImage: 0, failed: [], savedTypes: 0, saveFails: [] };
    try {
      const types = sidebarTypes().filter((t) => TYPE_BY_NAME[t.typeName] || false).filter((t) => t.total > 0);
      const unknown = sidebarTypes().filter((t) => !(t.typeName in TYPE_BY_NAME) && t.total > 0);
      if (!types.length) throw new Error("\u672C\u9875\u4FA7\u680F\u6CA1\u6709\u53EF\u4F5C\u7B54\u7684\u9898\u578B");
      if (unknown.length) summary.failed.push({ id: "-", reason: `\u6682\u4E0D\u652F\u6301\u9898\u578B\uFF1A${unknown.map((u) => u.typeName).join("\u3001")}\uFF08\u8DF3\u8FC7\uFF09` });
      for (const t of types) {
        if (!EXAM_PROBLEMS_RE.test(location.pathname) || !location.pathname.includes(psId)) {
          throw new Error("\u5DF2\u79BB\u5F00\u539F\u9898\u76EE\u9875\uFF0C\u4E2D\u6B62");
        }
        if (!location.pathname.endsWith(`/type/${t.typeId}`)) {
          const link = [...document.querySelectorAll("a[href]")].find((a) => (a.getAttribute("href") || "").match(`^/problem-sets/${psId}/exam/problems/type/${t.typeId}$`));
          if (!link) throw new Error(`\u627E\u4E0D\u5230\u300C${t.typeName}\u300D\u7684\u9875\u9762\u94FE\u63A5`);
          link.click();
          const type2 = TYPE_BY_NAME[t.typeName];
          let ready = false;
          for (let i = 0; i < 60 && !ready; i++) {
            await sleep(100);
            ready = location.pathname.endsWith(`/type/${t.typeId}`) && collectPage().filter((q) => q.kind === type2).length >= t.total;
          }
          if (!ready) throw new Error(`\u300C${t.typeName}\u300D\u9875\u9762\u672A\u5C31\u7EEA\uFF08\u4FA7\u680F\u7EDF\u8BA1 ${t.total} \u9898\uFF09`);
        }
        await sleep(300);
        const type = TYPE_BY_NAME[t.typeName];
        const questions = collectPage().filter((q) => q.kind === type);
        if (!questions.length) throw new Error(`\u300C${t.typeName}\u300D\u9875\u9762\u6536\u96C6\u4E0D\u5230\u9898\u76EE`);
        const stats = { ok: [], skippedAnswered: 0, skippedImage: 0, failed: [] };
        let done = 0;
        const queue2 = questions.map((q, i) => ({ q, i }));
        let cursor = 0;
        const emitProgress = () => emit({ event: "progress", typeName: t.typeName, done, total: questions.length });
        const worker = async () => {
          while (cursor < queue2.length) {
            const { q } = queue2[cursor++];
            done += 1;
            if (q.answered && !cfg.overwrite) {
              stats.skippedAnswered += 1;
              emitProgress();
              continue;
            }
            if (q.hasImg) {
              stats.skippedImage += 1;
              emitProgress();
              continue;
            }
            const err = await answerOne(q, cfg, cfg.overwrite);
            if (err) stats.failed.push({ id: q.id, reason: err });
            else stats.ok.push(q.id);
            emitProgress();
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, queue2.length) }, worker));
        const filled = stats.ok.length > 0;
        let saved = null;
        if (filled && !cfg.drySave) {
          saved = await saveTypePage();
          if (saved.saved) summary.savedTypes += 1;
          else summary.saveFails.push(`${t.typeName}\uFF1A${saved.reason}`);
        } else if (!filled) {
          saved = { saved: false, reason: "\u672C\u9875\u65E0\u9700\u65B0\u7B54\u6848\uFF0C\u672A\u4FDD\u5B58" };
        }
        const pg = progressOf(stats);
        summary.applied += pg.applied;
        summary.skippedAnswered += pg.skippedAnswered;
        summary.skippedImage += pg.skippedImage;
        summary.failed.push(...stats.failed);
        summary.types.push({ type: t.typeName, total: questions.length, applied: pg.applied, skippedAnswered: pg.skippedAnswered, skippedImage: pg.skippedImage, failed: stats.failed.length, saved: saved?.saved === true });
        emit({ event: "typedone", typeName: t.typeName, ...pg, saved: saved?.saved === true });
      }
      const result = { ok: true, summary };
      emit({ event: "done", summary });
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      emit({ event: "done", summary, error: message });
      return { ok: false, error: message, summary };
    } finally {
      running = false;
      restoreLeaveConfirm();
    }
  }

  // src/content/classify.js
  function parseRules(settings2) {
    return (settings2.rules || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
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
  function classifyDetailed(title, settings2) {
    for (const r of parseRules(settings2)) {
      if (title.includes(r.key)) return { course: r.course, locked: true };
    }
    return {
      course: splitCourse(title, settings2.separators.split(",").map((x) => x.trim()).filter(Boolean)),
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
  function buildCourseRenameMap(pairs, settings2) {
    const cls = pairs.map((p) => ({ ...classifyDetailed(p.title, settings2), teacher: p.teacher }));
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
  function extractItems(settings2) {
    const anchors = [...document.querySelectorAll("main a[href]")].filter((a) => SET_HREF_RE.test(a.getAttribute("href") || "") && !a.closest(".bps-root"));
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    for (const el of anchors) {
      const id = el.getAttribute("href").match(SET_HREF_RE)[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const titleEl = el.querySelector("div[title]");
      const title = (titleEl?.getAttribute("title") || titleEl?.textContent || el.textContent || "").trim();
      const fullText = el.textContent || "";
      items.push({
        id,
        el,
        title,
        ...classifyDetailed(title, settings2),
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
      const el = pill || document.createElement("span");
      if (!pill) {
        el.className = "bps-done";
        row.append(el);
      }
      if (el.dataset.stamp !== (done ? "done" : "todo")) {
        el.dataset.stamp = done ? "done" : "todo";
        el.dataset.level = done ? "done" : "todo";
        el.textContent = done ? "\u5DF2\u5B8C\u6210" : "\u672A\u5B8C\u6210";
      }
    }
    const line = metaLine(scopeEl);
    const target = line && (line.querySelector(".flex .flex") || line.querySelector(".flex"));
    if (target) {
      const el = text || document.createElement("span");
      if (!text) {
        el.className = "bps-answered";
        target.append(el);
      }
      const label = `\u5DF2\u4F5C\u7B54 ${p.answered}/${p.total}`;
      if (el.textContent !== label) el.textContent = label;
    }
  }
  function decorate(it, s) {
    const el = it.el;
    if (s.badge && it.course) {
      const line = metaLine(el);
      if (line) {
        const target = line.querySelector(".flex .flex") || line.querySelector(".flex");
        let b = el.querySelector(".bps-badge");
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
    updateCountdown(el, it, s);
    updateProgress(el, it, s);
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
  function reminderCfg(settings2) {
    return {
      enabled: settings2.reminderEnabled !== false,
      server: settings2.reminderServer || "",
      email: settings2.reminderEmail || ""
    };
  }
  function consumeRemindCfgChange(settings2) {
    const cfg = reminderCfg(settings2);
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
  function syncRemindersDirect(settings2) {
    const changed = consumeRemindCfgChange(settings2);
    const cfg = reminderCfg(settings2);
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
  function pushAggregatedReminders(settings2) {
    const changed = consumeRemindCfgChange(settings2);
    const cfg = reminderCfg(settings2);
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
  function unifiedItems(domItems, settings2, renameMap, aggItems) {
    if (!aggItems) return domItems.map((d) => ({ ...d, fromDom: true }));
    const domById = new Map(domItems.map((i) => [i.id, i.el]));
    return aggItems.map((ai) => {
      const el = domById.get(ai.id);
      const det = classifyDetailed(ai.title, settings2);
      return {
        id: ai.id,
        title: ai.title,
        course: det.locked ? det.course : renameMap.get(det.course) || det.course,
        startAt: ai.startAt,
        closeAt: ai.closeAt,
        closeText: fmtCloseLocal(ai.closeAt),
        examId: ai.examId || "",
        // 答题进度的取数钥匙（入口据此挂 it.progress）
        el: el || buildApiCard(ai),
        fromDom: !!el
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
  function refreshCountdowns(settings2) {
    for (const it of state.items) updateCountdown(it.el, it, settings2);
    for (const c of document.querySelectorAll(".bps-countdown")) {
      const a = c.closest("a[href]");
      const id = a && (a.getAttribute("href").match(SET_HREF_RE) || [])[1];
      const it = state.items.find((i) => i.id === id);
      if (it) updateCountdown(a, it, settings2);
    }
  }

  // src/content/index.js
  var settings = { ...DEFAULTS };
  setAggregateHooks({
    onPathChange: () => resetForRoute(),
    onSuccess: () => pushAggregatedReminders(settings),
    onSettled: () => sync(true)
  });
  setViewHooks({ rerender: () => sync(true) });
  setProgressHooks({ onUpdate: () => scheduleSync() });
  function sync(force = false) {
    try {
      if (!settings.enabled || !window.__BPS_FORCE_LIST__ && !LIST_PATH_RE.test(location.pathname)) {
        if (state.sig) teardown();
        return;
      }
      const domItems = extractItems(settings);
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
      const renameMap = settings.mergeSimilar && aggItems ? buildCourseRenameMap(aggItems.map((ai) => ({ title: ai.title, teacher: ai.creator })), settings) : /* @__PURE__ */ new Map();
      const renamed = domItems.map((d) => ({
        ...d,
        course: d.locked ? d.course : renameMap.get(d.course) || d.course
      }));
      if (settings.progress) ensureProgress(aggItems || []);
      const attachProgress = (list) => list.forEach((it) => {
        it.progress = progressOf2(it.id);
      });
      attachProgress(renamed);
      renamed.forEach((it) => decorate(it, settings));
      const uni = unifiedItems(renamed, settings, renameMap, aggItems);
      state.items = uni;
      attachProgress(uni);
      uni.forEach((it) => decorate(it, settings));
      const domSig = domItems.map((i) => i.id).join(",");
      const sig = `${state.grouped}#${state.filter}#${state.page}#${domSig}#${uni.map((i) => `${i.id}|${i.course}|${i.closeText}|${i.progress ? `${i.progress.answered}/${i.progress.total}` : "-"}`).join(";")}`;
      const nativeListMode = state.filter === "ALL" && !state.grouped;
      const hiddenOk = nativeListMode ? listEl.style.display !== "none" : listEl.style.display === "none";
      const anchor = state.root || state.bar;
      if (!force && anchor && state.sig === sig && hiddenOk && document.contains(anchor)) {
        refreshCountdowns(settings);
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
    syncTimer = setTimeout(() => sync(), 200);
  }
  async function init() {
    settings = await loadSettings({ persistMigration: true });
    onSettingsChanged((s) => {
      settings = s;
      sync(true);
      syncRemindersDirect(settings);
    });
    try {
      performance.setResourceTimingBufferSize(1e3);
    } catch (_) {
    }
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        const relevant = [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && !n.closest?.(".bps-root") && !n.closest?.(".bps-clone"));
        if (relevant) {
          scheduleSync();
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (e) => {
      if (!settings.enabled || !settings.openInNewTab) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target?.closest?.("a[href]");
      if (!a || !SET_HREF_RE.test(a.getAttribute("href") || "")) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener");
    }, true);
    setInterval(() => sync(), 3e3);
    setInterval(() => {
      if (state.root) refreshCountdowns(settings);
    }, 6e4);
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type !== "BPS_AUTOANSWER_RUN") return void 0;
        if (isRunning()) {
          sendResponse({ ok: false, error: "\u5DF2\u6709\u4E00\u6B21\u7B54\u9898\u5728\u8FD0\u884C\u4E2D" });
          return;
        }
        sendResponse({ ok: true, started: true });
        handleRun(msg.config).catch((err) => console.warn("[\u66F4\u597D\u7684\u9898\u76EE\u96C6] \u81EA\u52A8\u7B54\u9898\u8FD0\u884C\u5F02\u5E38:", err?.message || err));
        return void 0;
      });
    }
    armDirectCooldown();
    setTimeout(() => syncRemindersDirect(settings), 2e3);
    sync(true);
  }
  window.BPS = {
    init,
    sync,
    teardown,
    DEFAULTS,
    // 自动答题调试与回归入口：run 走完整流程（配合 __BPS_LLM_MOCK__ 可 mock LLM），
    // collect 只收集当前题型页的题目（验证提取纯度用）
    autoAnswer: {
      run: (config = {}) => handleRun(config),
      collect: () => collectPage(),
      types: () => sidebarTypes()
    },
    setSettings: async (patch) => {
      settings = { ...settings, ...patch };
      await saveSettings(settings);
      sync(true);
    },
    // 会话内视图模式（等同于点筛选条上的「切换为分组/列表」），预览页与自动化测试用
    setView: (patch) => {
      Object.assign(state, patch);
      state.page = 1;
      sync(true);
    }
  };
  function boot() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        init();
      });
    } else {
      init();
    }
  }
  if (!window.__BPS_LOADED__) {
    window.__BPS_LOADED__ = true;
    boot();
  }
})();
