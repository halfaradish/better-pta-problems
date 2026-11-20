// 三份 manifest 的构造契约：公共身份一致，后台模型与 Firefox 元数据按目标分化。
// 产物级校验在 tools/validate-manifests.mjs（CI 在构建后跑），这里钉住源头的生成规则。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANIFEST_TARGETS, manifestFor, manifestJson } from '../tools/manifests.mjs';

const chrome = manifestFor('chrome');
const edge = manifestFor('edge');
const firefox = manifestFor('firefox');

test('三个目标都产出 MV3 且公共身份字段完全一致', () => {
  for (const m of [chrome, edge, firefox]) {
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, '更好的题目集（PTA 增强）');
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    assert.ok(m.description.length <= 132, 'Chrome/Edge 的 manifest description 上限 132 字符');
  }
  assert.equal(edge.name, chrome.name);
  assert.equal(edge.version, chrome.version);
  assert.equal(firefox.name, chrome.name);
  assert.equal(firefox.version, chrome.version);
  assert.equal(firefox.description, chrome.description);
});

test('公共权限与内容脚本在三个目标间不漂移', () => {
  for (const m of [edge, firefox]) {
    assert.deepEqual(m.permissions, chrome.permissions);
    assert.deepEqual(m.host_permissions, chrome.host_permissions);
    assert.deepEqual(m.content_scripts, chrome.content_scripts);
    assert.deepEqual(m.icons, chrome.icons);
  }
  assert.deepEqual(chrome.permissions, ['storage', 'alarms', 'notifications']);
});

test('Chrome / Edge 用 service_worker，且不带 Firefox 专属键', () => {
  for (const m of [chrome, edge]) {
    assert.equal(m.background.service_worker, 'background.js');
    assert.equal('scripts' in m.background, false);
    assert.equal('browser_specific_settings' in m, false);
  }
  assert.equal(chrome.minimum_chrome_version, '121'); // Chrome 121 起所有异步扩展 API 支持 Promise
  assert.equal('minimum_chrome_version' in edge, false, 'Edge 包不写 Chrome 专属的 minimum_chrome_version');
});

test('Firefox 用事件页 background.scripts，且带 gecko id / 最低版本 / 数据收集声明', () => {
  assert.deepEqual(firefox.background.scripts, ['background.js']);
  assert.equal('service_worker' in firefox.background, false);

  const gecko = firefox.browser_specific_settings.gecko;
  assert.match(gecko.id, /@/);
  assert.ok(Number.parseFloat(gecko.strict_min_version) >= 140);
  assert.deepEqual(gecko.data_collection_permissions.required, ['none']);
  for (const category of ['websiteContent', 'authenticationInfo', 'personallyIdentifyingInfo']) {
    assert.ok(gecko.data_collection_permissions.optional.includes(category), `缺少可选类别 ${category}`);
  }
});

test('manifestJson 是可回读的 2 空格 JSON 且以换行结尾', () => {
  const text = manifestJson('firefox');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), firefox);
});

test('目标名白名单：未知目标直接报错', () => {
  assert.deepEqual(MANIFEST_TARGETS, ['chrome', 'edge', 'firefox']);
  assert.throws(() => manifestFor('safari'), /未知 manifest 目标/);
});
