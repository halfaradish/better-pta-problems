/* 更好的题目集 · PTA 题目集列表增强（内容脚本入口）
 *
 * 在 pintia.cn 的题目集列表页（/problem-sets/active、/problem-sets/all 等）
 * 按课程分组展示列表，提供课程筛选条、卡片课程徽章与截止倒计时。
 *
 * 模块分工见同目录各文件；本文件是组装层：读设置、串起「解析 → 识别/归并 →
 * 装饰 → 聚合取数 → 渲染」并维护签名，挂 MutationObserver / 定时器 / 路由钩子，
 * 最后暴露 window.BPS（预览页与自动化测试的入口）。
 */
import { DEFAULTS, loadSettings, onSettingsChanged, saveSettings } from '../shared/settings.js';
import { LIST_PATH_RE, SET_HREF_RE } from '../shared/paths.js';
import * as agg from './aggregate.js';
import { buildCourseRenameMap } from './classify.js';
import { decorate, extractItems } from './decorate.js';
import * as progress from './progress.js';
import * as reminders from './reminders.js';
import * as view from './list-view.js';

let settings = { ...DEFAULTS };

// 模块间钩子：aggregate 不反向 import 本文件，视图重建统一走 sync
agg.setAggregateHooks({
  onPathChange: () => view.resetForRoute(),
  onSuccess: () => reminders.pushAggregatedReminders(settings),
  onSettled: () => sync(true),
});
view.setViewHooks({ rerender: () => sync(true) });
// 进度逐个返回，落地即重建（scheduleSync 自带防抖，避免一批请求触发一串重建）
progress.setProgressHooks({ onUpdate: () => scheduleSync() });

function sync(force = false) {
  try {
    // __BPS_FORCE_LIST__：preview.html 本地预览用的测试钩子，放开路径限制
    if (!settings.enabled || (!window.__BPS_FORCE_LIST__ && !LIST_PATH_RE.test(location.pathname))) {
      if (view.state.sig) view.teardown();
      return;
    }
    const domItems = extractItems(settings);
    if (!domItems.length) { if (view.state.root) view.removeRoot(); return; }

    // 列表容器：优先用 PTA 自身的 .pc-list，缺失时退化为条目的共同父节点
    let listEl = document.querySelector('main .pc-list');
    if (!listEl) {
      const parent = domItems[0].el.parentElement;
      listEl = domItems.every(i => i.el.parentElement === parent) ? parent : null;
    }
    if (!listEl) { if (view.state.root) view.removeRoot(); return; }

    // 同教师相似课程名归并（基于聚合数据；规则命中的名字不受影响）
    const aggItems = agg.ensureAggregate();
    const renameMap = settings.mergeSimilar && aggItems
      ? buildCourseRenameMap(aggItems.map(ai => ({ title: ai.title, teacher: ai.creator })), settings)
      : new Map();
    const renamed = domItems.map(d => ({
      ...d,
      course: d.locked ? d.course : (renameMap.get(d.course) || d.course),
    }));

    // 答题进度：考试型且未关闭的题目集才取数（aggItems 带 examId/时间），按 id 挂到卡片上
    if (settings.progress) progress.ensureProgress(aggItems || []);
    const attachProgress = list => list.forEach(it => { it.progress = progress.progressOf(it.id); });
    attachProgress(renamed);
    renamed.forEach(it => decorate(it, settings)); // 原始卡片徽章/倒计时（列表模式直接可见）

    const uni = view.unifiedItems(renamed, settings, renameMap, aggItems);
    view.state.items = uni;
    attachProgress(uni);
    uni.forEach(it => decorate(it, settings)); // API 卡片补徽章/倒计时；DOM 卡片幂等

    // 签名含 DOM 条目指纹与筛选/模式/页码：SPA 换页、筛选、模式、翻页都触发内容重建；
    // 进度晚到（逐个接口）也靠它触发重建，卡片上的「已作答 X/Y」才会出现
    const domSig = domItems.map(i => i.id).join(',');
    const sig = `${view.state.grouped}#${view.state.filter}#${view.state.page}#${domSig}#${uni.map(i => `${i.id}|${i.course}|${i.closeText}|${i.progress ? `${i.progress.answered}/${i.progress.total}` : '-'}`).join(';')}`;
    // 默认态（全部+列表）要求原生列表可见；分组/课程筛选态要求其隐藏
    const nativeListMode = view.state.filter === 'ALL' && !view.state.grouped;
    const hiddenOk = nativeListMode ? listEl.style.display !== 'none' : listEl.style.display === 'none';
    const anchor = view.state.root || view.state.bar;
    if (!force && anchor && view.state.sig === sig && hiddenOk && document.contains(anchor)) {
      view.refreshCountdowns(settings);
      view.setPagingHidden(!nativeListMode);
      return;
    }

    view.state.sig = sig;
    view.removeRoot();
    view.renderContent(listEl, uni);
  } catch (err) {
    console.warn('[更好的题目集] sync 失败:', err);
  }
}

let syncTimer = 0;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 200);
}

async function init() {
  settings = await loadSettings({ persistMigration: true });
  onSettingsChanged(s => { settings = s; sync(true); reminders.syncRemindersDirect(settings); });

  try { performance.setResourceTimingBufferSize(1000); } catch (_) { /* ignore */ }

  // React 重渲染 / SPA 路由切换 → 重建视图；插件自身的 DOM 变动不触发
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      const relevant = [...m.addedNodes, ...m.removedNodes]
        .some(n => n.nodeType === 1 && !n.closest?.('.bps-root'));
      if (relevant) { scheduleSync(); return; }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // 点开题目集 → 新标签页打开。capture 挂在 document 上，先于 PTA 挂在
  // React 根上的路由委托（document 是 #root 的祖先）；stopPropagation 拦下
  // SPA 同页跳转。修饰键/中键交还浏览器原生行为（Ctrl+Click 本来就是新标签页）。
  document.addEventListener('click', e => {
    if (!settings.enabled || !settings.openInNewTab) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.('a[href]');
    if (!a || !SET_HREF_RE.test(a.getAttribute('href') || '')) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(a.href, '_blank', 'noopener');
  }, true);

  setInterval(() => sync(), 3000);                    // 兜底：路由切换 / 遗漏的变动
  setInterval(() => { if (view.state.root) view.refreshCountdowns(settings); }, 60000);

  // 打开 PTA 任意页面即同步一次邮件提醒订阅（延迟 2s 避开页面首屏请求；
  // 预占节流窗口：若聚合钩子先完成推送，到点后不再重复拉取）
  reminders.armDirectCooldown();
  setTimeout(() => reminders.syncRemindersDirect(settings), 2000);

  sync(true);
}

window.BPS = {
  init, sync, teardown: view.teardown, DEFAULTS,
  // 自动答题调试与回归入口：run 走完整流程（配合 __BPS_LLM_MOCK__ 可 mock LLM），
  // collect 只收集当前题型页的题目（验证提取纯度用）
  setSettings: async patch => {
    settings = { ...settings, ...patch };
    await saveSettings(settings);
    sync(true);
  },
  // 会话内视图模式（等同于点筛选条上的「切换为分组/列表」），预览页与自动化测试用
  setView: patch => {
    Object.assign(view.state, patch);
    view.state.page = 1;
    sync(true);
  },
};

function boot() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { init(); });
  } else {
    init();
  }
}

// 预览页可能重复引入；同一页面只初始化一次
if (!window.__BPS_LOADED__) {
  window.__BPS_LOADED__ = true;
  boot();
}
