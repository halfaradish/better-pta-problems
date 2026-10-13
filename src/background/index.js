/* 更好的题目集 · 后台消息转发
 *
 * 内容脚本在 PTA「进行中」页聚合到未关闭题目集后，经此转发到用户自建的
 * 提醒后端（POST /api/subscriptions，全量替换该邮箱的订阅）；设置弹窗的
 * 「发送测试邮件」走 POST /api/test。放在 background 是因为内容脚本所在
 * 页面对跨源 POST 受页面 CSP/CORS 限制，而 service worker 的 fetch 只受
 * 后端 CORS 约束（后端返回 Access-Control-Allow-Origin: * 即可，无需
 * host_permissions）。服务器地址格式：ip:port 或带 http(s):// 前缀，
 * 后端配置了 TOKEN 时可写成 ip:port/令牌（令牌以 X-Token 头透传）。
 *
 * 另承接图片转取（BPS_FETCH_IMAGE）：pta 的图源 images.ptausercontent.com
 * 不放行页面 fetch（实测 CORS 拒绝），host_permissions 已针对该域，由
 * service worker 带登录态取图转 data URL 交回内容脚本（自动答题含图链路）。
 */
function normalizeServer(server) {
  const s = String(server || '').trim();
  if (!s) return null;
  const withProto = /^https?:\/\//i.test(s) ? s : 'http://' + s;
  try {
    const u = new URL(withProto);
    if (!u.hostname) return null;
    // 「/令牌」后缀：首段路径作为共享令牌，不做真实路径拼接
    const token = u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : '';
    return { base: u.origin, token };
  } catch (_) {
    return null;
  }
}

async function post(base, token, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Token'] = token;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

// 图片转 data URL：分块 btoa 避免大图 String.fromCharCode.apply 栈溢出
async function toDataUrl(src) {
  const res = await fetch(src, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'BPS_FETCH_IMAGE') {
    if (typeof msg.src !== 'string' || !/^https?:\/\//i.test(msg.src)) {
      sendResponse({ ok: false, reason: '图片地址无效' });
      return false;
    }
    toDataUrl(msg.src).then(
      dataUrl => sendResponse({ ok: true, dataUrl }),
      err => sendResponse({ ok: false, reason: err?.message || String(err) }),
    );
    return true; // 异步 sendResponse
  }
  if (!msg || (msg.type !== 'BPS_SYNC' && msg.type !== 'BPS_TEST')) return;
  (async () => {
    const base = normalizeServer(msg.server);
    if (!base) return { ok: false, error: '服务器地址无效' };
    const email = String(msg.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: '邮箱格式不正确' };
    if (msg.type === 'BPS_SYNC') {
      if (!Array.isArray(msg.sets)) return { ok: false, error: '上报数据缺失' };
      const data = await post(base.base, base.token, '/api/subscriptions', { email, sets: msg.sets });
      return { ok: true, total: data.total };
    }
    await post(base.base, base.token, '/api/test', { email });
    return { ok: true };
  })().then(sendResponse, err => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // 异步 sendResponse
});
