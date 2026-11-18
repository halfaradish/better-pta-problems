// 编码题批量作答的纯逻辑（与 DOM/fetch 无关；页面编排走真机回归，见 docs/自动答题初探.md §10.10）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RELAY_VERSION, RELAY_SIZE_LIMIT, SPA_SWITCH_WAIT_MS,
  buildVerifyPlan, clampConcurrency, classifyProblem, failDetails, flattenCodingTypes,
  isFreshStatement, pickCompiler, redoModeOf, resumeAction, runPool, slimDraftDetail, verdictOf,
} from '../src/shared/coding-batch.js';

const PROG_TYPES = [
  { typeId: 7, typeName: '编程题', ids: ['3001', '3002'] },
  { typeId: 6, typeName: '函数题', ids: ['3003'] },
];

test('flattenCodingTypes：多题型扁平化、id 转 string、order 全局递增', () => {
  const ps = flattenCodingTypes(PROG_TYPES);
  assert.deepEqual(ps.map(p => [p.id, p.typeId, p.typeName, p.order]), [
    ['3001', '7', '编程题', 0],
    ['3002', '7', '编程题', 1],
    ['3003', '6', '函数题', 2],
  ]);
  assert.equal(flattenCodingTypes([]).length, 0);
  assert.equal(flattenCodingTypes([{ typeId: 7, ids: [] }]).length, 0);
  assert.equal(flattenCodingTypes(null).length, 0);
});

test('classifyProblem：已答默认跳过；覆盖已作答时仍 pending', () => {
  assert.equal(classifyProblem({ answered: true }, {}).status, 'skipped');
  assert.equal(classifyProblem({ answered: true }, { overwrite: true }).status, 'pending');
  assert.equal(classifyProblem({ answered: false }, {}).status, 'pending');
  assert.equal(classifyProblem(null, {}).status, 'pending');
});

test('redoModeOf：三态优先，旧布尔 overwrite 兼容', () => {
  assert.equal(redoModeOf({ redo: 'wrong' }), 'wrong');
  assert.equal(redoModeOf({ redo: 'all' }), 'all');
  assert.equal(redoModeOf({ redo: 'skip', overwrite: true }), 'skip'); // 新值优先
  assert.equal(redoModeOf({ overwrite: true }), 'all');                // 旧续跑单只有布尔
  assert.equal(redoModeOf({ overwrite: false }), 'skip');
  assert.equal(redoModeOf({}), 'skip');
  assert.equal(redoModeOf(null), 'skip');
  assert.equal(redoModeOf({ redo: 'bogus' }), 'skip');
});

test('verdictOf：PTA 判分状态映射（非通过终态一律可重做）', () => {
  assert.equal(verdictOf('PROBLEM_ACCEPTED'), 'accepted');
  assert.equal(verdictOf('PROBLEM_WRONG_ANSWER'), 'wrong');
  assert.equal(verdictOf('PROBLEM_COMPILATION_ERROR'), 'wrong');
  assert.equal(verdictOf('PROBLEM_PARTIAL_ACCEPTED'), 'wrong');
  assert.equal(verdictOf('PROBLEM_SUBMITTED'), 'pending');
  assert.equal(verdictOf('PROBLEM_JUDGING'), 'pending');
  assert.equal(verdictOf('PROBLEM_NO_ANSWER'), 'none');
  assert.equal(verdictOf(''), 'none');
  assert.equal(verdictOf(undefined), 'unknown'); // 状态接口失败 / 该题不在响应里
  assert.equal(verdictOf(null), 'unknown');
});

