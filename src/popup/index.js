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

/* ---------- 子页面：从右往左滑入（协议同移动端「进入下一层」，不是展开/收起） ---------- */
const PAGE_TITLES = {
  reminders: '题目关闭倒计时提醒',
  rules: '课程识别与高级规则',
  backup: '配置导入导出',
};
const pageEls = {
  main: $('page-main'), reminders: $('page-reminders'),
  rules: $('page-rules'), backup: $('page-backup'),
};
const pagesBox = $('pages');
let currentPage = 'main';
let entryFocus = null; // 返回时把焦点还给发起跳转的入口行

// 页面是绝对定位堆叠的，容器高度只能自己给：跟着当前页量。内容变化（状态位、摘要文字）
// 由 ResizeObserver 兜住，切页与窗口尺寸变化时重算。
function syncPageHeight() {
  const el = pageEls[currentPage];
  if (el) pagesBox.style.height = el.offsetHeight + 'px';
}

function showPage(name, { focusBack = true } = {}) {
  const next = pageEls[name] ? name : 'main';
  if (next === currentPage) return;
  currentPage = next;
  const isMain = next === 'main';
  $('headMain').hidden = !isMain;
  $('headPage').hidden = isMain;
  if (!isMain) $('pageTitle').textContent = PAGE_TITLES[next];
  for (const [k, el] of Object.entries(pageEls)) el.classList.toggle('is-active', k === next);
  syncPageHeight();
  if (isMain) {
    if (entryFocus && document.contains(entryFocus)) entryFocus.focus({ preventScroll: true });
  } else if (focusBack) {
    $('pageBack').focus({ preventScroll: true });
  }
}

for (const el of document.querySelectorAll('.entry')) {
  el.addEventListener('click', () => { entryFocus = el; showPage(el.dataset.goto); });
}
$('pageBack').addEventListener('click', () => showPage('main'));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && currentPage !== 'main') { e.preventDefault(); showPage('main'); }
});
for (const el of Object.values(pageEls)) {
  new ResizeObserver(entries => {
    if (entries.some(entry => entry.target === pageEls[currentPage])) syncPageHeight();
  }).observe(el);
}
window.addEventListener('resize', syncPageHeight);
pagesBox.classList.add('js-ready'); // 先切到堆叠定位，再量高度（页面自身高度不受定位方式影响）
syncPageHeight(); // 首帧就把高度定下来，别让弹窗先闪一下再撑开

/* ---------- 主页面入口行的状态摘要 ---------- */
let notifyDenied = false;

function renderRemindersSummary() {
  const el = $('remindersSummary');
  if (notifyDenied && $('reminderBrowser').checked) {
    el.textContent = '系统通知已关';
    el.classList.add('warn');
    return;
  }
  el.classList.remove('warn');
  const on = [];
  if ($('reminderBrowser').checked) on.push('浏览器通知');
  // 邮件按实际生效口径算：开关开且地址、邮箱都填齐（与 reminderChannels 一致）
  if ($('reminderEmailEnabled').checked
    && $('reminderServer').value.trim() && $('reminderEmail').value.trim()) on.push('邮件提醒');
  el.textContent = on.length ? on.join(' · ') : '两个通道都已关闭';
}

function renderRulesSummary() {
  const n = $('rules').value.split('\n').filter(line => line.trim()).length;
  $('rulesSummary').textContent = n ? `${n} 条自定义规则` : '自动识别';
}

function renderEntrySummaries() {
  renderRemindersSummary();
  renderRulesSummary();
}

async function load() {
  // 迁移结果不在这里写回：等用户真正保存时，随 collect() 的 settingsVersion 一起落盘
  stored = await loadSettings();
  for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab', 'progress']) $(k).checked = !!stored[k];
  $('separators').value = stored.separators;
  $('rules').value = stored.rules || '';
  $('reminderBrowser').checked = stored.reminderBrowser !== false;
  $('reminderEmailEnabled').checked = stored.reminderEmailEnabled !== false;
  $('reminderSkipDone').checked = stored.reminderSkipDone !== false;
  $('reminderServer').value = stored.reminderServer || '';
  $('reminderEmail').value = stored.reminderEmail || '';
  applyReminderSwitches();
  resumeTestCooldown();
  checkNotifyPermission();
  renderEntrySummaries();
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
    reminderBrowser: $('reminderBrowser').checked,
    reminderEmailEnabled: $('reminderEmailEnabled').checked,
    reminderSkipDone: $('reminderSkipDone').checked,
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

/* ---------- 提醒：双通道开关、测试通知/测试邮件与冷却 ---------- */
const TEST_COOLDOWN_MS = 60 * 1000; // 与后端 /api/test 的每邮箱冷却一致，双保险
let testCooldownUntil = 0;
let countdownTimer = null;
let testBusy = false;
let notifyBusy = false;

// 开启的通道才可操作：邮件两框随邮件开关禁用，测试按钮各自跟自己的通道
function applyReminderSwitches() {
  const emailOn = $('reminderEmailEnabled').checked;
  const anyOn = emailOn || $('reminderBrowser').checked;
  $('reminderSkipDone').disabled = !anyOn;
  $('reminderServer').disabled = !emailOn;
  $('reminderEmail').disabled = !emailOn;
  $('testReminder').disabled = !emailOn || Date.now() < testCooldownUntil;
  $('testNotify').disabled = !$('reminderBrowser').checked;
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
      $('testReminder').textContent = '测试邮件';
      applyReminderSwitches();
    } else {
      $('testReminder').textContent = `冷却中（${left}s）`;
    }
  }, 1000);
  applyReminderSwitches();
}

