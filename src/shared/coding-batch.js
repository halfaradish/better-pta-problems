/* 编码题批量作答的纯逻辑（node:test 覆盖；DOM / fetch 相关留在 content/autoanswer.js）
 *
 * v0.12.0 并行化：把编码题（编程/函数）从「逐题串行 relay」改为
 *   SPA 收题（题型页，1.8s/题）→ 列表页 k 路并发作答（草稿串行队列）→ 逐题种本地键 + 整页 reload 提交。
 * 与页面无关的状态机、判定与常量都在这里；真机实验依据（SPA 挂载不回带刚 POST 的草稿、
 * SPA 卸载会把编辑器内容回写服务端草稿、整页卸载不回写、SPA 4 API vs 整页 10 API）
 * 见 docs/自动答题初探.md §10.10。
 */

export const RELAY_VERSION = 2;
// sessionStorage 续跑单体积上限：题面/代码过大时明确报错中止，不静默截断（截断 = 可能答错题）
export const RELAY_SIZE_LIMIT = 2 * 1024 * 1024;

// SPA 收题节奏：实测 1.2s × 4 次连续切题无 PTA 限流（每次切题 4 个 API、0 个文档请求），
// 留余量取 1.8s。只作用于 SPA 切题；整页 reload（验证阶段）仍用 PAGE_LOAD_WAIT_MS=5s——
// PTA 的「访问得太快啦」是整页错误页，限的是文档/页面访问，与 API 节奏不是一回事。
export const SPA_SWITCH_WAIT_MS = 1800;

// 题型清单 → 扁平题目数组（order = 全局顺序，collect 游标按它推进）
export function flattenCodingTypes(progTypes) {
  const problems = [];
  let order = 0;
  for (const t of progTypes || []) {
    for (const id of t.ids || []) {
      problems.push({ id: String(id), typeId: String(t.typeId), typeName: t.typeName || '', order: order++ });
    }
  }
  return problems;
}

// 收题后的分类：已答且未开「覆盖已作答」→ skipped（保留用户答案）；其余 pending
export function classifyProblem(q, cfg) {
  if (q && q.answered && !(cfg && cfg.overwrite)) return { status: 'skipped' };
  return { status: 'pending' };
}

// 从 exam-draft GET 的 answer.detail 抽批量流程需要的字段（瘦身）：
// 不把旧 program 塞进续跑单；compiler 单独拎出（编程题编译器的兜底来源）。
// customTestData 原样保留（可为 null）——写草稿与种键都要带上它，丢了会清掉用户的自定义测试数据。
export function slimDraftDetail(detail, pspId) {
  const d = detail && typeof detail === 'object' ? detail : null;
  const prog = d && d.programmingSubmissionDetail && typeof d.programmingSubmissionDetail === 'object'
    ? d.programmingSubmissionDetail
    : null;
  return {
    problemId: (d && d.problemId != null ? String(d.problemId) : null) || '0',
    problemSetProblemId: (d && d.problemSetProblemId != null ? String(d.problemSetProblemId) : null) || String(pspId || ''),
    customTestData: d ? (d.customTestData ?? null) : null,
    compiler: prog ? (prog.compiler ?? null) : null,
  };
}

// 编译器选择（编程题）：固定语言 > 题面语言反查 > 草稿 compiler；都没有 → 失败。
// 函数题编译器由题目固定（草稿无 compiler 字段），语言标签直接用于 prompt。
// helpers.labelFor / helpers.compilerIdFromLabel 由调用方注入（COMPILER_LABELS 表在 content 侧）。
export function pickCompiler(p, detail, cfg, helpers = {}) {
  const kind = p.kind || 'PROGRAMMING';
  if (kind === 'CODE_COMPLETION') {
    return { ok: true, compilerId: null, wantLangLabel: String(p.langLabel || '') };
  }
  const labelFor = helpers.labelFor || (() => '');
  const fromLabel = helpers.compilerIdFromLabel || (() => null);
  const fixed = String((cfg && cfg.language) || '').trim();
  const compilerId = fixed || fromLabel(p.langLabel) || (detail && detail.compiler) || null;
  if (!compilerId) {
    return { ok: false, reason: `读不到当前语言「${p.langLabel || '（空）'}」，无法确定编译器` };
  }
  return { ok: true, compilerId, wantLangLabel: labelFor(compilerId) || String(p.langLabel || '') };
}

// 待提交集合：只有草稿写入成功（answered）的题才进入 verify；跳过/失败不进
export function buildVerifyPlan(problems) {
  return (problems || []).filter(p => p.status === 'answered').map(p => p.id);
}

