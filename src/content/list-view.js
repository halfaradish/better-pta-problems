/* 列表视图：三种内容形态的渲染与状态机。
 *
 *  - 全部 + 列表：PTA 原生列表保持可见（徽章/倒计时已注入，分页可用），筛选条直接
 *    插入列表容器旁——sticky 的包含块须覆盖整个列表高度才能全程吸附；
 *  - 全部 + 分组：聚合分组区段，整组分页（PAGE_SIZE），隐藏原生列表与分页条；
 *  - 选中具体课程：该课程聚合平铺（单课程无需分页），隐藏原生列表与分页条。
 * 排序一律沿用 PTA 当前排序。
 *
 * 与入口（sync）之间用 hooks 解耦：rerender 由入口注入，避免本模块反向 import 入口
 * 造成循环依赖。
 */
import { SET_HREF_RE } from '../shared/paths.js';
import { fmtCloseLocal, pad } from '../shared/time.js';
import { escapeHtml, hashHue } from '../shared/util.js';
import { classifyDetailed } from './classify.js';
import { updateCountdown } from './decorate.js';

export const PAGE_SIZE = 30;

// 各路由的默认视图：所有列表页均默认「列表」（PTA 原生分页可用）；
// 分组视图通过筛选条上的 toggle 会话内切换。保留函数形式便于将来按路由定制。
export function defaultGroupedFor() {
  return false;
}

export const state = {
  filter: 'ALL',
  grouped: false,         // 当前路由的视图模式（进入路由时取默认，会话内可切换，不持久化）
  page: 1,                // 分组视图的当前页（整组分页）
  collapsed: new Set(),   // 已折叠的课程名（仅分组视图）
  sig: '',
  root: null,
  bar: null,              // 原生列表模式下筛选条独立插入（不包在 .bps-root 里）
  items: [],
};

let hooks = {};

export function setViewHooks(next) {
  hooks = { ...hooks, ...next };
}

// 换路由时恢复该路由的默认视图与筛选；折叠状态保持（会话内复用）
export function resetForRoute() {
  state.filter = 'ALL';
  state.grouped = defaultGroupedFor();
  state.page = 1;
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
export function unifiedItems(domItems, settings, renameMap, aggItems) {
  if (!aggItems) return domItems.map(d => ({ ...d, fromDom: true }));
  const domById = new Map(domItems.map(i => [i.id, i.el]));
  return aggItems.map(ai => {
    const el = domById.get(ai.id);
    const det = classifyDetailed(ai.title, settings);
    return {
      id: ai.id,
      title: ai.title,
      course: det.locked ? det.course : (renameMap.get(det.course) || det.course),
      startAt: ai.startAt,
      closeAt: ai.closeAt,
      closeText: fmtCloseLocal(ai.closeAt),
      examId: ai.examId || '',   // 答题进度的取数钥匙（入口据此挂 it.progress）
      el: el || buildApiCard(ai),
      fromDom: !!el,
    };
  });
}

/* ---------- 筛选条 / 分组 / 分页 ---------- */
export function collectGroups(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.course || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return groups;
}

export function buildChipBar(groups) {
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
      hooks.rerender?.(); // 内容按筛选重建：全部=列表/分组，具体课程=平铺
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
      hooks.rerender?.();
    });
    bar.appendChild(toggle);
  }
  return bar;
}

export function buildGroup(course, list) {
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
export function packPages(groups) {
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

export function buildPager(total, totalPages) {
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
    hooks.rerender?.();
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

/* ---------- 内容状态机 ---------- */
export function renderContent(listEl, items) {
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
export function setPagingHidden(hide) {
  for (const w of document.querySelectorAll('main [class*="paginationWrapper"], main [class*="paginationSummary"]')) {
    const card = w.closest('div.bg-bg-base') || w;
    const want = hide ? 'none' : '';
    if (card.style.display !== want) card.style.display = want;
  }
}

export function removeRoot() {
  document.querySelectorAll('.bps-root').forEach(n => n.remove());
  document.querySelectorAll('[data-bps-bar]').forEach(n => n.remove());
  document.querySelectorAll('main .pc-list').forEach(n => { if (n.style.display) n.style.display = ''; });
  setPagingHidden(false);
  state.root = null;
  state.bar = null;
}

export function teardown() {
  removeRoot();
  document.querySelectorAll('.bps-badge, .bps-countdown, .bps-done, .bps-answered').forEach(n => n.remove());
  state.sig = '';
  state.items = [];
}

export function refreshCountdowns(settings) {
  for (const it of state.items) updateCountdown(it.el, it, settings);
  // 分组视图中的克隆卡片不在 state.items 里，单独刷一遍
  for (const c of document.querySelectorAll('.bps-countdown')) {
    const a = c.closest('a[href]');
    const id = a && (a.getAttribute('href').match(SET_HREF_RE) || [])[1];
    const it = state.items.find(i => i.id === id);
    if (it) updateCountdown(a, it, settings);
  }
}
