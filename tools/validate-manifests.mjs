// 三份 manifest 的独立校验：不信任 build 刚写出来的东西，按商店要求逐项核对。
//
// 跑法：npm run build -- --target all && npm run validate:manifests
// CI 在构建后调用；任一断言失败即非零退出。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const TARGETS = [
  { name: 'chrome', dir: 'extension', kind: 'chromium' },
  { name: 'edge', dir: 'dist/edge', kind: 'chromium' },
  { name: 'firefox', dir: 'dist/firefox', kind: 'firefox' },
];

const COMMON = ['name', 'version', 'description', 'icons', 'permissions', 'host_permissions', 'content_scripts', 'action'];
const errors = [];
const fail = (target, message) => errors.push(`[${target}] ${message}`);

function readManifest(dir) {
  const file = path.join(ROOT, dir, 'manifest.json');
  if (!existsSync(file)) return { file, manifest: null };
  try {
    return { file, manifest: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { file, manifest: null, parseError: err.message };
  }
}

const baseRead = readManifest('extension');
if (!baseRead.manifest) {
  console.error(`[manifests] 找不到/无法解析 extension/manifest.json${baseRead.parseError ? '：' + baseRead.parseError : ''}`);
  process.exit(1);
}
const base = baseRead.manifest;

for (const target of TARGETS) {
  const { file, manifest, parseError } = readManifest(target.dir);
  if (!manifest) {
    fail(target.name, `缺少或无法解析 ${path.relative(ROOT, file)}${parseError ? '：' + parseError : ''}`);
    continue;
  }

  if (manifest.manifest_version !== 3) fail(target.name, `manifest_version 必须是 3，实际 ${manifest.manifest_version}`);

  for (const key of COMMON) {
    if (!isDeepStrictEqual(manifest[key], base[key])) {
      fail(target.name, `公共字段「${key}」与 extension/manifest.json 不一致`);
    }
  }

  if (target.kind === 'chromium') {
    if (manifest.background?.service_worker !== 'background.js') {
      fail(target.name, 'Chromium 的 background.service_worker 必须是 background.js');
    }
    if ('scripts' in (manifest.background || {})) fail(target.name, 'Chromium manifest 不应包含 background.scripts');
    if (manifest.browser_specific_settings) fail(target.name, 'Chromium manifest 不应包含 browser_specific_settings');
  } else {
    if (!Array.isArray(manifest.background?.scripts) || !manifest.background.scripts.includes('background.js')) {
      fail(target.name, 'Firefox 的 background.scripts 必须包含 background.js');
    }
    if ('service_worker' in (manifest.background || {})) fail(target.name, 'Firefox manifest 不应包含 background.service_worker');

    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko || typeof gecko.id !== 'string' || !gecko.id.trim()) {
      fail(target.name, '缺少 browser_specific_settings.gecko.id（MV3 签名必需）');
    }
    const min = Number.parseFloat(gecko?.strict_min_version);
    if (!Number.isFinite(min) || min < 140) {
      fail(target.name, 'strict_min_version 必须 >= 140.0（数据收集声明与运行时同意 API）');
    }
    const dc = gecko?.data_collection_permissions;
    if (!Array.isArray(dc?.required) || !dc.required.includes('none')) {
      fail(target.name, 'data_collection_permissions.required 必须包含 "none"');
    }
    for (const category of ['websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo']) {
      if (!Array.isArray(dc?.optional) || !dc.optional.includes(category)) {
        fail(target.name, `data_collection_permissions.optional 缺少 ${category}`);
      }
    }
  }

  // 引用的文件必须真的存在（商店会在上传时校验，提前在 CI 拦住）
  const referenced = ['background.js', 'content/core.js', 'content/styles.css', 'popup/popup.html', 'popup/popup.js'];
  for (const rel of referenced) {
    if (!existsSync(path.join(ROOT, target.dir, rel))) fail(target.name, `引用的文件不存在：${rel}`);
  }
  for (const icon of Object.values(manifest.icons || {})) {
    if (!existsSync(path.join(ROOT, target.dir, icon))) fail(target.name, `图标不存在：${icon}`);
  }
}

if (errors.length) {
  console.error('[manifests] 校验失败：');
  for (const err of errors) console.error('  ✗ ' + err);
  process.exit(1);
}

for (const target of TARGETS) {
  console.log(`[manifests] ${target.name.padEnd(7)} ✓ ${target.dir}/manifest.json`);
}
