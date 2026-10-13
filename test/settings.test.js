// 设置的默认值、版本迁移与存储降级（内容脚本与弹窗共用同一份）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULTS, SETTINGS_VERSION, loadSettings, migrate, needsMigration, sanitizeSettings, saveSettings, unwrapExport,
} from '../src/shared/settings.js';

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

test('unwrapExport：信封与裸设置对象两种形态都解出设置', () => {
  const envelope = { app: 'better-pta-problems', settingsVersion: 6, exportedAt: 'x', settings: { enabled: false } };
  assert.deepEqual(unwrapExport(envelope), { enabled: false });
  assert.deepEqual(unwrapExport({ enabled: false }), { enabled: false }); // 裸对象原样返回
  assert.deepEqual(unwrapExport(null), null); // 交由 sanitizeSettings 兜底
  // settings 字段不是对象时不算信封
  assert.deepEqual(unwrapExport({ settings: 'bad' }), { settings: 'bad' });
});

test('sanitizeSettings：只收认识且同型的字段，导入旧格式先迁移再清洗', () => {
  // 合法字段保留，未知字段丢弃
  const clean = sanitizeSettings({
    enabled: false, separators: '·', autoAnswerApiKeys: { deepseek: 'sk-a' },
    evil: 'drop-me', autoAnswer: true,
  });
  assert.equal(clean.enabled, false);
  assert.equal(clean.separators, '·');
  assert.deepEqual(clean.autoAnswerApiKeys, { deepseek: 'sk-a' });
  assert.equal(clean.autoAnswer, true);
  assert.equal('evil' in clean, false);
  assert.equal(clean.settingsVersion, SETTINGS_VERSION);

  // 类型不对的回默认
  assert.equal(sanitizeSettings({ enabled: 'yes' }).enabled, DEFAULTS.enabled);
  assert.equal(sanitizeSettings({ separators: 123 }).separators, DEFAULTS.separators);
  assert.deepEqual(sanitizeSettings({ autoAnswerApiKeys: [] }).autoAnswerApiKeys, {});
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULTS, settingsVersion: SETTINGS_VERSION });

  // Key 映射逐条过滤：非字符串值的条目丢弃，字符串保留
  assert.deepEqual(
    sanitizeSettings({ autoAnswerApiKeys: { deepseek: 'sk-a', junk: 42, nested: {} } }).autoAnswerApiKeys,
    { deepseek: 'sk-a' },
  );
});

test('导入全链路：unwrapExport → migrate → sanitize 兼容 v5 旧导出', () => {
  const legacy = { settingsVersion: 5, autoAnswerApiKey: 'sk-legacy', autoAnswerGateway: 'opencode', grouped: true };
  const next = sanitizeSettings(migrate(unwrapExport(legacy)));
  assert.equal(next.settingsVersion, SETTINGS_VERSION);
  assert.deepEqual(next.autoAnswerApiKeys, { opencode: 'sk-legacy' }); // 旧 Key 已归档
  assert.equal('autoAnswerApiKey' in next, false);
  assert.equal('grouped' in next, false);
});
