/* OpenAI 兼容的 SSE 流解析（OpenCode Go 转发用，纯函数可单测）
 *
 * 只关心 `data:` 行：事件以空行分隔，多行 data 按 SSE 规范用 \n 连接；
 * `[DONE]` 作为结束标记单独上报，注释/心跳（`:` 开头）和其他字段忽略。
 * 解析器按块喂入，能处理 JSON 被网络切在两块之间的情形。
 */

function stripPrefix(line) {
  return line.slice(5).replace(/^ /, '');
}

export function createSseParser(onEvent) {
  let buf = '';
  let dataLines = [];
  const emit = fn => { try { fn(); } catch (_) { /* 回调异常不破坏解析状态 */ } };

  const dispatch = () => {
    if (!dataLines.length) return;
    const lines = dataLines;
    dataLines = [];
    const handle = raw => {
      if (raw === '[DONE]') { emit(() => onEvent?.({ done: true })); return true; }
      try {
        const data = JSON.parse(raw);
        emit(() => onEvent?.({ data }));
        return true;
      } catch (_) {
        return false;
      }
    };
    // 正常是单行 JSON；多行 data 按 SSE 规范用 \n 连接。若整段不是合法 JSON，
    // 再逐行兜底（个别网关把多条 data 行连着发，不按空行分隔）。
    if (lines.length === 1) { handle(lines[0]); return; }
    if (handle(lines.join('\n'))) return;
    for (const line of lines) handle(line);
  };

  return {
    push(chunk) {
      buf += String(chunk ?? '');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') { dispatch(); continue; }
        if (line.startsWith(':')) continue; // 注释 / keep-alive
        if (!line.startsWith('data:')) continue; // event:/id:/retry: 忽略
        dataLines.push(stripPrefix(line));
      }
    },
    end() {
      // 最后一行可能没有换行结尾
      if (buf) {
        const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
        buf = '';
        if (line.startsWith('data:')) dataLines.push(stripPrefix(line));
      }
      dispatch();
    },
  };
}

// 从一条 SSE data 事件里取增量文本：兼容 delta.content / message.content / 分段数组
function contentText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  return '';
}

export function sseDeltaText(obj) {
  const ch = obj?.choices?.[0];
  const d = contentText(ch?.delta?.content);
  if (d) return d;
  return contentText(ch?.message?.content);
}

// 推理模型的思考增量（DeepSeek/GLM 系常见 reasoning_content，OpenRouter 系用 reasoning）。
// 这些字符不算答案，但能证明连接在持续输出；日志用它区分「模型在思考」与「网关卡住」。
export function sseReasoningText(obj) {
  const ch = obj?.choices?.[0];
  const d = ch?.delta || ch?.message || {};
  return contentText(d.reasoning_content)
    || contentText(d.reasoning)
    || contentText(d.reasoning_details)
    || '';
}
