// 自动答题的纯函数：LLM 输出解析与 prompt 构造。
// DOM 相关的 collectPage/collectProgramming/cleanText/handleRun 依赖 document，走内容脚本 + IAB 真机回归（见 docs/自动答题初探.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleImgMessage, assertChatModel, buildPrompt, clearPersistedLog, COMPILER_LABELS, compilerIdFromLabel, failDetails,
  isRateLimitedText, isRetryableLlmError, nonChatProtocol, normalizeBaseUrl, normalizeTF, parseChoiceAnswer, parseCodeAnswer,
  parseFillAnswers, parseLlmErrorBody, persistLogLine, readPersistedLog, relaySummaryLine, seedCodingProblemCache, TYPE_BY_NAME,
  normalizeLangLabel,
} from '../src/content/autoanswer.js';
import { PRESETS, clampBallPos, currentKey, resolveModel, withKeyFor } from '../src/content/autoanswer-panel.js';

test('parseChoiceAnswer：裸字母 / 带句点 / JSON 文本 / 代码围栏', () => {
  for (const raw of ['C', 'c', 'C. 分治', 'C、', '```json\n{"answer":"C"}\n```']) {
    assert.equal(parseChoiceAnswer(raw, 4), 'C');
  }
  assert.equal(parseChoiceAnswer('{"answer":"D","reason":"O(n^2)"}', 4), 'D');
});

test('parseChoiceAnswer：越界与空值返回 null', () => {
  assert.equal(parseChoiceAnswer('E', 4), null);
  assert.equal(parseChoiceAnswer('Z', 4), null);
  assert.equal(parseChoiceAnswer('', 4), null);
  assert.equal(parseChoiceAnswer(null, 4), null);
  assert.equal(parseChoiceAnswer('无所谓哪个字母', 4), null); // 无字母打头也按首个字母算
});

test('normalizeTF：中英与简写，非二值返回 null', () => {
  for (const raw of ['T', 'true', 'TRUE', '对', '正确', '是']) {
    assert.equal(normalizeTF(raw), 'TRUE', raw);
  }
  for (const raw of ['F', 'false', 'FALSE', '错', '错误', '否']) {
    assert.equal(normalizeTF(raw), 'FALSE', raw);
  }
  assert.equal(normalizeTF('O(n^2)'), null);
  assert.equal(normalizeTF(''), null);
  assert.equal(normalizeTF(null), null);
});

test('parseFillAnswers：数组 / 单空裸字符串 / 长度校验与 trim', () => {
  assert.deepEqual(parseFillAnswers({ answers: ['n', 'nlogn'] }, 2), ['n', 'nlogn']);
  assert.deepEqual(parseFillAnswers('{"answers":["O(n)"]}', 1), ['O(n)']);
  assert.deepEqual(parseFillAnswers('big-O', 1), ['big-O']);
  assert.deepEqual(parseFillAnswers([' n ', ' logn'], 2), ['n', 'logn']);
  assert.equal(parseFillAnswers(['a', 'b'], 1), null);
  assert.equal(parseFillAnswers('a', 2), null);     // 多空不接受裸字符串
  assert.equal(parseFillAnswers(null, 2), null);
});

test('buildPrompt：三种题型的指令与填空占位符', () => {
  const tf = buildPrompt({ kind: 'TRUE_OR_FALSE', text: '算法分析的…', options: [], blanks: 0 });
  assert.match(tf[0].content, /只输出要求的 JSON/);
  assert.match(tf[1].content, /"TRUE" 或 "FALSE"/);
  assert.match(tf[1].content, /T=正确、F=错误/);

  const mc = buildPrompt({ kind: 'MULTIPLE_CHOICE', text: '快速排序基于…', options: [{ letter: 'A' }, { letter: 'B' }, { letter: 'C' }, { letter: 'D' }], blanks: 0 });
  assert.match(mc[1].content, /answer 为选项字母/);
  assert.match(mc[1].content, /A、B、C、D/);

  const fill = buildPrompt({ kind: 'FILL_IN_THE_BLANK', text: 'O( [空1] ) 表示…记作 T(n) = O( [空2] )。', options: [], blanks: 2 });
  assert.match(fill[1].content, /共 2 空/);
  assert.match(fill[1].content, /\[空1\]/);
  assert.match(fill[1].content, /本题为 2 个/);
});

