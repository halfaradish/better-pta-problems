const DEFAULTS = { enabled: true, badge: true, countdown: true, separators: '--,｜,|', rules: '', mergeSimilar: true, settingsVersion: 0 };
const $ = id => document.getElementById(id);
let stored = { ...DEFAULTS };

async function load() {
  const { settings } = await chrome.storage.sync.get({ settings: {} });
  stored = { ...DEFAULTS, ...settings };
  // 与内容脚本一致的 v4 迁移：列表/分组改为按路由的会话内状态，不再持久化
  if (!stored.settingsVersion || stored.settingsVersion < 4) {
    delete stored.grouped;
    stored.settingsVersion = 4;
  }
  for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar']) $(k).checked = !!stored[k];
  $('separators').value = stored.separators;
  $('rules').value = stored.rules || '';
}

function collect() {
  // 保留 settingsVersion 等非 UI 字段，避免保存时把迁移标记抹掉
  return {
    ...stored,
    settingsVersion: Math.max(stored.settingsVersion || 0, 4),
    enabled: $('enabled').checked,
    badge: $('badge').checked,
    countdown: $('countdown').checked,
    mergeSimilar: $('mergeSimilar').checked,
    separators: $('separators').value.trim() || DEFAULTS.separators,
    rules: $('rules').value.trim(),
  };
}

function save() {
  chrome.storage.sync.set({ settings: collect() });
}

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', save);
$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  load();
});

load();
