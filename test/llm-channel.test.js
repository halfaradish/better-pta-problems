// 后台端口通道（bps-llm）的回归：progress/done、worker 回收、用户中止。
// 真机无法在 IAB 里装扩展，这里用假的 chrome.runtime.connect 钉住协议形状。
import assert from 'node:assert/strict';
import { test } from 'node:test';

function fakeChrome({ connectError } = {}) {
  const ports = [];
  globalThis.chrome = {
    runtime: {
      connect: () => {
        if (connectError) throw new Error(connectError);
        const msgListeners = [];
        const disListeners = [];
        const port = {
          name: 'bps-llm',
          sent: [],
          disconnected: false,
          postMessage(m) { port.sent.push(m); },
          disconnect() {
            if (port.disconnected) return;
            port.disconnected = true;
            for (const fn of disListeners) fn();
          },
          onMessage: { addListener: fn => msgListeners.push(fn) },
          onDisconnect: { addListener: fn => disListeners.push(fn) },
          emit: m => { for (const fn of msgListeners) fn(m); },
          drop() {
            port.disconnected = true;
            for (const fn of disListeners) fn();
          },
        };
        ports.push(port);
        return port;
      },
      sendMessage: (_msg, cb) => { cb?.(); },
      lastError: undefined,
    },
  };
  return { ports };
}

let modPromise = null;
const load = () => (modPromise ||= import('../src/content/autoanswer.js'));

test('端口通道：progress 转发，done 正常回传', async () => {
  const { ports } = fakeChrome();
  const { backgroundChat } = await load();
  const seen = [];
  const p = backgroundChat({ type: 'BPS_LLM_CHAT', reqId: 'req-1' }, {
    timeoutMs: 1000,
    onProgress: evt => seen.push(evt),
  });
  const port = ports[0];
  assert.equal(port.sent[0].reqId, 'req-1');
  port.emit({ type: 'progress', phase: 'first', chars: 3, elapsedMs: 12 });
  port.emit({ type: 'done', ok: true, status: 200, content: 'ok' });
  const rsp = await p;
  assert.equal(rsp.content, 'ok');
  assert.deepEqual(seen, [{ type: 'progress', phase: 'first', chars: 3, elapsedMs: 12 }]);
  assert.equal(port.disconnected, true);
});

test('端口通道：后台被回收 → channelClosed 错误（可重试分类）', async () => {
  const { ports } = fakeChrome();
  const { backgroundChat } = await load();
  const p = backgroundChat({ type: 'BPS_LLM_CHAT', reqId: 'req-2' }, { timeoutMs: 1000 });
  ports[0].drop();
  await assert.rejects(p, err => err.channelClosed === true && /连接被回收/.test(err.message));
});

test('端口通道：用户中止 → 立即断开端口并报已中止', async () => {
  const { ports } = fakeChrome();
  const { backgroundChat } = await load();
  const ctl = new AbortController();
  const p = backgroundChat({ type: 'BPS_LLM_CHAT', reqId: 'req-3' }, { timeoutMs: 1000, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, err => err.aborted === true);
  assert.equal(ports[0].disconnected, true);
});

test('端口通道：扩展被重载/更新 → invalidated 错误，提示刷新页面', async () => {
  fakeChrome({ connectError: 'Extension context invalidated.' });
  const { backgroundChat } = await load();
  const p = backgroundChat({ type: 'BPS_LLM_CHAT', reqId: 'req-4' }, { timeoutMs: 1000 });
  await assert.rejects(p, err => err.kind === 'invalidated' && /刷新 PTA 页面/.test(err.message));
});
