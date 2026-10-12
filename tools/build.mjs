// 构建脚本：把 src/ 打包到 extension/ 的现有路径。
//
// 产物路径刻意与拆分前保持一致（extension/content/core.js、extension/background.js、
// extension/popup/popup.js），这样 manifest、preview.html、发版 workflow 的打包步骤
// 都不用改，`git clone` 后仍可直接「加载已解压的扩展程序」。
//
// 用法：npm run build（一次性）/ npm run dev（监听重建）
import { build, context } from 'esbuild';

const TARGETS = [
  { in: 'src/content/index.js', out: 'extension/content/core.js', label: '内容脚本', banner: '更好的题目集 · PTA 题目集列表增强（构建产物，请勿直接编辑；源码见 src/content/）' },
  { in: 'src/background/index.js', out: 'extension/background.js', label: '后台 service worker', banner: '更好的题目集 · 后台消息转发（构建产物，请勿直接编辑；源码见 src/background/）' },
  { in: 'src/popup/index.js', out: 'extension/popup/popup.js', label: '设置弹窗', banner: '更好的题目集 · 设置弹窗（构建产物，请勿直接编辑；源码见 src/popup/）' },
];

const options = t => ({
  entryPoints: [t.in],
  outfile: t.out,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  banner: { js: `/* ${t.banner} */` },
  logLevel: 'warning',
  metafile: false,
});

if (process.argv.includes('--watch')) {
  for (const t of TARGETS) {
    const ctx = await context(options(t));
    await ctx.watch();
    console.log(`[watch] ${t.in} → ${t.out}`);
  }
} else {
  for (const t of TARGETS) {
    await build(options(t));
    console.log(`[build] ${t.in} → ${t.out}`);
  }
}
