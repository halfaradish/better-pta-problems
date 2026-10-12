/* 关闭时间的解析与文案（纯函数） */

export function pad(n) { return String(n).padStart(2, '0'); }

// "关闭时间: 12:22"（当天）或 "关闭时间: 2026-10-17 23:59"
export function parseCloseTime(text) {
  const m = /关闭时间[:：]\s*(?:(\d{4})-(\d{1,2})-(\d{1,2}))?\s*(?:(\d{1,2}):(\d{2}))?/.exec(text || '');
  if (!m || (!m[1] && !m[4])) return null;
  if (m[1]) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  const d = new Date();
  d.setHours(+m[4], +m[5], 0, 0);
  return d;
}

// Date -> "YYYY-MM-DD HH:mm"（整点零分与 PTA 一致省略时刻）
export function fmtCloseLocal(d) {
  if (!d) return '';
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return hm === '00:00' ? date : `${date} ${hm}`;
}

// 剩余时间文案；已截止或 >7 天返回 null（不显示）
export function fmtCountdown(closeAt, now = Date.now()) {
  const ms = closeAt - now;
  if (ms <= 0) return null;
  const min = Math.floor(ms / 60000);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (hr < 1) return { text: `剩 ${min} 分钟`, level: 3 };
  if (hr < 24) return { text: `剩 ${hr} 小时`, level: 3 };
  if (hr < 48) return { text: `剩 ${day} 天 ${hr - day * 24} 小时`, level: 2 };
  if (day <= 7) return { text: `剩 ${day} 天`, level: 1 };
  return null;
}