// 收题新鲜度：id 必须命中；题干非空；与上一题（或列表页）文本不同——防 SPA 路由先到、
// 内容后到时把上一题的题面/编辑器状态当成本题（正确性风险，宁可不答不能答错）
export function isFreshStatement(prevText, q, targetId) {
  if (!q || String(q.id || '') !== String(targetId || '')) return { ok: false, reason: '页面题目与目标不符' };
  const text = String(q.text || '');
  if (text.length < 20) return { ok: false, reason: '题干为空或过短' };
  const prev = String(prevText || '');
  if (prev && text === prev) return { ok: false, reason: '题干与上一题相同（疑似页面未切换）' };
  return { ok: true };
}

// boot 恢复动作：按 phase + 当前 URL 判定继续 / 种键 / 弃单。
// url: { pathname, search }（与 location 同形，便于单测）。
// 弃单口径与旧 relay 一致：用户把页面开去别处就停，已落位题目保持各自状态。
export function resumeAction(relay, url) {
  const problems = relay.problems || [];
  const path = String(url?.pathname || '');
  const problemId = (String(url?.search || '').match(/[?&]problemSetProblemId=(\d+)/) || [])[1] || null;
  const typeId = (path.match(/\/exam\/problems\/type\/(\d+)/) || [])[1] || null;
  const onKnownTypeList = !!(typeId && !problemId && problems.some(p => p.typeId === typeId));
  if (relay.phase === 'collect') {
    const cur = problems[relay.ci];
    if (!cur) return { action: 'clear', reason: '续跑单 collect 游标越界' };
    if (problemId && problemId === cur.id) return { action: 'collect' };
    if (!problemId && typeId && typeId === cur.typeId) return { action: 'collect' };
    return { action: 'clear', reason: `页面不在待收题（${cur.label || cur.id.slice(-4)}）上，已落位题目保持各自状态` };
  }
  if (relay.phase === 'answer') {
    if (onKnownTypeList) return { action: 'answer' };
    return { action: 'clear', reason: '页面不在编码题列表页（作答中断；已写入的草稿保留）' };
  }
  if (relay.phase === 'verify') {
    const ids = relay.verifyIds || [];
    const cur = problems.find(p => p.id === ids[relay.vi]);
    if (!cur) return { action: 'clear', reason: '续跑单 verify 游标越界' };
    if (problemId && problemId === cur.id) return { action: 'verify' };
    if (problemId && ids.includes(problemId)) {
      // verify 清单里的其他题页（导航重发/重复装载落回旧题）：重新种当前题的键跳回去，不弃单
      return { action: 'verifyJump' };
    }
    if (onKnownTypeList) return { action: 'seedVerify' };
    return { action: 'clear', reason: `页面不在待提交题（${cur.label || cur.id.slice(-4)}）上，已提交题目保持各自状态` };
  }
  return { action: 'clear', reason: `未知阶段「${relay.phase}」` };
}

// 并发数：1–6 夹取，再受待答题目数约束
export function clampConcurrency(value, pending) {
  let k = Number(value);
  if (!Number.isFinite(k) || k <= 0) k = 3;
  k = Math.min(6, Math.max(1, Math.floor(k)));
  if (Number.isFinite(pending) && pending >= 1) k = Math.min(k, Math.floor(pending));
  return k;
}

// 有界并发池：最多 width 个 worker 同时跑；shouldStop() 为真时不再拉新任务（在途任务自行收尾）。
// worker 抛错会让该 worker 收摊、其余继续，全部结束后抛出第一个错误（批量层按致命错误中止）。
export async function runPool(items, width, worker, shouldStop = () => false) {
  const list = items || [];
  const n = Math.max(1, Math.min(Math.floor(Number(width)) || 1, list.length));
  let cursor = 0;
  let firstErr = null;
  const runners = Array.from({ length: n }, async () => {
    while (cursor < list.length && !shouldStop()) {
      const idx = cursor;
      cursor += 1;
      try {
        await worker(list[idx], idx);
      } catch (err) {
        if (!firstErr) firstErr = err;
        return;
      }
    }
  });
  await Promise.all(runners);
  if (firstErr) throw firstErr;
  return cursor;
}

// 失败明细的纯函数（单测覆盖）：label 缺省回退服务端题 id 后四位
export function failDetails(failed) {
  return (failed || []).map(f => `${f.label || (f.id || '').slice(-4)}：${f.reason}`).join('\n');
}
