/* 答题进度：考试型题目集的「已作答 / 总题数」，用于在列表页区分做完与没做完。
 *
 * 数据源 = PTA 考试概览页（/problem-sets/{id}/exam/overview）自己用的接口：
 *   GET /api/exams/{examId}/problem-sets/{problemSetId}/problem-status
 * 语义与 PTA 概览页口径一致（实测 7/15 对得上页面上的 47%）：已作答 = 状态为
 * PROBLEM_SUBMITTED 的题目数，总题数 = problemStatus 长度（= 各题型 total 之和）。
 * 非考试型题目集没有这个接口（problem-status 406、problem-summaries 403），PTA 自己
 * 也不给它们显示答题进度，所以这类题目集不显示进度。
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

const cache = new Map();   // problemSetId -> { at, ok, answered, total }
const queued = new Set();  // 已排队/在途的 problemSetId（去重）
const queue = [];          // 待取 [{ id, examId }]，未关闭的排在前面
let active = 0;
let hooks = {};

export function setProgressHooks(next) {
  hooks = { ...hooks, ...next };
}

// 相对 URL（内容脚本与页面同源）；_bps 标记让聚合的路由记账跳过插件自身的请求
export function progressUrl(examId, problemSetId) {
  return `/api/exams/${encodeURIComponent(examId)}/problem-sets/${encodeURIComponent(problemSetId)}/problem-status?_bps=progress`;
}

// 纯函数：接口响应 → { answered, total }；字段缺失一律按 0 处理，不抛错
export function countAnswered(json) {
  const list = json?.problemStatus || [];
  return {
    answered: list.filter(p => p.problemSubmissionStatus === 'PROBLEM_SUBMITTED').length,
    total: list.length,
  };
}

// 需要进度的条目：考试型 + 已开始 + 未关闭（与「未开放」徽章同口径）
export function wantsProgress(it, now = Date.now()) {
  return !!(it?.examId && it.startAt && it.closeAt && +it.startAt <= now && +it.closeAt > now);
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

// 当前页条目里缺进度的排入队列（幂等：缓存新鲜 / 已在途 / 已排队都不重复入队）
export function ensureProgress(items, now = Date.now()) {
  for (const it of (items || []).filter(x => wantsProgress(x, now))) {
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
        hooks.onUpdate?.(); // 落定即重建视图；由入口做防抖
        pump();
      });
  }
}