test('classifyProblem：仅重做错误按判分状态分流', () => {
  const cfg = { redo: 'wrong' };
  assert.equal(classifyProblem({ answered: true, verdict: 'accepted' }, cfg).status, 'skipped');
  assert.equal(classifyProblem({ answered: true, verdict: 'accepted' }, cfg).reason, 'accepted');
  assert.equal(classifyProblem({ answered: true, verdict: 'wrong' }, cfg).status, 'pending');
  assert.equal(classifyProblem({ answered: true, verdict: 'wrong' }, cfg).reason, 'wrong');
  assert.equal(classifyProblem({ answered: false, verdict: 'wrong' }, cfg).status, 'pending');
  assert.equal(classifyProblem({ answered: true, verdict: 'pending' }, cfg).status, 'skipped');
  assert.equal(classifyProblem({ answered: false, verdict: 'pending' }, cfg).status, 'skipped');
  // 从未提交但有草稿：用户选择一并重做
  assert.equal(classifyProblem({ answered: true, verdict: 'none' }, cfg).status, 'pending');
  assert.equal(classifyProblem({ answered: true, verdict: 'none' }, cfg).reason, 'unsubmitted');
  // 从未提交且无草稿：正常作答
  assert.equal(classifyProblem({ answered: false, verdict: 'none' }, cfg).status, 'pending');
  // 状态缺失：保守回退（已答跳过，未答照常答）
  assert.equal(classifyProblem({ answered: true, verdict: 'unknown' }, cfg).status, 'skipped');
  assert.equal(classifyProblem({ answered: true, verdict: 'unknown' }, cfg).reason, 'unknown');
  assert.equal(classifyProblem({ answered: false, verdict: 'unknown' }, cfg).status, 'pending');
  // 含图闸门仍生效：判分错误但没开含图题 → 跳过并标注原因
  assert.equal(classifyProblem({ answered: true, verdict: 'wrong', hasImg: true }, cfg).status, 'skippedImage');
  assert.equal(classifyProblem({ answered: true, verdict: 'wrong', hasImg: true }, { ...cfg, images: true }).status, 'pending');
  // 已通过的含图题仍然跳过，不因图片开关改判
  assert.equal(classifyProblem({ answered: true, verdict: 'accepted', hasImg: true }, { ...cfg, images: true }).status, 'skipped');
});

test('classifyProblem：全部重做模式不受判分状态影响', () => {
  assert.equal(classifyProblem({ answered: true, verdict: 'accepted' }, { redo: 'all' }).status, 'pending');
  assert.equal(classifyProblem({ answered: true, verdict: 'wrong', hasImg: true }, { redo: 'all' }).status, 'skippedImage');
});

test('classifyProblem：含图编码题在未开「作答含图题」时跳过，开了仍 pending', () => {
  assert.equal(classifyProblem({ answered: false, hasImg: true }, {}).status, 'skippedImage');
  assert.equal(classifyProblem({ answered: false, hasImg: true }, { images: true }).status, 'pending');
  // 已答优先（保留用户答案），开不开图都不改判
  assert.equal(classifyProblem({ answered: true, hasImg: true }, { images: true }).status, 'skipped');
  // 无图题不受开关影响
  assert.equal(classifyProblem({ answered: false, hasImg: false }, {}).status, 'pending');
});

test('slimDraftDetail：保留 problemId/problemSetProblemId/customTestData，抽出 compiler，不搬旧 program', () => {
  const raw = {
    problemId: '0',
    problemSetProblemId: '3001',
    customTestData: { content: '5 3\n', hasCustomTestData: true },
    programmingSubmissionDetail: { compiler: 'GCC', program: 'int main(){...旧代码...' },
  };
  const slim = slimDraftDetail(raw, '3001');
  assert.deepEqual(slim, {
    problemId: '0',
    problemSetProblemId: '3001',
    customTestData: { content: '5 3\n', hasCustomTestData: true },
    compiler: 'GCC',
  });
  // detail 缺省：problemId 兜 '0'，problemSetProblemId 兜 pspId，customTestData null
  assert.deepEqual(slimDraftDetail(null, '3002'), {
    problemId: '0', problemSetProblemId: '3002', customTestData: null, compiler: null,
  });
  // 函数题草稿没有 programmingSubmissionDetail
  const fn = slimDraftDetail({ problemId: '0', codeCompletionSubmissionDetail: { program: 'int f(){...}' } }, '3003');
  assert.equal(fn.compiler, null);
  assert.equal(fn.customTestData, null);
  assert.equal(fn.problemSetProblemId, '3003');
});

