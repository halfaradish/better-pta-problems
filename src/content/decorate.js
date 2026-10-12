/* PTA 原生卡片的解析与装饰：读当前 DOM 的条目，往原生卡片里注入课程徽章与倒计时。
 * 这部分只碰 PTA 自己的 DOM（注入元素都带 bps- 前缀且幂等），与插件自绘的视图无关。
 */
import { SET_HREF_RE } from '../shared/paths.js';
import { fmtCloseLocal, fmtCountdown, parseCloseTime } from '../shared/time.js';
import { hashHue } from '../shared/util.js';
import { classifyDetailed } from './classify.js';

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
}
