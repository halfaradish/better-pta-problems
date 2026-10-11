/* 题目集关闭邮件提醒 · 后端服务（「更好的题目集」插件配套）
 *
 * 职责：接收扩展上报的未关闭题目集订阅（按邮箱全量替换），每分钟扫描一次，
 * 在截止前 REMIND_BEFORE_MINUTES（默认 4320,1440 = 提前 3 天 / 1 天）各发一封提醒邮件。
 *
 * 存储：node:sqlite（Node >= 22.5 内置，无第三方数据库依赖），单文件 data.db。
 * 日志：运行日志 service.log（DB 同目录，2MB×5 滚动）+ SQLite mail_log 发信审计（90 天），
 *       后者可经 GET /api/mail-log 查询。
 * 配置：环境变量或同目录 .env（模板见 .env.example）。
 * 测试：DRY_RUN=1 只打印邮件不真发；REMIND_BEFORE_MINUTES=5 配合一个 6 分钟后
 *       关闭的订阅可端到端验证（见 README「验证」一节）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const nodemailer = require('nodemailer');
const { DatabaseSync } = require('node:sqlite');

/* ---------- 配置 ---------- */
function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function parseMinutes(s, d) {
  const arr = String(s || d).split(',').map(x => parseInt(x.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  return [...new Set(arr)].sort((a, b) => b - a);
}

const cfg = {
  port: int(process.env.PORT, 8787),
  dbFile: process.env.DB_FILE || path.join(__dirname, 'data.db'),
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: int(process.env.SMTP_PORT, 465),
  smtpSecure: process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE !== '0' : true,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || '',
  // 发件人显示名：收件箱里看到的名字（截图里的 "public12306" 就是没设它时露出的邮箱账号名）
  mailFromName: process.env.MAIL_FROM_NAME !== undefined ? process.env.MAIL_FROM_NAME : '更好的题目集',
  remindBefore: parseMinutes(process.env.REMIND_BEFORE_MINUTES, '4320,1440'),
  checkIntervalSec: int(process.env.CHECK_INTERVAL_SECONDS, 60),
  // 宕机补发宽限：触发点已过多少分钟之内仍补发，超过则记为跳过，避免恢复后陈旧轰炸
  graceMinutes: int(process.env.GRACE_MINUTES, 120),
  // 测试邮件冷却（秒）：防止连点测试按钮刷信；每个邮箱独立计时
  testCooldownSec: int(process.env.TEST_COOLDOWN_SECONDS, 60),
  token: process.env.TOKEN || '',
  displayTz: process.env.DISPLAY_TZ || 'Asia/Shanghai',
  dryRun: process.env.DRY_RUN === '1' || !process.env.SMTP_HOST,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- 日志 ---------- */
// 运行日志写 DB 同目录 service.log（Docker 即卷内，随数据持久化），超 2MB 滚动保留 5 份；
// 时间戳用 DISPLAY_TZ 格式化——容器默认 UTC，直接打 ISO 会对不上邮件里的时间。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 5;
const logFile = path.join(path.dirname(cfg.dbFile), 'service.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function logTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: cfg.displayTz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).replace(/\//g, '-');
}

function rotateLogFile() {
  let size = 0;
  try { size = fs.statSync(logFile).size; } catch { return; }
  if (size < LOG_MAX_BYTES) return;
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
    try { fs.renameSync(from, `${logFile}.${i}`); } catch { /* 源不存在，跳过 */ }
  }
}

function writeLog(level, msg) {
  const line = `[${logTime(Date.now())}] [${level}] ${msg}`;
  try {
    rotateLogFile();
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* 文件写失败不影响业务 */ }
  (level === 'error' ? console.error : console.log)(line);
}

const log = {
  info: m => writeLog('info', m),
  warn: m => writeLog('warn', m),
  error: m => writeLog('error', m),
};

/* ---------- 存储（node:sqlite） ---------- */
fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
const db = new DatabaseSync(cfg.dbFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    email      TEXT NOT NULL,
    set_id     TEXT NOT NULL,
    title      TEXT NOT NULL,
    end_at     INTEGER NOT NULL,           -- epoch ms
    owner      TEXT NOT NULL DEFAULT '',
    org        TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (email, set_id)
  );
  CREATE TABLE IF NOT EXISTS sent_log (
    email          TEXT NOT NULL,
    set_id         TEXT NOT NULL,
    offset_minutes INTEGER NOT NULL,
    sent_at        INTEGER NOT NULL,       -- 发送/跳过时刻（epoch ms）
    PRIMARY KEY (email, set_id, offset_minutes)
  );
  CREATE TABLE IF NOT EXISTS mail_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,       -- epoch ms
    event          TEXT NOT NULL,          -- sent / failed / skipped / dry-run / test / test-failed / test-dry-run
    email          TEXT NOT NULL DEFAULT '',
    set_ids        TEXT NOT NULL DEFAULT '',  -- 汇总邮件为逗号分隔
    titles         TEXT NOT NULL DEFAULT '',
    offset_minutes INTEGER,                   -- 提前档位（测试邮件为 NULL）
    subject        TEXT NOT NULL DEFAULT '',
    detail         TEXT NOT NULL DEFAULT ''   -- 失败 / 跳过原因等
  );
  CREATE INDEX IF NOT EXISTS idx_mail_log_ts ON mail_log (ts);
  CREATE INDEX IF NOT EXISTS idx_mail_log_email ON mail_log (email);
`);

const store = {
  replaceSubscription(email, sets, now) {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM subscriptions WHERE email = ?').run(email);
      const ins = db.prepare('INSERT INTO subscriptions (email, set_id, title, end_at, owner, org, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of sets) ins.run(email, s.id, s.title, s.endAt, s.owner, s.org, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
  activeSets(now) {
    return db.prepare('SELECT * FROM subscriptions WHERE end_at > ? ORDER BY end_at').all(now);
  },
  isSent(email, setId, offsetMin) {
    return !!db.prepare('SELECT 1 FROM sent_log WHERE email = ? AND set_id = ? AND offset_minutes = ?').get(email, setId, offsetMin);
  },
  markSent(email, setId, offsetMin, now) {
    db.prepare('INSERT OR REPLACE INTO sent_log (email, set_id, offset_minutes, sent_at) VALUES (?, ?, ?, ?)').run(email, setId, offsetMin, now);
  },
  // 发信审计：每种发信事件（成功/失败/跳过/测试/dry-run）都落库，供 /api/mail-log 追溯
  recordMail({ event, email, sets = [], offsetMin = null, subject = '', detail = '' }) {
    db.prepare('INSERT INTO mail_log (ts, event, email, set_ids, titles, offset_minutes, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), event, email || '', sets.map(s => s.id).join(','), sets.map(s => s.title).join(' | '), offsetMin, subject || '', detail || '');
  },
  mailLog({ limit = 50, email } = {}) {
    const lim = Math.min(Math.max(int(limit, 50), 1), 200);
    const rows = email
      ? db.prepare('SELECT * FROM mail_log WHERE email = ? ORDER BY id DESC LIMIT ?').all(email, lim)
      : db.prepare('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?').all(lim);
    return rows.map(r => ({ ...r, time: logTime(r.ts) }));
  },
  cleanup(now) {
    db.prepare('DELETE FROM subscriptions WHERE end_at < ?').run(now - 7 * 86400000);
    db.prepare('DELETE FROM sent_log WHERE sent_at < ?').run(now - 90 * 86400000);
    db.prepare('DELETE FROM mail_log WHERE ts < ?').run(now - 90 * 86400000);
  },
  counts() {
    return {
      emails: db.prepare('SELECT COUNT(DISTINCT email) AS n FROM subscriptions').get().n,
      sets: db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,
    };
  },
};

/* ---------- 邮件（HTML 模板） ---------- */
// 与插件弹窗同一套设计语言：深蓝主色、浅蓝衬底、冷灰字阶、圆角与胶囊徽标。
// 刻意只用 table + 内联样式：不依赖远程图片和 <style>，主流邮箱（QQ/163/Gmail/Outlook）都能渲染，
// 不支持的特性（圆角、媒体查询）只做优雅降级。
const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const C = {
  ink: '#242a32', ink2: '#5c6672', ink3: '#6f7a88',   // 文字三级灰
  line: '#e3e7ec', wash: '#f6f8fa', outer: '#eef1f4', // 描边 / 面板底 / 页面底
  accent: '#0a4991', accentSoft: '#e8f0fa',           // 插件主蓝 / 浅蓝衬底
  ok: '#2b8a3e', okSoft: '#e7f3ea',                   // 成功（测试邮件）
  err: '#e03131', errSoft: '#fdecec',                 // 紧急：剩余不足 24h
};
const URGENT_MS = 24 * 3600 * 1000;

const transporter = cfg.dryRun ? null : nodemailer.createTransport({
  host: cfg.smtpHost,
  port: cfg.smtpPort,
  secure: cfg.smtpSecure,
  auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: cfg.displayTz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(/\//g, '-');
}
function humanLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m >= 2880) return `约 ${Math.round(m / 1440)} 天`;
  if (m >= 120) return `约 ${Math.round(m / 60)} 小时`;
  return `约 ${m} 分钟`;
}
function humanMinutes(min) {
  const n = min >= 1440 ? min / 1440 : min >= 60 ? min / 60 : min;
  const unit = min >= 1440 ? '天' : min >= 60 ? '小时' : '分钟';
  return `${Number.isInteger(n) ? n : Math.round(n * 10) / 10} ${unit}`;
}
// 纯文本降级版（提升进箱率与无障碍阅读）
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/td|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendMail({ to, subject, html }) {
  if (cfg.dryRun) {
    log.info(`[dry-run] 邮件 -> ${to}\n  发件人: ${cfg.mailFromName ? `${cfg.mailFromName} <${cfg.mailFrom}>` : cfg.mailFrom}\n  主题: ${subject}\n  正文: ${htmlToText(html).replace(/\s+/g, ' ').slice(0, 200)}`);
    return;
  }
  await transporter.sendMail({
    // 对象形式让 nodemailer 处理显示名的 MIME 编码与引号转义
    from: cfg.mailFromName ? { name: cfg.mailFromName, address: cfg.mailFrom } : cfg.mailFrom,
    to, subject, html, text: htmlToText(html),
  });
}

/* ----- 模板片段 ----- */
// 剩余时间胶囊：不足 24h 转紧急红，颜色编码的是真实信息
function chipHtml(text, urgent) {
  const bg = urgent ? C.errSoft : C.accentSoft;
  const fg = urgent ? C.err : C.accent;
  return `<span style="display:inline-block;padding:1px 9px;border-radius:9999px;background:${bg};color:${fg};font:500 12px/20px ${MAIL_FONT};white-space:nowrap">${text}</span>`;
}

// 视觉锚点：大字结论 + 右侧精确时间；bg/bigColor 按紧急度或语义（成功绿）传入
function heroPanel({ bg, label, big, bigColor, right }) {
  return `<table role="presentation" class="hero" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background:${bg};border-radius:8px;border-collapse:separate"><tr class="hero-tr">
    <td style="padding:18px 20px;font-family:${MAIL_FONT}">
      <div style="font:400 13px/20px ${MAIL_FONT};color:${C.ink3}">${label}</div>
      <div style="margin-top:2px;font:700 28px/38px ${MAIL_FONT};color:${bigColor}">${big}</div>
    </td>
    <td class="r" valign="bottom" align="right" style="padding:18px 20px;font:400 13px/20px ${MAIL_FONT};color:${C.ink2}">${right}</td>
  </tr></table>`;
}

function cardHeader() {
  return `<tr><td style="padding:16px 24px;border-bottom:1px solid ${C.line};font-family:${MAIL_FONT}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="28" height="28" align="center" valign="middle" bgcolor="${C.accentSoft}" style="background:${C.accentSoft};border-radius:8px;font:700 14px/28px ${MAIL_FONT};color:${C.accent}">题</td>
      <td style="padding-left:10px;font:600 15px/22px ${MAIL_FONT};color:${C.ink};letter-spacing:.01em">更好的题目集</td>
      <td align="right" valign="middle"><span style="display:inline-block;padding:0 9px;border:1px solid ${C.line};border-radius:9999px;background:${C.wash};color:${C.ink3};font:500 11px/19px ${MAIL_FONT};white-space:nowrap">题目集关闭提醒</span></td>
    </tr></table>
  </td></tr>`;
}

function cardFooter() {
  return `<tr><td bgcolor="${C.wash}" style="background:${C.wash};padding:13px 24px;border-top:1px solid ${C.line};font:400 12px/20px ${MAIL_FONT};color:${C.ink3}">
    这封邮件由你自行部署的「更好的题目集」插件提醒服务发送。不想再收到：在插件设置中清空服务器地址或邮箱即可。
  </td></tr>`;
}

function mailShell({ preheader = '', inner }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>
.t { white-space:nowrap; }
@media only screen and (max-width:480px) {
  .hero, .hero-tr { display:block !important; width:100% !important; }
  .hero-tr > td { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:left !important; }
  .r { padding:0 20px 16px !important; }
  .hide-sm { display:none !important; }
  .t { white-space:normal !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:${C.outer}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.outer}">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.outer}" style="background:${C.outer}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${C.line};border-radius:12px;border-collapse:separate;overflow:hidden">
${cardHeader()}
${inner}
${cardFooter()}
</table>
</td></tr></table>
</body>
</html>`;
}

