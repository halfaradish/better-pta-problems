// 聚合层的数据源记账与徽章推导：这两条都是出过 bug 的地方（v0.3.1 串页、v0.5.3 污染）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalApiUrl, normalizeApiItems } from '../src/content/aggregate.js';

test('canonicalApiUrl：剥掉 page/limit，保留其余筛选与排序参数', () => {
  assert.equal(
    canonicalApiUrl('https://pintia.cn/api/problem-sets?filter=active&page=2&limit=30&order_by=END_AT'),
    'https://pintia.cn/api/problem-sets?filter=active&order_by=END_AT',
  );
  assert.equal(canonicalApiUrl('https://pintia.cn/api/problem-sets?page=0&limit=100'), 'https://pintia.cn/api/problem-sets');
});

test('canonicalApiUrl：插件自身的 _bps 请求不作为路由数据源', () => {
  assert.equal(canonicalApiUrl('https://pintia.cn/api/problem-sets?filter=x&_bps=reminder'), null);
});

test('canonicalApiUrl：非列表接口一律拒绝', () => {
  assert.equal(canonicalApiUrl('https://www.pintia.cn/api/problem-sets?filter=x'), null); // 只认 pintia.cn
  assert.equal(canonicalApiUrl('https://pintia.cn/api/problem-sets/123'), null);
  assert.equal(canonicalApiUrl('https://pintia.cn/api/users'), null);
  assert.equal(canonicalApiUrl('随手一条不是 URL'), null);
});

test('canonicalApiUrl：预览页的 mock 数据源原样透传', () => {
  assert.equal(canonicalApiUrl('mock://problem-sets'), 'mock://problem-sets');
});

test('normalizeApiItems：徽章按 startAt/endAt/考试关联推导', () => {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const HOUR = 3600000;
  const DAY = 86400000;
  const raw = [
    { id: 1, name: '未开放', startAt: iso(now + DAY), endAt: iso(now + 2 * DAY) },
    { id: 2, name: '考试开放中', startAt: iso(now - HOUR), endAt: iso(now + DAY) },
    { id: 3, name: '考试刚关闭', startAt: iso(now - 3 * DAY), endAt: iso(now - DAY) },
    { id: 4, name: '考试关闭超过一周', startAt: iso(now - 30 * DAY), endAt: iso(now - 8 * DAY) },
    { id: 5, name: '普通题目集已关闭', startAt: iso(now - 3 * DAY), endAt: iso(now - HOUR) },
    { id: 6, name: '缺字段' },
  ];
  const items = normalizeApiItems(raw, { 2: 'e', 3: 'e', 4: 'e' });
  assert.deepEqual(items.map(i => i.badges), [
    [['未开放', 'orange']],
    [['已开考', 'green'], ['已开放', 'blue']],
    [['已开考', 'green'], ['已关闭', 'grey']],   // 关闭未满 7 天的考试仍带「已开考」
    [['已关闭', 'grey']],
    [['已关闭', 'grey']],
    [['未开放', 'orange']],
  ]);
  assert.equal(items[0].id, '1');      // id 统一成字符串
  assert.equal(items[5].closeAt, null);
});

test('normalizeApiItems：接口字段映射到条目，缺字段退化为空串', () => {
  const [it] = normalizeApiItems(
    [{ id: '9', name: '算法设计与分析--课堂练习1-3', startAt: '2026-09-20T14:15:00Z', endAt: '2026-10-10T04:22:00Z', ownerNickname: '教师A', organizationName: '某高校' }],
    {},
  );
  assert.equal(it.title, '算法设计与分析--课堂练习1-3');
  assert.equal(it.creator, '教师A');
  assert.equal(it.org, '某高校');
  assert.ok(it.closeAt instanceof Date);
});
