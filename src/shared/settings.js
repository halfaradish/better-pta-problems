/* 设置的唯一定义处：内容脚本与弹窗共用。
 *
 * 拆分前 DEFAULTS 与版本迁移在 core.js 和 popup.js 各写一份，加一个开关要改两处，
 * 漏一处就是静默漂移——现在只有这里一份。
 */
export const DEFAULTS = {
  enabled: true,          // 总开关
  badge: true,            // 卡片上的课程徽章
  countdown: true,        // 截止倒计时（仅剩 ≤7 天时显示）
  separators: '--,｜,|',  // 课程名分隔符：取首个分隔符之前的部分作为课程名
  rules: '',              // 自定义规则，每行一条：关键词=>课程名（包含匹配，优先于自动识别）
  mergeSimilar: true,     // 同一教师下相似课程名自动归并为同一门课
  openInNewTab: true,     // 点开题目集在新标签页打开（绕过 PTA 的 SPA 同页跳转）
  reminderEnabled: true,  // 题目关闭邮件提醒总开关（与下面两项配置配合；关闭即暂停同步）
  reminderServer: '',     // 邮件提醒后端地址（ip:port，可加 /令牌 后缀）；空 = 关闭
  reminderEmail: '',      // 提醒邮件接收邮箱
  settingsVersion: 0,     // 0 = 旧版设置；v4 起「列表/分组」不再持久化（改为按路由的会话内状态）
};

export const SETTINGS_VERSION = 4;

// 扩展环境用 chrome.storage.sync（跨设备同步）；预览页 / 独立打开的弹窗退化为内存
export const HAS_CHROME_STORAGE = typeof chrome !== 'undefined' && !!chrome.storage?.sync;

export function needsMigration(raw) {
  return (raw?.settingsVersion || 0) < SETTINGS_VERSION;
}

export function migrate(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  if (needsMigration(s)) {
    delete s.grouped;                 // 旧版持久化的视图偏好，现已由会话内状态接管
    s.settingsVersion = SETTINGS_VERSION;
  }
  return s;
}

export const storage = {
  async get() {
    try {
      if (HAS_CHROME_STORAGE) {
        const { settings } = await chrome.storage.sync.get({ settings: {} });
        return { ...DEFAULTS, ...settings };
      }
    } catch (_) { /* fall through */ }
    return { ...DEFAULTS, ...(globalThis.__BPS_SETTINGS__ || {}) };
  },
  async set(next) {
    try {
      if (HAS_CHROME_STORAGE) {
        await chrome.storage.sync.set({ settings: next });
        return;
      }
    } catch (_) { /* fall through */ }
    globalThis.__BPS_SETTINGS__ = next;
  },
};

// 内容脚本用 persistMigration：把迁移结果写回，避免每次加载都重跑迁移。
// 弹窗不写回（等到用户真正保存时随 collect() 一起落盘）。
export async function loadSettings({ persistMigration = false } = {}) {
  const raw = await storage.get();
  const next = migrate(raw);
  if (persistMigration && needsMigration(raw)) await storage.set(next);
  return next;
}

export function saveSettings(next) {
  return storage.set(next);
}

export function onSettingsChanged(cb) {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) cb({ ...DEFAULTS, ...changes.settings.newValue });
  });
}
