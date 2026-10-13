/* 更好的题目集 · 设置弹窗
 * 设置的默认值与版本迁移统一取自 src/shared/settings.js（与内容脚本同一份）。
 */
import {
  DEFAULTS, HAS_CHROME_STORAGE, SETTINGS_VERSION,
  loadSettings, migrate, sanitizeSettings, saveSettings, unwrapExport,
} from '../shared/settings.js';

const $ = id => document.getElementById(id);
let stored = { ...DEFAULTS };
// 无扩展环境（直接打开 popup.html 做设计回归）时优雅降级：用默认值渲染、跳过存储
const hasChrome = HAS_CHROME_STORAGE;

async function load() {
  // 迁移结果不在这里写回：等用户真正保存时，随 collect() 的 settingsVersion 一起落盘
  stored = await loadSettings();
  for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab', 'progress']) $(k).checked = !!stored[k];
  $('separators').value = stored.separators;
  $('rules').value = stored.rules || '';
  $('reminderEnabled').checked = stored.reminderEnabled !== false;
  $('reminderServer').value = stored.reminderServer || '';
  $('reminderEmail').value = stored.reminderEmail || '';
  applyReminderEnabled();
  resumeTestCooldown();
  $('autoAnswer').checked = !!stored.autoAnswer;
}

function collect() {
  // 只回传弹窗 UI 承载的字段；非 UI 字段由 save() 从最新存储合并
  // （悬浮面板也在改 autoAnswer* 字段，弹窗打开时的快照可能已过期）
  return {
    enabled: $('enabled').checked,
    badge: $('badge').checked,
    countdown: $('countdown').checked,
    mergeSimilar: $('mergeSimilar').checked,
    openInNewTab: $('openInNewTab').checked,
    progress: $('progress').checked,
    separators: $('separators').value.trim() || DEFAULTS.separators,
    rules: $('rules').value.trim(),
    reminderEnabled: $('reminderEnabled').checked,
    reminderServer: $('reminderServer').value.trim(),
    reminderEmail: $('reminderEmail').value.trim(),
    autoAnswer: $('autoAnswer').checked,
  };
}

async function save() {
  if (!hasChrome) return;
  const fresh = await loadSettings();
  await saveSettings({ ...fresh, ...collect(), settingsVersion: Math.max(fresh.settingsVersion || 0, SETTINGS_VERSION) });
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

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab', 'progress', 'autoAnswer']) $(k).addEventListener('change', save);
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
  if (hasChrome) await saveSettings({ ...DEFAULTS });
  load();
});

/* ---------- 配置备份：导出 / 导入（页脚第二行） ---------- */

const backupStatus = $('backupStatus');
const showBackup = (text, cls) => {
  backupStatus.textContent = text;
  backupStatus.className = 'status' + (cls ? ' ' + cls : '');
};

$('exportSettings').addEventListener('click', async () => {
  if (!hasChrome) return showBackup('无扩展环境不可导出', 'err');
  try {
    const settings = await loadSettings(); // 迁移后的当前全量设置（含各服务 API Key）
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const payload = {
      app: 'better-pta-problems',
      settingsVersion: SETTINGS_VERSION,
      exportedAt: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      settings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `better-pta-settings-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showBackup('已导出（含 API Key，请妥善保管）', 'ok');
  } catch (err) {
    showBackup('导出失败：' + (err?.message || err), 'err');
  }
});

$('importSettings').addEventListener('click', () => {
  if (!hasChrome) return showBackup('无扩展环境不可导入', 'err');
  $('importFile').click();
});

$('importFile').addEventListener('change', async e => {
  const file = e.target.files?.[0];
  e.target.value = ''; // 允许重选同一文件
  if (!file) return;
  if (!confirm('导入将覆盖当前全部设置（含各服务 API Key），确定？')) return;
  try {
    const parsed = JSON.parse(await file.text());
    // 信封/裸对象两种形态 → 旧版字段走迁移 → 只收认识且同型的字段
    const next = sanitizeSettings(migrate(unwrapExport(parsed)));
    await saveSettings(next);
    await load(); // 重渲染弹窗为新配置
    showBackup('已导入并生效', 'ok');
  } catch (err) {
    showBackup('导入失败：' + (err?.message || '文件不是有效的配置'), 'err');
  }
});

try { $('version').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) { /* 非扩展环境保留静态文案 */ }
load();
