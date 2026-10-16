// 浏览器通知通道的纯逻辑：档位判定、去重记账、通知文案、状态裁剪与快照归一
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRUNE_NOTIFIED_MS, buildNotification, computeDue, fmtLeft, fmtTime,
  normalizeSets, normalizeState, notifiedKey, pruneState, withSnapshot,
} from '../src/shared/browser-notify.js';

const now = Date.now();
const DAY = 86400000;
const HOUR = 3600000;
const mk = (id, endAt, title = `题目集 ${id}`) => ({ id, title, endAt, owner: '教师A', org: '某高校' });

test('computeDue：剩余 20 小时同时命中 3 天与 1 天两档，marks 一并记账（浏览器关了几天后只补一条、不连环弹）', () => {
  const { items, marks } = computeDue([mk('a', now + 20 * HOUR)], {}, now);
  assert.deepEqual(items.map(i => i.id), ['a']);
  assert.deepEqual([...items[0].offsets].sort((x, y) => x - y), [1440, 4320]);
  assert.deepEqual([...marks].sort(), [notifiedKey('a', 1440), notifiedKey('a', 4320)].sort());
});

test('computeDue：剩余 2 天只进 3 天档（1 天档还没到）', () => {
  const { items, marks } = computeDue([mk('a', now + 2 * DAY)], {}, now);
  assert.deepEqual(items[0].offsets, [4320]);
  assert.deepEqual(marks, [notifiedKey('a', 4320)]);
});

test('computeDue：剩余 4 天还没进 3 天档，不通知', () => {
  const { items, marks } = computeDue([mk('a', now + 4 * DAY)], {}, now);
  assert.deepEqual(items, []);
  assert.deepEqual(marks, []);
});

test('computeDue：已通知过的档位跳过，只留没发过的档位（3 天档发过后，1 天档照发）', () => {
  const notified = { [notifiedKey('a', 4320)]: now - 1000 };
  const { items, marks } = computeDue([mk('a', now + 20 * HOUR)], notified, now);
  assert.deepEqual(items[0].offsets, [1440]);
  assert.deepEqual(marks, [notifiedKey('a', 1440)]);
});

test('computeDue：档位全通知完则不通知（幂等）', () => {
  const notified = { [notifiedKey('a', 4320)]: now, [notifiedKey('a', 1440)]: now };
  assert.deepEqual(computeDue([mk('a', now + 2 * DAY)], notified, now).items, []);
});

test('computeDue：marks 记账后再扫一轮不再重复通知（端到端幂等）', () => {
  const sets = [mk('a', now + 3 * HOUR), mk('b', now + 20 * HOUR)];
  const first = computeDue(sets, {}, now);
  assert.equal(first.items.length, 2);
  const notified = Object.fromEntries(first.marks.map(k => [k, now]));
  assert.deepEqual(computeDue(sets, notified, now).items, []);
});

test('computeDue：已截止与坏数据（endAt 解析不出）一律不通知', () => {
  const { items } = computeDue([mk('past', now - HOUR), { id: 'bad', title: 'x', endAt: NaN }], {}, now);
  assert.deepEqual(items, []);
});

test('computeDue：items 按截止升序（文案取「最早关闭的」那条）', () => {
  const { items } = computeDue([mk('late', now + 20 * HOUR), mk('early', now + 3 * HOUR)], {}, now);
  assert.deepEqual(items.map(i => i.id), ['early', 'late']);
});

test('buildNotification：单条给出标题与截止时间，targetId/按钮指向该题', () => {
  const n = buildNotification([mk('a', now + 20 * HOUR, '操作系统作业3')], now);
  assert.equal(n.title, '《操作系统作业3》约 20 小时后关闭');
  assert.match(n.message, /^截止 .+，点击打开题目集$/);
  assert.equal(n.buttonTitle, '打开题目集');
  assert.equal(n.targetId, 'a');
});

