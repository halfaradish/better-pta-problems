// 跨浏览器 API 口：Chrome 走 chrome.*，Firefox 走 browser.*；数据收集同意只在 Firefox 拦截。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIREFOX_DATA, ext, hasDataConsent, hasDataConsentViaBackground, hasHostPermissions, isFirefox,
  requestDataConsent, sendMessage,
} from '../src/shared/ext.js';

function clearGlobals(t) {
  const saved = { chrome: globalThis.chrome, browser: globalThis.browser };
  t.after(() => {
    if (saved.chrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = saved.chrome;
    if (saved.browser === undefined) delete globalThis.browser;
    else globalThis.browser = saved.browser;
  });
  delete globalThis.chrome;
  delete globalThis.browser;
}

test('ext()：优先 Firefox 的 browser，其次 chrome，都没有返回 null', t => {
  clearGlobals(t);
  const chrome = { name: 'chrome' };
  globalThis.chrome = chrome;
  assert.equal(ext(), chrome);
  assert.equal(isFirefox(), false);

  const browser = { name: 'browser', runtime: { getBrowserInfo: () => {} } };
  globalThis.browser = browser;
  assert.equal(ext(), browser);
  assert.equal(isFirefox(), true);

  // 内容脚本可能看不到 getBrowserInfo：Firefox 构建的 manifest 带 gecko 段。
  globalThis.browser = { runtime: { getManifest: () => ({ browser_specific_settings: { gecko: {} } }) } };
  assert.equal(isFirefox(), true);
  globalThis.browser = { runtime: { getManifest: () => ({ manifest_version: 3 }) } };
  assert.equal(isFirefox(), false, 'Chrome 148+ 的原生 browser 命名空间不应被误判');
});

test('sendMessage()：Promise 型宿主直接透传；无宿主时安全地解析为 undefined', async t => {
  clearGlobals(t);
  globalThis.chrome = { runtime: { sendMessage: msg => Promise.resolve({ echo: msg }) } };
  assert.deepEqual(await sendMessage({ a: 1 }), { echo: { a: 1 } });

  delete globalThis.chrome;
  assert.equal(await sendMessage({ a: 1 }), undefined);
});

test('hasDataConsent()：非 Firefox 直接放行；Firefox 按 permissions.contains 判定', async t => {
  clearGlobals(t);
  globalThis.chrome = {};
  assert.equal(await hasDataConsent(FIREFOX_DATA.autoAnswer), true); // Chrome 没有运行时同意层

  let asked = null;
  globalThis.browser = {
    runtime: { getBrowserInfo: () => {} },
    permissions: {
      contains: async q => { asked = q; return true; },
      request: async () => true,
    },
  };
  assert.equal(await hasDataConsent(FIREFOX_DATA.autoAnswer), true);
  assert.deepEqual(asked, { data_collection: FIREFOX_DATA.autoAnswer });

  globalThis.browser.permissions.contains = async () => false;
  assert.equal(await hasDataConsent(FIREFOX_DATA.autoAnswer), false);
});

test('hasDataConsentViaBackground()：内容脚本没有 permissions API 时让后台代查', async t => {
  clearGlobals(t);
  const asked = [];
  globalThis.browser = {
    runtime: {
      getManifest: () => ({ browser_specific_settings: { gecko: {} } }),
      sendMessage: async msg => { asked.push(msg); return { granted: false }; },
    },
  };
  assert.equal(await hasDataConsentViaBackground(FIREFOX_DATA.autoAnswer), false);
  assert.deepEqual(asked, [{ type: 'BPS_DATA_CONSENT', categories: FIREFOX_DATA.autoAnswer }]);

  globalThis.browser.runtime.sendMessage = async () => ({ granted: true });
  assert.equal(await hasDataConsentViaBackground(FIREFOX_DATA.autoAnswer), true);

  globalThis.browser.runtime.sendMessage = async () => { throw new Error('后台不在'); };
  assert.equal(await hasDataConsentViaBackground(FIREFOX_DATA.autoAnswer), false, '拿不准时拒绝外发');
});

test('requestDataConsent() / host 权限：只在 Firefox 调 permissions.request', async t => {
  clearGlobals(t);
  globalThis.chrome = {};
  assert.equal(await requestDataConsent(FIREFOX_DATA.email), true); // Chrome 不请求
  assert.equal(await hasHostPermissions(), true);

  const calls = [];
  globalThis.browser = {
    runtime: { getBrowserInfo: () => {} },
    permissions: {
      request: async q => { calls.push(q); return true; },
      contains: async q => { calls.push(q); return false; },
    },
  };
  assert.equal(await requestDataConsent(FIREFOX_DATA.email), true);
  assert.deepEqual(calls[0], { data_collection: FIREFOX_DATA.email });
  assert.equal(await hasHostPermissions(['https://example.com/*']), false);
  assert.deepEqual(calls[1], { origins: ['https://example.com/*'] });
});
