/* 题目集关闭邮件提醒 · 后端服务（「更好的题目集」插件配套）
 *
 * 职责：接收扩展上报的未关闭题目集订阅（按邮箱全量替换），每分钟扫描一次，
 * 在截止前 REMIND_BEFORE_MINUTES（默认 4320,1440 = 提前 3 天 / 1 天）各发一封提醒邮件。
 *
 * 存储：node:sqlite（Node >= 22.5 内置，无第三方数据库依赖），单文件 data.db。
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
  remindBefore: parseMinutes(process.env.REMIND_BEFORE_MINUTES, '4320,1440'),
  checkIntervalSec: int(process.env.CHECK_INTERVAL_SECONDS, 60),
  // 宕机补发宽限：触发点已过多少分钟之内仍补发，超过则记为跳过，避免恢复后陈旧轰炸
  graceMinutes: int(process.env.GRACE_MINUTES, 120),
  token: process.env.TOKEN || '',
  displayTz: process.env.DISPLAY_TZ || 'Asia/Shanghai',
  dryRun: process.env.DRY_RUN === '1' || !process.env.SMTP_HOST,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  cleanup(now) {
    db.prepare('DELETE FROM subscriptions WHERE end_at < ?').run(now - 7 * 86400000);
    db.prepare('DELETE FROM sent_log WHERE sent_at < ?').run(now - 90 * 86400000);
  },
  counts() {
    return {
      emails: db.prepare('SELECT COUNT(DISTINCT email) AS n FROM subscriptions').get().n,
      sets: db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n,
    };
  },
};

/* ---------- 邮件 ---------- */
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
  });
}
function humanLeft(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m >= 2880) return `约 ${Math.round(m / 1440)} 天`;
  if (m >= 120) return `约 ${Math.round(m / 60)} 小时`;
  return `约 ${m} 分钟`;
}

async function sendMail({ to, subject, html }) {
  if (cfg.dryRun) {
    console.log(`[dry-run] 邮件 -> ${to}\n  主题: ${subject}\n  正文: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    return;
  }
  await transporter.sendMail({ from: cfg.mailFrom, to, subject, html });
}

function reminderMail(row, now) {
  const left = row.end_at - now;
  const setUrl = `https://pintia.cn/problem-sets/${row.set_id}/overview`;
  const td = 'padding: 4px 12px 4px 0; vertical-align: top;';
  const html = `
<div style="font:14px/1.7 -apple-system,'Microsoft YaHei',sans-serif;color:#343a40;max-width:560px">
  <p>你好，</p>
  <p>以下题目集即将关闭：</p>
  <table style="border-collapse:collapse;margin:8px 0">
    <tr><td style="${td}color:#868e96">题目集</td><td style="${td}"><a href="${setUrl}">${escapeHtml(row.title)}</a></td></tr>
    <tr><td style="${td}color:#868e96">教师 / 单位</td><td style="${td}">${escapeHtml(row.owner)}${row.owner && row.org ? ' · ' : ''}${escapeHtml(row.org)}</td></tr>
    <tr><td style="${td}color:#868e96">关闭时间</td><td style="${td}">${fmtTime(row.end_at)}</td></tr>
    <tr><td style="${td}color:#868e96">剩余时间</td><td style="${td}"><b>${humanLeft(left)}</b></td></tr>
  </table>
  <p>别忘了完成还没提交的题目：<a href="${setUrl}">打开题目集</a></p>
  <p style="color:#868e96;font-size:12px">—— 由你自行部署的「更好的题目集」插件邮件提醒服务发送；不想再收到，请在插件设置中清空服务器地址或邮箱。</p>
</div>`;
  return { to: row.email, subject: `【PTA提醒】《${row.title}》${humanLeft(left)}后关闭（${fmtTime(row.end_at)}）`, html };
}

function testMail(email) {
  const html = `
<div style="font:14px/1.7 -apple-system,'Microsoft YaHei',sans-serif;color:#343a40">
  <p>这是一封<b>测试邮件</b>，说明「更好的题目集」插件的服务器与邮箱配置已生效。</p>
  <p style="color:#868e96">发送时间：${fmtTime(Date.now())}（${cfg.displayTz}）</p>
  <p style="color:#868e96;font-size:12px">打开 PTA「进行中」页面后，未关闭的题目集会自动同步到本服务，截止前 ${cfg.remindBefore.join(' / ')} 分钟你会各收到一封提醒。</p>
</div>`;
  return { to: email, subject: '【PTA提醒】测试邮件', html };
}

/* ---------- 调度器 ---------- */
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const row of store.activeSets(now)) {
      for (const offsetMin of cfg.remindBefore) {
        const trigger = row.end_at - offsetMin * 60000;
        if (trigger > now) continue;                                    // 还没到提醒时间
        if (store.isSent(row.email, row.set_id, offsetMin)) continue;   // 已发/已跳过
        const lateMinutes = (now - trigger) / 60000;
        if (lateMinutes > cfg.graceMinutes) {
          store.markSent(row.email, row.set_id, offsetMin, now);
          console.log(`[skip] 《${row.title}》的「提前 ${offsetMin} 分钟」提醒已过期 ${Math.round(lateMinutes)} 分钟，不再补发`);
          continue;
        }
        try {
          await sendMail(reminderMail(row, now));
          store.markSent(row.email, row.set_id, offsetMin, now);
          console.log(`[sent] 《${row.title}》 -> ${row.email}（提前 ${offsetMin} 分钟）`);
        } catch (err) {
          // 不标记，下一轮重试；宽限期内一直有效
          console.error(`[error] 发送失败（《${row.title}》 -> ${row.email}）: ${err.message}`);
        }
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

app.post('/api/test', async (req, res) => {
  const { email } = req.body || {};
  if (!EMAIL_RE.test(String(email || ''))) return res.status(400).json({ ok: false, error: '邮箱格式不正确' });
  try {
    await sendMail(testMail(String(email).toLowerCase()));
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || String(err) });
  }
});

app.listen(cfg.port, () => {
  console.log(`题目集关闭邮件提醒服务已启动: http://0.0.0.0:${cfg.port}（数据文件 ${cfg.dbFile}）`);
  console.log(`提醒时机: 截止前 ${cfg.remindBefore.join(' / ')} 分钟 | 检查间隔 ${cfg.checkIntervalSec}s | 补发宽限 ${cfg.graceMinutes} 分钟${cfg.token ? ' | 已启用访问令牌' : ''}`);
  if (cfg.dryRun) console.log('DRY_RUN 生效（DRY_RUN=1 或未配置 SMTP_HOST）：邮件只打印到日志，不会真发');
});

setInterval(tick, cfg.checkIntervalSec * 1000);
tick(); // 启动即扫一轮：覆盖「服务停机期间错过触发点」的补发（受宽限约束）
