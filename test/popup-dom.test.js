// 弹窗 DOM 与 popup.js 的接线契约。
// popup.html 是手写静态文件、popup.js 由 src/popup/index.js 构建，两者靠 id 与 data-goto 对齐——
// 单测里没有 DOM 环境，所以这里用文本扫描把「改了 HTML 悄悄打断 JS」这类事故挡在 CI 上。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(path.join(ROOT, 'extension', 'popup', 'popup.html'), 'utf8');
const js = readFileSync(path.join(ROOT, 'src', 'popup', 'index.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

const htmlIds = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]));

test('popup.js 引用的每个 id 都在 popup.html 里存在', () => {
  const used = new Set([
    ...[...js.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]),
    ...[...js.matchAll(/getElementById\('([\w-]+)'\)/g)].map(m => m[1]),
  ]);
  assert.ok(used.size > 20, `应解析出足够多的 id，实际 ${used.size}`);
  const missing = [...used].filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, [], '这些 id 在 popup.html 里找不到：' + missing.join(', '));
});

test('弹窗里不再有展开/收起（details/summary）', () => {
  // 倒计时提醒、课程识别、邮件配置、导入导出都改成了子页面/直铺，折叠控件不该再出现
  assert.equal(/<details\b/.test(html), false);
  assert.equal(/<summary\b/.test(html), false);
});

test('四个页面齐备，且默认只显示主页面', () => {
  for (const id of ['page-main', 'page-reminders', 'page-rules', 'page-backup']) {
    assert.ok(htmlIds.has(id), `缺少页面 ${id}`);
  }
  const active = [...html.matchAll(/class="page([^"]*)"|class="page is-active"/g)];
  assert.ok(active.length >= 4, '四个 section 都应带 page 类');
  // 只有主页面带 is-active：其余页靠 .is-active 从右侧滑入
  assert.equal([...html.matchAll(/class="page is-active"/g)].length, 1);
  assert.match(html, /class="page is-active" id="page-main"/);
});

test('每个入口行的 data-goto 都指向存在的页面，且标题表里有对应文案', () => {
  const gotos = [...html.matchAll(/class="row entry" data-goto="([\w-]+)"/g)].map(m => m[1]);
  assert.deepEqual(gotos.sort(), ['backup', 'reminders', 'rules']); // 三个入口：提醒 / 规则 / 备份
  const titles = js.match(/PAGE_TITLES = \{[\s\S]*?\};/);
  assert.ok(titles, 'src/popup/index.js 里应有 PAGE_TITLES 表');
  for (const name of gotos) {
    assert.ok(htmlIds.has(`page-${name}`), `data-goto="${name}" 没有对应的 #page-${name}`);
    assert.match(titles[0], new RegExp(`\\b${name}:`), `PAGE_TITLES 缺 ${name} 的标题`);
  }
  // 子页面头部的返回键（切页后焦点落这里）
  assert.ok(htmlIds.has('pageBack'), '缺少返回键 #pageBack');
});

test('弹窗里的静态版本号与 manifest 一致（非扩展环境下的回退文案）', () => {
  assert.match(html, new RegExp(`>v${manifest.version.replace(/\./g, '\\.')}<`),
    `popup.html 的版本回退文案应写成 v${manifest.version}`);
});
