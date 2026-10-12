// 课程识别与同教师归并：对照 docs/课程识别策略.md 的逐层回退与真实数据结论
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCourseRenameMap, classifyDetailed, parseRules, shouldMergeCourses, tidyCourse } from '../src/content/classify.js';
import { DEFAULTS } from '../src/shared/settings.js';

const S = { ...DEFAULTS };
const course = title => classifyDetailed(title, S).course;

test('分隔符层：取最靠前的分隔符左侧作为课程名', () => {
  assert.equal(course('算法设计与分析--课堂练习1-3'), '算法设计与分析');
  assert.equal(course('代数结构与初等数论｜作业01｜证明方法与整除'), '代数结构与初等数论');
  assert.equal(course('算法设计与分析｜作业01--补交'), '算法设计与分析'); // '｜' 比 '--' 靠前
});

test('关键词层：命中首个能构成课程名的类型词', () => {
  assert.equal(course('数据结构复习题(树一)'), '数据结构');
  assert.equal(course('数据结构-作业八（第7章）'), '数据结构');
  assert.equal(course('数据结构-实验八-排序'), '数据结构');
  assert.equal(course('数据结构期中测试一'), '数据结构');
  assert.equal(course('2024程序设计基础-作业8'), '2024程序设计基础');
  assert.equal(course('2024程序设计基础-242-作业9'), '2024程序设计基础-242'); // 班级后缀变体，留给归并处理
});

test('学年前缀兜底：纯数字课程名只在兜底层接受', () => {
  assert.equal(course('2025-实验3'), '2025');
  assert.equal(course('2025-随堂243-接口与多态'), '2025');
  assert.equal(course('2025-期中考试'), '2025-期中'); // 关键词层的纯数字段被拒，继续命中「考试」
});

test('无法成课的标题归入未分类', () => {
  assert.equal(course('作业1'), null);      // 关键词命中位置需在第 3 个字符之后
  assert.equal(course('数据结构'), null);   // 既无分隔符也无类型词
  assert.equal(course(''), null);
});

test('课程名整理：去掉尾部残留分隔符，拒绝空名与纯数字', () => {
  assert.equal(tidyCourse('数据结构-'), '数据结构');
  assert.equal(tidyCourse('2024程序设计基础--'), '2024程序设计基础');
  assert.equal(tidyCourse(' 算法设计与分析 ｜ '), '算法设计与分析');
  assert.equal(tidyCourse('2025'), null);
  assert.equal(tidyCourse('   '), null);
});

test('自定义规则优先于自动识别，并标记为 locked', () => {
  const rules = { ...S, rules: '2025-=>2025级Java\n数据结构=>数据结构课' };
  assert.deepEqual(classifyDetailed('2025-期中考试', rules), { course: '2025级Java', locked: true });
  assert.deepEqual(classifyDetailed('数据结构复习题(树一)', rules), { course: '数据结构课', locked: true });
  assert.deepEqual(classifyDetailed('算法设计与分析--课堂练习1-3', rules), { course: '算法设计与分析', locked: false });
});

test('parseRules：跳过空行、缺 => 与单侧为空的条目', () => {
  const rules = '\n数据结构=>数据结构课\n没有箭头\n双=>箭头=>课\n还没有=>\n';
  assert.deepEqual(parseRules({ rules }), [
    { key: '数据结构', course: '数据结构课' },
    { key: '双', course: '箭头=>课' },
  ]);
});

test('归并阈值：max(4, 短名长度的 60%)', () => {
  assert.equal(shouldMergeCourses('2025', '2025-期中'), true);
  assert.equal(shouldMergeCourses('2024程序设计基础', '2024程序设计基础-242'), true);
  assert.equal(shouldMergeCourses('2024', '2025'), false);       // LCS=3 不足下限 4
  assert.equal(shouldMergeCourses('操作系统', '操作实训'), false); // LCS=2 远低于阈值
});

test('同一个教师下的相似课程名归并，组名取条目最多者（并列取最短）', () => {
  const pairs = [
    { title: '2025-随堂243-接口与多态', teacher: '教师D' },
    { title: '2025-期中考试', teacher: '教师D' },
  ];
  assert.deepEqual([...buildCourseRenameMap(pairs, S)], [['2025-期中', '2025']]);

  const withSuffix = [
    { title: '2024程序设计基础-作业11', teacher: '教师E' },
    { title: '2024程序设计基础-242-作业9', teacher: '教师E' },
  ];
  assert.deepEqual([...buildCourseRenameMap(withSuffix, S)], [['2024程序设计基础-242', '2024程序设计基础']]);
});

test('不同教师之间互不归并', () => {
  const pairs = [
    { title: '2025-期中考试', teacher: '教师A' },
    { title: '2025-实验3', teacher: '教师B' },
  ];
  assert.equal(buildCourseRenameMap(pairs, S).size, 0);
});

test('规则命中的课程名不参与归并、也不被改名', () => {
  const pairs = [
    { title: '2025-随堂243-接口与多态', teacher: '教师D' },
    { title: '2025-期中考试', teacher: '教师D' },
  ];
  const rules = { ...S, rules: '2025-期中=>2025级Java期中' };
  assert.deepEqual([...buildCourseRenameMap(pairs, S)], [['2025-期中', '2025']]);
  assert.equal(buildCourseRenameMap(pairs, rules).size, 0); // 剩下的那个名字凑不成簇
});

test('同一门课的各种命名变体归入单一名（真实数据形态，零碎片组）', () => {
  const titles = [
    '数据结构复习题(线性表）', '数据结构复习题(树一)', '数据结构复习题(树二)',
    '数据结构复习题(图)', '数据结构复习题(排序)',
    '数据结构-作业八（第7章）', '数据结构-实验八-排序', '数据结构-实验七-最小生成树',
    '数据结构-实验六-图的存储与遍历', '数据结构-实验五-散列查找',
    '数据结构-实验四-二叉搜索树与平衡二叉树', '数据结构-实验三-二叉树',
    '数据结构-期中测试', '数据结构期中测试一',
  ];
  const names = new Set(titles.map(course));
  assert.deepEqual([...names], ['数据结构']);
  // 全部同名，无需归并即可成组
  assert.equal(buildCourseRenameMap(titles.map(title => ({ title, teacher: '教师C' })), S).size, 0);
});