function primaryButton(href, text) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${C.accent}" style="background:${C.accent};border-radius:8px">
      <a href="${href}" style="display:inline-block;padding:11px 26px;border-radius:8px;font:500 14px/22px ${MAIL_FONT};color:#ffffff;text-decoration:none">${text}</a>
    </td>
  </tr></table>`;
}

function ownerOrg(row) {
  return [row.owner, row.org].filter(Boolean).map(escapeHtml).join(' · ');
}

/* ----- 三种邮件 ----- */
function reminderMail(row, now) {
  const left = row.end_at - now;
  const urgent = left < URGENT_MS;
  const setUrl = `https://pintia.cn/problem-sets/${row.set_id}/overview`;
  const meta = ownerOrg(row);
  const preheader = `《${row.title}》将于 ${fmtTime(row.end_at)} 关闭，剩余${humanLeft(left)}。`;
  const inner = `<tr><td style="padding:24px 24px 28px;font-family:${MAIL_FONT}">
  <p style="margin:0 0 16px;font:400 14px/22px ${MAIL_FONT};color:${C.ink}">你好，</p>
  ${heroPanel({
    bg: urgent ? C.errSoft : C.accentSoft,
    label: '距关闭还剩',
    big: humanLeft(left),
    bigColor: urgent ? C.err : C.accent,
    right: `${fmtTime(row.end_at)} 关闭`,
  })}
  <p style="margin:20px 0 ${meta ? '4px' : '20px'};font:600 17px/26px ${MAIL_FONT}"><a href="${setUrl}" style="color:${C.accent};text-decoration:none">《${escapeHtml(row.title)}》</a></p>
  ${meta ? `<p style="margin:0 0 22px;font:400 13px/20px ${MAIL_FONT};color:${C.ink3}">${meta}</p>` : ''}
  ${primaryButton(setUrl, '打开题目集，完成未提交的题目')}
</td></tr>`;
  return { to: row.email, subject: `【PTA提醒】《${row.title}》${humanLeft(left)}后关闭（${fmtTime(row.end_at)}）`, html: mailShell({ preheader, inner }) };
}