test('buildPrompt：编程题——带语言名 + 围栏输出，不含 JSON 指令', () => {
  const p = buildPrompt({ kind: 'PROGRAMMING', text: '本题目要求读入n个整数…', langLabel: 'C (gcc)', options: [], blanks: 0 });
  assert.match(p[0].content, /代码围栏块/);
  assert.doesNotMatch(p[0].content, /JSON/);
  assert.match(p[1].content, /用「C \(gcc\)」/);
  assert.match(p[1].content, /代码围栏/);
  assert.doesNotMatch(p[1].content, /只输出一个 JSON/);
  // 空语言回退文案
  const p2 = buildPrompt({ kind: 'PROGRAMMING', text: '…', langLabel: '', options: [], blanks: 0 });
  assert.match(p2[1].content, /编辑器当前语言/);
});

test('TYPE_BY_NAME：侧栏题型 → exam-submissions 的 problemType', () => {
  assert.equal(TYPE_BY_NAME['判断题'], 'TRUE_OR_FALSE');
  assert.equal(TYPE_BY_NAME['单选题'], 'MULTIPLE_CHOICE');
  assert.equal(TYPE_BY_NAME['填空题'], 'FILL_IN_THE_BLANK');
  assert.equal(TYPE_BY_NAME['编程题'], 'PROGRAMMING');
});

test('parseCodeAnswer：代码围栏优先，多围栏取最长块', () => {
  const c1 = parseCodeAnswer('```c\nint main() { return 0; }\n```');
  assert.equal(c1, 'int main() { return 0; }\n');
  const c2 = parseCodeAnswer('```python\nprint(1)\n```');
  assert.equal(c2, 'print(1)\n');
  // 围栏可以不带语言标
  assert.equal(parseCodeAnswer('```\nx = 1\n```'), 'x = 1\n');
  // 先解释后贴码：取最长块（解释块短）
  const mixed = '思路：用一次遍历。```c\nint a;\nint b;\n```\n说明完毕。```c\nint long_code;\nint longer;\nint longest_line_here;\n```';
  assert.equal(parseCodeAnswer(mixed), 'int long_code;\nint longer;\nint longest_line_here;\n');
});

test('parseCodeAnswer：JSON 包裹回退，代码里的花括号击不穿', () => {
  // 代码含大量花括号时贪婪 {…} 不能当 JSON——只有整串合法 JSON 且有 answer 字段才走这一支
  const bare = '{"answer":"int main() { while (1) { ; } }"}';
  assert.equal(parseCodeAnswer(bare), 'int main() { while (1) { ; } }\n');
  // 伪 JSON（花括号不成对）落入围栏分支
  assert.equal(parseCodeAnswer('```c\nif (x) { y(); }\n```'), 'if (x) { y(); }\n');
});

test('parseCodeAnswer：裸代码回退与自然语言拒绝', () => {
  // 没有围栏但整体像源码（含换行/分号/花括号）：剥残留围栏标记后收下
  assert.equal(parseCodeAnswer('int x;\nprintf("%d", x);'), 'int x;\nprintf("%d", x);\n');
  assert.equal(parseCodeAnswer('```c\nint y;\n```'), 'int y;\n'); // 只闭合一半围栏也剥
  // 纯自然语言（无代码特征）拒绝
  assert.equal(parseCodeAnswer('抱歉，这道题我不会'), null);
  assert.equal(parseCodeAnswer('以上是完整说明。'), null);
  assert.equal(parseCodeAnswer(''), null);
  assert.equal(parseCodeAnswer(null), null);
});