test('pickCompiler：固定语言 > 题面语言反查 > 草稿 compiler；函数题跳过；全空失败', () => {
  const p = { kind: 'PROGRAMMING', langLabel: 'C (gcc)' };
  const helpers = {
    labelFor: id => ({ GCC: 'C (gcc)', PYTHON3: 'Python (python3)' }[id] || ''),
    compilerIdFromLabel: l => (l === 'C (gcc)' ? 'GCC' : null),
  };
  assert.deepEqual(pickCompiler(p, { compiler: 'GXX' }, { language: 'PYTHON3' }, helpers), { ok: true, compilerId: 'PYTHON3', wantLangLabel: 'Python (python3)' });
  assert.deepEqual(pickCompiler(p, { compiler: 'GXX' }, {}, helpers), { ok: true, compilerId: 'GCC', wantLangLabel: 'C (gcc)' });
  // 题面语言带限额（7-8 实测形状）也能被 normalizeLangLabel 处理后的 langLabel 反查
  const picked = pickCompiler({ kind: 'PROGRAMMING', langLabel: '' }, { compiler: 'CLANG' }, {}, helpers);
  assert.deepEqual(picked, { ok: true, compilerId: 'CLANG', wantLangLabel: '' });
  assert.equal(pickCompiler({ kind: 'PROGRAMMING', langLabel: '' }, null, {}, helpers).ok, false);
  assert.match(pickCompiler({ kind: 'PROGRAMMING', langLabel: '' }, null, {}, helpers).reason, /读不到当前语言/);
  // 函数题：编译器由题目固定，wantLangLabel 直接用题面语言
  assert.deepEqual(
    pickCompiler({ kind: 'CODE_COMPLETION', langLabel: 'C (gcc)' }, null, {}, helpers),
    { ok: true, compilerId: null, wantLangLabel: 'C (gcc)' },
  );
});

test('buildVerifyPlan：只收 answered；skipped/failed/answering 不进', () => {
  const ps = [
    { id: 'a', status: 'answered' },
    { id: 'b', status: 'skipped' },
    { id: 'c', status: 'failed' },
    { id: 'd', status: 'answered' },
    { id: 'e', status: 'answering' },
  ];
  assert.deepEqual(buildVerifyPlan(ps), ['a', 'd']);
  assert.deepEqual(buildVerifyPlan([]), []);
  assert.deepEqual(buildVerifyPlan(null), []);
});

test('isFreshStatement：id 命中、题干非空、与上一题不同', () => {
  const q = { id: '3001', text: '7-1 背包问题 有 N 件物品和一个容量是 V 的背包……' };
  assert.deepEqual(isFreshStatement('', q, '3001'), { ok: true });
  assert.deepEqual(isFreshStatement('上一题的题干……', q, '3001'), { ok: true });
  // 与上一题完全相同 → 疑似未切换
  const r1 = isFreshStatement(q.text, { id: '3002', text: q.text }, '3002');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /未切换/);
  // id 不符
  assert.equal(isFreshStatement('', q, '9999').ok, false);
  // 题干过短
  assert.equal(isFreshStatement('', { id: '3001', text: '太短' }, '3001').ok, false);
  // 纯图片题：题面文本只有标题/分值，但有题干图 → 放宽文本长度
  assert.deepEqual(
    isFreshStatement('', { id: '3001', text: '7-4 矩阵 分数 10', hasImg: true }, '3001'),
    { ok: true },
  );
  assert.equal(isFreshStatement('', { id: '3001', text: '', hasImg: true }, '3001').ok, false);
});

test('resumeAction：collect 阶段按题型页/题目页恢复，页面漂移弃单', () => {
  const relay = {
    v: RELAY_VERSION,
    phase: 'collect',
    ci: 1,
    problems: [
      { id: '3001', typeId: '7', label: '7-1' },
      { id: '3002', typeId: '7', label: '7-2' },
      { id: '3003', typeId: '6', label: '6-1' },
    ],
    verifyIds: [],
    vi: 0,
  };
  const base = '/problem-sets/1/exam/problems';
  // 当前题（ci=1 → 3002）的题型列表页
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/7`, search: '' }), { action: 'collect' });
  // 当前题的题目页
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/7`, search: '?problemSetProblemId=3002' }), { action: 'collect' });
  // 题目页但 id 是别的题（ci 之前/之后的）→ 弃单
  const drift = resumeAction(relay, { pathname: `${base}/type/7`, search: '?problemSetProblemId=3001' });
  assert.equal(drift.action, 'clear');
  assert.match(drift.reason, /3001|7-1|不在待收题/);
  // 别的题型列表页 → 弃单（不在当前待收题的题型上）
  assert.equal(resumeAction(relay, { pathname: `${base}/type/6`, search: '' }).action, 'clear');
  // 完全无关页面 → 弃单
  assert.equal(resumeAction(relay, { pathname: '/problem-sets/1/exam/overview', search: '' }).action, 'clear');
});

