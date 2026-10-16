/* 浏览器通知通道的纯逻辑：档位判定、通知文案、状态裁剪。
 *
 * 与后端邮件通道同构：按档位（截止前 N 分钟）提醒一次、按「题目集 + 档位」去重；
 * 区别是判定用「剩余 ≤ 档位 且该档未通知过」而不是精确触发时刻——闹钟会因为
 * 浏览器没开、系统休眠而迟到甚至跨天，档位判定天然容忍迟到，错过的档位在下次
 * 扫描一并补发（这正是本地通道该有的语义：只要还没到截止，提醒就有意义）。
 * 通知里的剩余时间与截止时刻都是现算的，不会出现「3 天前」这类陈旧文案。
 *
 * 本模块不碰 chrome.*：background 负责读写 storage 与创建通知，单测直跑这里。
 */

export const NOTIFY_BEFORE_MINUTES = [4320, 1440]; // 截止前 3 天 / 1 天（与后端默认档位一致）
export const SCAN_PERIOD_MINUTES = 30;             // 闹钟扫描周期：档位以天计，半小时粒度足够
export const STATE_KEY = 'bpsNotifyState';         // chrome.storage.local：快照 + 去重表 + 点击目标
export const NOTIFY_ID = 'bps-reminder';           // 固定通知 id：新一轮提醒替换旧的一条，不在系统通知里堆积
export const TEST_NOTIFY_ID = 'bps-notify-test';
export const PRUNE_NOTIFIED_MS = 90 * 86400000;    // 去重记录保留 90 天（对齐后端 sent_log）
export const PRUNE_SET_MS = 7 * 86400000;          // 已截止快照保留 7 天（对齐后端订阅清理）

const DAY_MS = 86400000;

// 通知与「打开」的目标地址（与邮件里的链接同形）
export const LIST_URL = 'https://pintia.cn/problem-sets';
export const setOverviewUrl = id => `https://pintia.cn/problem-sets/${id}/overview`;

// 去重键：题目集 + 档位；与后端 sent_log 的主键同构
export const notifiedKey = (setId, offsetMin) => `${setId}|${offsetMin}`;

// 存储里的状态归一到认识的形状（字段缺失/类型不对一律回默认，坏数据不清空整体）
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    sets: Array.isArray(s.sets) ? s.sets : [],
    notified: s.notified && typeof s.notified === 'object' && !Array.isArray(s.notified) ? s.notified : {},
    lastTarget: typeof s.lastTarget === 'string' ? s.lastTarget : '',
    syncedAt: Number.isFinite(s.syncedAt) ? s.syncedAt : 0,
  };
}

// 上报的 sets（endAt 为 ISO 字符串，契约与后端一致）归一成内部形状（endAt 为毫秒数）；
// 非法条目（缺 id / 截止时间解析不出）直接丢弃
export function normalizeSets(sets) {
  const out = [];
  for (const s of sets || []) {
    const endAt = typeof s?.endAt === 'number' ? s.endAt : Date.parse(s?.endAt ?? '');
    const id = String(s?.id ?? '');
    if (!id || !Number.isFinite(endAt)) continue;
    out.push({
      id,
      title: String(s?.title ?? ''),
      endAt,
      owner: String(s?.owner ?? ''),
      org: String(s?.org ?? ''),
    });
  }
  return out;
}

// 写入新快照：订阅是全量替换语义，快照同样全量替换；去重表与点击目标保留
export function withSnapshot(state, sets, now = Date.now()) {
  return { ...state, sets: normalizeSets(sets), syncedAt: now };
}

// 本轮该通知的条目。items 按截止升序（文案取「最早关闭的」那条）；marks 是随通知
// 一起记账的全部命中档位——一次扫描把 3 天/1 天都到点的情形（浏览器关了几天）
// 合并成一条通知、两个档位一起记，避免补发时连环弹。
export function computeDue(sets, notified = {}, now = Date.now(), tiers = NOTIFY_BEFORE_MINUTES) {
  const items = [];
  const marks = [];
  for (const s of sets || []) {
    if (!Number.isFinite(s?.endAt) || s.endAt <= now) continue; // 已截止/坏数据：不通知（裁剪时清理）
    const offsets = tiers.filter(t => s.endAt - now <= t * 60000 && !notified[notifiedKey(s.id, t)]);
    if (!offsets.length) continue;
    items.push({ ...s, offsets });
    for (const t of offsets) marks.push(notifiedKey(s.id, t));
  }
  items.sort((a, b) => a.endAt - b.endAt);
  return { items, marks };
}

// 状态裁剪：去重表留 90 天、已截止快照留 7 天（与后端 sent_log / 订阅清理同口径）
export function pruneState(state, now = Date.now()) {
  const notified = {};
  for (const [k, ts] of Object.entries(state.notified || {})) {
    if (Number.isFinite(ts) && now - ts < PRUNE_NOTIFIED_MS) notified[k] = ts;
  }
  const sets = (state.sets || []).filter(s => Number.isFinite(s?.endAt) && s.endAt > now - PRUNE_SET_MS);
  return { ...state, notified, sets };
}

/* ---------- 通知文案 ---------- */

// 与后端邮件同一口径的剩余时间：约 X 天 / 小时 / 分钟
export function fmtLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m >= 2880) return `约 ${Math.round(m / 1440)} 天`;
  if (m >= 120) return `约 ${Math.round(m / 60)} 小时`;
  return `约 ${m} 分钟`;
}

// 截止时刻：今天/明天用相对词，更远用「MM-DD HH:mm」（本地时区＝用户时区，无需服务端那套 DISPLAY_TZ）
export function fmtTime(ms, now = Date.now()) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dayStart = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const diff = Math.round((dayStart(ms) - dayStart(now)) / DAY_MS);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `明天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

// 通知文案。Windows 上正文两三行就截断，所以刻意只留一行：
// 单条给具体信息，多条只报「最早关闭的那条 + 总数」（点击打开最早的那条）。
export function buildNotification(items, now = Date.now()) {
  if (!items?.length) return null;
  const first = items[0]; // computeDue 已按截止升序
  const left = fmtLeft(first.endAt - now);
  if (items.length === 1) {
    return {
      title: `《${first.title}》${left}后关闭`,
      message: `截止 ${fmtTime(first.endAt, now)}，点击打开题目集`,
      buttonTitle: '打开题目集',
      targetId: first.id,
    };
  }
  return {
    title: `${items.length} 个题目集即将关闭`,
    message: `最早《${first.title}》${left}后关闭（${fmtTime(first.endAt, now)}）`,
    buttonTitle: '打开最早关闭的',
    targetId: first.id,
  };
}