test('COMPILER_LABELS：38 种语言与菜单显示名（初探 §10.5 抽样实证）', () => {
  assert.equal(Object.keys(COMPILER_LABELS).length, 38);
  assert.equal(COMPILER_LABELS.GCC, 'C (gcc)');
  assert.equal(COMPILER_LABELS.PYTHON3, 'Python (python3)');
  assert.equal(COMPILER_LABELS.KOTLIN, 'Kotlin (kotlinc)');
  assert.equal(COMPILER_LABELS.CANGJIE, '仓颉 (cjc)');
  assert.equal(COMPILER_LABELS.MODERN_GCC, 'C (gcc c11)');
  assert.equal(COMPILER_LABELS.CAT, 'Plaintext (cat)');
});

test('compilerIdFromLabel：显示名反查编译器 id，未知返回 null', () => {
  assert.equal(compilerIdFromLabel('C (gcc)'), 'GCC');
  assert.equal(compilerIdFromLabel('C (gcc c11)'), 'MODERN_GCC');
  assert.equal(compilerIdFromLabel(' Kotlin (kotlinc) '), 'KOTLIN'); // 含空白也规整
  assert.equal(compilerIdFromLabel('Python (python3)'), 'PYTHON3');
  assert.equal(compilerIdFromLabel('仓颉 (cjc)'), 'CANGJIE');
  assert.equal(compilerIdFromLabel('Bogus (none)'), null);
  assert.equal(compilerIdFromLabel(''), null);
  assert.equal(compilerIdFromLabel(null), null);
});

test('normalizeLangLabel：去掉 single-value 里并排渲染的语言限额（7-8 实测形状）', () => {
  // PTA 在部分题目里把「语言 + 该语言限额」放进同一个 select__single-value，textContent 直接拼接
  assert.equal(normalizeLangLabel('C (gcc)100 ms / 64 MB'), 'C (gcc)');
  assert.equal(normalizeLangLabel('C (gcc) 100 ms / 64 MB'), 'C (gcc)');
  assert.equal(normalizeLangLabel('C (gcc c11)100ms/64MB'), 'C (gcc c11)');
  assert.equal(normalizeLangLabel('Python (python3)1.5 s / 256 MB'), 'Python (python3)');
  assert.equal(normalizeLangLabel('C# (dotnet)1000 ms / 1024 MB'), 'C# (dotnet)');
  // 没有限额的常规形状与空值保持原样（含空白规整）
  assert.equal(normalizeLangLabel('C (gcc)'), 'C (gcc)');
  assert.equal(normalizeLangLabel(' Kotlin (kotlinc) '), 'Kotlin (kotlinc)');
  assert.equal(normalizeLangLabel(''), '');
  assert.equal(normalizeLangLabel(null), '');
  // 规整后的语言名仍能反查编译器 id
  assert.equal(compilerIdFromLabel(normalizeLangLabel('C (gcc)100 ms / 64 MB')), 'GCC');
});

test('resolveModel：可自填网关用输入值（trim，空回默认），固定适配无视输入', () => {
  assert.equal(resolveModel(PRESETS.opencode, '  glm-5.3-flash  '), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.opencode, 'kimi-k6'), 'kimi-k6');
  assert.equal(resolveModel(PRESETS.opencode, ''), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.opencode, null), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.deepseek, 'kimi-k6'), 'deepseek-flash');
  assert.equal(resolveModel(PRESETS.custom, ''), '');
});

test('currentKey/withKeyFor：API Key 按服务各存一把，切换服务不互相覆盖', () => {
  // 写入 A 服务不动 B 服务
  const s1 = withKeyFor({ autoAnswerApiKeys: { deepseek: 'sk-a' } }, 'opencode', ' sk-b ');
  assert.deepEqual(s1.autoAnswerApiKeys, { deepseek: 'sk-a', opencode: 'sk-b' });
  assert.equal(currentKey(s1, 'deepseek'), 'sk-a');
  assert.equal(currentKey(s1, 'opencode'), 'sk-b');
  // 更新同服务只换自己的
  const s2 = withKeyFor(s1, 'deepseek', 'sk-a2');
  assert.equal(currentKey(s2, 'deepseek'), 'sk-a2');
  assert.equal(currentKey(s2, 'opencode'), 'sk-b');
  // 旧版存储形态（无映射/映射坏掉）读到空串，写入从空映射起步
  assert.equal(currentKey({}, 'deepseek'), '');
  assert.equal(currentKey(null, 'deepseek'), '');
  assert.equal(currentKey({ autoAnswerApiKeys: 'bad' }, 'deepseek'), '');
  assert.deepEqual(withKeyFor(null, 'custom', 'sk-c').autoAnswerApiKeys, { custom: 'sk-c' });
  // 未知网关回 deepseek，不写脏键
  assert.deepEqual(withKeyFor({}, 'nope', 'sk-x').autoAnswerApiKeys, { deepseek: 'sk-x' });
  assert.equal(currentKey({ autoAnswerApiKeys: { deepseek: 'sk-a' } }, 'nope'), 'sk-a');
});