function testMail(email) {
  const now = Date.now();
  const settingRows = [
    ['提醒时机', `截止前 ${cfg.remindBefore.map(humanMinutes).join(' / ')}`],
    ['检查频率', `每 ${cfg.checkIntervalSec} 秒扫描一次`],
    ['显示时区', escapeHtml(cfg.displayTz)],
    ['汇总规则', '同一时间到期的多个题目集合并为一封'],
  ].map(([k, v]) => `<tr>
      <td style="padding:3px 18px 3px 0;font:400 13px/22px ${MAIL_FONT};color:${C.ink3};vertical-align:top">${k}</td>
      <td style="padding:3px 0;font:400 13px/22px ${MAIL_FONT};color:${C.ink}">${v}</td>
    </tr>`).join('');
  const inner = `<tr><td style="padding:24px 24px 28px;font-family:${MAIL_FONT}">
  <p style="margin:0 0 16px;font:400 14px/22px ${MAIL_FONT};color:${C.ink}">你好，</p>
  ${heroPanel({ bg: C.okSoft, label: '测试邮件', big: '发送成功', bigColor: C.ok, right: `${fmtTime(now)}<br><span style="color:${C.ink3}">${escapeHtml(cfg.displayTz)}</span>` })}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.wash}" style="background:${C.wash};border-radius:8px;border-collapse:separate;margin-top:20px"><tr><td style="padding:14px 18px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${settingRows}</table>
  </td></tr></table>
  <p style="margin:18px 0 0;font:400 14px/22px ${MAIL_FONT};color:${C.ink2}">接下来，正在进行的题目集临近关闭时，你会收到同样式的提醒邮件。</p>
</td></tr>`;
  return { to: email, subject: '【PTA提醒】测试邮件', html: mailShell({ preheader: '测试邮件：服务器与邮箱配置正常。', inner }) };
}

