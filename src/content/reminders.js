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
 *
 * 「已完成的不再提醒」（reminderSkipDone，默认开）：两条路径推送前都先把答题窗口内
 * 条目的进度拉齐（与列表胶囊共用 progress.js 的缓存），把「每道题都有提交/判分记录」
 * 的条目从 payload 里剔除——订阅是全量替换语义，剔除即后端不再提醒；之后做完了，
 * 下一次同步再进 payload（已发过的档位由后端 sent_log 去重，不会重发）。进度缺失
 * （未取到/失败/过期）一律按未完成保留——宁可多提醒，不漏提醒。
 */
import { ACTIVE_PATH_RE } from '../shared/paths.js';
import { aggregateAll, aggregateItems } from './aggregate.js';
import { ensureProgressAsync, isReminderDone } from './progress.js';

const PUSH_MIN_INTERVAL = 30 * 60 * 1000;  // 聚合路径：签名未变时的最小重发间隔（endAt 不变就静默）
const DIRECT_MIN_INTERVAL = 5 * 60 * 1000; // 直连路径：同文档内配置未变时的最小重拉间隔
const PROGRESS_WAIT_MS = 15 * 1000;        // 推送前等进度拉齐的上限：进度接口卡死也不拖住同步

let lastPush = { sig: null, at: 0 };
let lastRemindCfg = { enabled: null, skipDone: null, server: null, email: null };
let lastDirectAt = 0;

function reminderCfg(settings) {
  return {
    enabled: settings.reminderEnabled !== false,
    skipDone: settings.reminderSkipDone !== false,
    server: settings.reminderServer || '',
    email: settings.reminderEmail || '',
  };
}

// 与上次快照比对并更新；配置变更方获得一次 force 推送资格（如换了邮箱，签名虽同也要推）
function consumeRemindCfgChange(settings) {
  const cfg = reminderCfg(settings);
  const changed = cfg.enabled !== lastRemindCfg.enabled || cfg.skipDone !== lastRemindCfg.skipDone
    || cfg.server !== lastRemindCfg.server || cfg.email !== lastRemindCfg.email;
  lastRemindCfg = cfg;
  return changed;
}

// 订阅 payload：未关闭 + （开关开时）剔除已完成的条目。独立导出便于单测断言过滤口径；
// isDone 参数供测试注入（生产用 progress.js 的 isReminderDone）
export function buildSyncSets(items, { skipDone = false, isDone = isReminderDone } = {}) {
  const now = Date.now();
  return (items || [])
    .filter(i => i.closeAt && +i.closeAt > now)
    .filter(i => !skipDone || !isDone(i.id)) // 进度不可得时按未完成保留：宁可多提醒，不漏提醒
    .map(i => ({ id: i.id, title: i.title, endAt: i.closeAt.toISOString(), owner: i.creator, org: i.org }))
    .sort((a, b) => a.endAt.localeCompare(b.endAt));
}

function pushReminders(cfg, items, force = false) {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return; // 预览页无扩展运行时
  const now = Date.now();
  const sets = buildSyncSets(items, cfg);
  const sig = JSON.stringify(sets);
  if (!force && sig === lastPush.sig && now - lastPush.at < PUSH_MIN_INTERVAL) return;
  lastPush = { sig, at: now }; // 记在发送前：失败也等下一轮节流窗口，避免高频重试
  chrome.runtime.sendMessage({ type: 'BPS_SYNC', server: cfg.server, email: cfg.email, sets })
    .then(res => {
      if (res?.ok) console.info(`[更好的题目集] 邮件提醒订阅已同步（${sets.length} 个题目集）`);
      else console.warn('[更好的题目集] 邮件提醒同步失败:', res?.error || '未知错误');
    })
    .catch(err => console.warn('[更好的题目集] 邮件提醒同步失败:', err?.message || err));
}

// 推送前先把答题窗口内条目的进度拉齐，「已完成」判定才有数据；fetch 卡死按上限放行
//（进度后到的条目按未完成保留，随后一次同步会自我修正）
async function pushWithProgress(cfg, items, force) {
  if (cfg.skipDone) {
    await Promise.race([
      ensureProgressAsync(items),
      new Promise(resolve => setTimeout(resolve, PROGRESS_WAIT_MS)),
    ]);
  }
  pushReminders(cfg, items, force);
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
    .then(items => pushWithProgress(cfg, items, changed))
    .catch(err => console.warn(`[更好的题目集] 邮件提醒同步失败（拉取进行中题目集）: ${err?.message || err}`));
}

export function pushAggregatedReminders(settings) {
  const cfg = reminderCfg(settings);
  // 路由闸门必须先于 cfg 快照消费：本钩子在所有列表路由的聚合成功时都会被调，
  // 但只有「进行中」页的聚合是全量；先消费会把 force 资格白白吃掉（顺带修了
  // 既有问题——在其余列表页改提醒配置后，2s 直连会因变更已被消费而延迟 5 分钟）
  if (!cfg.enabled || !cfg.server || !cfg.email || !ACTIVE_PATH_RE.test(location.pathname)) return;
  const changed = consumeRemindCfgChange(settings);
  void pushWithProgress(cfg, aggregateItems(), changed);
}
