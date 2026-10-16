// 三处 UI 的 PTA 令牌一致性守卫。
// 设置弹窗（popup.html）、注入列表页样式（styles.css）、悬浮答题面板（autoanswer-panel.js 的
// CSS 模板）各自手写了一份令牌拷贝——这是 2026-10-16 实测 PTA 后的既定做法（PTA 不对外提供
// 样式表给扩展引用），所以必须用测试把「三份是否还一样」钉住，避免改一处忘另两处。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const popup = read(path.join('extension', 'popup', 'popup.html'));
const injected = read(path.join('extension', 'content', 'styles.css'));
const panelSrc = read(path.join('src', 'content', 'autoanswer-panel.js'));
const panelCss = panelSrc.slice(panelSrc.indexOf('const CSS = `') + 12, panelSrc.indexOf('\n`;', panelSrc.indexOf('const CSS = `')));

// 取出某个选择器块的正文（支持嵌套的 @media）
function block(css, startRe) {
  const m = startRe.exec(css);
  if (!m) return '';
  const from = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(from, i + 1);
  }
  return '';
}
const norm = (v) => (v || '').replace(/\s+/g, '');
// 从块里读若干 --var 的值；没声明的返回 null（例：弹窗没有 warning 令牌）
function vars(css, names) {
  const out = {};
  for (const n of names) {
    if (!n) continue;
    const m = new RegExp(`--${n}\\s*:\\s*([^;]+);`).exec(css);
    out[n] = m ? norm(m[1]) : null;
  }
  return out;
}

const lightBlocks = {
  popup: block(popup, /:root\s*\{/),
  injected: block(injected, /:root\s*\{/),
  // 面板开头还有个 `:host { all: initial; }`，要认准以 --bg 打头的令牌块
  panel: block(panelCss, /:host\s*\{\s*--bg\s*:/),
};
const darkBlocks = {
  popup: block(popup, /@media\s*\(prefers-color-scheme:\s*dark\)/),
  injected: block(injected, /^\.dark\s*\{/m),
  panel: block(panelCss, /:host\(\.dark\)\s*\{/),
};

// 语义角色 → 各文件里的变量名（三处历史命名不同；值必须一致）
// 注：页面底色（--bg-site）只有弹窗用得到，注入 UI 与面板都画在 PTA 页面上，不参与比对。
const ROLES = {
  '主色': { popup: 'color-primary', injected: 'bps-primary', panel: 'accent' },
  '卡片底': { popup: 'bg-base', injected: 'bps-bg-base', panel: 'bg' },
  '浅底（悬停/禁用）': { popup: 'bg-light', injected: 'bps-bg-light', panel: 'bg-light' },
  '中底（开关关）': { popup: 'bg-normal', injected: 'bps-bg-normal', panel: 'bg-normal' },
  '分隔线/描边': { popup: 'border-all', injected: 'bps-border', panel: 'hairline' },
  '正文': { popup: 'text-normal', injected: 'bps-text-normal', panel: 'text' },
  '次级文字': { popup: 'text-light', injected: 'bps-text-light', panel: 'text-2' },
  '三级文字': { popup: 'text-lightest', injected: 'bps-text-lightest', panel: 'text-3' },
  '输入框边框': { popup: 'input-border', injected: 'bps-input-border', panel: 'input-border' },
  '通过/成功': { popup: 'color-pass', injected: 'bps-pass', panel: 'ok' },
  '危险/错误': { popup: 'color-danger', injected: 'bps-danger', panel: 'err' },
  '告警': { popup: null, injected: 'bps-warning', panel: 'warn' },
};

// 暗色块里没重声明的令牌 = 该主题下不变（沿用亮色值），逐级回退
function resolve(file, name, theme) {
  if (!name) return null;
  const own = vars(theme === '亮色' ? lightBlocks[file] : darkBlocks[file], [name])[name];
  return own != null ? own : vars(lightBlocks[file], [name])[name];
}

for (const theme of ['亮色', '暗色']) {
  test(`三处 UI 的 PTA 令牌在${theme}下一致`, () => {
    for (const [role, names] of Object.entries(ROLES)) {
      const vals = {};
      for (const file of ['popup', 'injected', 'panel']) {
        const v = resolve(file, names[file], theme);
        if (names[file]) assert.ok(v, `${theme} · ${role}：${file} 里找不到 --${names[file]}`);
        if (v != null) vals[file] = v;
      }
      const uniq = [...new Set(Object.values(vals))];
      assert.equal(uniq.length, 1, `${theme} · ${role}：多处不一致 → ${JSON.stringify(vals)}`);
      assert.ok(Object.keys(vals).length >= 2, `${theme} · ${role}：至少要有两份可比对`);
    }
  });
}

test('注入样式与面板里不再出现旧的品牌色/旧调色板', () => {
  const stale = ['#0a4991', '#1171cf', '#79aaee', '#8ff0b4', '#e8f0fa', '#242a32', '#5c6672', '#6f7a88', '#1a1c20', '#2b8a3e', '#d9480f'];
  for (const [label, css] of [['styles.css', stripComments(injected)], ['面板 CSS', stripComments(panelCss)]]) {
    const hit = stale.filter(c => css.toLowerCase().includes(c));
    assert.deepEqual(hit, [], `${label} 里还留着旧色：${hit.join(', ')}`);
  }
});

test('弹窗暗色仍跟随系统、注入 UI 与面板跟随 PTA 的 .dark 类（两者的触发机制有意不同）', () => {
  // 弹窗是独立窗口，读不到 PTA 的主题类，只能跟系统
  assert.match(popup, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  // 注入样式与面板跑在 PTA 页面里，跟页面的 .dark（实测挂在 <body> 上）
  assert.ok(darkBlocks.injected.length > 0, 'styles.css 应有 .dark 覆盖块');
  assert.ok(darkBlocks.panel.length > 0, '面板应有 :host(.dark) 覆盖块');
  assert.equal(/prefers-color-scheme/.test(stripComments(panelCss)), false,
    '面板不该再用 prefers-color-scheme（会与 PTA 的主题选择脱钩）');
});
