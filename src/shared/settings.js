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
  progress: true,         // 考试型题目集的答题状态胶囊（顶替原生「已开放」，见 content/progress.js）
  reminderEnabled: true,  // 题目关闭邮件提醒总开关（与下面两项配置配合；关闭即暂停同步）
  reminderServer: '',     // 邮件提醒后端地址（ip:port，可加 /令牌 后缀）；空 = 关闭
  reminderEmail: '',      // 提醒邮件接收邮箱
  // 自动答题（实验）：入口为题目页的悬浮球面板（弹窗只留总开关），见 docs/自动答题初探.md §9
  autoAnswer: false,          // 题目列表页显示悬浮答题球（实验功能，默认关）
  autoAnswerApiKeys: {},      // 每个模型服务各存一把 Key（键 = PRESETS 键），切服务不互相覆盖
  autoAnswerGateway: 'deepseek', // 悬浮面板选中的模型适配（content/autoanswer-panel.js 的 PRESETS 键）
  autoAnswerModel: '',        // 可自填网关的模型名（OpenCode Go / 自定义）；空 = 用适配预设的默认模型
  autoAnswerBaseUrl: '',      // 「自定义」服务的 OpenAI 兼容端点（填到 /v1；仅选自定义时用）
  autoAnswerOverwrite: false, // 覆盖已作答的题目（默认跳过已答，避免把用户的正确答案改错）
  autoAnswerImages: false,    // 含图题作答（需视觉模型如 deepseek-flash：图片下载编码进 prompt；默认关闭=含图题跳过）
  autoAnswerLanguage: '',     // 编程题固定语言（exams 接口白名单的编译器 id）；空 = 跟随各题编辑器当前语言
  settingsVersion: 0,     // 0 = 旧版设置；v4 起「列表/分组」不再持久化（改为按路由的会话内状态）
};

export const SETTINGS_VERSION = 6;

// 扩展环境用 chrome.storage.sync（跨设备同步）；预览页 / 独立打开的弹窗退化为内存
export const HAS_CHROME_STORAGE = typeof chrome !== 'undefined' && !!chrome.storage?.sync;

export function needsMigration(raw) {
  return (raw?.settingsVersion || 0) < SETTINGS_VERSION;
}

export function migrate(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  if (needsMigration(s)) {
    delete s.grouped;                 // 旧版持久化的视图偏好，现已由会话内状态接管
    // v6：API Key 改为按服务各存一把 —— 旧的单把 Key 归入当前选中的服务名下，
    // 这样切服务不再互相覆盖；迁移后旧字段清掉
    if (typeof s.autoAnswerApiKey === 'string' && s.autoAnswerApiKey) {
      s.autoAnswerApiKeys = { ...(s.autoAnswerApiKeys || {}), [s.autoAnswerGateway || 'deepseek']: s.autoAnswerApiKey };
    }
    delete s.autoAnswerApiKey;
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

/* ---------- 配置备份（弹窗的导入/导出共用） ---------- */

// 导出文件信封解包：兼容 { app, settings } 信封与裸设置对象两种形态
export function unwrapExport(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) {
    return raw.settings;
  }
  return raw;
}

// 导入清洗：只收与 DEFAULTS 同名同型的字段（旧版字段经 migrate 先行归档），其余丢默认；
// 返回可直接落盘的对象（settingsVersion 固定当前版）
export function sanitizeSettings(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const next = {};
  for (const [k, dv] of Object.entries(DEFAULTS)) {
    const v = src[k];
    if (typeof dv === 'boolean') next[k] = typeof v === 'boolean' ? v : dv;
    else if (typeof dv === 'string') next[k] = typeof v === 'string' ? v : dv;
    else if (typeof dv === 'number') next[k] = (typeof v === 'number' && Number.isFinite(v)) ? v : dv;
    else if (k === 'autoAnswerApiKeys') {
      // Key 映射逐条过滤：只留字符串值的条目
      const map = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      next[k] = {};
      for (const [gk, gv] of Object.entries(map)) if (typeof gv === 'string') next[k][gk] = gv;
    } else next[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : dv;
  }
  next.settingsVersion = SETTINGS_VERSION;
  return next;
}
