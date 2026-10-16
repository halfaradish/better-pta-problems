/* 答题进度：考试型题目集的「已作答 / 总题数」，用于在列表页区分做完与没做完。
 *
 * 数据源 = PTA 考试概览页（/problem-sets/{id}/exam/overview）自己用的接口：
 *   GET /api/exams/{examId}/problem-sets/{problemSetId}/problem-status
 * 口径 = 「有提交就算」：已作答 = 有提交/判分记录的题目数，总题数 = problemStatus
 * 长度（= 各题型 total 之和）。判分后的题目状态不再是 PROBLEM_SUBMITTED，而是
 * PROBLEM_ACCEPTED / PROBLEM_WRONG_ANSWER 等评测结论，它们同样是「答过」——所以
 * 展示胶囊与提醒（浏览器通知 / 邮件两条通道）的「已完成」判定共用这一个计数
 * （content/reminders.js）。
 * v0.8～v0.9.5 只数 PROBLEM_SUBMITTED，判分完的题集一律显示「未完成 0/N」；用户
 * 2026-10-15 报障（实验1 全部答完仍标未完成）后统一到 PTA 概览页的口径。
 *
 * examId 来自列表接口的 examIdByProblemSetId，实测它是「考试场次表」：场次在用户
 * 首次进场时才创建（未进场的题目集状态 READY，/exams 响应里连 exam 对象都没有），
 * 而提交必须挂在场次下——所以不在表里的已开放题目集必然零提交，直接标「未答题」，
 * 不打接口（problem-summaries 对它们也 403，本身就没有计数源）。
 *
 * 只对「已开始且未关闭」的题目集取数：关闭后剩没剩题都无从补做，为历史题目集逐个
 * 打接口既没意义也白刷 PTA 的接口（用户的「所有题目集」有 59 个考试型题目集，其中
 * 53 个已关闭）；未开始的题目集连答题窗口都没到，同样不取。
 *
 * 请求注意：PTA 的接口在缺 accept: application/json 时返回二进制 protobuf（实测），
 * 必须带这个头；请求带 _bps 标记，聚合的路由记账会跳过（与提醒同步同一约定）。
 */
import { fetchJson } from './aggregate.js';

const OK_TTL = 2 * 60 * 1000;      // 成功结果 2 分钟（与聚合同频，答完题回来很快能看到）
const FAIL_TTL = 10 * 60 * 1000;   // 失败/无权限 10 分钟，避免反复打同一个坏接口
const CONCURRENCY = 3;             // 并发上限：一次翻页可能带出十几个题目集

// 实测词表见 docs/核心结论.md §2.1：没交过只有 PROBLEM_NO_ANSWER 一种，交过就必然
// 换成别的状态（提交待判 PROBLEM_SUBMITTED、判分结论 PROBLEM_ACCEPTED /
// PROBLEM_WRONG_ANSWER…）。判定因此按「排除没交」写——枚举「算已答」的正向词表在
// PTA 多出评测中/编译错误之类的状态时会重演「答完却显示未完成」，排除法不会再踩。
const NO_ANSWER_STATUS = 'PROBLEM_NO_ANSWER';

const cache = new Map();   // problemSetId -> { at, ok, answered, total }
const queued = new Set();  // 已排队/在途的 problemSetId（去重）
const queue = [];          // 待取 [{ id, examId }]，未关闭的排在前面
const waiters = [];        // ensureProgressAsync 的等待者 [{ pending: Set<id>, resolve }]
let active = 0;
let hooks = {};

export function setProgressHooks(next) {
  hooks = { ...hooks, ...next };
}

// 相对 URL（内容脚本与页面同源）；_bps 标记让聚合的路由记账跳过插件自身的请求
export function progressUrl(examId, problemSetId) {
  return `/api/exams/${encodeURIComponent(examId)}/problem-sets/${encodeURIComponent(problemSetId)}/problem-status?_bps=progress`;
}