async function resumeTestCooldown() {
  const sentAt = await readTestSentAt();
  const left = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1000);
  if (left > 0) startTestCooldown(left);
}

// 系统级通知被关（系统设置 / 专注助手）时在开关行内联提示，并把主页面入口行的摘要改成告警——
// 这是本地通道最常见的失效原因；完整的失败原因在点「发送测试通知」时由 background 回报
async function checkNotifyPermission() {
  const state = $('notifyState');
  notifyDenied = false;
  try {
    notifyDenied = (await chrome.notifications.getPermissionLevel()) === 'denied';
  } catch (_) { /* 无扩展环境/无该 API：按正常态渲染 */ }
  if (notifyDenied) {
    state.textContent = '系统通知已关';
    state.classList.add('warn');
    state.title = '系统未允许浏览器发送通知（系统设置或专注助手），通知不会弹出';
  } else {
    state.textContent = '零配置 · 本机弹窗';
    state.classList.remove('warn');
    state.title = '零配置：数据只留在本机，浏览器在运行就能弹出';
  }
  renderRemindersSummary();
}

const showReminderStatus = (text, cls) => {
  const status = $('reminderStatus');
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
};

$('testNotify').addEventListener('click', async () => {
  if (notifyBusy || $('testNotify').disabled) return;
  notifyBusy = true;
  try {
    showReminderStatus('发送中…');
    const res = await chrome.runtime.sendMessage({ type: 'BPS_NOTIFY_TEST' });
    if (res?.ok) {
      showReminderStatus('已发送，看看系统通知', 'ok');
      checkNotifyPermission();
    } else {
      showReminderStatus('失败：' + (res?.error || '未知错误'), 'err');
    }
  } catch (err) {
    showReminderStatus('失败：' + (err?.message || err), 'err');
  } finally {
    notifyBusy = false;
  }
});

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab', 'progress', 'autoAnswer']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', () => { save(); renderRulesSummary(); });
$('reminderServer').addEventListener('input', () => { save(); renderRemindersSummary(); });
$('reminderEmail').addEventListener('input', () => { save(); renderRemindersSummary(); });
$('reminderBrowser').addEventListener('change', () => { save(); applyReminderSwitches(); renderRemindersSummary(); });
$('reminderEmailEnabled').addEventListener('change', () => { save(); applyReminderSwitches(); renderRemindersSummary(); });
$('reminderSkipDone').addEventListener('change', save);

$('testReminder').addEventListener('click', async () => {
  if (testBusy || $('testReminder').disabled) return;
  testBusy = true;
  try {
    const server = $('reminderServer').value.trim();
    const email = $('reminderEmail').value.trim();
    if (!server) return showReminderStatus('请先填写服务器地址', 'err');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showReminderStatus('邮箱格式不正确', 'err');
    const sentAt = await readTestSentAt();
    const waitLeft = Math.ceil((sentAt + TEST_COOLDOWN_MS - Date.now()) / 1000);
    if (waitLeft > 0) return showReminderStatus(`请 ${waitLeft} 秒后再试`, 'err');
    save(); // 先落盘，再让 background 发起测试
    showReminderStatus('发送中…');
    try {
      await chrome.storage.session.set({ testSentAt: Date.now() }); // 冷却起点：请求发出即计时，SMTP 失败也要等
    } catch (_) { /* 无 session 存储，仅靠后端冷却 */ }
    startTestCooldown(TEST_COOLDOWN_MS / 1000);
    const res = await chrome.runtime.sendMessage({ type: 'BPS_TEST', server, email });
    if (res?.ok) showReminderStatus('已发送，请查收', 'ok');
    else showReminderStatus('失败：' + (res?.error || '未知错误'), 'err');
  } catch (err) {
    showReminderStatus('失败：' + (err?.message || err), 'err');
  } finally {
    testBusy = false;
  }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('恢复默认将把全部设置重置为初始值（含各服务 API Key），确定？')) return;
  if (hasChrome) await saveSettings({ ...DEFAULTS });
  load();
});

/* ---------- 配置备份：导出 / 导入（「配置导入导出」子页面） ---------- */

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
