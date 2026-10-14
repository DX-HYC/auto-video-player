// 静态自检：验证课时序号过滤不会误伤网梯平台（源码直接提取，非副本）
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.slice(start, end);
}

const codeBody = extractFn('looksLikeLessonItem') + '\n' + extractFn('filterLessonLeaves');

// 构造指定 profile 下的 filterLessonLeaves。
// v2.0.0 起序号过滤只在 jxnu profile 下启用（profileAllows('jxnu')），
// 因此测试必须能切换 profile —— 顺带把"平台隔离"本身也变成断言。
function buildFilter(activeProfile) {
  const head =
    'var ACTIVE_PROFILE = ' + JSON.stringify(activeProfile) + ';\n' +
    'function profileAllows(id) {\n' +
    '  if (ACTIVE_PROFILE === id) return true;\n' +
    '  if (ACTIVE_PROFILE === "generic") return true;\n' +
    '  return false;\n' +
    '}\n';
  return new Function(head + codeBody + '\nreturn { filterLessonLeaves };')().filterLessonLeaves;
}
const jxnuFilter = buildFilter('jxnu');
const wtFilter = buildFilter('whaty');
const genFilter = buildFilter('generic');

// 极简 DOM 桩
function El(o) { this.attrs = o.attrs || {}; this.className = o.className || ''; this.sel = o.sel || ''; }
El.prototype.getAttribute = function (n) { return this.attrs[n] != null ? this.attrs[n] : null; };
El.prototype.matches = function (s) {
  const want = String(s).split(',').map(x => x.trim());
  const have = this.sel.split(',').map(x => x.trim());
  return want.some(w => have.indexOf(w) >= 0);
};
const item = (text, o) => ({ text, el: new El(o || {}) });

let pass = 0, fail = 0;
function check(name, got, wantLessons, wantHeaders) {
  const ok = got.lessons.length === wantLessons && got.headers.length === wantHeaders;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name +
    ' → 课时 ' + got.lessons.length + '（期望 ' + wantLessons + '）' +
    ' / 剔除 ' + got.headers.length + '（期望 ' + wantHeaders + '）');
  ok ? pass++ : fail++;
}

// 场景1：jxnu zjpt —— 13 个带序号课时 + 4 个 SPAN.nav-title 章节标题
const jxnu = [
  item('确保实现社会主义基本现代化取得决定性进展——深入学习党的二十届四中全会精神',
       { className: 'nav-title text-overflow-hidden' }),
  item('80.4%\n1-1 确保基本实现社会主义现代化取得决定性进展——深入学习党的二十'),
  item('0.0%\n1-2 确保基本实现社会主义现代化取得决定性进展——深入学习党的二十届'),
  item('0.0%\n1-3 确保基本实现社会主义现代化取得决定性进展'),
  item('0.0%\n1-4 确保基本实现社会主义现代化取得决定性进展'),
  item('“十五五”时期我国面临的国际环境和战略机遇', { className: 'nav-title text-overflow-hidden' }),
  item('0.0%\n2-1 “十五五”时期我国面临的国际环境和战略机遇（上）'),
  item('0.0%\n2-2 “十五五”时期我国面临的国际环境和战略机遇（中）'),
  item('0.0%\n2-3 “十五五”时期我国面临的国际环境和战略机遇（下）'),
  item('建设强大国内市场，加快构建新发展格局', { className: 'nav-title text-overflow-hidden' }),
  item('0.0%\n3-1 建设强大国内市场，加快构建新发展格局（上）'),
  item('0.0%\n3-2 建设强大国内市场，加快构建新发展格局（中）'),
  item('0.0%\n3-3 建设强大国内市场，加快构建新发展格局（下）'),
  item('推进国家安全体系和能力现代化，建设更高水平平安中国', { className: 'nav-title text-overflow-hidden' }),
  item('0.0%\n4-1 推进国家安全体系和能力现代化（上）'),
  item('0.0%\n4-2 推进国家安全体系和能力现代化（中）'),
  item('0.0%\n4-3 推进国家安全体系和能力现代化（下）')
];
check('jxnu：剔除章节标题', jxnuFilter(jxnu), 13, 4);

// 平台隔离：同一份 jxnu 目录结构，在不同 profile 下的结果必须符合隔离约定
check('隔离：网梯 profile 下不执行 jxnu 的序号过滤', wtFilter(jxnu), 17, 0);
// generic 是"未识别出已知平台"时的兼容模式：两套专属逻辑都放行，行为与隔离改造前一致，
// 这样平台哪天换了域名也不会整站失效。真正的隔离发生在两个已知平台之间（见上一条）。
check('未识别平台保持向后兼容（专属逻辑都放行 → 过滤照旧生效）', genFilter(jxnu), 13, 4);

// 场景2：网梯 —— 全部是 .s_point[itemtype="video"]，文本无序号
const wt1 = [
  item('课程导学与学习要求', { sel: '.s_point[itemtype="video"]', attrs: { itemtype: 'video', completestate: '0' } }),
  item('第一章 绪论', { sel: '.s_point[itemtype="video"]', attrs: { itemtype: 'video', completestate: '1' } }),
  item('绪论（下）', { sel: '.s_point[itemtype="video"]', attrs: { itemtype: 'video', completestate: '0' } })
];
check('网梯A：全是 s_point，无序号也不过滤', wtFilter(wt1), 3, 0);

// 场景3：网梯 —— 课时无序号 + 章节标题带序号，被剔除项带 openLearnResItem onclick
const wt2 = [
  item('1.1 第一章 绪论', { className: 's_chapter' }),
  item('课程导学', { className: 's_point', attrs: { onclick: "openLearnResItem('uuid1','video',null,'课程导学')", completestate: '0' } }),
  item('绪论（上）', { className: 's_point', attrs: { onclick: "openLearnResItem('uuid2','video',null,'绪论上')", completestate: '0' } }),
  item('2.1 第二章 进阶', { className: 's_chapter' }),
  item('进阶讲解', { className: 's_point', attrs: { onclick: "openLearnResItem('uuid3','video',null,'进阶')", completestate: '0' } })
];
check('网梯B：章节带序号但课时带 onclick → 不过滤', wtFilter(wt2), 5, 0);

// 场景4：网梯 —— 课时被误判为"标题"（无序号），剔除项含 itemtype=video
const wt3 = [
  item('1.1 第一章', { className: 's_chapter' }),
  item('2.1 第二章', { className: 's_chapter' }),
  item('真实课时一', { className: 's_point', attrs: { itemtype: 'video' } }),
  item('真实课时二', { className: 's_point', attrs: { itemtype: 'video' } })
];
check('网梯C：剔除项含 itemtype=video → 不过滤', wtFilter(wt3), 4, 0);

// 场景5：通用平台 —— 课时与章节都不带序号
const generic = [
  item('第一讲 开场'), item('第二讲 正文'), item('第三讲 结尾')
];
check('通用：都不带序号 → 不过滤', genFilter(generic), 3, 0);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