// 同邮箱同档位的多条提醒合并成一封汇总邮件；单条仍用 reminderMail 的具体主题
function digestMail(items, now) {
  if (items.length === 1) return reminderMail(items[0].row, now);
  const sorted = [...items].sort((a, b) => a.row.end_at - b.row.end_at);
  const earliest = sorted[0].row;
  const urgent = earliest.end_at - now < URGENT_MS;
  const rows = sorted.map(({ row }, i) => {
    const l = row.end_at - now;
    const b = i < sorted.length - 1 ? `border-bottom:1px solid ${C.line};` : '';
    const td = `padding:12px 14px 12px 0;${b}vertical-align:top;font:400 13px/21px ${MAIL_FONT}`;
    const [datePart, timePart] = fmtTime(row.end_at).split(' ');
    return `<tr>
      <td style="${td}"><a href="https://pintia.cn/problem-sets/${row.set_id}/overview" style="color:${C.accent};text-decoration:none;font:600 14px/22px ${MAIL_FONT}">《${escapeHtml(row.title)}》</a></td>
      <td class="hide-sm" style="${td}color:${C.ink2}">${ownerOrg(row) || '—'}</td>
      <td class="t" style="${td}color:${C.ink2}"><span style="white-space:nowrap">${datePart}</span> <span style="white-space:nowrap">${timePart}</span></td>
      <td align="right" style="${td}white-space:nowrap">${chipHtml(humanLeft(l), l < URGENT_MS)}</td>
    </tr>`;
  }).join('');
  const head = `<tr>
    <td style="padding:0 14px 8px 0;font:500 12px/18px ${MAIL_FONT};color:${C.ink3}">题目集</td>
    <td class="hide-sm" style="padding:0 14px 8px 0;font:500 12px/18px ${MAIL_FONT};color:${C.ink3}">教师 / 单位</td>
    <td class="t" style="padding:0 14px 8px 0;font:500 12px/18px ${MAIL_FONT};color:${C.ink3}">关闭时间</td>
    <td align="right" style="padding:0 0 8px;font:500 12px/18px ${MAIL_FONT};color:${C.ink3}">剩余</td>
  </tr>`;
  const inner = `<tr><td style="padding:24px 24px 28px;font-family:${MAIL_FONT}">
  <p style="margin:0 0 16px;font:400 14px/22px ${MAIL_FONT};color:${C.ink}">你好，</p>
  ${heroPanel({
    bg: urgent ? C.errSoft : C.accentSoft,
    label: '即将关闭',
    big: `${sorted.length} 个题目集`,
    bigColor: urgent ? C.err : C.accent,
    right: `最早 ${fmtTime(earliest.end_at)} 关闭`,
  })}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;width:100%;border-collapse:collapse">
    ${head}${rows}
  </table>
  <p style="margin:18px 0 0;font:400 14px/22px ${MAIL_FONT};color:${C.ink2}">记得在关闭前完成还没提交的题目。</p>
</td></tr>`;
  return {
    to: earliest.email,
    subject: `【PTA提醒】${sorted.length} 个题目集即将关闭（最早 ${fmtTime(earliest.end_at)}）`,
    html: mailShell({ preheader: `${sorted.length} 个题目集即将关闭，最早 ${fmtTime(earliest.end_at)}，剩余${humanLeft(earliest.end_at - now)}。`, inner }),
  };
}