// 纯函数：单题是否已作答（有提交记录，含判分结论）；字段缺失/none 值一律不算
export function hasSubmission(p) {
  const st = p?.problemSubmissionStatus;
  return typeof st === 'string' && st !== '' && st !== NO_ANSWER_STATUS;
}

// 纯函数：接口响应 → { answered, total }；字段缺失一律按 0 处理，不抛错
export function countAnswered(json) {
  const list = json?.problemStatus || [];
  return { answered: list.filter(hasSubmission).length, total: list.length };
}

// 答题窗口内：已开始且未关闭（有无考试场次都适用，未进场标「未答题」也用它）
export function inAnswerWindow(it, now = Date.now()) {
  return !!(it?.startAt && it.closeAt && +it.startAt <= now && +it.closeAt > now);
}

// 需要进度的条目：考试场次已建（examId 在表）+ 答题窗口内
export function wantsProgress(it, now = Date.now()) {
  return !!(it?.examId && inAnswerWindow(it, now));
}

// 纯函数：缓存记录 → 可用进度（过期、失败、无题目的都返回 null）
export function readProgress(rec, now = Date.now()) {
  if (!rec || !rec.ok) return null;
  if (now - rec.at > OK_TTL) return null;
  if (!rec.total) return null;
  return { answered: rec.answered, total: rec.total };
}

export function progressOf(id) {
  return readProgress(cache.get(id));
}

// 纯函数：缓存记录 → 「已完成」：每道题都有提交/判分记录才算完。展示胶囊与提醒
// 共用这个判定（判分后也满足）；记录缺失/过期/失败/无题目一律 false——提醒侧
// 「宁可多提醒，不漏提醒」，展示侧此时不落胶囊
export function reminderDone(rec, now = Date.now()) {
  const p = readProgress(rec, now);
  return !!p && p.answered >= p.total;
}

export function isReminderDone(id, now = Date.now()) {
  return reminderDone(cache.get(id), now);
}

// 当前页条目里缺进度的排入队列（幂等：缓存新鲜 / 已在途 / 已排队都不重复入队），
// 返回所有新入队/已在途请求落定后才 resolve 的 Promise（无论成败——落定即有记账）。
// 提醒推送前等着它，「已完成」判定才有数据；fetch 卡死由调用方用超时兜底
export function ensureProgressAsync(items, now = Date.now()) {
  const pending = new Set();
  for (const it of (items || []).filter(x => wantsProgress(x, now))) {
    const rec = cache.get(it.id);
    if (rec && (rec.ok ? now - rec.at <= OK_TTL : now - rec.at <= FAIL_TTL)) continue;
    pending.add(it.id);
    if (!queued.has(it.id)) {
      queued.add(it.id);
      queue.push({ id: it.id, examId: it.examId });
    }
  }
  pump();
  if (!pending.size) return Promise.resolve();
  return new Promise(resolve => waiters.push({ pending, resolve }));
}

// ensureProgress 的旧入口：不需要等待的调用方（列表视图）用这个
export function ensureProgress(items, now = Date.now()) {
  void ensureProgressAsync(items, now);
}

// 落定记账：把该 id 从各等待者的待定集中划掉，集齐即放行
function settleWaiter(id) {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    w.pending.delete(id);
    if (!w.pending.size) {
      waiters.splice(i, 1);
      w.resolve();
    }
  }
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    fetchJson(progressUrl(job.examId, job.id))
      .then(json => {
        cache.set(job.id, { at: Date.now(), ok: true, ...countAnswered(json) });
      })
      .catch(err => {
        cache.set(job.id, { at: Date.now(), ok: false });
        console.warn(`[更好的题目集] 答题进度获取失败（题目集 ${job.id}）: ${err?.message || err}`);
      })
      .finally(() => {
        active--;
        queued.delete(job.id);
        settleWaiter(job.id);
        hooks.onUpdate?.(); // 落定即重建视图；由入口做防抖
        pump();
      });
  }
}
