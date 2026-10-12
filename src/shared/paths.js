/* PTA 的 URL 形状：列表页路由、题目集卡片链接、列表接口、进行中路由。
 * 路径闸门、卡片识别、聚合记账都从这里取，避免同一个正则散落多处。
 */

// 仅在列表页生效；题目集详情页、dashboard 等不受影响
export const LIST_PATH_RE = /^\/problem-sets(?:\/(active|all|finished|mine))?\/?$/;

// 题目集卡片链接（原生卡片与插件按接口重建的卡片同形）
export const SET_HREF_RE = /^\/problem-sets\/(\d+)\/overview$/;

// 页面自身的列表接口
export const API_URL_RE = /pintia\.cn\/api\/problem-sets(\?|$)/;

// 「进行中」路由：该路由的聚合才是未关闭全集，其余路由的聚合是筛选子集
export const ACTIVE_PATH_RE = /^\/problem-sets\/active\/?$/;