/* ---------- 调度器 ---------- */
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = []; // { row, offsetMin }
    for (const row of store.activeSets(now)) {
      for (const offsetMin of cfg.remindBefore) {
        const trigger = row.end_at - offsetMin * 60000;
        if (trigger > now) continue;                                    // 还没到提醒时间
        if (store.isSent(row.email, row.set_id, offsetMin)) continue;   // 已发/已跳过
        const lateMinutes = (now - trigger) / 60000;
        if (lateMinutes > cfg.graceMinutes) {
          store.markSent(row.email, row.set_id, offsetMin, now);
          store.recordMail({ event: 'skipped', email: row.email, sets: [{ id: row.set_id, title: row.title }], offsetMin, detail: `提醒点已过期 ${Math.round(lateMinutes)} 分钟，超过宽限不再补发` });
          log.info(`[skip] 《${row.title}》的「提前 ${offsetMin} 分钟」提醒已过期 ${Math.round(lateMinutes)} 分钟，不再补发`);
          continue;
        }
        due.push({ row, offsetMin });
      }
    }
    // 同邮箱同档位到期的合并成一封汇总邮件：多个题目集同一时间截止时不再连环发信；
    // 宕机恢复时积压的多条提醒也会并成一封
    const groups = new Map(); // "email|offsetMin" -> items[]
    for (const d of due) {
      const key = `${d.row.email}|${d.offsetMin}`;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(d);
    }
    for (const items of groups.values()) {
      const { email, title } = items[0].row;
      const sets = items.map(it => ({ id: it.row.set_id, title: it.row.title }));
      const mail = digestMail(items, now);
      try {
        await sendMail(mail);
        for (const it of items) store.markSent(it.row.email, it.row.set_id, it.offsetMin, now);
        store.recordMail({ event: cfg.dryRun ? 'dry-run' : 'sent', email, sets, offsetMin: items[0].offsetMin, subject: mail.subject });
        log.info(items.length === 1
          ? `[sent] 《${title}》 -> ${email}（提前 ${items[0].offsetMin} 分钟）`
          : `[sent] ${items.length} 个题目集 -> ${email}（提前 ${items[0].offsetMin} 分钟，已合并）`);
      } catch (err) {
        // 不标记，下一轮重试；宽限期内一直有效
        store.recordMail({ event: 'failed', email, sets, offsetMin: items[0].offsetMin, subject: mail.subject, detail: err.message });
        log.error(`[error] 发送失败（${items.length === 1 ? `《${title}》` : `${items.length} 个题目集`} -> ${email}）: ${err.message}`);
      }
    }
    store.cleanup(now);
  } finally {
    ticking = false;
  }
}

