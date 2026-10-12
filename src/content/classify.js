/* 课程识别：规则 > 分隔符 > 类型关键词 > 学年前缀兜底，再按同教师相似归并。
 * 全部是纯函数（不碰 DOM、不读全局状态），输入 title/settings 输出课程名。
 * 策略细节与真实数据验证见 docs/课程识别策略.md。
 */

export function parseRules(settings) {
  return (settings.rules || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const i = l.indexOf('=>');
      if (i <= 0) return null;
      const key = l.slice(0, i).trim();
      const course = l.slice(i + 2).trim();
      return key && course ? { key, course } : null;
    })
    .filter(Boolean);
}

// 课程名整理：去掉尾部残留的分隔符；拒绝空名与纯数字（如年份 "2025"）
export function tidyCourse(s) {
  s = String(s).trim();
  for (;;) {
    const before = s;
    s = s.replace(/(?:--|｜|\||—|-|·)+$/, '').trim();
    if (s === before) break;
  }
  if (!s || /^[\d\s.\-—·｜|]+$/.test(s)) return null;
  return s;
}

export function splitCourse(title, separators) {
  // 1) 分隔符：取最早出现者，左侧为课程名
  let best = -1;
  for (const sep of separators) {
    const i = title.indexOf(sep);
    if (i > 0 && (best === -1 || i < best)) best = i;
  }
  if (best > 0) {
    const c = tidyCourse(title.slice(0, best));
    if (c) return c;
  }
  // 2) 类型关键词：从左到右找到第一个能构成有效课程名的命中
  // （正则建在函数内：带 /g 的正则对象有 lastIndex 状态，跨调用共享会互相干扰）
  const keywordRe = /(课堂练习|课堂测试|课堂作业|课堂测验|随堂练习|复习题|上机|随堂|实验|作业|测验|考试|测试|练习|期中|期末|项目|Lab|HW)/gi;
  let m;
  while ((m = keywordRe.exec(title))) {
    if (m.index >= 3) {
      const c = tidyCourse(title.slice(0, m.index));
      if (c) return c;
    }
  }
  // 3) 兜底：老师常用 "2025-xxx" 学年前缀命名，前缀本身作课程名（纯数字名仅在此接受）
  const ym = /^(\d{4})[-—·]/.exec(title);
  if (ym) return ym[1];
  return null;
}

export function classifyDetailed(title, settings) {
  for (const r of parseRules(settings)) {
    if (title.includes(r.key)) return { course: r.course, locked: true };
  }
  return {
    course: splitCourse(title, settings.separators.split(',').map(x => x.trim()).filter(Boolean)),
    locked: false,
  };
}

/* ---------- 同教师相似课程归并（教师粗分 → 最长公共子串细分） ---------- */
function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best;
}

// 课程名通常很短，O(n*m) 足够；阈值取 max(4, 短名长度的 60%)，
// 例如 "2025"~"2025-期中"(LCS=4)、"2024程序设计基础"~"2024程序设计基础-242"(LCS=10) 归并，
// 而 "2024"~"2025"(LCS=3)、"操作系统"~"操作实训"(LCS=2) 不归并
export function shouldMergeCourses(a, b) {
  const min = Math.min(a.length, b.length);
  return lcsLength(a, b) >= Math.max(4, Math.ceil(min * 0.6));
}

// pairs: [{title, teacher}]；返回 Map<旧课程名, 归并后课程名>。
// 规则命中的课程名（locked）是用户显式意图，不参与归并也不被改名。
export function buildCourseRenameMap(pairs, settings) {
  const cls = pairs.map(p => ({ ...classifyDetailed(p.title, settings), teacher: p.teacher }));
  const counts = new Map();
  const byTeacher = new Map();
  for (const c of cls) {
    if (!c.course) continue;
    counts.set(c.course, (counts.get(c.course) || 0) + 1);
    if (c.locked || !c.teacher) continue;
    (byTeacher.get(c.teacher) || byTeacher.set(c.teacher, []).get(c.teacher)).push(c.course);
  }
  const nameMap = new Map();
  for (const names of byTeacher.values()) {
    const uniq = [...new Set(names)];
    if (uniq.length < 2) continue;
    const parent = uniq.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        if (shouldMergeCourses(uniq[i], uniq[j])) parent[find(i)] = find(j);
      }
    }
    const clusters = new Map();
    uniq.forEach((n, i) => {
      const r = find(i);
      (clusters.get(r) || clusters.set(r, []).get(r)).push(n);
    });
    for (const members of clusters.values()) {
      if (members.length < 2) continue;
      // 组名取条目最多的名字（并列取最短的基础名）
      const canonical = members
        .map(n => ({ n, count: counts.get(n) || 0 }))
        .sort((a, b) => b.count - a.count || a.n.length - b.n.length)[0].n;
      for (const n of members) if (n !== canonical) nameMap.set(n, canonical);
    }
  }
  return nameMap;
}
