/* 更好的题目集 · 设置弹窗
 * 设置的默认值与版本迁移统一取自 src/shared/settings.js（与内容脚本同一份）。
 */
import {
  DEFAULTS, HAS_CHROME_STORAGE, SETTINGS_VERSION,
  loadSettings, migrate, sanitizeSettings, saveSettings, unwrapExport,
} from '../shared/settings.js';
import { compareVersions, pickReleaseInfo } from '../shared/update.js';
import { fmtAgoShort } from '../shared/time.js';

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
  if ($('reminderBrowser').checked) on.push('浏览器提醒');
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

// 反馈位分工：两个测试按钮各有自己的状态位，就长在按钮正下方（曾经共用一个、
// 放在页面底部——点完反馈落在 390px 之外，看着像「点了没反应」）
const setStatus = (el, text, cls) => {
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
};
const showNotifyStatus = (text, cls) => setStatus($('notifyStatus'), text, cls);
const showReminderStatus = (text, cls) => setStatus($('reminderStatus'), text, cls);

// 后台没响应时的兜底：正常一两百毫秒就回（SW 冷启动也就 1s 上下），
// 迟迟不回就当场报错——否则按钮永远卡在「发送中…」，再点还被 notifyBusy 挡住，表现就是「点了没反应」
function sendToBackground(msg, ms = 12000) {
  return Promise.race([
    chrome.runtime.sendMessage(msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('后台没有响应，请重试')), ms)),
  ]);
}

