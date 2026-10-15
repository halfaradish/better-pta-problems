// 组装发行包：把 extension/ 与由 docs/安装教程.md 渲染出的《安装教程》打成一个 zip。
//
// 用法：
//   npm run package                  # 版本号取自 extension/manifest.json
//   npm run package -- --tag v0.9.7  # 顺带校验 tag 与 manifest 版本一致（发版流程用）
//
// 产出 dist/better-pta-problems-v<版本>/（组装目录，便于发版流程断言）与同名 .zip：
//   better-pta-problems-v<版本>/
//   ├── extension/          ← 浏览器「加载已解压的扩展程序」要选的目录
//   └── 安装教程.html       ← 双击即读（中文文件名带 UTF-8 标志位，见 tools/zip.mjs）
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import { FLAG_UTF8, makeZip, readZip } from './zip.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_URL = 'https://github.com/halfaradish/better-pta-problems';
export const GUIDE_FILE = '安装教程.html';
const GUIDE_SOURCE = path.join('docs', '安装教程.md');
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function readManifestVersion(root = ROOT) {
  const file = path.join(root, 'extension', 'manifest.json');
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

// 教程里的本地图片内联成 data URI：HTML 离线可读，单独拖出来也不裂图。
function inlineLocalImages(html, baseDir) {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (whole, pre, src, post) => {
    if (/^(https?:|data:)/i.test(src)) return whole;
    const ext = path.extname(src).toLowerCase();
    if (!MIME[ext]) return whole;
    const file = path.resolve(baseDir, decodeURIComponent(src));
    let data;
    try {
      data = readFileSync(file);
    } catch {
      throw new Error(`教程（${GUIDE_SOURCE}）里引用的图片不存在：${src}`);
    }
    return `${pre}data:${MIME[ext]};base64,${data.toString('base64')}${post}`;
  });
}

