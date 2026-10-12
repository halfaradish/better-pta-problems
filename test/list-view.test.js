// 整组分页与分组收集：对照 docs/布局设计.md 的「组不跨页」与真实数据的 3 页结论
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAGE_SIZE, collectGroups, packPages } from '../src/content/list-view.js';

const items = n => Array.from({ length: n }, (_, i) => ({ id: String(i) }));

test('整组分页：按聚合顺序装页，组不跨页', () => {
  const groups = new Map([
    ['代数结构与初等数论', items(11)],
    ['算法设计与分析', items(7)],
    ['数据结构', items(23)],
    ['2025', items(15)],
    ['2024程序设计基础', items(13)],
  ]);
  const pages = packPages(groups);
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(p => p.count), [18, 23, 28]);
  assert.deepEqual(pages.map(p => p.groups.map(([name]) => name)), [
    ['代数结构与初等数论', '算法设计与分析'],
    ['数据结构'],
    ['2025', '2024程序设计基础'],
  ]);
  for (const p of pages) assert.ok(p.count <= PAGE_SIZE);
  const placed = pages.flatMap(p => p.groups.map(([name]) => name));
  assert.equal(new Set(placed).size, placed.length); // 每个组只出现在一页里
});

test('整组分页：单组超过页容量时独占一页（组不拆）', () => {
  const pages = packPages(new Map([['大组', items(45)], ['小组', items(3)]]));
  assert.deepEqual(pages.map(p => p.count), [45, 3]);
  assert.equal(pages[0].groups.length, 1);
});

test('collectGroups：没有课程名的条目归入未分类，保持插入顺序', () => {
  const groups = collectGroups([
    { id: '1', course: '数据结构' },
    { id: '2', course: null },
    { id: '3', course: '数据结构' },
  ]);
  assert.deepEqual([...groups.keys()], ['数据结构', '未分类']);
  assert.deepEqual(groups.get('数据结构').map(i => i.id), ['1', '3']);
});
