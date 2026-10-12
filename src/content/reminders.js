/* 题目关闭邮件提醒：把未关闭题目集同步到用户自建后端。
 *
 * 两条推送路径，payload 同构（后端按邮箱全量替换订阅）：
 * 1) syncRemindersDirect：打开 PTA 任意页面（含 dashboard/详情页）后直连拉取一次
 *    「进行中」全集——防止只有打开「进行中」列表页才同步造成漏提醒。查询参数取自
 *    docs/核心结论.md §2 的实测结论（endAtAfter 过滤 + END_AT 升序 + limit=100）；
 *    这里是后台数据同步而非页面功能，允许硬编码，页面功能仍坚持重放页面自身请求。
 *    请求带 _bps 标记，aggregate 的路由记账会跳过，避免插件流量污染页面请求记账。
 * 2) pushAggregatedReminders：「进行中」页聚合成功后的新鲜度钩子，捕获会话中途改期等
 *    endAt 变化；仅限该路由——其余路由的聚合是筛选子集，按全量替换语义推子集会丢数据。
 */
import { ACTIVE_PATH_RE } from '../shared/paths.js';
import { aggregateAll, aggregateItems } from './aggregate.js';

const PUSH_MIN_INTERVAL = 30 * 60 * 1000;  // 聚合路径：签名未变时的最小重发间隔（endAt 不变就静默）
const DIRECT_MIN_INTERVAL = 5 * 60 * 1000; // 直连路径：同文档内配置未变时的最小重拉间隔

let lastPush = { sig: null, at: 0 };
let lastRemindCfg = { enabled: null, server: null, email: null };
let lastDirectAt = 0;

function reminderCfg(settings) {
  return {
    enabled: settings.reminderEnabled !== false,
    server: settings.reminderServer || '',
    email: settings.reminderEmail || '',
  };
}

// 与上次快照比对并更新；配置变更方获得一次 force 推送资格（如换了邮箱，签名虽同也要推）
function consumeRemindCfgChange(settings) {
  const cfg = reminderCfg(settings);
  const changed = cfg.enabled !== lastRemindCfg.enabled || cfg.server !== lastRemindCfg.server || cfg.email !== lastRemindCfg.email;
  lastRemindCfg = cfg;
  return changed;
}

function pushReminders(server, email, items, force = false) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return; // 预览页无扩展运行时
  const now = Date.now();
  const sets = (items || [])
    .filter(i => i.closeAt && +i.closeAt > now)
    .map(i => ({ id: i.id, title: i.title, endAt: i.closeAt.toISOString(), owner: i.creator, org: i.org }))
    .sort((a, b) => a.endAt.localeCompare(b.endAt));
  const sig = JSON.stringify(sets);
  if (!force && sig === lastPush.sig && now - lastPush.at < PUSH_MIN_INTERVAL) return;
  lastPush = { sig, at: now }; // 记在发送前：失败也等下一轮节流窗口，避免高频重试
  chrome.runtime.sendMessage({ type: 'BPS_SYNC', server, email, sets })
    .then(res => {
      if (res?.ok) console.info(`[更好的题目集] 邮件提醒订阅已同步（${sets.length} 个题目集）`);
      else console.warn('[更好的题目集] 邮件提醒同步失败:', res?.error || '未知错误');
    })
    .catch(err => console.warn('[更好的题目集] 邮件提醒同步失败:', err?.message || err));
}

// 预占直连节流窗口（init 调用）：若聚合钩子先完成推送，2s 后的直连到点不再重复拉取
export function armDirectCooldown() {
  lastDirectAt = Date.now();
}

// 打开 PTA 任意页面即同步一次「进行中」全集（init 延迟 2s 调用，避开页面首屏请求）
export function syncRemindersDirect(settings) {
  const changed = consumeRemindCfgChange(settings);
  const cfg = reminderCfg(settings);
  if (!cfg.enabled || !cfg.server || !cfg.email) return;
  const now = Date.now();
  if (!changed && now - lastDirectAt < DIRECT_MIN_INTERVAL) return;
  lastDirectAt = now;
  const u = new URL('/api/problem-sets', location.origin);
  u.searchParams.set('filter', JSON.stringify({ endAtAfter: new Date().toISOString() }));
  u.searchParams.set('page', '0');
  u.searchParams.set('limit', '100');
  u.searchParams.set('order_by', 'END_AT');
  u.searchParams.set('asc', 'true');
  u.searchParams.set('_bps', 'reminder'); // 标记插件自身的同步请求，路由记账据此跳过
  aggregateAll(String(u))
    .then(items => pushReminders(cfg.server, cfg.email, items, changed))
    .catch(err => console.warn(`[更好的题目集] 邮件提醒同步失败（拉取进行中题目集）: ${err?.message || err}`));
}

export function pushAggregatedReminders(settings) {
  const changed = consumeRemindCfgChange(settings);
  const cfg = reminderCfg(settings);
  if (!cfg.enabled || !cfg.server || !cfg.email || !ACTIVE_PATH_RE.test(location.pathname)) return;
  pushReminders(cfg.server, cfg.email, aggregateItems(), changed);
}
