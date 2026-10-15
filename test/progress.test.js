// 答题进度：展示口径 = 只把 PROBLEM_SUBMITTED（提交待评测）计入已作答，判分结论不算完
// （有意比 PTA 概览页更严：实测 7/15 对应页面 47%；判分后 5 过 1 错概览 100% 但插件
// 显示未完成）。提醒口径更宽：每道题有提交/判分记录即算完成（邮件提醒不再订阅该题集）。
// 取数范围只限「考试场次已建 + 已开始 + 未关闭」——范围写错会变成给
// 59 个历史题目集打接口；未进场（不在考试场次表）的已开放题目集直接标「未答题」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countAnswered, inAnswerWindow, progressUrl, readProgress, reminderDone, wantsProgress,
} from '../src/content/progress.js';
import { canonicalApiUrl, normalizeApiItems } from '../src/content/aggregate.js';

test('countAnswered：展示口径只把 PROBLEM_SUBMITTED 计入已作答，attempted 数有提交记录的', () => {
  const json = {
    problemStatus: [
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
      { problemSubmissionStatus: 'PROBLEM_ACCEPTED' },     // 判分通过：不算「已作答」，算「有提交记录」
      { problemSubmissionStatus: 'PROBLEM_WRONG_ANSWER' }, // 判分答错：同上
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
    ],
  };
  assert.deepEqual(countAnswered(json), { answered: 2, attempted: 4, total: 6 });
});

test('countAnswered：字段缺失/空响应不抛错，按 0 处理', () => {
  assert.deepEqual(countAnswered({}), { answered: 0, attempted: 0, total: 0 });
  assert.deepEqual(countAnswered({ problemStatus: [] }), { answered: 0, attempted: 0, total: 0 });
  assert.deepEqual(countAnswered(null), { answered: 0, attempted: 0, total: 0 });
});

test('countAnswered：判分集 5 过 1 错——严口径未作答 0/6（展示），宽口径已全部提交（提醒）', () => {
  const json = {
    problemStatus: [
      'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER',
    ].map(problemSubmissionStatus => ({ problemSubmissionStatus })),
  };
  const { answered, attempted, total } = countAnswered(json);
  assert.deepEqual({ answered, total }, { answered: 0, total: 6 }); // 展示管线 0/6 = 未完成（有意保留的严口径）
  assert.deepEqual(attempted, 6);                                   // 提醒管线 6/6 = 已完成，不再订阅提醒
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

test('wantsProgress：只对考试场次已建 + 已开始 + 未关闭的题目集取数', () => {
  const now = Date.now();
  const HOUR = 3600000;
  const DAY = 86400000;
  const it = (over = {}) => ({ id: '1', examId: '9', startAt: new Date(now - DAY), closeAt: new Date(now + DAY), ...over });

  assert.equal(wantsProgress(it(), now), true);
  assert.equal(wantsProgress(it({ examId: '' }), now), false);                    // 未进场：必然零提交，不取数
  assert.equal(wantsProgress(it({ startAt: new Date(now + HOUR) }), now), false); // 未开始：还没到答题窗口
  assert.equal(wantsProgress(it({ closeAt: new Date(now - HOUR) }), now), false); // 已关闭：补做不了，不为历史题目集打接口
  assert.equal(wantsProgress(it({ startAt: null }), now), false);
  assert.equal(wantsProgress(it({ closeAt: null }), now), false);
  assert.equal(wantsProgress(undefined, now), false);
});

test('inAnswerWindow：与场次无关，已开始且未关闭即真（未进场集合据此标「未答题」）', () => {
  const now = Date.now();
  const HOUR = 3600000;
  const DAY = 86400000;
  assert.equal(inAnswerWindow({ startAt: new Date(now - DAY), closeAt: new Date(now + DAY) }, now), true);
  assert.equal(inAnswerWindow({ examId: '', startAt: new Date(now - DAY), closeAt: new Date(now + DAY) }, now), true);
  assert.equal(inAnswerWindow({ startAt: new Date(now + HOUR), closeAt: new Date(now + DAY) }, now), false);
  assert.equal(inAnswerWindow({ startAt: new Date(now - DAY), closeAt: new Date(now - HOUR) }, now), false);
  assert.equal(inAnswerWindow({ startAt: null, closeAt: new Date(now + DAY) }, now), false);
  assert.equal(inAnswerWindow({ startAt: new Date(now - DAY), closeAt: null }, now), false);
  assert.equal(inAnswerWindow(undefined, now), false);
});

test('readProgress：成功记录在 TTL 内可用，过期/失败/无题目都返回 null', () => {
  const now = Date.now();
  assert.deepEqual(readProgress({ at: now, ok: true, answered: 7, attempted: 7, total: 15 }, now), { answered: 7, attempted: 7, total: 15 });
  assert.equal(readProgress({ at: now - 3 * 60 * 1000, ok: true, answered: 7, attempted: 7, total: 15 }, now), null); // 超过 2 分钟
  assert.equal(readProgress({ at: now, ok: false }, now), null);      // 接口失败
  assert.equal(readProgress({ at: now, ok: true, answered: 0, total: 0 }, now), null); // 题目集里没有题
  assert.equal(readProgress(undefined, now), null);
});

test('reminderDone：提醒口径（宽）——判分集也算完成', () => {
  const now = Date.now();
  assert.equal(reminderDone({ at: now, ok: true, answered: 6, attempted: 6, total: 6 }, now), true);  // 全部提交
  assert.equal(reminderDone({ at: now, ok: true, answered: 0, attempted: 6, total: 6 }, now), true);  // 判分后严口径 0/6，宽口径算完
  assert.equal(reminderDone({ at: now, ok: true, answered: 5, attempted: 5, total: 6 }, now), false); // 没做完
  assert.equal(reminderDone({ at: now, ok: true, answered: 6, total: 6 }, now), false);               // 旧形态记录缺 attempted：按未完成
  assert.equal(reminderDone({ at: now, ok: true, answered: 0, attempted: 0, total: 0 }, now), false); // 无题目：不给结论
  assert.equal(reminderDone({ at: now - 3 * 60 * 1000, ok: true, answered: 6, attempted: 6, total: 6 }, now), false); // 过期
  assert.equal(reminderDone({ at: now, ok: false, answered: 6, attempted: 6, total: 6 }, now), false); // 失败
  assert.equal(reminderDone(undefined, now), false);                                                  // 没取过进度
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