test('buildNotification：多条只报最早一条 + 总数，按钮指向最早关闭的', () => {
  const n = buildNotification([mk('a', now + 3 * HOUR, '甲'), mk('b', now + 2 * DAY, '乙')], now);
  assert.equal(n.title, '2 个题目集即将关闭');
  assert.match(n.message, /^最早《甲》约 3 小时后关闭（.+）$/);
  assert.equal(n.buttonTitle, '打开最早关闭的');
  assert.equal(n.targetId, 'a'); // items 已按截止升序，第一条即最早
});

test('buildNotification：空列表返回 null（无到点条目不弹通知）', () => {
  assert.equal(buildNotification([], now), null);
});

test('fmtLeft：天/小时/分钟三档，与后端邮件口径一致', () => {
  assert.equal(fmtLeft(3 * DAY), '约 3 天');
  assert.equal(fmtLeft(5 * HOUR), '约 5 小时');
  assert.equal(fmtLeft(90 * 60000), '约 90 分钟');
  assert.equal(fmtLeft(0), '约 1 分钟'); // 已截止的兜底（正常情况下不会走到）
});

test('fmtTime：今天/明天用相对词，更远用 MM-DD HH:mm', () => {
  const base = new Date(2026, 9, 16, 10, 0, 0).getTime(); // 2026-10-16 10:00 本地
  assert.equal(fmtTime(new Date(2026, 9, 16, 23, 59).getTime(), base), '今天 23:59');
  assert.equal(fmtTime(new Date(2026, 9, 17, 23, 59).getTime(), base), '明天 23:59');
  assert.equal(fmtTime(new Date(2026, 11, 5, 8, 5).getTime(), base), '12-05 08:05');
});

test('normalizeState：坏存储回默认（字段缺失/类型不对不整体清空）', () => {
  assert.deepEqual(normalizeState(null), { sets: [], notified: {}, lastTarget: '', syncedAt: 0 });
  assert.deepEqual(
    normalizeState({ sets: 'x', notified: [], lastTarget: 123, syncedAt: 'y' }),
    { sets: [], notified: {}, lastTarget: '', syncedAt: 0 },
  );
});

test('withSnapshot：sets 归一（ISO → 毫秒）、非法条目丢弃，去重表与点击目标保留', () => {
  const prev = normalizeState({ notified: { 'a|1440': now }, lastTarget: 'a', syncedAt: now - 1000 });
  const next = withSnapshot(prev, [
    { id: 'a', title: '甲', endAt: new Date(now + DAY).toISOString(), owner: '教师A', org: '某高校' },
    { id: '', title: '缺 id', endAt: new Date(now + DAY).toISOString() },
    { id: 'b', title: '坏时间', endAt: 'not-a-date' },
  ], now);
  assert.deepEqual(next.sets, [{ id: 'a', title: '甲', endAt: now + DAY, owner: '教师A', org: '某高校' }]);
  assert.deepEqual(next.notified, { 'a|1440': now });
  assert.equal(next.lastTarget, 'a');
  assert.equal(next.syncedAt, now);
});

test('normalizeSets：数字 endAt 原样保留（内部形态往返不丢精度）', () => {
  const [s] = normalizeSets([{ id: 'x', title: 't', endAt: now + DAY }]);
  assert.equal(s.endAt, now + DAY);
});

test('pruneState：去重表留 90 天、已截止快照留 7 天（对齐后端 sent_log / 订阅清理）', () => {
  const state = normalizeState({
    sets: [mk('fresh', now + DAY), mk('recent', now - 3 * DAY), mk('ancient', now - 8 * DAY)],
    notified: { old: now - PRUNE_NOTIFIED_MS - 1, fresh: now - HOUR },
    lastTarget: 'fresh',
  });
  const pruned = pruneState(state, now);
  assert.deepEqual(pruned.sets.map(s => s.id), ['fresh', 'recent']);
  assert.deepEqual(Object.keys(pruned.notified), ['fresh']);
});
