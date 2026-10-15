// 答题进度：「有提交就算」——已作答数涵盖提交待判（PROBLEM_SUBMITTED）与判分结论
// （PROBLEM_ACCEPTED / PROBLEM_WRONG_ANSWER / 评测中…），与 PTA 概览页口径一致。
// 回归：2026-10-15 用户报障「实验1 全部答完仍显示未完成」——判分后状态不再是
// PROBLEM_SUBMITTED，只数 PROBLEM_SUBMITTED 会把答完的题集永远算成 0/N。
// 取数范围只限「考试场次已建 + 已开始 + 未关闭」——范围写错会变成给
// 59 个历史题目集打接口；未进场（不在考试场次表）的已开放题目集直接标「未答题」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countAnswered, hasSubmission, inAnswerWindow, progressUrl, readProgress, reminderDone, wantsProgress,
} from '../src/content/progress.js';
import { canonicalApiUrl, normalizeApiItems } from '../src/content/aggregate.js';

test('countAnswered：提交待判与判分结论都算已作答，只有没交不算', () => {
  const json = {
    problemStatus: [
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
      { problemSubmissionStatus: 'PROBLEM_ACCEPTED' },     // 判分通过：答过
      { problemSubmissionStatus: 'PROBLEM_WRONG_ANSWER' }, // 判分答错：也是答过
      { problemSubmissionStatus: 'PROBLEM_SUBMITTED' },
      { problemSubmissionStatus: 'PROBLEM_NO_ANSWER' },
    ],
  };
  assert.deepEqual(countAnswered(json), { answered: 4, total: 6 });
});

test('countAnswered：字段缺失/空响应不抛错，按 0 处理', () => {
  assert.deepEqual(countAnswered({}), { answered: 0, total: 0 });
  assert.deepEqual(countAnswered({ problemStatus: [] }), { answered: 0, total: 0 });
  assert.deepEqual(countAnswered(null), { answered: 0, total: 0 });
});

test('hasSubmission：只有没交（含字段缺失/空值）算未作答，未知非空状态按已作答', () => {
  assert.equal(hasSubmission({ problemSubmissionStatus: 'PROBLEM_NO_ANSWER' }), false);
  assert.equal(hasSubmission({ problemSubmissionStatus: '' }), false);
  assert.equal(hasSubmission({}), false);
  assert.equal(hasSubmission(null), false);
  // 排除法：PTA 多出评测中/编译错误/部分通过之类的状态时，答完的题集不会被判成未完成
  for (const st of ['PROBLEM_SUBMITTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER',
    'PROBLEM_JUDGING', 'PROBLEM_COMPILATION_ERROR', 'PROBLEM_PARTIAL_ACCEPTED']) {
    assert.equal(hasSubmission({ problemSubmissionStatus: st }), true, st);
  }
});

test('口径等价：实测状态闭集上「有提交就算」与 v0.9.4 的提醒白名单逐项一致（提醒过滤结果不变）', () => {
  // PTA 生产 bundle 实证（2026-10-15，chunk 71629）：problemSubmissionStatus 枚举是闭集 4 值；
  // 概览页自己统计每题型已作答用的正是排除法（chunk 17539）= Number(status !== 'PROBLEM_NO_ANSWER')。
  // 于是新口径在 PTA 能产出的数据上与 v0.9.4 提醒侧的 attempted 白名单完全重合——
  // 「已完成的不再提醒」的过滤结果没有任何变化，只有 PTA 未来新增状态时两端一起当「有提交」。
  const PTA_STATUS_ENUM = ['PROBLEM_NO_ANSWER', 'PROBLEM_SUBMITTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER'];
  const V094_REMINDER_WHITELIST = ['PROBLEM_SUBMITTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER'];
  for (const st of PTA_STATUS_ENUM) {
    assert.equal(hasSubmission({ problemSubmissionStatus: st }), V094_REMINDER_WHITELIST.includes(st), st);
  }
  // 提醒判定本身照旧：四题里有一题没交 → 未完成，仍会提醒
  const json = { problemStatus: PTA_STATUS_ENUM.map(problemSubmissionStatus => ({ problemSubmissionStatus })) };
  assert.deepEqual(countAnswered(json), { answered: 3, total: 4 });
  assert.equal(reminderDone({ at: Date.now(), ok: true, ...countAnswered(json) }), false);
});

test('countAnswered：回归——实验1（编程 4 题全部判分）应为 4/4 已完成，不再是 0/4', () => {
  const json = {
    problemStatus: ['PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER', 'PROBLEM_ACCEPTED']
      .map(problemSubmissionStatus => ({ problemType: 'PROGRAMMING', problemSubmissionStatus })),
  };
  assert.deepEqual(countAnswered(json), { answered: 4, total: 4 });
});

test('countAnswered：判分集 5 过 1 错 = 6/6 已完成（与 PTA 概览页 100% 一致）', () => {
  const json = {
    problemStatus: [
      'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_ACCEPTED', 'PROBLEM_WRONG_ANSWER',
    ].map(problemSubmissionStatus => ({ problemSubmissionStatus })),
  };
  const { answered, total } = countAnswered(json);
  assert.deepEqual({ answered, total }, { answered: 6, total: 6 }); // 判分结论算答过 → 已完成
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
  assert.deepEqual(readProgress({ at: now, ok: true, answered: 7, total: 15 }, now), { answered: 7, total: 15 });
  assert.equal(readProgress({ at: now - 3 * 60 * 1000, ok: true, answered: 7, total: 15 }, now), null); // 超过 2 分钟
  assert.equal(readProgress({ at: now, ok: false }, now), null);      // 接口失败
  assert.equal(readProgress({ at: now, ok: true, answered: 0, total: 0 }, now), null); // 题目集里没有题
  assert.equal(readProgress(undefined, now), null);
});

test('reminderDone：每道题都有提交/判分记录才算完成', () => {
  const now = Date.now();
  assert.equal(reminderDone({ at: now, ok: true, answered: 6, total: 6 }, now), true);  // 每题都有提交/判分记录（含判分答错）即完成
  assert.equal(reminderDone({ at: now, ok: true, answered: 5, total: 6 }, now), false); // 还剩一题没交
  assert.equal(reminderDone({ at: now, ok: true, answered: 0, total: 6 }, now), false); // 一题没做
  assert.equal(reminderDone({ at: now, ok: true, answered: 0, total: 0 }, now), false); // 无题目：不给结论
  assert.equal(reminderDone({ at: now - 3 * 60 * 1000, ok: true, answered: 6, total: 6 }, now), false); // 过期
  assert.equal(reminderDone({ at: now, ok: false, answered: 6, total: 6 }, now), false); // 失败
  assert.equal(reminderDone(undefined, now), false);                                    // 没取过进度
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
