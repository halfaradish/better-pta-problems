/* 跨页聚合：复用页面自身的列表接口，一次拉全所有分页。
 *
 * 状态更新全部按 key 守卫：快速切换路由时旧请求会被 abort，其 settle 回调不得覆盖
 * 新路由的聚合状态（否则会把 A 页数据错缓存给 B 页，或提前清掉 B 的 inflight 导致
 * 重复请求）。失败不清空已有数据——过期后暂用上次结果（可能略旧），30s 后自动重试；
 * 仅在从未成功过时才退回当前页数据。
 *
 * 与渲染 / 提醒之间用 hooks 解耦（本模块不关心谁在渲染、谁在推送）：
 *   onPathChange(path) 路由变化——调用方据此重置会话内的视图状态
 *   onSuccess()        聚合成功——提醒同步挂在这里，捕获会话中途改期
 *   onSettled()        每次请求落定——触发一次视图重建
 */
import { API_URL_RE } from '../shared/paths.js';

const AGG_TTL = 2 * 60 * 1000;

const agg = { key: null, items: null, at: 0, inflight: null, abort: null, retryAt: 0 };
const routeUrls = new Map();   // pathname -> { url: 该页自己的列表请求, entryTime }
let lastApiEntryTime = 0;
let lastPath = null;
let hooks = {};

export function setAggregateHooks(next) {
  hooks = { ...hooks, ...next };
}

// 当前聚合结果（可能为 null：尚未成功过），提醒推送取这里的原始条目
export function aggregateItems() {
  return agg.items;
}

export function canonicalApiUrl(raw) {
  if (String(raw).startsWith('mock://')) return raw; // 预览页测试数据源
  try {
    const u = new URL(raw);
    if (u.hostname !== 'pintia.cn' || u.pathname !== '/api/problem-sets') return null;
    if (u.searchParams.has('_bps')) return null; // 插件自身的提醒同步请求，不作为路由数据源
    u.searchParams.delete('page');
    u.searchParams.delete('limit'); // 聚合时统一改写为 100，避免缓存键漂移
    return u.toString();
  } catch (_) { return null; }
}

// 消费 resource timing 里新出现的列表请求，记录到「它发出时所在的路径」名下。
// 不能直接取「全局最新请求」：快速切换标签（所有→活跃→没加载完就切回）时，
// 最新请求可能是另一个页面的，会把活跃页数据渲染到所有题目集页上。
export function trackRouteApiUrl() {
  const path = location.pathname;
  if (path !== lastPath) {
    lastPath = path;
    hooks.onPathChange?.(path);
  }
  for (const e of performance.getEntriesByType('resource')) {
    if (e.startTime <= lastApiEntryTime || !API_URL_RE.test(e.name)) continue;
    if (e.name.includes('_bps=')) continue; // 插件自身的提醒同步请求，不消费也不推进水位线
    lastApiEntryTime = e.startTime;
    const key = canonicalApiUrl(e.name);
    if (!key) continue;
    const rec = routeUrls.get(path);
    if (!rec || e.startTime > rec.entryTime) routeUrls.set(path, { url: key, entryTime: e.startTime });
  }
}

export function currentRouteApiUrl() {
  trackRouteApiUrl(); // 先记账/应用路由默认视图，再决定数据源
  if (window.__BPS_FORCE_LIST__ && window.__BPS_MOCK_API__) return 'mock://problem-sets'; // 预览页测试数据源
  return routeUrls.get(location.pathname)?.url || null;
}

export async function fetchJson(url, signal) {
  if (window.__BPS_FETCH_JSON__) return window.__BPS_FETCH_JSON__(url); // 预览页测试注入
  const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' }, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// 徽章推导：未开始→未开放；已开始→已开考(仅关联考试的题目集,参照 PTA 现状)+已开放/已关闭
export function normalizeApiItems(list, examMap) {
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

export async function aggregateAll(keyUrl, signal) {
  const u = new URL(keyUrl);
  u.searchParams.set('page', '0');
  u.searchParams.set('limit', '100'); // 实测服务端支持一次拉全
  const data = await fetchJson(String(u), signal);
  const examMap = { ...(data.examIdByProblemSetId || {}) };
  const items = normalizeApiItems(data.problemSets, examMap);
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

export function startAggregate(key) {
  if (agg.inflight && agg.key === key) return;             // 同一路由已在拉取
  if (agg.key === key && Date.now() < agg.retryAt) return; // 同一路由失败退避
  agg.abort?.abort();                                      // 旧路由的在途请求作废
  agg.key = key;
  const ctrl = new AbortController();
  agg.abort = ctrl;
  const settled = p => {
    if (agg.inflight === p) { agg.inflight = null; agg.abort = null; }
    hooks.onSettled?.();
  };
  const p = aggregateAll(key, ctrl.signal)
    .then(items => {
      if (agg.key !== key) return;
      agg.items = items;
      agg.at = Date.now();
      agg.retryAt = 0;
      hooks.onSuccess?.();
    })
    .catch(err => {
      if (agg.key !== key || err?.name === 'AbortError') return; // 旧路由/已中止：静默
      agg.retryAt = Date.now() + 30 * 1000;
      console.warn(`[更好的题目集] 跨页聚合失败（${err?.message || err}），暂用${agg.items ? '上次聚合结果' : '当前页数据'}，30 秒后自动重试`);
    })
    .finally(() => settled(p));
  agg.inflight = p;
}

export function ensureAggregate() {
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