test('clampBallPos：拖拽位置夹回视口内（留出最小边距），非法输入回 0 边界', () => {
  // 正常值原样保留
  assert.deepEqual(clampBallPos({ r: 200, b: 100 }, 1920, 1080), { r: 200, b: 100 });
  // 越界：夹到 [MARGIN, 视口-球-MARGIN]（MARGIN=18，球 46）
  assert.deepEqual(clampBallPos({ r: -50, b: 9999 }, 800, 600), { r: 18, b: 600 - 46 - 18 });
  assert.deepEqual(clampBallPos({ r: 9999, b: -1 }, 800, 600), { r: 800 - 46 - 18, b: 18 });
  // 非法/缺失按 0 处理后照常夹取
  assert.deepEqual(clampBallPos({ r: 'x', b: null }, 800, 600), { r: 18, b: 18 });
  assert.deepEqual(clampBallPos(null, 800, 600), { r: 18, b: 18 });
  // 极小视口（不够球+双边距）不产生负值
  assert.deepEqual(clampBallPos({ r: 5, b: 5 }, 40, 40), { r: 18, b: 18 });
});

test('normalizeBaseUrl：去空白/尾斜杠，误粘 /chat/completions 自动剥掉', () => {
  assert.equal(normalizeBaseUrl('https://api.x.com/v1'), 'https://api.x.com/v1');
  assert.equal(normalizeBaseUrl('https://api.x.com/v1/'), 'https://api.x.com/v1');
  assert.equal(normalizeBaseUrl('https://api.x.com/v1/chat/completions'), 'https://api.x.com/v1');
  assert.equal(normalizeBaseUrl(' https://api.x.com '), 'https://api.x.com');
  assert.equal(normalizeBaseUrl(''), '');
  assert.equal(typeof PRESETS.custom.customEndpoint, 'boolean');
});

test('assembleImgMessage：视觉消息 = 原文本在前（附说明），题干图逐张标注、选项图按字母映射', () => {
  const parts = assembleImgMessage('题干文本…', { stem: ['d1', 'd2'], options: { B: 'dB' } });
  assert.equal(parts[0].type, 'text');
  assert.match(parts[0].text, /本题含配图/);
  assert.match(parts[0].text, /题干文本…/);
  assert.deepEqual(parts[1], { type: 'text', text: '（题干配图 1/2）' });
  assert.deepEqual(parts[2], { type: 'image_url', image_url: { url: 'd1' } });
  assert.deepEqual(parts[3], { type: 'text', text: '（题干配图 2/2）' });
  assert.deepEqual(parts[4], { type: 'image_url', image_url: { url: 'd2' } });
  assert.deepEqual(parts[5], { type: 'text', text: '（选项 B 的配图）' });
  assert.deepEqual(parts[6], { type: 'image_url', image_url: { url: 'dB' } });
  // 纯题干图 / 纯选项图 / 无图（空数组）也能组装
  const noStem = assembleImgMessage('x', { stem: [], options: { A: 'da' } });
  assert.equal(noStem.filter(p => p.type === 'image_url').length, 1);
  const empty = assembleImgMessage('x', { stem: [], options: {} });
  assert.equal(empty.length, 1); // 只有说明文本
  assert.match(empty[0].text, /本题含配图/);
});

