// 发行包（tools/zip.mjs 的 zip 读写器 + tools/package.mjs 的组装与教程渲染）单测。
// 用 node:test 内置解析器读写往返，不依赖外部 unzip 命令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_UTF8, crc32, makeZip, readZip } from '../tools/zip.mjs';
import { GUIDE_FILE, buildStage, packZip, readManifestVersion, renderGuide } from '../tools/package.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUIDE_SOURCE_NAME = '安装教程.md'; // 教程正文的文件名，与 tools/package.mjs 内的常量同名
const tmp = () => mkdtempSync(path.join(tmpdir(), 'bps-package-'));

// 按位实现的 CRC-32，用来交叉校验查表版
function crc32Bitwise(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

test('crc32：标准向量 + 与按位实现一致', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
  for (const sample of ['更好的题目集', 'a'.repeat(1000), '']) {
    const buf = Buffer.from(sample, 'utf8');
    assert.equal(crc32(buf), crc32Bitwise(buf), sample.slice(0, 20));
  }
});

test('zip 往返：中文条目名、空文件、内容一致且带 UTF-8 标志位', () => {
  const entries = [
    { name: 'root/安装教程.html', data: Buffer.from('<!DOCTYPE html><p>中文</p>', 'utf8') },
    { name: 'root/extension/manifest.json', data: Buffer.from('{"version":"1.2.3"}', 'utf8') },
    { name: 'root/empty.bin', data: Buffer.alloc(0) },
  ];
  const back = readZip(makeZip(entries));
  assert.deepEqual(back.map(e => e.name), entries.map(e => e.name));
  for (let i = 0; i < entries.length; i++) {
    assert.equal(back[i].data.toString('utf8'), entries[i].data.toString('utf8'), entries[i].name);
    assert.ok(back[i].flags & FLAG_UTF8, `${entries[i].name} 未设置 UTF-8 标志位`);
  }
});

test('zip：可压缩内容走 deflate、不可压缩内容原样存储', () => {
  const compressible = Buffer.from('a'.repeat(2000));
  const entropy = randomBytes(2000);
  const [deflated, stored] = readZip(makeZip([
    { name: 'a.txt', data: compressible },
    { name: 'b.bin', data: entropy },
  ]));
  assert.equal(deflated.method, 8);
  assert.ok(deflated.compressedSize < deflated.size);
  assert.equal(stored.method, 0);
  assert.equal(stored.compressedSize, stored.size);
  assert.ok(stored.data.equals(entropy));
});

test('zip：内容被改动时回读报错（CRC 校验）', () => {
  const buf = makeZip([{ name: 'a.txt', data: Buffer.from('abc') }]);
  const cdStart = buf.length - 22 - (46 + Buffer.byteLength('a.txt'));
  buf[cdStart + 16] ^= 0xff; // 中央目录里的 CRC-32 字段
  assert.throws(() => readZip(buf), /不是有效的 zip/);
});

test('renderGuide：内联样式、charset、版本号与仓库链接，本地图片内联为 data URI', () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'images', 'step.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(root, 'docs', GUIDE_SOURCE_NAME), [
      '# 安装教程',
      '',
      '打开 `chrome://extensions`，选择 extension 文件夹。',
      '',
      '![示意图](images/step.png)',
      '',
    ].join('\n'));
    const html = renderGuide({ root, version: '9.9.9', date: new Date(2026, 9, 15) });

    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /v9\.9\.9/);
    assert.match(html, /打包于 2026-10-15/);
    assert.match(html, /https:\/\/github\.com\/halfaradish\/better-pta-problems/);
    assert.match(html, /chrome:\/\/extensions/);
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /images\/step\.png/, '本地图片应被内联，不留相对路径');
    assert.match(html, /prefers-color-scheme: dark/, '教程自带明暗两套样式');
    assert.equal((html.match(/<style>/g) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderGuide：引用了不存在的图片时当场报错', () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', GUIDE_SOURCE_NAME), '# 教程\n\n![x](images/missing.png)\n');
    assert.throws(() => renderGuide({ root, version: '1.0.0' }), /图片不存在/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildStage：解压后的目录结构 = extension/ + 安装教程.html', () => {
  const out = tmp();
  const version = readManifestVersion(ROOT);
  try {
    const { stageName, stageDir } = buildStage({ root: ROOT, outDir: out });
    assert.equal(stageName, `better-pta-problems-v${version}`);
    assert.ok(existsSync(path.join(stageDir, 'extension', 'manifest.json')));
    assert.ok(existsSync(path.join(stageDir, 'extension', 'content', 'core.js')));
    assert.ok(existsSync(path.join(stageDir, GUIDE_FILE)));
    assert.ok(!existsSync(path.join(stageDir, 'docs')), '发行包不带仓库文档目录');
    const guide = readFileSync(path.join(stageDir, GUIDE_FILE), 'utf8');
    assert.match(guide, new RegExp(`v${version.replace(/\./g, '\\.')}`));
    assert.match(guide, /加载已解压的扩展程序/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('buildStage：tag 与 manifest 版本不一致时拒绝打包，一致时放行', () => {
  const out = tmp();
  const version = readManifestVersion(ROOT);
  try {
    assert.throws(() => buildStage({ root: ROOT, outDir: out, tag: 'v0.0.1' }), /不一致/);
    assert.equal(buildStage({ root: ROOT, outDir: out, tag: `v${version}` }).version, version);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('packZip：条目齐全、全部带 UTF-8 标志位、重复打包结果稳定', () => {
  const out = tmp();
  try {
    const { stageName, stageDir } = buildStage({ root: ROOT, outDir: out });
    const zipPath = path.join(out, `${stageName}.zip`);
    const { buf, entries } = packZip({ stageDir, stageName, zipPath });
    const names = entries.map(e => e.name);

    assert.ok(names.includes(`${stageName}/extension/manifest.json`));
    assert.ok(names.includes(`${stageName}/${GUIDE_FILE}`));
    assert.ok(entries.every(e => e.flags & FLAG_UTF8));
    assert.deepEqual(names, readZip(readFileSync(zipPath)).map(e => e.name), '落盘的 zip 与返回值一致');
    assert.deepEqual(readZip(buf).map(e => `${e.name}:${e.data.length}`), names.map((n, i) => `${n}:${entries[i].size}`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
