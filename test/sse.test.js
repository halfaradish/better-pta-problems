// OpenCode Go 流式转发用的 SSE 解析：增量、跨块、[DONE]、注释与非标准多行。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSseParser, sseDeltaText, sseReasoningText } from '../src/shared/sse.js';

const collect = () => {
  const events = [];
  const parser = createSseParser(ev => events.push(ev));
  return { events, parser };
};

test('SSE：单块多事件 + [DONE]', () => {
  const { events, parser } = collect();
  parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n');
  parser.end();
  assert.equal(events.length, 3);
  assert.equal(sseDeltaText(events[0].data), '你');
  assert.equal(sseDeltaText(events[1].data), '好');
  assert.equal(events[2].done, true);
});

test('SSE：JSON 被网络切在两块之间', () => {
  const { events, parser } = collect();
  parser.push('data: {"choices":[{"delta":{"con');
  parser.push('tent":"ok"}}]}\n\n');
  parser.end();
  assert.equal(events.length, 1);
  assert.equal(sseDeltaText(events[0].data), 'ok');
});

test('SSE：注释/心跳与其他字段忽略，末尾没有换行也能收尾', () => {
  const { events, parser } = collect();
  parser.push(': keep-alive\n\nevent: message\ndata: {"choices":[{"delta":{"content":"尾"}}]}');
  parser.end();
  assert.equal(events.length, 1);
  assert.equal(sseDeltaText(events[0].data), '尾');
});

test('SSE：多行 data 按规范拼接；整段不是 JSON 时逐行兜底', () => {
  const joined = collect();
  joined.parser.push('data: {"choices":[{"delta":{"content":"a"}}]}\ndata: \n\n');
  joined.parser.end();
  assert.equal(joined.events.length, 1);

  const fallback = collect();
  fallback.parser.push('data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n');
  fallback.parser.end();
  assert.equal(fallback.events.length, 2);
  assert.equal(sseDeltaText(fallback.events[0].data), 'a');
  assert.equal(sseDeltaText(fallback.events[1].data), 'b');
});

test('sseDeltaText：兼容 delta.content / message.content / 分段数组 / 空事件', () => {
  assert.equal(sseDeltaText({ choices: [{ delta: { content: 'x' } }] }), 'x');
  assert.equal(sseDeltaText({ choices: [{ message: { content: 'y' } }] }), 'y');
  assert.equal(sseDeltaText({ choices: [{ delta: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.equal(sseDeltaText({ choices: [{ delta: { role: 'assistant' } }] }), '');
  assert.equal(sseDeltaText({}), '');
  assert.equal(sseDeltaText(null), '');
});

test('sseReasoningText：兼容 reasoning_content / reasoning / reasoning_details，不混入答案', () => {
  assert.equal(sseReasoningText({ choices: [{ delta: { reasoning_content: '想' } }] }), '想');
  assert.equal(sseReasoningText({ choices: [{ delta: { reasoning: '想' } }] }), '想');
  assert.equal(sseReasoningText({ choices: [{ delta: { reasoning_details: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab');
  assert.equal(sseReasoningText({ choices: [{ delta: { content: '答' } }] }), '');
  assert.equal(sseReasoningText({}), '');
  assert.equal(sseReasoningText(null), '');
});
