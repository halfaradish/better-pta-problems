/* 更好的题目集 · 后台消息转发（构建产物，请勿直接编辑；源码见 src/background/） */
(() => {
  // src/background/index.js
  function normalizeServer(server) {
    const s = String(server || "").trim();
    if (!s) return null;
    const withProto = /^https?:\/\//i.test(s) ? s : "http://" + s;
    try {
      const u = new URL(withProto);
      if (!u.hostname) return null;
      const token = u.pathname.length > 1 ? decodeURIComponent(u.pathname.slice(1)) : "";
      return { base: u.origin, token };
    } catch (_) {
      return null;
    }
  }
  async function post(base, token, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Token"] = token;
    const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }
  async function toDataUrl(src) {
    const res = await fetch(src, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || "application/octet-stream"};base64,${btoa(bin)}`;
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "BPS_FETCH_IMAGE") {
      if (typeof msg.src !== "string" || !/^https?:\/\//i.test(msg.src)) {
        sendResponse({ ok: false, reason: "\u56FE\u7247\u5730\u5740\u65E0\u6548" });
        return false;
      }
      toDataUrl(msg.src).then(
        (dataUrl) => sendResponse({ ok: true, dataUrl }),
        (err) => sendResponse({ ok: false, reason: err?.message || String(err) })
      );
      return true;
    }
    if (!msg || msg.type !== "BPS_SYNC" && msg.type !== "BPS_TEST") return;
    (async () => {
      const base = normalizeServer(msg.server);
      if (!base) return { ok: false, error: "\u670D\u52A1\u5668\u5730\u5740\u65E0\u6548" };
      const email = String(msg.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "\u90AE\u7BB1\u683C\u5F0F\u4E0D\u6B63\u786E" };
      if (msg.type === "BPS_SYNC") {
        if (!Array.isArray(msg.sets)) return { ok: false, error: "\u4E0A\u62A5\u6570\u636E\u7F3A\u5931" };
        const data = await post(base.base, base.token, "/api/subscriptions", { email, sets: msg.sets });
        return { ok: true, total: data.total };
      }
      await post(base.base, base.token, "/api/test", { email });
      return { ok: true };
    })().then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  });
})();