test('PRESETS：OpenCode Go 网关适配的关键约定（协议头分支与默认模型）', () => {
  assert.equal(PRESETS.opencode.gateway, 'opencode'); // chatOnce 靠它走后台转发并加 x-opencode-session
  assert.equal(PRESETS.opencode.baseUrl, 'https://opencode.ai/inference/go/openai/v1'); // 官方文档口径
  assert.equal(PRESETS.opencode.editableModel, true);
  assert.equal(PRESETS.deepseek.gateway, 'deepseek');
  assert.equal(!!PRESETS.deepseek.editableModel, false); // DeepSeek 固定 deepseek-flash
});

test('OpenCode Go：非 chat 协议模型按前缀拒绝，chat 系放行', () => {
  for (const id of ['glm-5.3-flash', 'glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash', 'longcat-2.0', 'mimo-v2.6-flash', 'minimax-m3.1-flash', 'hy3']) {
    assert.equal(nonChatProtocol(id), '', id);
  }
  assert.match(nonChatProtocol('claude-haiku-5-5'), /Anthropic Messages/);
  assert.match(nonChatProtocol('minimax-m3'), /Anthropic Messages/); // 仅精确匹配，不能误伤 m3.1-flash
  assert.match(nonChatProtocol('qwen3.8-max'), /Anthropic Messages/);
  assert.match(nonChatProtocol('qwen3.7-plus'), /Anthropic Messages/);
  assert.match(nonChatProtocol('gpt-6-luna'), /OpenAI Responses/);
  assert.match(nonChatProtocol('grok-4.7'), /OpenAI Responses/);
  assert.match(nonChatProtocol('muse-spark-1.3-contributor'), /OpenAI Responses/);
  assert.match(nonChatProtocol('gemini-4-argon-contributor'), /Google generateContent/);
  // 只对 OpenCode 通道生效；自定义端点可自己代理/转协议
  assert.doesNotThrow(() => assertChatModel({ gateway: 'custom', model: 'claude-haiku-5-5' }));
  assert.throws(() => assertChatModel({ gateway: 'opencode', model: 'claude-haiku-5-5' }), /Anthropic Messages/);
});

test('LLM 错误体：两种网关形状 + 重试判定', () => {
  assert.deepEqual(
    parseLlmErrorBody('{"type":"error","error":{"type":"MissingSessionID","message":"missing"}}'),
    { type: 'MissingSessionID', message: 'missing' },
  );
  assert.deepEqual(
    parseLlmErrorBody('{"error":{"type":"server_error","message":"Go requires a credential"}}'),
    { type: 'server_error', message: 'Go requires a credential' },
  );
  assert.deepEqual(parseLlmErrorBody('plain text'), { type: '', message: 'plain text' });
  assert.equal(parseLlmErrorBody(''), null);
  // 429 / 5xx / 网络错误可重试；配置与凭证错误不重试
  assert.equal(isRetryableLlmError({ status: 429 }), true);
  assert.equal(isRetryableLlmError({ status: 503 }), true);
  assert.equal(isRetryableLlmError(new Error('Failed to fetch')), true);
  for (const status of [400, 401, 403, 404]) assert.equal(isRetryableLlmError({ status }), false, String(status));
  assert.equal(isRetryableLlmError({ aborted: true }), false);
  assert.equal(isRetryableLlmError(null), false);
});

test('PTA 限流页识别：专有文案直接命中，泛化词需错误页外壳', () => {
  assert.equal(isRateLimitedText('您访问得太快啦，不如休息一会儿吧'), true);
  assert.equal(isRateLimitedText('错误信息 浏览器信息 反馈问题 访问过于频繁'), true);
  assert.equal(isRateLimitedText('反馈问题：操作过于频繁'), true);
  assert.equal(isRateLimitedText('题目：为什么访问得太快会导致缓存失效'), false);
  assert.equal(isRateLimitedText('设计一个限流器，访问过于频繁时返回 429'), false);
  assert.equal(isRateLimitedText('正常题目页'), false);
  assert.equal(isRateLimitedText(''), false);
  assert.equal(isRateLimitedText(null), false);
});

