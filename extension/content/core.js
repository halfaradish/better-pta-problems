/* 更好的题目集 · PTA 题目集列表增强
 *
 * 在 pintia.cn 的题目集列表页（/problem-sets/active、/problem-sets/all 等）
 * 按课程分组展示列表，提供课程筛选条、卡片课程徽章与截止倒计时。
 *
 * v0.2：分组视图跨页聚合——复用 PTA 自身的列表接口（/api/problem-sets?...，
 * 带 query 参数，登录态 fetch）一次拉全所有分页，课程筛选条在全部分页间保持
 * 稳定，分组视图展示全部条目（当前页克隆 PTA 原卡片，其余页按接口数据重建）。
 * 课程识别：用户规则（关键词=>课程）> 分隔符 > 类型关键词 > 未分类。
 * PTA 是 React SPA，列表会被重渲染，因此用 MutationObserver + 签名比对
 * 自动重建本插件视图；插件 DOM 全部挂在 .bps-root 下，便于整体装卸。
 */
(() => {
  'use strict';
  if (window.__BPS_LOADED__) return;
  window.__BPS_LOADED__ = true;

  const DEFAULTS = {
    enabled: true,          // 总开关
    badge: true,            // 卡片上的课程徽章
    countdown: true,        // 截止倒计时（仅剩 ≤7 天时显示）
    separators: '--,｜,|',  // 课程名分隔符：取首个分隔符之前的部分作为课程名
    rules: '',              // 自定义规则，每行一条：关键词=>课程名（包含匹配，优先于自动识别）
    mergeSimilar: true,     // 同一教师下相似课程名自动归并为同一门课
    settingsVersion: 0,     // 0 = 旧版设置；init 时迁移到 v4（移除 grouped，改为按路由的会话内状态）
  };

  // 各路由的默认视图：所有列表页均默认「列表」（PTA 原生分页可用）；
  // 分组视图通过筛选条上的 toggle 会话内切换。保留函数形式便于将来按路由定制。
  function defaultGroupedFor() {
    return false;
  }
  const PAGE_SIZE = 30;

  // 仅在这些列表页生效；题目集详情页、dashboard 等不受影响
  const LIST_PATH_RE = /^\/problem-sets(?:\/(active|all|finished|mine))?\/?$/;
  const SET_HREF_RE = /^\/problem-sets\/(\d+)\/overview$/;
  const API_URL_RE = /pintia\.cn\/api\/problem-sets(\?|$)/;
  // 无分隔符时，从标题中识别「课程名 + 类型词」的关键词（exec 循环会跳过无法成课的命中）
  const KEYWORD_RE = /(课堂练习|课堂测试|课堂作业|课堂测验|随堂练习|复习题|上机|随堂|实验|作业|测验|考试|测试|练习|期中|期末|项目|Lab|HW)/gi;
  const AGG_TTL = 2 * 60 * 1000;

  /* ---------- 存储：扩展环境用 chrome.storage.sync，预览页退化为内存 ---------- */
  const storage = {
    async get() {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
          const { settings } = await chrome.storage.sync.get({ settings: {} });
          return { ...DEFAULTS, ...settings };
        }
      } catch (_) { /* fall through */ }
      return { ...DEFAULTS, ...(window.__BPS_SETTINGS__ || {}) };
    },
    async set(next) {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
          await chrome.storage.sync.set({ settings: next });
          return;
        }
      } catch (_) { /* fall through */ }
      window.__BPS_SETTINGS__ = next;
    },
    onChanged(cb) {
      if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'sync' && changes.settings) cb({ ...DEFAULTS, ...changes.settings.newValue });
        });
      }
    },
  };

  /* ---------- 通用 ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }

  function hashHue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- 课程识别（规则 > 分隔符 > 类型关键词 > 未分类） ---------- */
  function parseRules(settings) {
    return (settings.rules || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const i = l.indexOf('=>');
        if (i <= 0) return null;
        const key = l.slice(0, i).trim();
        const course = l.slice(i + 2).trim();
        return key && course ? { key, course } : null;
      })
      .filter(Boolean);
  }

  // 课程名整理：去掉尾部残留的分隔符；拒绝空名与纯数字（如年份 "2025"）
  function tidyCourse(s) {
    s = String(s).trim();
    for (;;) {
      const before = s;
      s = s.replace(/(?:--|｜|\||—|-|·)+$/, '').trim();
      if (s === before) break;
    }
    if (!s || /^[\d\s.\-—·｜|]+$/.test(s)) return null;
    return s;
  }

  function splitCourse(title, separators) {
    // 1) 分隔符：取最早出现者，左侧为课程名
    let best = -1;
    for (const sep of separators) {
      const i = title.indexOf(sep);
      if (i > 0 && (best === -1 || i < best)) best = i;
    }
    if (best > 0) {
      const c = tidyCourse(title.slice(0, best));
      if (c) return c;
    }
    // 2) 类型关键词：从左到右找到第一个能构成有效课程名的命中
    KEYWORD_RE.lastIndex = 0;
    let m;
    while ((m = KEYWORD_RE.exec(title))) {
      if (m.index >= 3) {
        const c = tidyCourse(title.slice(0, m.index));
        if (c) return c;
      }
    }
    // 3) 兜底：老师常用 "2025-xxx" 学年前缀命名，前缀本身作课程名（纯数字名仅在此接受）
    const ym = /^(\d{4})[-—·]/.exec(title);
    if (ym) return ym[1];
    return null;
  }

  function classifyDetailed(title, settings) {
    for (const r of parseRules(settings)) {
      if (title.includes(r.key)) return { course: r.course, locked: true };
    }
    return {
      course: splitCourse(title, settings.separators.split(',').map(x => x.trim()).filter(Boolean)),
      locked: false,
    };
  }

  function classify(title, settings) {
    return classifyDetailed(title, settings).course;
  }

  /* ---------- 同教师相似课程归并（教师粗分 → 最长公共子串细分） ---------- */
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

  // 课程名很长都很短，O(n*m) 足够；阈值取 max(4, 短名长度的 60%)，
  // 例如 "2025"~"2025-期中"(LCS=4)、"2024程序设计基础"~"…-242"(LCS=11) 归并，
  // 而 "2024"~"2025"(LCS=3)、"操作系统"~"操作实训"(LCS=2) 不归并
  function shouldMergeCourses(a, b) {
    const min = Math.min(a.length, b.length);
    return lcsLength(a, b) >= Math.max(4, Math.ceil(min * 0.6));
  }

  // pairs: [{title, teacher}]；返回 Map<旧课程名, 归并后课程名>。
  // 规则命中的课程名（locked）是用户显式意图，不参与归并也不被改名。
  function buildCourseRenameMap(pairs, settings) {
    const cls = pairs.map(p => ({ ...classifyDetailed(p.title, settings), teacher: p.teacher }));
    const counts = new Map();
    const byTeacher = new Map();
    for (const c of cls) {
      if (!c.course) continue;
      counts.set(c.course, (counts.get(c.course) || 0) + 1);
      if (c.locked || !c.teacher) continue;
      (byTeacher.get(c.teacher) || byTeacher.set(c.teacher, []).get(c.teacher)).push(c.course);
    }
    const nameMap = new Map();
    for (const names of byTeacher.values()) {
      const uniq = [...new Set(names)];
      if (uniq.length < 2) continue;
      const parent = uniq.map((_, i) => i);
      const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          if (shouldMergeCourses(uniq[i], uniq[j])) parent[find(i)] = find(j);
        }
      }
      const clusters = new Map();
      uniq.forEach((n, i) => {
        const r = find(i);
        (clusters.get(r) || clusters.set(r, []).get(r)).push(n);
      });
      for (const members of clusters.values()) {
        if (members.length < 2) continue;
        // 组名取条目最多的名字（并列取最短的基础名）
        const canonical = members
          .map(n => ({ n, count: counts.get(n) || 0 }))
          .sort((a, b) => b.count - a.count || a.n.length - b.n.length)[0].n;
        for (const n of members) if (n !== canonical) nameMap.set(n, canonical);
      }
    }
    return nameMap;
  }

  /* ---------- 时间 ---------- */
  // "关闭时间: 12:22"（当天）或 "关闭时间: 2026-10-17 23:59"
  function parseCloseTime(text) {
    const m = /关闭时间[:：]\s*(?:(\d{4})-(\d{1,2})-(\d{1,2}))?\s*(?:(\d{1,2}):(\d{2}))?/.exec(text || '');
    if (!m || (!m[1] && !m[4])) return null;
    if (m[1]) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const d = new Date();
    d.setHours(+m[4], +m[5], 0, 0);
    return d;
  }

  // Date -> "YYYY-MM-DD HH:mm"（整点零分与 PTA 一致省略时刻）
  function fmtCloseLocal(d) {
    if (!d) return '';
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return hm === '00:00' ? date : `${date} ${hm}`;
  }

  // 剩余时间文案；已截止或 >7 天返回 null（不显示）
  function fmtCountdown(closeAt, now = Date.now()) {
    const ms = closeAt - now;
    if (ms <= 0) return null;
    const min = Math.floor(ms / 60000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (hr < 1) return { text: `剩 ${min} 分钟`, level: 3 };
    if (hr < 24) return { text: `剩 ${hr} 小时`, level: 3 };
    if (hr < 48) return { text: `剩 ${day} 天 ${hr - day * 24} 小时`, level: 2 };
    if (day <= 7) return { text: `剩 ${day} 天`, level: 1 };
    return null;
  }

  /* ---------- DOM 解析与卡片装饰 ---------- */
  // 从当前 DOM 提取列表条目（排除本插件生成的克隆节点）
  function extractItems(settings) {
    const anchors = [...document.querySelectorAll('main a[href]')]
      .filter(a => SET_HREF_RE.test(a.getAttribute('href') || '') && !a.closest('.bps-root'));
    const seen = new Set();
    const items = [];
    for (const el of anchors) {
      const id = el.getAttribute('href').match(SET_HREF_RE)[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const titleEl = el.querySelector('div[title]');
      const title = (titleEl?.getAttribute('title') || titleEl?.textContent || el.textContent || '').trim();
      const fullText = el.textContent || '';
      items.push({
        id, el, title,
        ...classifyDetailed(title, settings),
        nativeCountdown: /距离关闭/.test(fullText), // PTA 自带精确倒计时的卡片不再叠加我们的
        closeText: (/关闭时间[:：]\s*[\d: -]+/.exec(fullText)?.[0] || '').trim(),
        closeAt: parseCloseTime(fullText),
      });
    }
    return items;
  }

  // 副标题行：PTA 结构为 .text-xs > .flex > .flex > "关闭时间:<span>"
  function metaLine(scopeEl) {
    return [...scopeEl.querySelectorAll('.text-xs')]
      .find(n => /关闭时间/.test(n.textContent) && n.querySelector('.flex'));
  }

  function updateCountdown(scopeEl, it, s) {
    const line = metaLine(scopeEl);
    if (!line) return;
    const target = line.querySelector('.flex .flex') || line.querySelector('.flex');
    let c = scopeEl.querySelector('.bps-countdown');
    const cd = s.countdown && it.closeAt && !it.nativeCountdown ? fmtCountdown(it.closeAt) : null;
    if (!cd) { c?.remove(); return; }
    if (!c) {
      c = document.createElement('span');
      c.className = 'bps-countdown';
      target.append(c);
    }
    const stamp = `${cd.text}|${cd.level}`;
    if (c.dataset.stamp !== stamp) {
      c.dataset.stamp = stamp;
      c.textContent = cd.text;
      c.dataset.level = String(cd.level);
      c.title = `关闭时间 ${fmtCloseLocal(it.closeAt)}`;
    }
  }

  function decorate(it, s) {
    const el = it.el;
    if (s.badge && it.course) {
      const line = metaLine(el);
      if (line) {
        const target = line.querySelector('.flex .flex') || line.querySelector('.flex');
        let b = el.querySelector('.bps-badge');
        if (!b) {
          b = document.createElement('span');
          b.className = 'bps-badge';
          target.prepend(b);
        }
        if (b.textContent !== it.course) {
          b.textContent = it.course;
          b.style.setProperty('--h', String(hashHue(it.course)));
        }
      }
    }
    updateCountdown(el, it, s);
  }

  /* ---------- 跨页聚合：复用页面自身的列表接口 ---------- */
  const agg = { key: null, items: null, at: 0, inflight: null, abort: null, retryAt: 0 };
  const routeUrls = new Map();   // pathname -> { url: 该页自己的列表请求, entryTime }
  let lastApiEntryTime = 0;
  let lastPath = null;

  function canonicalApiUrl(raw) {
    if (String(raw).startsWith('mock://')) return raw; // 预览页测试数据源
    try {
      const u = new URL(raw);
      if (u.hostname !== 'pintia.cn' || u.pathname !== '/api/problem-sets') return null;
      u.searchParams.delete('page');
      u.searchParams.delete('limit'); // 聚合时统一改写为 100，避免缓存键漂移
      return u.toString();
    } catch (_) { return null; }
  }

  // 消费 resource timing 里新出现的列表请求，记录到「它发出时所在的路径」名下。
  // 不能直接取「全局最新请求」：快速切换标签（所有→活跃→没加载完就切回）时，
  // 最新请求可能是另一个页面的，会把活跃页数据渲染到所有题目集页上。
  function trackRouteApiUrl() {
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      state.filter = 'ALL';                       // 换页后筛选回到全部，避免上一页的筛选造成误解
      state.grouped = defaultGroupedFor();        // 每个路由进入时恢复其默认视图
      state.page = 1;
    }
    for (const e of performance.getEntriesByType('resource')) {
      if (e.startTime <= lastApiEntryTime || !API_URL_RE.test(e.name)) continue;
      lastApiEntryTime = e.startTime;
      const key = canonicalApiUrl(e.name);
      if (!key) continue;
      const rec = routeUrls.get(path);
      if (!rec || e.startTime > rec.entryTime) routeUrls.set(path, { url: key, entryTime: e.startTime });
    }
  }

  function currentRouteApiUrl() {
    trackRouteApiUrl(); // 先记账/应用路由默认视图，再决定数据源
    if (window.__BPS_FORCE_LIST__ && window.__BPS_MOCK_API__) return 'mock://problem-sets'; // 预览页测试数据源
    return routeUrls.get(location.pathname)?.url || null;
  }

  async function fetchJson(url, signal) {
    if (window.__BPS_FETCH_JSON__) return window.__BPS_FETCH_JSON__(url); // 预览页测试注入
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' }, signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // 徽章推导：未开始→未开放；已开始→已开考(仅关联考试的题目集,参照 PTA 现状)+已开放/已关闭
  function normalizeApiItems(list, examMap) {
    const now = Date.now();
    return (list || []).map(p => {
      const startAt = p.startAt ? new Date(p.startAt) : null;
      const closeAt = p.endAt ? new Date(p.endAt) : null;
      const started = startAt && now >= +startAt;
      const closed = closeAt && now >= +closeAt;
      const isExam = !!(examMap && examMap[p.id]);
      const badges = [];
      if (!started) badges.push(['未开放', 'orange']);
      else {
        // 已开考徽章只在开放中或临近关闭（7 天内）的考试型题目集上展示，与 PTA 现状一致
        if (isExam && (!closed || now - +closeAt < 7 * 86400000)) badges.push(['已开考', 'green']);
        badges.push([closed ? '已关闭' : '已开放', closed ? 'grey' : 'blue']);
      }
      return {
        id: String(p.id),
        title: p.name || '',
        startAt, closeAt, badges,
        creator: p.ownerNickname || '',
        org: p.organizationName || '',
      };
    });
  }

  async function aggregateAll(keyUrl, signal) {
    const u = new URL(keyUrl);
    u.searchParams.set('page', '0');
    u.searchParams.set('limit', '100'); // 实测服务端支持一次拉全
    const data = await fetchJson(String(u), signal);
    const examMap = { ...(data.examIdByProblemSetId || {}) };
    let items = normalizeApiItems(data.problemSets, examMap);
    const total = data.total ?? items.length;
    if (items.length < total) {
      const pageSize = items.length;
      for (let page = 1; items.length < total && page < 60; page++) {
        u.searchParams.set('page', String(page));
        const d = await fetchJson(String(u), signal);
        Object.assign(examMap, d.examIdByProblemSetId || {});
        const batch = normalizeApiItems(d.problemSets, examMap);
        if (!batch.length) break;
        items.push(...batch);
        if (batch.length < pageSize) break;
      }
    }
    const seen = new Set();
    return items.filter(i => !seen.has(i.id) && seen.add(i.id));
  }

  // 发起一次聚合。状态更新全部按 key 守卫：快速切换路由时旧请求会被 abort，
  // 其 settle 回调不得覆盖新路由的聚合状态（否则会把 A 页数据错缓存给 B 页，或
  // 提前清掉 B 的 inflight 导致重复请求）。失败不清空已有数据——过期后暂用上次
  // 结果（可能略旧），30s 后自动重试；仅在从未成功过时才退回当前页数据。
  function startAggregate(key) {
    if (agg.inflight && agg.key === key) return;             // 同一路由已在拉取
    if (agg.key === key && Date.now() < agg.retryAt) return; // 同一路由失败退避
    agg.abort?.abort();                                      // 旧路由的在途请求作废
    agg.key = key;
    const ctrl = new AbortController();
    agg.abort = ctrl;
    const settled = p => {
      if (agg.inflight === p) { agg.inflight = null; agg.abort = null; }
      sync(true);
    };
    const p = aggregateAll(key, ctrl.signal)
      .then(items => {
        if (agg.key !== key) return;
        agg.items = items;
        agg.at = Date.now();
        agg.retryAt = 0;
      })
      .catch(err => {
        if (agg.key !== key || err?.name === 'AbortError') return; // 旧路由/已中止：静默
        agg.retryAt = Date.now() + 30 * 1000;
        console.warn(`[更好的题目集] 跨页聚合失败（${err?.message || err}），暂用${agg.items ? '上次聚合结果' : '当前页数据'}，30 秒后自动重试`);
      })
      .finally(() => settled(p));
    agg.inflight = p;
  }

  function ensureAggregate() {
    const key = currentRouteApiUrl();
    if (!key) return null;
    if (agg.key !== key) startAggregate(key);   // 换路由：立即取新数据，旧数据作废
    if (agg.key === key && agg.items) {
      if (Date.now() - agg.at < AGG_TTL) return agg.items;
      startAggregate(key);                      // 过期：后台刷新，先给上次结果顶住
      return agg.items;
    }
    if (Date.now() < agg.retryAt) return null;  // 失败退避，避免每 3s 重试
    if (!agg.inflight) startAggregate(key);
    return null;
  }

  /* ---------- API 卡片构建（非当前页条目，复用 PTA 的样式类） ---------- */
  function pillHtml([label, tone]) {
    const bg = { green: 'bg-green-500', blue: 'bg-blue-500', orange: 'bg-orange-500', grey: 'bg-bg-light' }[tone] || 'bg-bg-light';
    const color = { green: 'pc-color-pass', blue: 'pc-color-primary', orange: 'pc-color-warning', grey: 'pc-color-light' }[tone] || 'pc-color-light';
    return `<div class="rounded-xl ${bg} bg-opacity-10 px-3 py-1 inline-block whitespace-nowrap flex-none"><div class="flex items-center space-x-1"><div class="pc-text ${color} pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>${escapeHtml(label)}</span></div></div></div></div>`;
  }

  function buildApiCard(ai) {
    const a = document.createElement('a');
    a.href = `/problem-sets/${ai.id}/overview`;
    a.className = 'flex py-3 px-4 items-center space-x-2 rounded-lg bg-bg-base shadow-sm hover:shadow-md transition-shadow hover:no-underline';
    a.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24" style="width:34px;height:34px;color:#adb5bd;flex:none"><rect x="2" y="4" width="20" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <div class="flex items-center space-x-2 flex-1"><div class="flex-1 space-y-1">
        <div title="${escapeHtml(ai.title)}" class="text-sm text-normal font-bold ellipsis-m">${escapeHtml(ai.title)}</div>
        <div class="text-xs text-light ellipsis whitespace-nowrap"><div class="flex space-x-2"><div class="flex space-x-2">关闭时间:<span>${fmtCloseLocal(ai.closeAt)}</span></div></div></div>
      </div></div>
      <div class="flex-none flex-col items-end space-y-1 flex"><div><div class="flex space-x-2 items-center">${ai.badges.map(pillHtml).join('')}</div></div></div>
      <div class="text-xs text-light flex-none hidden md:flex">${escapeHtml(ai.creator)}</div>`;
    return a;
  }

  // 统一条目：优先用聚合数据（全部分页 + 教师归并），接口不可用时退回当前页
  function unifiedItems(domItems, settings, renameMap) {
    const aggItems = ensureAggregate();
    if (!aggItems) return domItems.map(d => ({ ...d, fromDom: true }));
    const domById = new Map(domItems.map(i => [i.id, i.el]));
    return aggItems.map(ai => {
      const el = domById.get(ai.id);
      const det = classifyDetailed(ai.title, settings);
      return {
        id: ai.id,
        title: ai.title,
        course: det.locked ? det.course : (renameMap.get(det.course) || det.course),
        closeAt: ai.closeAt,
        closeText: fmtCloseLocal(ai.closeAt),
        el: el || buildApiCard(ai),
        fromDom: !!el,
      };
    });
  }

  /* ---------- 渲染 ---------- */
  let settings = { ...DEFAULTS };
  const state = {
    filter: 'ALL',
    grouped: false,         // 当前路由的视图模式（进入路由时取默认，会话内可切换，不持久化）
    page: 1,                // 分组视图的当前页（整组分页）
    collapsed: new Set(),   // 已折叠的课程名（仅分组视图）
    sig: '',
    root: null,
    bar: null,              // 原生列表模式下筛选条独立插入（不包在 .bps-root 里）
    items: [],
  };

  function collectGroups(items) {
    const groups = new Map();
    for (const it of items) {
      const key = it.course || '未分类';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    return groups;
  }

  function buildChipBar(groups) {
    const bar = document.createElement('div');
    bar.className = 'bps-chips';
    const now = Date.now();
    // 课程级开放状态：还有未关闭题目集的课程计数高亮（部分关闭时显示 开放/总数），
    // 已全部关闭的课程整颗灰显——筛选条上一眼区分还在开放的课和已结的课
    const mk = (key, label, list) => {
      const total = list.length;
      const isCourse = key !== 'ALL';
      const openCount = isCourse ? list.filter(i => !i.closeAt || +i.closeAt > now).length : 0;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'bps-chip' + (state.filter === key ? ' bps-on' : '');
      if (isCourse && openCount === 0) chip.classList.add('bps-off');
      const name = document.createElement('span');
      name.className = 'bps-chip-name';
      name.textContent = label;
      const num = document.createElement('span');
      num.className = 'bps-chip-num';
      if (isCourse && openCount > 0 && openCount < total) {
        num.classList.add('bps-num-open');
        num.textContent = `${openCount}/${total}`;
      } else {
        if (isCourse && openCount > 0) num.classList.add('bps-num-open');
        num.textContent = String(total);
      }
      if (isCourse) {
        chip.title = openCount > 0
          ? `还有 ${openCount} 个题目集未关闭（共 ${total} 个）`
          : '该课程的题目集已全部关闭';
      }
      chip.append(name, num);
      chip.addEventListener('click', () => {
        if (state.filter === key) return;
        state.filter = key;
        state.page = 1;
        sync(true); // 内容按筛选重建：全部=列表/分组，具体课程=平铺
      });
      return chip;
    };
    bar.appendChild(mk('ALL', '全部', state.items));
    for (const [course, list] of groups) bar.appendChild(mk(course, course, list));
    // 列表/分组切换只影响「全部」：选中具体课程时不渲染 toggle
    if (state.filter === 'ALL') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'bps-chip bps-mode';
      toggle.textContent = state.grouped ? '切换为列表' : '切换为分组';
      toggle.addEventListener('click', () => {
        state.grouped = !state.grouped;   // 会话内切换，不持久化；进入路由时恢复默认
        state.page = 1;
        sync(true);
      });
      bar.appendChild(toggle);
    }
    return bar;
  }

  function buildGroup(course, list) {
    const sec = document.createElement('section');
    sec.className = 'bps-group';
    sec.dataset.course = course;

    const times = list.map(i => i.closeAt?.getTime()).filter(Boolean);
    const earliest = times.length ? new Date(Math.min(...times)) : null;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'bps-head';
    head.innerHTML = `
      <span class="bps-caret${state.collapsed.has(course) ? ' bps-folded' : ''}"></span>
      <span class="bps-dot" style="--h:${hashHue(course)}"></span>
      <span class="bps-name"></span>
      <span class="bps-count"></span>
      <span class="bps-space"></span>
      ${earliest ? '<span class="bps-deadline"></span>' : ''}`;
    head.querySelector('.bps-name').textContent = course;
    head.querySelector('.bps-count').textContent = `${list.length} 个`;
    if (earliest) {
      head.querySelector('.bps-deadline').textContent =
        `最近关闭 ${pad(earliest.getMonth() + 1)}-${pad(earliest.getDate())} ${pad(earliest.getHours())}:${pad(earliest.getMinutes())}`;
    }

    const box = document.createElement('div');
    box.className = 'bps-items';
    const folded = state.collapsed.has(course);
    if (folded) box.classList.add('bps-hidden');
    const frag = document.createDocumentFragment();
    for (const it of list) {
      const c = it.el.cloneNode(true);
      c.classList.add('bps-clone');
      frag.appendChild(c);
    }
    box.appendChild(frag);

    head.addEventListener('click', () => {
      const next = !state.collapsed.has(course);
      if (next) state.collapsed.add(course); else state.collapsed.delete(course);
      head.querySelector('.bps-caret').classList.toggle('bps-folded', next);
      box.classList.toggle('bps-hidden', next);
    });

    sec.append(head, box);
    return sec;
  }

  // 整组分页：按聚合顺序把整组装进页（页容量 PAGE_SIZE），组不跨页
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
    const card = document.createElement('div');
    card.className = 'bps-pager';
    const summary = document.createElement('div');
    summary.className = 'bps-pager-summary';
    summary.textContent = `共 ${total} 条数据`;
    const nav = document.createElement('div');
    nav.className = 'bps-pager-nav';
    const go = p => {
      if (p < 1 || p > totalPages || p === state.page) return;
      state.page = p;
      sync(true);
      // 翻页后回到列表顶部
      const anchor = state.root;
      if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'instant' });
    };
    const btn = (label, page, disabled) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bps-pager-btn' + (page === state.page ? ' bps-on' : '');
      b.textContent = label;
      b.disabled = !!disabled;
      b.addEventListener('click', () => go(page));
      return b;
    };
    nav.append(btn('‹', state.page - 1, state.page <= 1));
    for (let p = 1; p <= totalPages; p++) nav.append(btn(String(p), p, false));
    nav.append(btn('›', state.page + 1, state.page >= totalPages));
    card.append(summary, nav);
    return card;
  }

  // 内容状态机：
  //  - 全部 + 列表（活跃默认）：PTA 原生列表保持可见（徽章/倒计时已注入，分页可用），
  //    筛选条直接插入列表容器旁——sticky 的包含块须覆盖整个列表高度才能全程吸附；
  //  - 全部 + 分组（所有默认）：聚合分组区段，整组分页（PAGE_SIZE），隐藏原生列表与分页条；
  //  - 选中具体课程：该课程聚合平铺（单课程无需分页），隐藏原生列表与分页条。
  // 排序一律沿用 PTA 当前排序。
  function renderContent(listEl, items) {
    const groups = collectGroups(items);
    const bar = buildChipBar(groups);
    const nativeListMode = state.filter === 'ALL' && !state.grouped;

    if (nativeListMode) {
      bar.dataset.bpsBar = '1';
      listEl.before(bar);
      state.root = null;
      state.bar = bar;
      return;
    }

    const root = document.createElement('div');
    root.className = 'bps-root';
    root.appendChild(bar);

    if (state.grouped && state.filter === 'ALL') {
      const pages = packPages(groups);
      if (state.page > pages.length) state.page = pages.length;
      const page = pages[state.page - 1];
      for (const [course, list] of page.groups) root.appendChild(buildGroup(course, list));
      if (pages.length > 1) root.appendChild(buildPager(items.length, pages.length));
    } else {
      // 走到这里 filter 必为具体课程（全部+列表已在上方走原生分支）
      const shown = items.filter(i => (i.course || '未分类') === state.filter);
      const box = document.createElement('div');
      box.className = 'bps-flat';
      const frag = document.createDocumentFragment();
      for (const it of shown) {
        const c = it.el.cloneNode(true);
        c.classList.add('bps-clone');
        frag.appendChild(c);
      }
      box.appendChild(frag);
      root.appendChild(box);
    }

    listEl.before(root);
    listEl.style.display = 'none';
    setPagingHidden(true);
    state.root = root;
    state.bar = null;
  }

  // 分组视图接管全部条目后，隐藏 PTA 自身的分页条/条数文案，切回列表模式时恢复
  function setPagingHidden(hide) {
    for (const w of document.querySelectorAll('main [class*="paginationWrapper"], main [class*="paginationSummary"]')) {
      const card = w.closest('div.bg-bg-base') || w;
      const want = hide ? 'none' : '';
      if (card.style.display !== want) card.style.display = want;
    }
  }

  function removeRoot() {
    document.querySelectorAll('.bps-root').forEach(n => n.remove());
    document.querySelectorAll('[data-bps-bar]').forEach(n => n.remove());
    document.querySelectorAll('main .pc-list').forEach(n => { if (n.style.display) n.style.display = ''; });
    setPagingHidden(false);
    state.root = null;
    state.bar = null;
  }

  function teardown() {
    removeRoot();
    document.querySelectorAll('.bps-badge, .bps-countdown').forEach(n => n.remove());
    state.sig = '';
    state.items = [];
  }

  function refreshCountdowns() {
    for (const it of state.items) updateCountdown(it.el, it, settings);
    // 分组视图中的克隆卡片不在 state.items 里，单独刷一遍
    for (const c of document.querySelectorAll('.bps-countdown')) {
      const a = c.closest('a[href]');
      const id = a && (a.getAttribute('href').match(SET_HREF_RE) || [])[1];
      const it = state.items.find(i => i.id === id);
      if (it) updateCountdown(a, it, settings);
    }
  }

  let syncTimer = 0;
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => sync(), 200);
  }

  function sync(force = false) {
    try {
      // __BPS_FORCE_LIST__：preview.html 本地预览用的测试钩子，放开路径限制
      if (!settings.enabled || (!window.__BPS_FORCE_LIST__ && !LIST_PATH_RE.test(location.pathname))) {
        if (state.sig) teardown();
        return;
      }
      const domItems = extractItems(settings);
      if (!domItems.length) { if (state.root) removeRoot(); return; }

      // 列表容器：优先用 PTA 自身的 .pc-list，缺失时退化为条目的共同父节点
      let listEl = document.querySelector('main .pc-list');
      if (!listEl) {
        const parent = domItems[0].el.parentElement;
        listEl = domItems.every(i => i.el.parentElement === parent) ? parent : null;
      }
      if (!listEl) { if (state.root) removeRoot(); return; }

      // 同教师相似课程名归并（基于聚合数据；规则命中的名字不受影响）
      const aggItems = ensureAggregate();
      const renameMap = settings.mergeSimilar && aggItems
        ? buildCourseRenameMap(aggItems.map(ai => ({ title: ai.title, teacher: ai.creator })), settings)
        : new Map();
      const renamed = domItems.map(d => ({
        ...d,
        course: d.locked ? d.course : (renameMap.get(d.course) || d.course),
      }));

      renamed.forEach(it => decorate(it, settings)); // 原始卡片徽章/倒计时（列表模式直接可见）

      const uni = unifiedItems(renamed, settings, renameMap);
      state.items = uni;
      uni.forEach(it => decorate(it, settings)); // API 卡片补徽章/倒计时；DOM 卡片幂等

      // 签名含 DOM 条目指纹与筛选/模式/页码：SPA 换页、筛选、模式、翻页都触发内容重建
      const domSig = domItems.map(i => i.id).join(',');
      const sig = `${state.grouped}#${state.filter}#${state.page}#${domSig}#${uni.map(i => `${i.id}|${i.course}|${i.closeText}`).join(';')}`;
      // 默认态（全部+列表）要求原生列表可见；分组/课程筛选态要求其隐藏
      const nativeListMode = state.filter === 'ALL' && !state.grouped;
      const hiddenOk = nativeListMode ? listEl.style.display !== 'none' : listEl.style.display === 'none';
      const anchor = state.root || state.bar;
      if (!force && anchor && state.sig === sig && hiddenOk && document.contains(anchor)) {
        refreshCountdowns();
        setPagingHidden(!nativeListMode);
        return;
      }

      state.sig = sig;
      removeRoot();
      renderContent(listEl, uni);
    } catch (err) {
      console.warn('[更好的题目集] sync 失败:', err);
    }
  }

  async function init() {
    settings = await storage.get();
    // v4 迁移：列表/分组改为按路由的会话内状态（活跃=列表、其余=分组），不再持久化
    if (!settings.settingsVersion || settings.settingsVersion < 4) {
      delete settings.grouped;
      settings.settingsVersion = 4;
      await storage.set(settings);
    }
    storage.onChanged(s => { settings = s; sync(true); });

    try { performance.setResourceTimingBufferSize(1000); } catch (_) { /* ignore */ }

    // React 重渲染 / SPA 路由切换 → 重建视图；插件自身的 DOM 变动不触发
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        const relevant = [...m.addedNodes, ...m.removedNodes]
          .some(n => n.nodeType === 1 && !n.closest?.('.bps-root'));
        if (relevant) { scheduleSync(); return; }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    setInterval(() => sync(), 3000);                    // 兜底：路由切换 / 遗漏的变动
    setInterval(() => { if (state.root) refreshCountdowns(); }, 60000);

    sync(true);
  }

  window.BPS = {
    init, sync, teardown, DEFAULTS,
    setSettings: async patch => {
      settings = { ...settings, ...patch };
      await storage.set(settings);
      sync(true);
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
})();
