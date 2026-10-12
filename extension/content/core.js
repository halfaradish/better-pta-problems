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
    reminderEnabled: true,
    // 题目关闭邮件提醒总开关（与下面两项配置配合；关闭即暂停同步）
    reminderServer: "",
    // 邮件提醒后端地址（ip:port，可加 /令牌 后缀）；空 = 关闭
    reminderEmail: "",
    // 提醒邮件接收邮箱
    settingsVersion: 0
    // 0 = 旧版设置；v4 起「列表/分组」不再持久化（改为按路由的会话内状态）
  };
  var SETTINGS_VERSION = 4;
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
  var hooks2 = {};
  function setViewHooks(next) {
    hooks2 = { ...hooks2, ...next };
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
        closeAt: ai.closeAt,
        closeText: fmtCloseLocal(ai.closeAt),
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
        hooks2.rerender?.();
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
        hooks2.rerender?.();
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
      hooks2.rerender?.();
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
    document.querySelectorAll(".bps-badge, .bps-countdown").forEach((n) => n.remove());
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
      renamed.forEach((it) => decorate(it, settings));
      const uni = unifiedItems(renamed, settings, renameMap, aggItems);
      state.items = uni;
      uni.forEach((it) => decorate(it, settings));
      const domSig = domItems.map((i) => i.id).join(",");
      const sig = `${state.grouped}#${state.filter}#${state.page}#${domSig}#${uni.map((i) => `${i.id}|${i.course}|${i.closeText}`).join(";")}`;
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
        const relevant = [...m.addedNodes, ...m.removedNodes].some((n) => n.nodeType === 1 && !n.closest?.(".bps-root"));
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
    armDirectCooldown();
    setTimeout(() => syncRemindersDirect(settings), 2e3);
    sync(true);
  }
  window.BPS = {
    init,
    sync,
    teardown,
    DEFAULTS,
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
