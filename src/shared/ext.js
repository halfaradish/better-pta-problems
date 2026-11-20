/* 扩展 API 的跨浏览器访问口。
 *
 * Chrome / Edge 只实现 chrome.*；Firefox 同时提供 browser.*（Promise 风格）。
 * 这里每次调用都现取 globalThis，既让 Firefox 用到原生 Promise API，也避免单元测试
 * 在同一进程里反复替换 globalThis.chrome 时把第一个假对象缓存死。
 *
 * 不要把返回值缓存到模块顶层：settings.js 的 HAS_CHROME_STORAGE 是唯一的静态快照，
 * 其余模块一律通过 ext() 动态取。
 */

export function ext() {
  const g = globalThis;
  if (typeof g.browser !== 'undefined' && g.browser) return g.browser;
  if (typeof g.chrome !== 'undefined' && g.chrome) return g.chrome;
  return null;
}

export function hasExt() {
  return !!ext();
}

// Firefox 判定：优先用 runtime.getBrowserInfo；内容脚本里该方法可能不可见，退而看
// manifest 的 gecko 段（Firefox 构建有 browser_specific_settings，Chrome/Edge 没有）。
// 这样 Chrome 148+ 的原生 browser.* 不会被误判成 Firefox。
export function isFirefox() {
  try {
    const api = ext();
    if (!api) return false;
    if (typeof api.runtime?.getBrowserInfo === 'function') return true;
    return !!api.runtime?.getManifest?.()?.browser_specific_settings?.gecko;
  } catch (_) {
    return false;
  }
}

/* runtime.sendMessage 的跨浏览器包装。
 * - Firefox / Chrome MV3：直接返回 Promise；
 * - 万一宿主只有回调式实现（老版本或测试假对象），返回已解决的 Promise，
 *   让 fire-and-forget 调用方不必区分；需要响应的调用方仍应只在支持的宿主上使用。
 */
export function sendMessage(msg) {
  const api = ext();
  if (!api?.runtime?.sendMessage) return Promise.resolve(undefined);
  try {
    const ret = api.runtime.sendMessage(msg);
    return ret && typeof ret.then === 'function' ? ret : Promise.resolve(ret);
  } catch (err) {
    return Promise.reject(err);
  }
}

/* Firefox 可选数据收集类别（必须与 manifest 的
 * browser_specific_settings.gecko.data_collection_permissions.optional 一致）。
 * 自动答题会把页面内容与 API Key 发给用户自选的模型服务；邮件提醒会把邮箱发给
 * 用户自建的后端。两者都是用户主动开启的可选行为。 */
export const FIREFOX_DATA = {
  autoAnswer: ['websiteContent', 'authenticationInfo'],
  // 邮件 payload 同时包含邮箱（PII）与题目集标题/截止时间（网站内容），两类都要同意。
  email: ['personallyIdentifyingInfo', 'websiteContent'],
};

// Firefox 的 host 权限可被用户随时撤销；内容脚本本身也吃这组 origin。
export const HOST_ORIGINS = [
  'https://pintia.cn/*',
  'https://www.pintia.cn/*',
  'https://images.ptausercontent.com/*',
  'https://opencode.ai/*',
];

// 查询数据收集同意。非 Firefox 或宿主缺少该 API 时一律放行（Chrome 在安装时披露）。
// 注意：Firefox 的 permissions API 不一定暴露给内容脚本；内容脚本请用下面的
// hasDataConsentViaBackground（后台是扩展页上下文，能读 permissions）。
export async function hasDataConsent(categories) {
  if (!isFirefox() || !categories?.length) return true;
  const api = ext();
  if (typeof api?.permissions?.contains !== 'function') return true;
  try {
    return !!(await api.permissions.contains({ data_collection: categories }));
  } catch (_) {
    return true; // 该宿主不支持 data_collection 查询：不在这里二次拦截
  }
}

// 内容脚本专用：优先自己查；宿主没给权限 API 时让后台代查（后台不可用则拒绝，
// 避免在拿不准的情况下把页面内容发出去）。
export async function hasDataConsentViaBackground(categories) {
  if (!isFirefox() || !categories?.length) return true;
  const api = ext();
  if (typeof api?.permissions?.contains === 'function') return hasDataConsent(categories);
  try {
    const rsp = await sendMessage({ type: 'BPS_DATA_CONSENT', categories });
    return rsp?.granted !== false;
  } catch (_) {
    return false;
  }
}

// 请求数据收集同意。只能在用户手势里调用（popup 的开关 change 处理器）。
export async function requestDataConsent(categories) {
  if (!isFirefox() || !categories?.length) return true;
  const api = ext();
  if (typeof api?.permissions?.request !== 'function') return true;
  try {
    return !!(await api.permissions.request({ data_collection: categories }));
  } catch (_) {
    return false;
  }
}

export async function hasHostPermissions(origins = HOST_ORIGINS) {
  const api = ext();
  if (typeof api?.permissions?.contains !== 'function') return true;
  try {
    return !!(await api.permissions.contains({ origins }));
  } catch (_) {
    return true;
  }
}

export async function requestHostPermissions(origins = HOST_ORIGINS) {
  const api = ext();
  if (typeof api?.permissions?.request !== 'function') return true;
  try {
    return !!(await api.permissions.request({ origins }));
  } catch (_) {
    return false;
  }
}
