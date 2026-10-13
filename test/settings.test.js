// 设置的默认值、版本迁移与存储降级（内容脚本与弹窗共用同一份）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, loadSettings, migrate, needsMigration, saveSettings } from '../src/shared/settings.js';

test('migrate：旧版设置升级到 v6，删掉不再持久化的 grouped，自动答题字段补默认值', () => {
  const next = migrate({ grouped: true, enabled: false });
  assert.equal(next.settingsVersion, 6);
  assert.equal('grouped' in next, false);
  assert.equal(next.enabled, false);
  assert.equal(next.separators, DEFAULTS.separators); // 缺失字段补默认值
  assert.equal(next.autoAnswer, false);             // 悬浮球总开关默认关
  assert.deepEqual(next.autoAnswerApiKeys, {});     // 每个服务各存一把 Key（默认全空）
  assert.equal(next.autoAnswerGateway, 'deepseek'); // 面板选中的模型适配默认 DeepSeek
  assert.equal(next.autoAnswerModel, '');
  assert.equal(next.autoAnswerBaseUrl, '');
  assert.equal(next.autoAnswerOverwrite, false);
  assert.equal(next.autoAnswerImages, false); // 含图题默认跳过（视觉模型需用户显式开启）
  assert.equal(next.autoAnswerLanguage, ''); // 编程题语言默认跟随编辑器当前（不固定）
});

test('migrate v5→v6：旧的单把 API Key 归入当时选中的服务名下', () => {
  const next = migrate({ settingsVersion: 5, autoAnswerApiKey: 'sk-legacy', autoAnswerGateway: 'opencode' });
  assert.equal(next.settingsVersion, 6);
  assert.deepEqual(next.autoAnswerApiKeys, { opencode: 'sk-legacy' });
  assert.equal('autoAnswerApiKey' in next, false); // 旧字段清掉，防止继续被读成全局 Key

  // 未选过服务（默认 deepseek）也一样归档
  const deepseek = migrate({ autoAnswerApiKey: 'sk-a' });
  assert.deepEqual(deepseek.autoAnswerApiKeys, { deepseek: 'sk-a' });
});

test('migrate：已是 v6 的设置不再改动', () => {
  const kept = migrate({ settingsVersion: 6, separators: '·', grouped: true });
  assert.equal(kept.separators, '·');
  assert.equal(kept.grouped, true); // 迁移只负责旧版清理
});

test('needsMigration', () => {
  assert.equal(needsMigration({}), true);
  assert.equal(needsMigration({ settingsVersion: 4 }), true);
  assert.equal(needsMigration({ settingsVersion: 5 }), true);
  assert.equal(needsMigration({ settingsVersion: 6 }), false);
});

test('无扩展环境（预览页 / 独立打开弹窗）退化为内存存储', async () => {
  globalThis.__BPS_SETTINGS__ = undefined;
  const initial = await loadSettings();
  assert.equal(initial.badge, DEFAULTS.badge);
  assert.equal(initial.settingsVersion, 6);
  await saveSettings({ ...DEFAULTS, badge: false });
  assert.equal(globalThis.__BPS_SETTINGS__.badge, false);
  assert.equal((await loadSettings()).badge, false);
  globalThis.__BPS_SETTINGS__ = undefined;
});

test('loadSettings：persistMigration 才把迁移结果写回', async () => {
  globalThis.__BPS_SETTINGS__ = { grouped: true, enabled: true };
  const inMemory = await loadSettings();
  assert.equal(inMemory.settingsVersion, 6);
  assert.equal(globalThis.__BPS_SETTINGS__.settingsVersion, undefined); // 未写回

  globalThis.__BPS_SETTINGS__ = { grouped: true, enabled: true };
  await loadSettings({ persistMigration: true });
  assert.equal(globalThis.__BPS_SETTINGS__.settingsVersion, 6);
  assert.equal('grouped' in globalThis.__BPS_SETTINGS__, false);
  globalThis.__BPS_SETTINGS__ = undefined;
});
