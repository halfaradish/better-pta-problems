// 商店发行包：zip 根目录直接是 manifest.json（Chrome Web Store / Edge Add-ons /
// Firefox AMO 都按这个结构校验），不带 GitHub 发行包的父目录与《安装教程》。
//
// 用法：
//   npm run build -- --target all
//   npm run package:store                 # 三个商店包
//   npm run package:store -- --target chrome
//
// 产出：dist/store/better-pta-problems-<target>-v<version>.zip
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, readZip } from './zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE_DIR = path.join(ROOT, 'dist', 'store');
const SOURCES = {
  chrome: 'extension',
  edge: 'dist/edge',
  firefox: 'dist/firefox',
};

function parseArgs(argv) {
  let target = 'all';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      target = argv[++i];
      if (!target) throw new Error('--target 后面要跟 chrome / edge / firefox / all');
    } else if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length);
    } else {
      throw new Error(`未知参数「${arg}」；可用：--target chrome|edge|firefox|all`);
    }
  }
  if (!['chrome', 'edge', 'firefox', 'all'].includes(target)) {
    throw new Error(`未知打包目标「${target}」；可用：chrome / edge / firefox / all`);
  }
  return { target };
}

function walkFiles(dir, rel = '') {
  const files = [];
  const names = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of names) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(abs, relPath));
    else files.push({ abs, name: relPath });
  }
  return files;
}

function packageTarget(target) {
  const sourceDir = path.join(ROOT, SOURCES[target]);
  const manifestFile = path.join(sourceDir, 'manifest.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`缺少 ${path.relative(ROOT, manifestFile)}；先跑 npm run build -- --target all`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const entries = walkFiles(sourceDir).map(f => ({ name: f.name, data: readFileSync(f.abs) }));
  if (!entries.some(e => e.name === 'manifest.json')) {
    throw new Error(`${SOURCES[target]}/manifest.json 不在 zip 根目录；商店会拒绝该包`);
  }

  const buf = makeZip(entries);
  const zipPath = path.join(STORE_DIR, `better-pta-problems-${target}-v${manifest.version}.zip`);
  writeFileSync(zipPath, buf);

  // 回读自检：条目齐全、manifest 在根、没有多套一层父目录
  const back = readZip(buf);
  if (back.length !== entries.length) throw new Error(`[${target}] zip 条目数 ${back.length} ≠ ${entries.length}`);
  if (!back.some(e => e.name === 'manifest.json')) throw new Error(`[${target}] 回读后根目录没有 manifest.json`);
  const nestedManifest = back.find(e => e.name.endsWith('/manifest.json'));
  if (nestedManifest) throw new Error(`[${target}] manifest.json 被套进了子目录：${nestedManifest.name}`);

  console.log(`[store] ${target.padEnd(7)} → ${path.relative(ROOT, zipPath).replace(/\\/g, '/')}  ${(buf.length / 1024).toFixed(1)} KB（${back.length} 个条目，根 manifest.json）`);
  return { zipPath, version: manifest.version };
}

const { target } = parseArgs(process.argv.slice(2));
mkdirSync(STORE_DIR, { recursive: true });
const names = target === 'all' ? ['chrome', 'edge', 'firefox'] : [target];
const built = names.map(packageTarget);
for (const item of built) {
  if (item.version !== built[0].version) throw new Error(`版本不一致：${item.zipPath} 是 ${item.version}，${built[0].zipPath} 是 ${built[0].version}`);
}
console.log(`[store] 完成：v${built[0].version}（${built.length} 个商店包）`);