/* ---------- HTTP API ---------- */
const app = express();
app.use(express.json({ limit: '1mb' }));

// 跨域：扩展 background 发起的是跨源请求（后端与 pintia.cn 不同源）
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 可选共享令牌：.env 配置 TOKEN 后，/api/* 要求请求头 X-Token 匹配
app.use('/api', (req, res, next) => {
  if (cfg.token && req.get('X-Token') !== cfg.token) {
    return res.status(401).json({ ok: false, error: '无效的访问令牌' });
  }
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ...store.counts() }));

app.post('/api/subscriptions', (req, res) => {
  const { email, sets } = req.body || {};
  if (!EMAIL_RE.test(String(email || ''))) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  if (!Array.isArray(sets)) return res.status(400).json({ ok: false, error: 'sets 必须是数组' });
  if (sets.length > 500) return res.status(400).json({ ok: false, error: 'sets 数量过多' });
  const normalized = [];
  for (const s of sets) {
    const endAt = typeof s?.endAt === 'number' ? s.endAt : Date.parse(s?.endAt ?? '');
    const id = String(s?.id ?? '').slice(0, 64);
    const title = String(s?.title ?? '').slice(0, 500);
    if (!id || !Number.isFinite(endAt)) return res.status(400).json({ ok: false, error: '题目集数据格式不正确' });
    normalized.push({ id, title, endAt, owner: String(s?.owner ?? '').slice(0, 200), org: String(s?.org ?? '').slice(0, 200) });
  }
  store.replaceSubscription(String(email).toLowerCase(), normalized, Date.now());
  res.json({ ok: true, total: normalized.length });
});

// 测试邮件每邮箱冷却：记「发起」时刻而非成功时刻，SMTP 失败的重试同样要等冷却
const testLimiter = new Map(); // email -> epoch ms

app.post('/api/test', async (req, res) => {
  const { email } = req.body || {};
  if (!EMAIL_RE.test(String(email || ''))) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  const mail = String(email).toLowerCase();
  const waitSec = Math.ceil((cfg.testCooldownSec * 1000 - (Date.now() - (testLimiter.get(mail) || 0))) / 1000);
  if (waitSec > 0) return res.status(429).json({ ok: false, error: `测试邮件发送过于频繁，请 ${waitSec} 秒后再试` });
  testLimiter.set(mail, Date.now());
  if (testLimiter.size > 500) {
    const cutoff = Date.now() - 10 * 60000;
    for (const [k, t] of testLimiter) if (t < cutoff) testLimiter.delete(k);
  }
  try {
    await sendMail(testMail(mail));
    store.recordMail({ event: cfg.dryRun ? 'test-dry-run' : 'test', email: mail, subject: '【PTA提醒】测试邮件' });
    res.json({ ok: true });
  } catch (err) {
    store.recordMail({ event: 'test-failed', email: mail, subject: '【PTA提醒】测试邮件', detail: err.message || String(err) });
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

// 发信审计查询：?limit=50（1~200）&email=...；配置 TOKEN 后需带 X-Token 头
app.get('/api/mail-log', (req, res) => {
  const rows = store.mailLog({ limit: req.query.limit, email: String(req.query.email || '').toLowerCase() });
  res.json({ ok: true, count: rows.length, log: rows });
});

app.listen(cfg.port, () => {
  log.info(`题目集关闭邮件提醒服务已启动: http://0.0.0.0:${cfg.port}（数据文件 ${cfg.dbFile}，日志文件 ${logFile}）`);
  log.info(`提醒时机: 截止前 ${cfg.remindBefore.join(' / ')} 分钟 | 检查间隔 ${cfg.checkIntervalSec}s | 补发宽限 ${cfg.graceMinutes} 分钟 | 测试邮件冷却 ${cfg.testCooldownSec}s${cfg.token ? ' | 已启用访问令牌' : ''}`);
  if (cfg.dryRun) log.info('DRY_RUN 生效（DRY_RUN=1 或未配置 SMTP_HOST）：邮件只打印到日志，不会真发');
});

// 崩溃前把痕迹写进日志再退出；重启交给 Docker 重启策略 / systemd
process.on('unhandledRejection', (err) => log.error(`未处理的 Promise 拒绝: ${(err && err.stack) || err}`));
process.on('uncaughtException', (err) => {
  log.error(`未捕获异常，进程退出: ${(err && err.stack) || err}`);
  process.exit(1);
});

setInterval(tick, cfg.checkIntervalSec * 1000);
tick(); // 启动即扫一轮：覆盖「服务停机期间错过触发点」的补发（受宽限约束）