test('resumeAction：answer 阶段只在已知题型列表页恢复', () => {
  const relay = {
    v: RELAY_VERSION,
    phase: 'answer',
    ci: 3,
    problems: [{ id: '3003', typeId: '6', label: '6-1' }],
    verifyIds: [],
    vi: 0,
  };
  const base = '/problem-sets/1/exam/problems';
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/6`, search: '' }), { action: 'answer' });
  assert.equal(resumeAction(relay, { pathname: `${base}/type/9`, search: '' }).action, 'clear');
  // 题目页（带 problemSetProblemId）→ 弃单：作答阶段页面漂移即中断
  assert.equal(resumeAction(relay, { pathname: `${base}/type/6`, search: '?problemSetProblemId=3003' }).action, 'clear');
});

test('resumeAction：verify 阶段按 verifyIds[vi] 恢复；列表页 → seedVerify；落在清单其他题页 → verifyJump', () => {
  const relay = {
    v: RELAY_VERSION,
    phase: 'verify',
    ci: 3,
    problems: [
      { id: '3001', typeId: '7', label: '7-1' },
      { id: '3003', typeId: '6', label: '6-1' },
    ],
    verifyIds: ['3001', '3003'],
    vi: 1,
  };
  const base = '/problem-sets/1/exam/problems';
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/6`, search: '?problemSetProblemId=3003' }), { action: 'verify' });
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/6`, search: '' }), { action: 'seedVerify' });
  // 落在 verify 清单的其他题页（导航重发/重复装载回到已提交题）→ 自愈跳回当前题，不弃单
  assert.deepEqual(resumeAction(relay, { pathname: `${base}/type/7`, search: '?problemSetProblemId=3001' }), { action: 'verifyJump' });
  // 游标越界 → 弃单
  const broken = { ...relay, vi: 5 };
  assert.equal(resumeAction(broken, { pathname: `${base}/type/6`, search: '' }).action, 'clear');
  assert.match(resumeAction(broken, { pathname: `${base}/type/6`, search: '' }).reason, /越界/);
});

test('resumeAction：未知阶段弃单', () => {
  const relay = { v: RELAY_VERSION, phase: 'done', problems: [], verifyIds: [], vi: 0 };
  assert.equal(resumeAction(relay, { pathname: '/x', search: '' }).action, 'clear');
});

test('clampConcurrency：默认 3、夹取 1–6、受待答数约束', () => {
  assert.equal(clampConcurrency(undefined, 7), 3);
  assert.equal(clampConcurrency(0, 7), 3);
  assert.equal(clampConcurrency('abc', 7), 3);
  assert.equal(clampConcurrency(1, 7), 1);
  assert.equal(clampConcurrency(6, 7), 6);
  assert.equal(clampConcurrency(9, 7), 6);
  assert.equal(clampConcurrency(6, 2), 2);
  assert.equal(clampConcurrency(3, 0), 3); // pending 非法时不约束
});

test('runPool：并发上限、任务全跑、shouldStop 停止拉新、worker 异常不拖垮其他', async () => {
  // 全部完成，且同一时刻并发 ≤ k
  let inflight = 0;
  let peak = 0;
  const done = await runPool([1, 2, 3, 4, 5, 6], 2, async x => {
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise(r => setTimeout(r, 5));
    inflight -= 1;
    return x;
  });
  assert.equal(done, 6);
  assert.equal(peak <= 2, true);
  // shouldStop：拉了第 1 个后停止，剩余不跑
  let ran = 0;
  const stopped = await runPool([1, 2, 3], 3, async () => { ran += 1; }, () => ran >= 1);
  assert.equal(ran, 1);
  assert.equal(stopped, 1);
  // worker 抛错：其他任务继续跑完，最后抛出第一个错误
  const ranIds = [];
  await assert.rejects(
    () => runPool([1, 2, 3, 4], 2, async x => {
      ranIds.push(x);
      if (x === 1) throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(ranIds.length, 4); // 其余任务都跑完
  // 空列表
  assert.equal(await runPool([], 3, async () => { throw new Error('never'); }), 0);
});

test('failDetails：label 缺省回退 id 后四位（与旧 relay 口径一致）', () => {
  assert.equal(failDetails([{ id: '2110', label: '7-1', reason: 'x' }]), '7-1：x');
  assert.equal(failDetails([{ id: '999888777', reason: '水合校验失败' }]), '8777：水合校验失败');
  assert.equal(failDetails([]), '');
  assert.equal(failDetails(null), '');
});

test('常量口径：RELAY_VERSION=2，体积上限 2MB，SPA 收题节奏 1.8s', () => {
  assert.equal(RELAY_VERSION, 2);
  assert.equal(RELAY_SIZE_LIMIT, 2 * 1024 * 1024);
  assert.equal(SPA_SWITCH_WAIT_MS, 1800);
});
