// 答题进度：口径必须与 PTA 概览页一致（实测 7/15 对应页面上的 47%），
// 取数范围只限「考试型 + 已开始 + 未关闭」——范围写错会变成给 59 个历史题目集打接口。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countAnswered, progressUrl, readProgress, wantsProgress } from '../src/content/progress.js';
import { canonicalApiUrl, normalizeApiItems } from '../src/content/aggregate.js';

test('countAnswered：只把 PROBLEM_SUBMITTED 计入已作答，其余状态都算未作答', () => {
  const json = {
    problemStatus: [
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
    ],
  };
  assert.deepEqual(countAnswered(json), { answered: 3, total: 5 });
});

test('countAnswered：字段缺失/空响应不抛错，按 0 处理', () => {
  assert.deepEqual(countAnswered({}), { answered: 0, total: 0 });
  assert.deepEqual(countAnswered({ problemStatus: [] }), { answered: 0, total: 0 });
  assert.deepEqual(countAnswered(null), { answered: 0, total: 0 });
});

test('countAnswered：复现真实 2-1 的题型分布（判断 5/5 + 单选 2/10 → 7/15 = 47%）', () => {
  const mk = (type, n, submitted) => Array.from({ length: n }, (_, i) => ({
    problemType: type,
    problemSubmissionStatus: i < submitted ? 'PROBLEM_SUBMITTED' : 'PROBLEM_NO_ANSWER',
  }));
  const json = { problemStatus: [...mk('TRUE_OR_FALSE', 5, 5), ...mk('MULTIPLE_CHOICE', 10, 2)] };
  const { answered, total } = countAnswered(json);
  assert.deepEqual({ answered, total }, { answered: 7, total: 15 });
  assert.equal(Math.round((answered / total) * 100), 47); // 与 PTA 概览页显示的 47 % 一致
});

test('progressUrl：走考试接口、带 _bps 标记（聚合的路由记账据此跳过）', () => {
  assert.equal(
    progressUrl('9000000000000000001', '2100000000000000138'),
    '/api/exams/9000000000000000001/problem-sets/2100000000000000138/problem-status?_bps=progress',
  );
});

test('progressUrl：进度请求不会被当成列表数据源（不改写用户筛选/排序）', () => {
  const url = 'https://pintia.cn' + progressUrl('9000000000000000001', '2100000000000000138');
  assert.equal(canonicalApiUrl(url), null);
});

test('wantsProgress：只对考试型 + 已开始 + 未关闭的题目集取数', () => {
  const now = Date.now();
  const HOUR = 3600000;
  const DAY = 86400000;
  const it = (over = {}) => ({ id: '1', examId: '9', startAt: new Date(now - DAY), closeAt: new Date(now + DAY), ...over });

  assert.equal(wantsProgress(it(), now), true);
  assert.equal(wantsProgress(it({ examId: '' }), now), false);                    // 非考试型：接口不存在
  assert.equal(wantsProgress(it({ startAt: new Date(now + HOUR) }), now), false); // 未开始：还没到答题窗口
  assert.equal(wantsProgress(it({ closeAt: new Date(now - HOUR) }), now), false); // 已关闭：补做不了，不为历史题目集打接口
  assert.equal(wantsProgress(it({ startAt: null }), now), false);
  assert.equal(wantsProgress(it({ closeAt: null }), now), false);
  assert.equal(wantsProgress(undefined, now), false);
});

test('readProgress：成功记录在 TTL 内可用，过期/失败/无题目都返回 null', () => {
  const now = Date.now();
  assert.deepEqual(readProgress({ at: now, ok: true, answered: 7, total: 15 }, now), { answered: 7, total: 15 });
  assert.equal(readProgress({ at: now - 3 * 60 * 1000, ok: true, answered: 7, total: 15 }, now), null); // 超过 2 分钟
  assert.equal(readProgress({ at: now, ok: false }, now), null);      // 接口失败
  assert.equal(readProgress({ at: now, ok: true, answered: 0, total: 0 }, now), null); // 题目集里没有题
  assert.equal(readProgress(undefined, now), null);
});

test('normalizeApiItems：把 examIdByProblemSetId 带进条目（答题进度的取数钥匙）', () => {
  const [withExam, without] = normalizeApiItems(
    [{ id: '100', name: 'A' }, { id: '200', name: 'B' }],
    { 100: 9001 },
  );
  assert.equal(withExam.examId, '9001');
  assert.equal(without.examId, '');
});

test('normalizeApiItems：没有考试关联表时不抛错', () => {
  const [it] = normalizeApiItems([{ id: '100', name: 'A' }], undefined);
  assert.equal(it.examId, '');
});
