/* PTA 原生卡片的解析与装饰：读当前 DOM 的条目，往原生卡片里注入课程徽章与倒计时。
 * 这部分只碰 PTA 自己的 DOM（注入元素都带 bps- 前缀且幂等），与插件自绘的视图无关。
 */
import { SET_HREF_RE } from '../shared/paths.js';
import { fmtCloseLocal, fmtCountdown, parseCloseTime } from '../shared/time.js';
import { hashHue } from '../shared/util.js';
import { classifyDetailed } from './classify.js';
import { inAnswerWindow } from './progress.js';

// 排除本插件生成的克隆节点，避免把分组视图里的克隆卡片当成新条目
export function extractItems(settings) {
  const anchors = [...document.querySelectorAll('main a[href]')]
    .filter(a => SET_HREF_RE.test(a.getAttribute('href') || '') && !a.closest('.bps-root'));
  const seen = new Set();
  const items = [];
  for (const el of anchors) {
    const id = el.getAttribute('href').match(SET_HREF_RE)[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const titleEl = el.querySelector('div[title]');
    const title = (titleEl?.getAttribute('title') || titleEl?.textContent || el.textContent || '').trim();
    const fullText = el.textContent || '';
    items.push({
      id, el, title,
      ...classifyDetailed(title, settings),
      nativeCountdown: /距离关闭/.test(fullText), // PTA 自带精确倒计时的卡片不再叠加我们的
      closeText: (/关闭时间[:：]\s*[\d: -]+/.exec(fullText)?.[0] || '').trim(),
      closeAt: parseCloseTime(fullText),
    });
  }
  return items;
}

// 副标题行：PTA 结构为 .text-xs > .flex > .flex > "关闭时间:<span>"
export function metaLine(scopeEl) {
  return [...scopeEl.querySelectorAll('.text-xs')]
    .find(n => /关闭时间/.test(n.textContent) && n.querySelector('.flex'));
}

export function updateCountdown(scopeEl, it, s) {
  const line = metaLine(scopeEl);
  if (!line) return;
  const target = line.querySelector('.flex .flex') || line.querySelector('.flex');
  let c = scopeEl.querySelector('.bps-countdown');
  const cd = s.countdown && it.closeAt && !it.nativeCountdown ? fmtCountdown(it.closeAt) : null;
  if (!cd) { c?.remove(); return; }
  if (!c) {
    c = document.createElement('span');
    c.className = 'bps-countdown';
    target.append(c);
  }
  const stamp = `${cd.text}|${cd.level}`;
  if (c.dataset.stamp !== stamp) {
    c.dataset.stamp = stamp;
    c.textContent = cd.text;
    c.dataset.level = String(cd.level);
    c.title = `关闭时间 ${fmtCloseLocal(it.closeAt)}`;
  }
}

// 状态徽章行：PTA 结构为 .flex.space-x-2.items-center > .rounded-xl（胶囊）
function pillRow(scopeEl) {
  const pill = scopeEl.querySelector('div[class~="rounded-xl"][class*="bg-opacity-10"]');
  return pill ? pill.parentElement : null;
}

// 找出原生「已开放」胶囊（蓝色；克隆重挂与恢复都要用文本特征，别认位置）
function openPillIn(row) {
  return [...(row?.children || [])].find(
    n => !n.classList.contains('bps-done') && /已开放/.test(n.textContent),
  );
}

// 显示我们的答案胶囊时隐藏原生「已开放」（dataset 标记，复原只动自己藏过的）；
// React 重渲染会换新节点（无标记无隐藏），下次 decorate 重新隐藏
function hideOpenPill(row) {
  const native = openPillIn(row);
  if (!native) return;
  native.dataset.bpsSwapOpen = '1';
  if (native.style.display !== 'none') native.style.display = 'none';
}

function restoreOpenPill(row) {
  const native = openPillIn(row);
  if (native?.dataset.bpsSwapOpen) {
    delete native.dataset.bpsSwapOpen;
    native.style.display = '';
  }
}

// 答题状态胶囊：与 PTA 原生胶囊同构（rounded-xl px-3 py-1 + pc-text text-xs），尺寸
// 与原生完全一致、明暗主题自动跟随；三态换色 = 换整套类名（蓝=未答题 橙=未完成 绿=已完成）
const STATUS_PILL = {
  done: { bg: 'bg-green-500', color: 'pc-color-pass', label: '已完成' },
  todo: { bg: 'bg-orange-500', color: 'pc-color-warning', label: '未完成' },
  none: { bg: 'bg-blue-500', color: 'pc-color-primary', label: '未答题' },
};

function statusPillHtml(level) {
  const t = STATUS_PILL[level];
  return `<div class="rounded-xl ${t.bg} bg-opacity-10 px-3 py-1 inline-block whitespace-nowrap flex-none"><div class="flex items-center space-x-1"><div class="pc-text ${t.color} pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>${t.label}</span></div></div></div></div>`;
}

function buildStatusPill(level) {
  const tpl = document.createElement('template');
  tpl.innerHTML = statusPillHtml(level);
  const el = tpl.content.firstElementChild;
  el.classList.add('bps-done');
  el.dataset.stamp = level;
  el.dataset.level = level;
  return el;
}

// 答题状态：徽章行尾部加「已完成/未完成/未答题」胶囊，副标题行尾加「已作答 X/Y」。
// 胶囊顶替原生「已开放」（时间语义已由已开考/倒计时覆盖，控制一行最多两个胶囊）；
// 考试场次已建的按提交数三态；已开放但还没进场（examId 不在考试场次表）的必然零
// 提交，直接标「未答题」。两者都依赖聚合数据的 startAt，纯 DOM 降级时维持原样。
export function updateProgress(scopeEl, it, s) {
  const p = s.progress && it.progress && it.progress.total > 0 ? it.progress : null;
  const openNoExam = s.progress && !it.examId && inAnswerWindow(it);
  const pill = scopeEl.querySelector('.bps-done');
  const text = scopeEl.querySelector('.bps-answered');
  if (!p && !openNoExam) { pill?.remove(); text?.remove(); restoreOpenPill(pillRow(scopeEl)); return; }

  const level = p ? (p.answered >= p.total ? 'done' : 'todo') : 'none';
  const row = pillRow(scopeEl);
  if (row) {
    hideOpenPill(row);
    if (!pill || pill.dataset.stamp !== level) {
      const next = buildStatusPill(level);
      if (pill) pill.replaceWith(next); else row.append(next);
    }
  }

  const line = metaLine(scopeEl);
  const target = line && (line.querySelector('.flex .flex') || line.querySelector('.flex'));
  if (target && p) {
    const el = text || document.createElement('span');
    if (!text) { el.className = 'bps-answered'; target.append(el); }
    const label = `已作答 ${p.answered}/${p.total}`;
    if (el.textContent !== label) el.textContent = label;
  } else if (text) {
    text.remove(); // 未进场标「未答题」时没有计数可写
  }
}

export function decorate(it, s) {
  const el = it.el;
  if (s.badge && it.course) {
    const line = metaLine(el);
    if (line) {
      const target = line.querySelector('.flex .flex') || line.querySelector('.flex');
      let b = el.querySelector('.bps-badge');
      if (!b) {
        b = document.createElement('span');
        b.className = 'bps-badge';
        target.prepend(b);
      }
      if (b.textContent !== it.course) {
        b.textContent = it.course;
        b.style.setProperty('--h', String(hashHue(it.course)));
      }
    }
  }
  updateCountdown(el, it, s);
  updateProgress(el, it, s);
}
