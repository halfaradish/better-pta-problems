const DEFAULTS = { enabled: true, badge: true, countdown: true, separators: '--,｜,|', rules: '', mergeSimilar: true, openInNewTab: true, reminderEnabled: true, reminderServer: '', reminderEmail: '', settingsVersion: 0 };
const $ = id => document.getElementById(id);
let stored = { ...DEFAULTS };
// 无扩展环境（直接打开 popup.html 做设计回归）时优雅降级：用默认值渲染、跳过存储
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.sync;

async function load() {
  if (hasChrome) {
    const { settings } = await chrome.storage.sync.get({ settings: {} });
    stored = { ...DEFAULTS, ...settings };
    // 与内容脚本一致的 v4 迁移：列表/分组改为按路由的会话内状态，不再持久化
    if (!stored.settingsVersion || stored.settingsVersion < 4) {
      delete stored.grouped;
      stored.settingsVersion = 4;
    }
  }
  for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab']) $(k).checked = !!stored[k];
  $('separators').value = stored.separators;
  $('rules').value = stored.rules || '';
  $('reminderEnabled').checked = stored.reminderEnabled !== false;
  $('reminderServer').value = stored.reminderServer || '';
  $('reminderEmail').value = stored.reminderEmail || '';
  applyReminderEnabled();
  resumeTestCooldown();
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
    openInNewTab: $('openInNewTab').checked,
    separators: $('separators').value.trim() || DEFAULTS.separators,
    rules: $('rules').value.trim(),
    reminderEnabled: $('reminderEnabled').checked,
    reminderServer: $('reminderServer').value.trim(),
    reminderEmail: $('reminderEmail').value.trim(),
  };
}

function save() {
  if (hasChrome) chrome.storage.sync.set({ settings: collect() });
}

/* ---------- 邮件提醒开关与测试邮件冷却 ---------- */
const TEST_COOLDOWN_MS = 60 * 1000; // 与后端 /api/test 的每邮箱冷却一致，双保险
let testCooldownUntil = 0;
let countdownTimer = null;
let testBusy = false;

function applyReminderEnabled() {
  const on = $('reminderEnabled').checked;
  $('reminderServer').disabled = !on;
  $('reminderEmail').disabled = !on;
  $('testReminder').disabled = !on || Date.now() < testCooldownUntil;
}

function readTestSentAt() {
  try {
    return chrome.storage?.session?.get({ testSentAt: 0 })
      .then(v => v.testSentAt || 0)
      .catch(() => 0);
  } catch (_) {
    return Promise.resolve(0); // 无扩展环境视为从未发送
  }
}

function startTestCooldown(seconds) {
  testCooldownUntil = Date.now() + seconds * 1000;
  clearInterval(countdownTimer);
  $('testReminder').textContent = `冷却中（${seconds}s）`;
  countdownTimer = setInterval(() => {
    const left = Math.ceil((testCooldownUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      testCooldownUntil = 0;
      $('testReminder').textContent = '发送测试邮件';
      applyReminderEnabled();
    } else {
      $('testReminder').textContent = `冷却中（${left}s）`;
    }
  }, 1000);
  applyReminderEnabled();
}

async function resumeTestCooldown() {
  const sentAt = await readTestSentAt();
  const left = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1000);
  if (left > 0) startTestCooldown(left);
}

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', save);
$('reminderServer').addEventListener('input', save);
$('reminderEmail').addEventListener('input', save);
$('reminderEnabled').addEventListener('change', () => { save(); applyReminderEnabled(); });

$('testReminder').addEventListener('click', async () => {
  if (testBusy || $('testReminder').disabled) return;
  testBusy = true;
  try {
    const status = $('reminderStatus');
    const show = (text, cls) => { status.textContent = text; status.className = 'status' + (cls ? ' ' + cls : ''); };
    const server = $('reminderServer').value.trim();
    const email = $('reminderEmail').value.trim();
    if (!server) return show('请先填写服务器地址', 'err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return show('邮箱格式不正确', 'err');
    const sentAt = await readTestSentAt();
    const waitLeft = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1000);
    if (waitLeft > 0) return show(`请 ${waitLeft} 秒后再试`, 'err');
    save(); // 先落盘，再让 background 发起测试
    show('发送中…');
    try {
      await chrome.storage.session.set({ testSentAt: Date.now() }); // 冷却起点：请求发出即计时，SMTP 失败也要等
    } catch (_) { /* 无 session 存储，仅靠后端冷却 */ }
    startTestCooldown(TEST_COOLDOWN_MS / 1000);
    const res = await chrome.runtime.sendMessage({ type: 'BPS_TEST', server, email });
    if (res?.ok) show('已发送，请查收', 'ok');
    else show('失败：' + (res?.error || '未知错误'), 'err');
  } catch (err) {
    $('reminderStatus').textContent = '失败：' + (err?.message || err);
    $('reminderStatus').className = 'status err';
  } finally {
    testBusy = false;
  }
});

$('reset').addEventListener('click', async () => {
  if (hasChrome) await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  load();
});

try { $('version').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) { /* 非扩展环境保留静态文案 */ }
load();
