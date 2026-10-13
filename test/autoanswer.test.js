// 自动答题的纯函数：LLM 输出解析与 prompt 构造。
// DOM 相关的 collectPage/collectProgramming/cleanText/handleRun 依赖 document，走内容脚本 + IAB 真机回归（见 docs/自动答题初探.md）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleImgMessage, buildPrompt, normalizeBaseUrl, normalizeTF, parseChoiceAnswer, parseFillAnswers, TYPE_BY_NAME } from '../src/content/autoanswer.js';
import { PRESETS, resolveModel } from '../src/content/autoanswer-panel.js';

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


test('TYPE_BY_NAME：侧栏题型 → exam-submissions 的 problemType', () => {
  assert.equal(TYPE_BY_NAME['判断题'], 'TRUE_OR_FALSE');
  assert.equal(TYPE_BY_NAME['单选题'], 'MULTIPLE_CHOICE');
  assert.equal(TYPE_BY_NAME['填空题'], 'FILL_IN_THE_BLANK');
});

test('resolveModel：可自填网关用输入值（trim，空回默认），固定适配无视输入', () => {
  assert.equal(resolveModel(PRESETS.opencode, '  glm-5.3-flash  '), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.opencode, 'kimi-k6'), 'kimi-k6');
  assert.equal(resolveModel(PRESETS.opencode, ''), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.opencode, null), 'glm-5.3-flash');
  assert.equal(resolveModel(PRESETS.deepseek, 'kimi-k6'), 'deepseek-flash');
  assert.equal(resolveModel(PRESETS.custom, ''), '');
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
  assert.equal(PRESETS.opencode.gateway, 'opencode'); // chatOnce 靠它加 x-opencode-session
  assert.equal(PRESETS.opencode.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(PRESETS.opencode.editableModel, true);
  assert.equal(PRESETS.deepseek.gateway, 'deepseek');
  assert.equal(!!PRESETS.deepseek.editableModel, false); // DeepSeek 固定 deepseek-flash
});
