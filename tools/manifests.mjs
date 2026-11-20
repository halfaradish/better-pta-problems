// 三份 manifest 的唯一来源：base.json（公共字段）+ 各浏览器 overlay。
//
// base 里的 name / version / description / permissions / content_scripts 不允许被
// overlay 覆盖——三个商店的扩展身份必须一致，差异只允许出现在后台模型与 Firefox
// 专属的 gecko 元数据上。校验脚本会再独立核对一遍，防止有人绕过这里直接改产物。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MANIFEST_DIR = path.join(ROOT, 'src', 'manifest');
export const MANIFEST_TARGETS = ['chrome', 'edge', 'firefox'];

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function manifestFor(target) {
  if (!MANIFEST_TARGETS.includes(target)) {
    throw new Error(`未知 manifest 目标「${target}」，可选：${MANIFEST_TARGETS.join(' / ')}`);
  }
  const base = readJson(path.join(MANIFEST_DIR, 'base.json'));
  const overlay = readJson(path.join(MANIFEST_DIR, `${target}.json`));
  for (const key of ['name', 'version', 'description', 'permissions', 'host_permissions', 'content_scripts']) {
    if (key in overlay) throw new Error(`${target}.json 不允许覆盖公共字段「${key}」；请改 base.json`);
  }
  return {
    ...base,
    ...overlay,
    icons: { ...(base.icons || {}), ...(overlay.icons || {}) },
  };
}

export function manifestJson(target) {
  return JSON.stringify(manifestFor(target), null, 2) + '\n';
}