$('testNotify').addEventListener('click', async () => {
  if (notifyBusy || $('testNotify').disabled) return;
  notifyBusy = true;
  try {
    showNotifyStatus('发送中…');
    const res = await sendToBackground({ type: 'BPS_NOTIFY_TEST' });
    if (res?.ok) {
      showNotifyStatus('已发送；没弹横幅就去系统通知中心找', 'ok');
      checkNotifyPermission();
    } else {
      showNotifyStatus('失败：' + (res?.error || '未知错误'), 'err');
    }
  } catch (err) {
    showNotifyStatus('失败：' + (err?.message || err), 'err');
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
    const res = await sendToBackground({ type: 'BPS_TEST', server, email });
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

/* ---------- 检查更新（GitHub Releases） ---------- */
/* GitHub API 带 Access-Control-Allow-Origin: *，弹窗直连即可，不需要 host_permissions
 * （加了反而会让已安装的扩展因权限变更在更新时被禁用等用户重新批准）。
 * 结果存 chrome.storage.local：打开弹窗先渲染缓存结论，超过 6h 再静默复查一次——
 * 静默检查失败不打扰（保持缓存或初始态），点行才算显式检查、失败当场报。 */
const UPDATE = {
  API: 'https://api.github.com/repos/halfaradish/better-pta-problems/releases/latest',
  RELEASES: 'https://github.com/halfaradish/better-pta-problems/releases',
  KEY: 'bpsUpdateCache',
  TTL: 6 * 3600 * 1000,
  TIMEOUT: 10000,
};
const CURRENT_VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch (_) {
    return ($('version').textContent || '').replace(/^v/, '') || '0.0.0';
  }
})();

let updateLatest = null;   // { version, url, publishedAt } | null：已知的服务端最新版
let updateCheckedAt = 0;   // 上次成功检查的时刻
let updateError = '';      // 只承接显式检查的失败；静默检查失败保持沉默
let updateChecking = false;
let updateAutoBusy = false;

function renderUpdate() {
  const value = $('updateValue');
  const spin = $('updateSpin');
  const chev = $('updateChev');
  const row = $('checkUpdate');
  const hasUpdate = !!updateLatest && compareVersions(updateLatest.version, CURRENT_VERSION) > 0;
  value.className = 'row-value';
  // SVGElement 没有 hidden IDL 属性（设 .hidden 只是 expando，动不了真特性），统一走 toggleAttribute
  spin.toggleAttribute('hidden', !updateChecking);
  chev.toggleAttribute('hidden', updateChecking || !!updateError || !hasUpdate); // 箭头只表示「点出去看发布页」
  $('version').classList.toggle('upd', hasUpdate);
  let tip = '连接 GitHub Releases 检查新版本';
  if (updateChecking) {
    value.textContent = '检查中…';
  } else if (updateError) {
    value.textContent = '检查失败';
    value.classList.add('warn');
    tip = `检查失败：${updateError}（点击重试）`;
  } else if (hasUpdate) {
    value.textContent = `${updateLatest.version} 可更新`;
    value.classList.add('upd');
    tip = `新版本 v${updateLatest.version}，点击打开发布页；下载后解压覆盖原目录、在扩展管理页刷新即可，设置不会丢`;
  } else if (updateLatest) {
    value.textContent = '已是最新';
    value.classList.add('ok');
    tip = `上次检查：${updateCheckedAt ? fmtAgoShort(updateCheckedAt) : '刚刚'}，当前已是最新版`;
  } else {
    value.textContent = '检查一下';
    if (updateCheckedAt) tip = `上次检查：${fmtAgoShort(updateCheckedAt)}，点击再查一次`;
  }
  row.title = tip;
}

async function fetchLatestRelease() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPDATE.TIMEOUT);
  try {
    const res = await fetch(UPDATE.API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    if (res.status === 404) throw new Error('仓库还没有发布版本');
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub 接口限流，请稍后再试');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const info = pickReleaseInfo(await res.json());
    if (!info) throw new Error('发布数据无法识别');
    return info;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('请求超时，请检查网络');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function applyUpdateResult(info) {
  updateLatest = info;
  updateCheckedAt = Date.now();
  updateError = '';
}

async function readUpdateCache() {
  try {
    const cache = (await chrome.storage.local.get(UPDATE.KEY))[UPDATE.KEY];
    return cache && cache.current === CURRENT_VERSION ? cache : null; // 版本变了（刚升级过）：旧结论作废
  } catch (_) {
    return null;
  }
}

async function writeUpdateCache() {
  try {
    await chrome.storage.local.set({
      [UPDATE.KEY]: { checkedAt: updateCheckedAt, latest: updateLatest, current: CURRENT_VERSION },
    });
  } catch (_) { /* 无扩展环境：仅本次会话内有效 */ }
}

async function manualCheck() {
  if (updateChecking) return;
  updateChecking = true;
  updateError = '';
  renderUpdate();
  try {
    applyUpdateResult(await fetchLatestRelease());
    await writeUpdateCache();
  } catch (err) {
    updateError = err?.message || String(err);
  } finally {
    updateChecking = false;
    renderUpdate();
  }
}

async function silentCheck() {
  if (updateAutoBusy || updateChecking) return;
  updateAutoBusy = true;
  try {
    applyUpdateResult(await fetchLatestRelease());
    await writeUpdateCache();
  } catch (_) {
    return; // 静默检查失败不打扰：缓存里有什么就显示什么
  } finally {
    updateAutoBusy = false;
  }
  if (!updateChecking) renderUpdate();
}

// 打开弹窗：缓存没过期直接渲染；过期（或从未查过）就静默复查一轮
async function initUpdateCheck() {
  const cache = await readUpdateCache();
  if (cache) {
    updateLatest = cache.latest || null;
    updateCheckedAt = cache.checkedAt || 0;
  }
  renderUpdate();
  if (!cache || Date.now() - (cache.checkedAt || 0) > UPDATE.TTL) silentCheck();
}

$('checkUpdate').addEventListener('click', () => {
  if (updateChecking) return;
  if (updateLatest && compareVersions(updateLatest.version, CURRENT_VERSION) > 0) {
    const url = updateLatest.url || UPDATE.RELEASES;
    try { chrome.tabs.create({ url }); } catch (_) { window.open(url, '_blank', 'noreferrer'); }
    return;
  }
  manualCheck();
});

try { $('version').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) { /* 非扩展环境保留静态文案 */ }
load();
initUpdateCheck();
