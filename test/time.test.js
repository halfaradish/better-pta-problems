// 关闭时间的解析与倒计时文案
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtCloseLocal, fmtCountdown, parseCloseTime } from '../src/shared/time.js';

test('parseCloseTime：带日期与当天两种写法', () => {
  const dated = parseCloseTime('关闭时间: 2026-10-17 23:59 · 还有 3 天');
  assert.equal(fmtCloseLocal(dated), '2026-10-17 23:59');

  const today = parseCloseTime('关闭时间: 12:22');
  const now = new Date();
  assert.equal(today.getFullYear(), now.getFullYear());
  assert.equal(today.getMonth(), now.getMonth());
  assert.equal(today.getDate(), now.getDate());
  assert.equal(today.getHours(), 12);
  assert.equal(today.getMinutes(), 22);
});

test('parseCloseTime：没有时间信息时返回 null', () => {
  assert.equal(parseCloseTime(''), null);
  assert.equal(parseCloseTime('距离关闭还有 2 天'), null);
  assert.equal(parseCloseTime(undefined), null);
});

test('fmtCloseLocal：整点零分与 PTA 一致省略时刻', () => {
  assert.equal(fmtCloseLocal(new Date(2026, 9, 17, 0, 0)), '2026-10-17');
  assert.equal(fmtCloseLocal(new Date(2026, 9, 17, 23, 59)), '2026-10-17 23:59');
  assert.equal(fmtCloseLocal(null), '');
});

test('fmtCountdown：分档文案与等级，超 7 天或已截止不显示', () => {
  const now = new Date(2026, 9, 12, 10, 0).getTime();
  const at = ms => fmtCountdown(now + ms, now);
  assert.deepEqual(at(30 * 60000), { text: '剩 30 分钟', level: 3 });
  assert.deepEqual(at(5 * 3600000), { text: '剩 5 小时', level: 3 });
  assert.deepEqual(at(30 * 3600000), { text: '剩 1 天 6 小时', level: 2 });
  assert.deepEqual(at(3 * 86400000), { text: '剩 3 天', level: 1 });
  assert.equal(at(8 * 86400000), null);
  assert.equal(at(-1000), null);
});
