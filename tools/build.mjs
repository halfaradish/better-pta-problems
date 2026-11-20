// 多目标构建：把 src/ 打包成 Chrome / Edge / Firefox 三份可加载的扩展。
//
// 用法：
//   npm run build                         # 等同 --target chrome，写回 extension/（保持旧行为）
//   npm run build -- --target chrome      # extension/
//   npm run build -- --target edge        # dist/edge/
//   npm run build -- --target firefox     # dist/firefox/
//   npm run build -- --target all         # 三份都出
//   npm run dev                           # 监听重建 Chrome（extension/）
//
// 产物路径：
//   extension/           Chrome 构建（仓库提交的漂移守卫对象，也被 GitHub 发行包使用）
//   dist/edge/           Edge 构建（Chromium MV3，与 Chrome 同代码，manifest 不带 minimum_chrome_version）
//   dist/firefox/        Firefox 构建（MV3 事件页，manifest 带 gecko + 数据收集声明）
//
// 静态资源（styles.css / popup.html / icons）仍以 extension/ 为母本：edge/firefox
// 构建时先复制这些文件，再覆盖 JS 与 manifest，避免三处各维护一份。
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestJson } from './manifests.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

const ENTRIES = [
  {
    in: 'src/content/index.js',
    out: 'content/core.js',
    banner: '更好的题目集 · PTA 题目集列表增强（构建产物，请勿直接编辑；源码见 src/content/）',
  },
  {
    in: 'src/background/index.js',
    out: 'background.js',
    banner: '更好的题目集 · 后台（Chrome service worker / Firefox 事件页；构建产物，源码见 src/background/）',
  },
  {
    in: 'src/popup/index.js',
    out: 'popup/popup.js',
    banner: '更好的题目集 · 设置弹窗（构建产物，请勿直接编辑；源码见 src/popup/）',
  },
];

// 这些文件是手写静态资源，三份构建共用 extension/ 里的母本。
const STATIC = ['content/styles.css', 'popup/popup.html', 'icons'];

const TARGETS = {
  chrome: { out: EXT, manifest: 'chrome', esbuildTarget: 'chrome121' },
  edge: { out: path.join(DIST, 'edge'), manifest: 'edge', esbuildTarget: 'chrome121' },
  firefox: { out: path.join(DIST, 'firefox'), manifest: 'firefox', esbuildTarget: 'firefox115' },
};

function parseArgs(argv) {
  const args = { target: 'chrome', watch: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--watch') args.watch = true;
    else if (arg === '--target') {
      args.target = argv[++i];
      if (!args.target) throw new Error('--target 后面要跟 chrome / edge / firefox / all');
    } else if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length);
    } else {
      throw new Error(`未知参数「${arg}」；可用：--target chrome|edge|firefox|all、--watch`);
    }
  }
  if (!['chrome', 'edge', 'firefox', 'all'].includes(args.target)) {
    throw new Error(`未知构建目标「${args.target}」；可用：chrome / edge / firefox / all`);
  }
  if (args.watch && args.target !== 'chrome') {
    throw new Error('--watch 只支持 chrome 目标（开发时加载 extension/）');
  }
  return args;
}

function esbuildOptions(entry, target) {
  return {
    entryPoints: [path.join(ROOT, entry.in)],
    outfile: path.join(target.out, entry.out),
    bundle: true,
    format: 'iife',
    target: target.esbuildTarget,
    banner: { js: `/* ${entry.banner} */` },
    logLevel: 'warning',
    metafile: false,
  };
}

function prepareOut(target) {
  if (target.out === EXT) return; // Chrome 直接写 extension/，静态资源本来就在
  rmSync(target.out, { recursive: true, force: true });
  mkdirSync(target.out, { recursive: true });
  for (const rel of STATIC) {
    const from = path.join(EXT, rel);
    if (!existsSync(from)) throw new Error(`缺少静态资源：${path.relative(ROOT, from)}`);
    cpSync(from, path.join(target.out, rel), { recursive: true });
  }
}

async function buildTarget(name) {
  const target = TARGETS[name];
  prepareOut(target);
  for (const entry of ENTRIES) {
    mkdirSync(path.dirname(path.join(target.out, entry.out)), { recursive: true });
    await build(esbuildOptions(entry, target));
  }
  writeFileSync(path.join(target.out, 'manifest.json'), manifestJson(target.manifest), 'utf8');
  console.log(`[build] ${name.padEnd(7)} → ${path.relative(ROOT, target.out).replace(/\\/g, '/')}/`);
}

async function watchChrome() {
  for (const entry of ENTRIES) {
    const ctx = await context(esbuildOptions(entry, TARGETS.chrome));
    await ctx.watch();
    console.log(`[watch] ${entry.in} → ${path.relative(ROOT, path.join(EXT, entry.out)).replace(/\\/g, '/')}`);
  }
  // manifest 是静态生成的，改 src/manifest 后重跑一次 npm run build 即可。
}

const args = parseArgs(process.argv.slice(2));
if (args.watch) {
  await watchChrome();
} else {
  const names = args.target === 'all' ? ['chrome', 'edge', 'firefox'] : [args.target];
  for (const name of names) await buildTarget(name);
  if (args.target === 'all') console.log('[build] all 完成：extension/ + dist/edge/ + dist/firefox/');
}
