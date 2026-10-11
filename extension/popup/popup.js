const DEFAULTS = { enabled: true, badge: true, countdown: true, separators: '--,｜,|', rules: '', mergeSimilar: true, reminderServer: '', reminderEmail: '', settingsVersion: 0 };
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
  $('reminderServer').value = stored.reminderServer || '';
  $('reminderEmail').value = stored.reminderEmail || '';
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
    reminderServer: $('reminderServer').value.trim(),
    reminderEmail: $('reminderEmail').value.trim(),
  };
}

function save() {
  chrome.storage.sync.set({ settings: collect() });
}

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', save);
$('reminderServer').addEventListener('input', save);
$('reminderEmail').addEventListener('input', save);
$('testReminder').addEventListener('click', async () => {
  const status = $('reminderStatus');
  const show = (text, cls) => { status.textContent = text; status.className = 'status' + (cls ? ' ' + cls : ''); };
  const server = $('reminderServer').value.trim();
  const email = $('reminderEmail').value.trim();
  if (!server) return show('请先填写服务器地址', 'err');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show('邮箱格式不正确', 'err');
  save(); // 先落盘，再让 background 发起测试
  show('发送中…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'BPS_TEST', server, email });
    if (res?.ok) show('已发送，请查收', 'ok');
    else show('失败：' + (res?.error || '未知错误'), 'err');
  } catch (err) {
    show('失败：' + (err?.message || err), 'err');
  }
});
$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  load();
});

load();