test('跨页日志：引擎落盘、读取裁剪与清空', () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  try {
    clearPersistedLog();
    persistLogLine('info', '第一行', '18:55:02');
    persistLogLine('err', '第二行', '18:55:03');
    assert.deepEqual(
      readPersistedLog().map(x => [x.level, x.text, x.t]),
      [['info', '第一行', '18:55:02'], ['err', '第二行', '18:55:03']],
    );
    for (let i = 0; i < 205; i++) persistLogLine('info', 'x' + i, '18:55:04');
    const capped = readPersistedLog();
    assert.equal(capped.length, 200);
    assert.equal(capped[capped.length - 1].text, 'x204');
    clearPersistedLog();
    assert.deepEqual(readPersistedLog(), []);
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('failDetails：失败明细逐条换行，label 缺省回退题 id 后四位', () => {
  assert.equal(failDetails([{ id: '2110', label: '7-1', reason: 'LLM 调用失败' }]), '7-1：LLM 调用失败');
  const two = failDetails([
    { id: '2110', label: '7-1', reason: 'LLM 调用失败' },
    { id: '999888777', reason: '水合校验失败' },
  ]);
  assert.match(two, /7-1：LLM 调用失败\n8777：水合校验失败/);
  assert.equal(failDetails([]), '');
  assert.equal(failDetails(null), '');
});

test('relaySummaryLine：无失败只有汇总行；有失败追加明细（跨页续跑的失败不再无从查起）', () => {
  const clean = relaySummaryLine({
    summary: { applied: 1, skippedAnswered: 2, failed: [] },
    cfg: {},
  });
  assert.match(clean, /作答 1 · 跳过已答 2 · 失败 0$/);
  assert.doesNotMatch(clean, /跳过含图/);
  assert.doesNotMatch(clean, /明细/);
  const messy = relaySummaryLine({
    summary: { applied: 0, skippedAnswered: 0, failed: [{ id: '2110', label: '7-1', reason: 'LLM 调用失败：请求 120s 无响应，已按超时中断' }] },
    cfg: {},
  });
  assert.match(messy, /失败 1/);
  assert.match(messy, /失败明细：\n7-1：LLM 调用失败：请求 120s 无响应，已按超时中断/);
  const dry = relaySummaryLine({
    summary: { applied: 1, skippedAnswered: 0, failed: [] },
    cfg: { drySave: true },
  });
  assert.match(dry, /（dry，未提交）$/);
});

test('seedCodingProblemCache：种入 boot 水合键，形状与 PTA 自写键一致且不动其余 user-cache', () => {
  // localStorage 在 Node 里不存在，用最小垫片（seed 只用 getItem/setItem）
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  store.set('user-cache', JSON.stringify({ userId: 'u1', PAT_HTTP_CACHE: '{}' }));
  const code = '//# BPS seed\nint main(void){ return 0; }\n';
  const r1 = seedCodingProblemCache('2110001', code, { customTestData: { content: 'I\n#\n' } });
  assert.equal(r1.seeded, true);
  const seeded = JSON.parse(store.get('user-cache'));
  const entry = seeded['codingProblem_2110001'];
  assert.equal(entry.program, code);
  assert.equal(entry.testData, 'I\n#\n');            // testData 与草稿 customTestData.content 同源
  assert.doesNotThrow(() => new Date(entry.saveAt).toISOString()); // saveAt 是可解析的 ISO 时刻
  assert.equal(seeded.userId, 'u1');                 // 其余 user-cache 键原样保留
  assert.equal(seeded.PAT_HTTP_CACHE, '{}');
  // 覆盖旧条目；detail 缺省时 testData 为空串
  assert.equal(seedCodingProblemCache('2110001', 'x', null).seeded, true);
  const reseeded = JSON.parse(store.get('user-cache'));
  assert.equal(reseeded['codingProblem_2110001'].program, 'x');
  assert.equal(reseeded['codingProblem_2110001'].testData, '');
  // 无 user-cache 键时从零种入
  store.delete('user-cache');
  assert.equal(seedCodingProblemCache('2110002', 'y', {}).seeded, true);
  assert.equal(JSON.parse(store.get('user-cache'))['codingProblem_2110002'].program, 'y');
});