export function renderGuide({ root = ROOT, version, date = new Date() } = {}) {
  const source = path.join(root, GUIDE_SOURCE);
  if (!statSync(source, { throwIfNoEntry: false })) throw new Error(`找不到教程正文：${source}`);
  const markdown = readFileSync(source, 'utf8');
  const rendered = inlineLocalImages(new MarkdownIt({ html: false }).render(markdown), path.dirname(source));

  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? '安装教程';
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const meta = `<p class="meta">本包版本 <strong>v${version}</strong> · 打包于 ${stamp} · <a href="${REPO_URL}">GitHub 仓库</a></p>`;
  const body = rendered.includes('</h1>') ? rendered.replace('</h1>', `</h1>\n${meta}`) : `${meta}\n${rendered}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}（v${version}）</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 20px 72px;
    background: #ffffff;
    color: #1f2328;
    font: 16px/1.75 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 26px; line-height: 1.4; }
  h2 { margin: 2.2em 0 .6em; padding-bottom: .3em; font-size: 21px; border-bottom: 1px solid #e6e8eb; }
  h3 { margin: 1.8em 0 .5em; font-size: 17px; }
  p, li { margin: .5em 0; }
  ul, ol { padding-left: 1.6em; }
  li > ul, li > ol { margin: .3em 0; }
  a { color: #0b62d0; text-underline-offset: 2px; }
  strong { font-weight: 600; }
  .meta { margin: 0 0 1.5em; color: #6b7280; font-size: 14px; }
  code {
    padding: .15em .42em;
    background: #f2f4f7;
    border: 1px solid #e6e8eb;
    border-radius: 5px;
    font-family: ui-monospace, SFMono-Regular, Consolas, "Courier New", monospace;
    font-size: .9em;
    white-space: nowrap;
  }
  pre {
    margin: .9em 0;
    padding: 12px 14px;
    background: #f8fafc;
    border: 1px solid #e6e8eb;
    border-radius: 8px;
    overflow: auto;
  }
  pre code { padding: 0; background: none; border: 0; white-space: pre; font-size: .88em; line-height: 1.6; }
  blockquote {
    margin: 1em 0;
    padding: .7em 1em;
    background: #eef5ff;
    border-left: 4px solid #3b82f6;
    border-radius: 0 8px 8px 0;
  }
  blockquote p { margin: .2em 0; }
  h2 + p, h3 + p { margin-top: .2em; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8eb; }
    h2 { border-color: #2c3038; }
    a { color: #6cb2ff; }
    .meta { color: #9098a3; }
    code { background: #22262d; border-color: #2c3038; }
    pre { background: #1c1f25; border-color: #2c3038; }
    blockquote { background: #1b2635; border-color: #4b8bf5; }
  }
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function walkFiles(dir, rel = '') {
  const files = [];
  const names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of names) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(abs, relPath));
    else files.push({ abs, rel: relPath });
  }
  return files;
}

// 组装 dist/better-pta-problems-v<版本>/：extension/ + 安装教程.html
export function buildStage({ root = ROOT, outDir, tag } = {}) {
  const version = readManifestVersion(root);
  if (tag && tag.replace(/^v/, '') !== version) {
    throw new Error(`tag「${tag}」与 extension/manifest.json 的 version「${version}」不一致`);
  }
  const stageName = `better-pta-problems-v${version}`;
  const stageDir = path.join(outDir, stageName);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(path.join(root, 'extension'), path.join(stageDir, 'extension'), { recursive: true });
  writeFileSync(path.join(stageDir, GUIDE_FILE), renderGuide({ root, version }), 'utf8');
  return { version, stageName, stageDir };
}

export function stageEntries(stageDir, stageName) {
  return walkFiles(stageDir).map(f => ({ name: `${stageName}/${f.rel}`, data: readFileSync(f.abs) }));
}

// 打包并回读自检：条目齐全、UTF-8 文件名标志位已设置、内容校验通过。
export function packZip({ stageDir, stageName, zipPath }) {
  const entries = stageEntries(stageDir, stageName);
  const buf = makeZip(entries);
  rmSync(zipPath, { force: true });
  writeFileSync(zipPath, buf);

  const back = readZip(buf);
  if (back.length !== entries.length) throw new Error(`zip 自检失败：条目数 ${back.length} ≠ ${entries.length}`);
  for (let i = 0; i < entries.length; i++) {
    if (back[i].name !== entries[i].name) throw new Error(`zip 自检失败：条目 ${back[i].name} ≠ ${entries[i].name}`);
    if (!(back[i].flags & FLAG_UTF8)) throw new Error(`zip 自检失败：「${back[i].name}」未设置 UTF-8 文件名标志位`);
  }
  return { buf, entries: back };
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  const tagAt = args.indexOf('--tag');
  const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
  if (tagAt >= 0 && !tag) throw new Error('--tag 后面要跟版本 tag，如：--tag v0.9.7');

  const outDir = path.join(ROOT, 'dist');
  const { version, stageName, stageDir } = buildStage({ outDir, tag });
  const zipPath = path.join(outDir, `${stageName}.zip`);
  const { buf, entries } = packZip({ stageDir, stageName, zipPath });
  const raw = entries.reduce((sum, e) => sum + e.size, 0);

  console.log(`[package] v${version}${tag ? `（tag ${tag} 校验一致）` : ''}`);
  console.log(`[package] ${path.relative(ROOT, stageDir).replace(/\\/g, '/')}/`);
  for (const e of entries) {
    console.log(`          ${e.name.slice(stageName.length + 1)}  ${kb(e.size)}${e.compressedSize < e.size ? ` → ${kb(e.compressedSize)}` : ''}`);
  }
  console.log(`[package] ${path.relative(ROOT, zipPath).replace(/\\/g, '/')}  ${kb(raw)} → ${kb(buf.length)}（${entries.length} 个条目，均带 UTF-8 文件名标志位）`);
}
