#!/usr/bin/env node
/* LLM 并发探针（开发用，不参与打包）
 *
 * 目的：用真实 Key 量出同一账号下 k 路并发 chat/completions 的「首块时间 / 总耗时 / 429 率」，
 * 决定自动答题编程题的并发数 k。Key 只从环境变量读，绝不打印。
 *
 * 用法（Git Bash / PowerShell 均可，变量只在当前命令内生效）：
 *   LLM_BASE_URL=https://api.deepseek.com \
 *   LLM_MODEL=deepseek-chat \
 *   LLM_API_KEY=sk-... \
 *   node tools/llm-concurrency-probe.mjs --k 3 --n 6
 *
 *   # OpenCode Go（脚本自动加 x-opencode-session 头）
 *   LLM_BASE_URL=https://opencode.ai/inference/go/openai/v1 \
 *   LLM_MODEL=glm-5.3-flash \
 *   LLM_API_KEY=... \
 *   node tools/llm-concurrency-probe.mjs --k 3 --n 6
 *
 * 参数：--k 并发数（默认 3）/ --n 总请求数（默认 6）/ --timeout 单请求毫秒（默认 300000）/
 *       --no-stream 关流式（默认 stream:true，用来量首块时间）
 * 输出：一段 JSON（summary + 每个请求的耗时），只含状态码、耗时、字符数、错误摘要与网关 log id。
 */

import process from 'node:process';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const baseUrl = String(process.env.LLM_BASE_URL || '').trim();
const model = String(process.env.LLM_MODEL || '').trim();
const apiKey = String(process.env.LLM_API_KEY || '').trim();
if (!baseUrl || !model || !apiKey) {
  console.error('缺少环境变量：LLM_BASE_URL / LLM_MODEL / LLM_API_KEY（Key 只从环境变量读，不要写进命令历史之外的文本）');
  process.exit(2);
}

const url = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') + '/chat/completions';
let hostname = '';
try { hostname = new URL(url).hostname; } catch (_) {
  console.error('LLM_BASE_URL 不是合法 URL：' + baseUrl);
  process.exit(2);
}
if (hostname !== 'opencode.ai' && hostname !== 'api.deepseek.com') {
  console.warn('[提示] 非 DeepSeek / OpenCode Go 官方域名：' + hostname + '（自定义端点也可，但网关头只对 opencode.ai 加）');
}

const k = Math.max(1, Number(arg('--k', 3)) || 3);
const n = Math.max(1, Number(arg('--n', 6)) || 6);
const timeoutMs = Math.max(1000, Number(arg('--timeout', 300000)) || 300000);
const stream = !process.argv.includes('--no-stream');
const isOpencode = hostname === 'opencode.ai';
const session = 'bps-probe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
const runId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
// 网关/服务端错误体可能回显 Key（DeepSeek 会打码，但不同端点不保证）；统一从输出里抹掉
const redact = s => String(s ?? '').split(apiKey).join('***');

// 与编程题 prompt 同量级：只要代码、围栏输出。题目固定，便于比较并发与非并发。
const messages = [
  { role: 'system', content: '你是编程题解答助手。只输出一个代码围栏，不要解释。' },
  {
    role: 'user',
    content: [
      '请用 C 语言（gcc）解答下面的题目，输出完整可编译源码：',
      '',
      '有 N 件物品和一个容量是 V 的背包。每件物品只能使用一次。第 i 件物品的体积是 vi，价值是 wi。',
      '求解将哪些物品装入背包，可使这些物品的总体积不超过背包容量，且总价值最大。输出最大价值。',
      '',
      '输入格式：第一行两个整数 N、V（1≤N≤1000，1≤V≤1000），接下来 N 行每行两个整数 vi、wi。',
      '输出格式：输出一个整数，表示最大价值。',
      '',
      '样例输入：',
      '4 5',
      '1 2',
      '2 4',
      '3 4',
      '4 5',
      '样例输出：',
      '8',
    ].join('\n'),
  },
];

async function one(i) {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let status = 0;
  let firstAt = null;
  let chars = 0;
  let err = null;
  let logId = '';
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    if (isOpencode) headers['x-opencode-session'] = session; // 网关要求；不带可能 400
    // 每个请求带唯一编号，避免网关对完全相同的 prompt 走缓存/去重，影响并发耗时
    const reqMessages = messages.map((m, idx) => idx === messages.length - 1
      ? { ...m, content: m.content + `\n\n（探针请求 ${runId}-${i}：仅用于区分并发请求，请忽略本行。）` }
      : m);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, temperature: 0, stream, messages: reqMessages }),
      signal: ctl.signal,
    });
    status = res.status;
    logId = res.headers.get('x-opencode-log-id') || '';
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      err = redact(`HTTP ${res.status}${body ? '：' + body.replace(/\s+/g, ' ').slice(0, 160) : ''}`);
    } else if (stream && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta;
            const text = delta?.content || '';
            if (text) {
              chars += text.length;
              if (!firstAt) firstAt = performance.now();
            }
          } catch (_) { /* 非 JSON 的 keep-alive/注释行忽略 */ }
        }
      }
    } else {
      const j = await res.json().catch(() => null);
      const text = j?.choices?.[0]?.message?.content || '';
      chars = text.length;
      if (chars) firstAt = performance.now();
    }
  } catch (e) {
    err = redact(e?.name === 'AbortError' ? `超时 ${Math.round(timeoutMs / 1000)}s` : String(e?.message || e));
  } finally {
    clearTimeout(timer);
  }
  const end = performance.now();
  return {
    i,
    status,
    ok: !err && status >= 200 && status < 300,
    firstMs: firstAt ? Math.round(firstAt - t0) : null,
    totalMs: Math.round(end - t0),
    chars,
    err,
    ...(logId ? { logId } : {}),
  };
}

const queue = Array.from({ length: n }, (_, i) => i);
let cursor = 0;
const results = [];
const startedAt = performance.now();
await Promise.all(Array.from({ length: Math.min(k, n) }, async () => {
  while (cursor < queue.length) {
    const i = queue[cursor];
    cursor += 1;
    results.push(await one(i));
  }
}));
const wallMs = performance.now() - startedAt;
results.sort((a, b) => a.i - b.i);

const ok = results.filter(r => r.ok);
const summary = {
  endpoint: url,
  model,
  concurrency: k,
  requests: n,
  stream,
  wallMs: Math.round(wallMs),
  ok: ok.length,
  failed: results.length - ok.length,
  status429: results.filter(r => r.status === 429).length,
  firstMs: results.map(r => r.firstMs),
  totalMs: results.map(r => r.totalMs),
  chars: results.map(r => r.chars),
  throughputPerMin: ok.length && wallMs > 0 ? Math.round((ok.length / wallMs) * 60000 * 10) / 10 : 0,
};

console.log(JSON.stringify({ summary, results }, null, 2));
console.log('');
console.log(`# ${model} · k=${k} · n=${n} · ${stream ? 'stream' : 'non-stream'}`);
console.log(`# 完成 ${summary.ok}/${n}（429 ${summary.status429}） · 整轮 ${(wallMs / 1000).toFixed(1)}s · 吞吐 ${summary.throughputPerMin}/min`);
for (const r of results) {
  console.log(`# #${String(r.i).padStart(2)}  ${r.ok ? 'ok  ' : 'FAIL'}  status=${String(r.status).padEnd(3)}  first=${r.firstMs == null ? '-' : (r.firstMs / 1000).toFixed(1) + 's'}  total=${(r.totalMs / 1000).toFixed(1)}s  chars=${r.chars}${r.err ? '  ' + r.err : ''}`);
}
