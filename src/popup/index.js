/* 更好的题目集 · 设置弹窗
 * 设置的默认值与版本迁移统一取自 src/shared/settings.js（与内容脚本同一份）。
 */
import { DEFAULTS, HAS_CHROME_STORAGE, SETTINGS_VERSION, loadSettings, saveSettings } from '../shared/settings.js';

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
  $('autoAnswerBaseUrl').value = stored.autoAnswerBaseUrl || '';
  $('autoAnswerApiKey').value = stored.autoAnswerApiKey || '';
  $('autoAnswerModel').value = stored.autoAnswerModel || '';
  $('autoAnswerOverwrite').checked = !!stored.autoAnswerOverwrite;
  if (!hasChrome) { $('autoAnswerStart').disabled = true; $('autoAnswerStart').title = '需在扩展环境使用'; }
}

function collect() {
  // 保留 settingsVersion 等非 UI 字段，避免保存时把迁移标记抹掉
  return {
    ...stored,
    settingsVersion: Math.max(stored.settingsVersion || 0, SETTINGS_VERSION),
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
    autoAnswerBaseUrl: $('autoAnswerBaseUrl').value.trim(),
    autoAnswerApiKey: $('autoAnswerApiKey').value.trim(),
    autoAnswerModel: $('autoAnswerModel').value.trim(),
    autoAnswerOverwrite: $('autoAnswerOverwrite').checked,
  };
}

function save() {
  if (hasChrome) saveSettings(collect());
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

for (const k of ['enabled', 'badge', 'countdown', 'mergeSimilar', 'openInNewTab', 'progress', 'autoAnswerOverwrite']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', save);
$('reminderServer').addEventListener('input', save);
$('reminderEmail').addEventListener('input', save);
$('reminderEnabled').addEventListener('change', () => { save(); applyReminderEnabled(); });
$('autoAnswerBaseUrl').addEventListener('input', save);
$('autoAnswerApiKey').addEventListener('input', save);
$('autoAnswerModel').addEventListener('input', save);

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

/* ---------- 自动答题 ---------- */
const aa = {
  status: $('autoAnswerStatus'),
  button: $('autoAnswerStart'),
  show(text, cls) {
    this.status.textContent = text;
    this.status.className = 'status status-pre' + (cls ? ' ' + cls : '');
  },
};

// 自动答题按运行时事件刷新状态（内容脚本在题目页持续广播，弹窗关了也不影响运行）
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'BPS_AUTOANSWER_EVENT') return;
    if (msg.event === 'typedone') {
      const parts = [`成功 ${msg.applied}`];
      if (msg.skippedAnswered) parts.push(`跳过已答 ${msg.skippedAnswered}`);
      if (msg.skippedImage) parts.push(`跳过含图 ${msg.skippedImage}`);
      if (msg.failed) parts.push(`失败 ${msg.failed}`);
      parts.push(msg.saved ? '已保存' : '未保存');
      aa.show(`「${msg.typeName}」完成：${parts.join('，')}`);
    } else if (msg.event === 'progress') {
      aa.show(`正在答题（${msg.typeName}）：${msg.done}/${msg.total}…`);
    } else if (msg.event === 'done') {
      if (msg.error) {
        aa.show('已中止：' + msg.error, 'err');
      } else {
        const fails = (msg.summary.failed || []).map(f => f.reason).filter(Boolean);
        const lines = [`完成：成功 ${msg.summary.applied}，失败 ${msg.summary.failed.length}${msg.summary.skippedAnswered ? `，跳过已答 ${msg.summary.skippedAnswered}` : ''}${msg.summary.skippedImage ? `，跳过含图 ${msg.summary.skippedImage}` : ''}`];
        if (msg.summary.saveFails?.length) lines.push('保存失败：' + msg.summary.saveFails.join('；'));
        if (fails.length) lines.push('失败原因：' + fails.join('；'));
        aa.show(lines.join('\n'), msg.summary.failed.length || msg.summary.saveFails.length ? 'err' : 'ok');
      }
    }
  });
}

aa.button.addEventListener('click', async () => {
  if (aa.button.disabled) return;
  const show = (t, c) => aa.show(t, c);
  const cfg = {
    baseUrl: $('autoAnswerBaseUrl').value.trim(),
    apiKey: $('autoAnswerApiKey').value.trim(),
    model: $('autoAnswerModel').value.trim(),
    overwrite: $('autoAnswerOverwrite').checked,
  };
  if (!cfg.baseUrl.startsWith('http')) return show('服务器地址需以 http(s):// 开头', 'err');
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) return show('请先填写服务器地址、API Key 与模型名', 'err');
  save(); // 先落盘，运行中重开弹窗也能读到同样配置
  show('正在连接题目页…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/(www\.)?pintia\.cn\/problem-sets\/\d+\/exam\/problems\/type\//.test(tab.url || '')) {
      return show('请先在题目列表的某个题型页（判断/单选/填空）使用', 'err');
    }
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'BPS_AUTOANSWER_RUN', config: cfg });
    if (res?.ok) show('已开始。作答逐题写在题目页表单上，可关闭此弹窗，完成后回到此弹窗看结果');
    else show('无法开始：' + (res?.error || '未知错误'), 'err');
  } catch (err) {
    const msg = err?.message || String(err);
    show(msg.includes('Could not establish connection') || msg.includes('message port closed')
      ? '题目页未就绪：刷新 PTA 页面后重试'
      : '失败：' + msg, 'err');
  }
});

try { $('version').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) { /* 非扩展环境保留静态文案 */ }
load();
