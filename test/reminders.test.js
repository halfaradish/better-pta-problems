// 邮件提醒的订阅 payload：未关闭 + 排序之外，「已完成的不再提醒」从 payload 剔除
// 已完成条目（订阅是按邮箱全量替换语义，剔除即后端不再提醒；之后做完了自然会回来）。
// 过滤方向是 fail-open：进度数据不可得（没取到/失败/过期）一律按未完成保留。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSyncSets } from '../src/content/reminders.js';

const now = Date.now();
const DAY = 86400000;
const mk = (id, closeAt, creator = '教师A') => ({ id, title: `题目集 ${id}`, closeAt: new Date(closeAt), creator, org: '某高校' });

// isDone 注入：id 以 -done 结尾的视为「已完成」（模拟 progress.js 里 reminderDone 的结论）
const isDoneInject = id => id.endsWith('-done');

test('buildSyncSets：只留未关闭的，payload 形状与后端契约一致', () => {
  const sets = buildSyncSets(
    [mk('a', now + DAY), mk('b', now - HOUR), mk('c', now + 2 * DAY)],
    {},
  );
  assert.deepEqual(sets.map(s => s.id), ['a', 'c']);
  assert.deepEqual(JSON.parse(JSON.stringify(sets[0])), {
    id: 'a', title: '题目集 a', endAt: new Date(now + DAY).toISOString(), owner: '教师A', org: '某高校',
  });
});

test('buildSyncSets：按截止时间升序排列', () => {
  const sets = buildSyncSets([mk('late', now + 3 * DAY), mk('early', now + DAY)], {});
  assert.deepEqual(sets.map(s => s.id), ['early', 'late']);
});

test('buildSyncSets：skipDone 开——已完成的从 payload 剔除（后端不再订阅提醒）', () => {
  const sets = buildSyncSets(
    [mk('a-done', now + DAY), mk('b-todo', now + DAY), mk('c-done', now + 2 * DAY), mk('d-todo', now - HOUR)],
    { skipDone: true, isDone: isDoneInject },
  );
  assert.deepEqual(sets.map(s => s.id), ['b-todo']);
});

test('buildSyncSets：skipDone 关——全部未关闭条目保留（开关还原即恢复提醒）', () => {
  const sets = buildSyncSets(
    [mk('a-done', now + DAY), mk('b-todo', now + DAY), mk('c-done', now + 2 * DAY)],
    { skipDone: false, isDone: isDoneInject },
  );
  assert.deepEqual(sets.map(s => s.id), ['a-done', 'b-todo', 'c-done']);
});

test('buildSyncSets：进度不可得（isDone 恒 false）按未完成保留——宁可多提醒，不漏提醒', () => {
  const sets = buildSyncSets(
    [mk('a-done', now + DAY), mk('b-todo', now + DAY)],
    { skipDone: true, isDone: () => false },
  );
  assert.deepEqual(sets.map(s => s.id), ['a-done', 'b-todo']);
});

const HOUR = 3600000;
