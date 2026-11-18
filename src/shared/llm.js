/* LLM 请求的时限与重试口径（内容脚本与后台共用，避免两处数字漂移）
 *
 * 2026-10-23 真机故障（7-9/7-10）：OpenCode Go 单次请求长时间无内容，旧口径连试 3 次，
 * 每题静默 4–6 分钟。现在的口径：
 * - OpenCode 转发走流式：45s 未拿到响应头、或 45s 收不到任何数据 → 判定卡住（可重试一次）；
 * - **总计时改为「300s 无新内容」看门狗**：正文或推理增量会重置它，所以深推理模型可以
 *   连续思考数分钟（2026-11-18 实测 36k 字符推理仍在涨，却被旧的固定 300s 总上限误杀）；
 *   只发 SSE keep-alive、迟迟没有真正内容的流仍会在 300s 被判定卡住，非流式回退同理；
 * - 等首块期间每 20s 调一次轻量扩展 API 保活，避免 MV3 worker 30s 空闲回收；
 * - 直连端点仍是 120s 整段响应，超时不重试（卡死的网关立刻重试不会变好）；
 * - 429 / 5xx / 网络错误 / 后台通道被回收：最多 3 次尝试；扩展被重载/更新则立即停手。
 */
export const LLM_HEADERS_TIMEOUT_MS = 45000;
export const LLM_IDLE_TIMEOUT_MS = 45000;
// 无新内容看门狗：收到正文/推理增量就重置；300s 没有任何新内容（含仅 keep-alive）才中断
export const LLM_TOTAL_TIMEOUT_MS = 300000;
export const LLM_DIRECT_TIMEOUT_MS = 120000;
export const LLM_PROGRESS_EVERY_MS = 15000;
// MV3 的 service worker 空闲 30s 会被回收；端口模式下挂起的 fetch 不算扩展活动，
// 等首块期间必须每 20s 调一次轻量扩展 API 顶住 idle 计时器（7-9/7-10 真机 30s 断线根因）。
export const LLM_KEEPALIVE_MS = 20000;
export const LLM_MAX_ATTEMPTS = 3;
export const LLM_MAX_IDLE_ATTEMPTS = 2;
