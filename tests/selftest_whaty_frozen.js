/*!
 * 自动连播助手 (Auto Video Player)
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。保留所有权利。
 * 本文件为项目自检用例，MIT 授权，详见 LICENSE。禁止删除作者署名。
 * -----------------------------------------------------------------------------
 *
 * 网梯（whaty）平台冻结回归门禁
 *
 * 约定：自 v2.0.0 起，网梯平台的目录识别与完成/当前判定正式冻结。
 * 任何改动只要让本文件出现 FAIL，就说明触碰了网梯平台，必须先恢复再谈别的。
 * 这是"新增/修改另一个平台不会影响网梯"这条保证的自动化兑现方式。
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' → ' + JSON.stringify(got) +
    (ok ? '' : '（期望 ' + JSON.stringify(want) + '）'));
}

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

// ---------------------------------------------------------------------------
// 极简 DOM 桩
// ---------------------------------------------------------------------------
function N(o) {
  o = o || {};
  this.tag = o.tag || 'div';
  this.className = o.className || '';
  this.attrs = o.attrs || {};
  this.children_ = o.children || [];
  this.textContent = o.text || '';
}
N.prototype.getAttribute = function (n) { return this.attrs[n] != null ? this.attrs[n] : null; };
N.prototype.matches = function (s) { return matchSel(this, s); };
N.prototype.contains = function () { return false; };

function collect(node, out) {
  out = out || [];
  node.children_.forEach(c => { out.push(c); collect(c, out); });
  return out;
}
function matchSel(el, s) {
  const parts = String(s).split(',').map(x => x.trim()).filter(Boolean);
  return parts.some(p => {
    if (/\[style\*="width"\s*i?\]/i.test(p)) {
      return /width\s*:/i.test(el.getAttribute('style') || '');
    }
    if (/\[class\*="icon"\s*i?\]/i.test(p)) return /icon/i.test(el.className);
    if (/^(i|svg|span|em|img)$/i.test(p)) return el.tag.toLowerCase() === p.toLowerCase();
    if (/^\./.test(p)) return (el.className || '').split(/\s+/).indexOf(p.slice(1)) >= 0;
    if (/^#/.test(p)) return el.attrs.id === p.slice(1);
    const m = p.match(/^\.?([\w-]*)\[(\w+)="([^"]+)"\]$/);
    if (m) {
      if (m[1] && (el.className || '').split(/\s+/).indexOf(m[1]) < 0) return false;
      return el.getAttribute(m[2]) === m[3];
    }
    const m2 = p.match(/^\[(\w+)="([^"]+)"\]$/);
    if (m2) return el.getAttribute(m2[1]) === m2[2];
    return false;
  });
}
N.prototype.querySelectorAll = function (s) { return collect(this).filter(el => matchSel(el, s)); };
N.prototype.querySelector = function (s) { return this.querySelectorAll(s)[0] || null; };

// ---------------------------------------------------------------------------
// 构造指定 profile 下的网梯相关判定
// ---------------------------------------------------------------------------
function build(activeProfile, extraFns) {
  const head =
    'var ACTIVE_PROFILE = ' + JSON.stringify(activeProfile) + ';\n' +
    'function profileAllows(id) {\n' +
    '  if (ACTIVE_PROFILE === id) return true;\n' +
    '  if (ACTIVE_PROFILE === "generic") return true;\n' +
    '  return false;\n' +
    '}\n' +
    'function getAllText(el) {\n' +
    '  if (!el) return "";\n' +
    '  return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim();\n' +
    '}\n' +
    'function hasClass(el, re) {\n' +
    '  var cls = (typeof el.className === "string") ? el.className : "";\n' +
    '  return re.test(cls);\n' +
    '}\n';
  const body = extraFns.map(extractFn).join('\n');
  return new Function(head + body + '\nreturn {' + extraFns.join(',') + '};')();
}

const W = build('whaty', ['hasCompletedMarker', 'hasCurrentMarker', 'findWangtiCatalog']);
const J = build('jxnu', ['hasCompletedMarker', 'hasCurrentMarker', 'findWangtiCatalog']);
const G = build('generic', ['hasCompletedMarker', 'hasCurrentMarker', 'findWangtiCatalog']);

console.log('== 网梯黄金用例：标识判定必须永远成立（无论怎么改别的平台）==');

// fixture 1：网梯标准课时节点 —— completestate="1"
const wtDone = new N({
  className: 's_point',
  attrs: { itemtype: 'video', completestate: '1' },
  text: '第一章 绪论'
});
check('网梯：completestate="1" → 已完成', W.hasCompletedMarker(wtDone), 'completestate');

// fixture 2：未完成
const wtUndone = new N({
  className: 's_point',
  attrs: { itemtype: 'video', completestate: '0' },
  text: '第一章 绪论'
});
check('网梯：completestate="0" → 未完成', W.hasCompletedMarker(wtUndone), false);

// fixture 3：当前正在学的节点
const wtCurrent = new N({ className: 's_point s_pointerct', attrs: { itemtype: 'video' }, text: '第二节' });
check('网梯：s_pointerct → 判定为当前项', W.hasCurrentMarker(wtCurrent), true);

// fixture 4：网梯目录容器
const menu = new N({
  attrs: { id: 'learnMenu' },
  children: [new N({ className: 's_point', text: '课时一' }), new N({ className: 's_point', text: '课时二' })]
});
const wtDoc = {
  querySelector: (s) => (/learnMenu/i.test(s) ? menu : null),
  querySelectorAll: () => []
};
menu.children = menu.children_;   // 真实 DOM 用的是 children 属性
check('网梯：命中 #learnMenu 容器', W.findWangtiCatalog(wtDoc) === menu, true);

console.log('\n== 隔离门禁：jxnu profile 下不能采信网梯专属信号 ==');
check('隔离：jxnu 下不采信 completestate', J.hasCompletedMarker(wtDone), false);
check('隔离：jxnu 下不采信 s_pointerct', J.hasCurrentMarker(wtCurrent), false);
check('隔离：jxnu 下不再做网梯目录识别', J.findWangtiCatalog(wtDoc), null);

console.log('\n== jxnu 黄金用例：新平台自身的判定不能走样 ==');
// jxnu 课时：百分比 100%（已完成）
const jxDone = new N({ className: 'course-detail', text: '1-1 课时一\n100.0%' });
check('jxnu：进度 100% → 已完成', J.hasCompletedMarker(jxDone), 'progress');
// 同一个节点在网梯 profile 下不应被百分比判定带偏（netgear 网梯用 completestate）
check('隔离：网梯下不采用百分比完成判定', W.hasCompletedMarker(jxDone), false);
// check-circle 图标判定（jxnu 用 Ant Design）
const jxIcon = new N({
  className: 'course-detail',
  text: '1-2 课时二\n0.0%',
  children: [new N({ tag: 'i', className: 'anticon anticon-check-circle' })]
});
check('jxnu：check-circle 图标 → 已完成', J.hasCompletedMarker(jxIcon), 'icon-check');
check('check-circle 是通用正向信号，网梯下同样成立', W.hasCompletedMarker(jxIcon), 'icon-check');

console.log('\n== 兼容模式：未识别平台保持旧行为（换域名不至于整站失效）==');
check('generic：completestate 仍被采信', G.hasCompletedMarker(wtDone), 'completestate');
check('generic：百分比仍被采信', G.hasCompletedMarker(jxDone), 'progress');

console.log('\n== 冻结标记：防止有人把网梯逻辑改回无隔离状态 ==');
check('PLATFORMS 中网梯标记为 frozen', /id: 'whaty'[\s\S]*?frozen: true/.test(src), true);
check('findWangtiCatalog 带冻结说明与 profile 闸门',
  /【已冻结 v2\.0\.0】[\s\S]*?function findWangtiCatalog[\s\S]*?if \(!profileAllows\('whaty'\)\) return null;/.test(src), true);
check('collectItems 的 .s_point 精准识别受 profile 保护',
  /profileAllows\('whaty'\)\s*\? Array\.from\(container\.querySelectorAll\('\.s_point\[itemtype="video"\]'\)\)/.test(src), true);
check('完成判定 completestate 受 profile 保护',
  /if \(profileAllows\('whaty'\)\) \{\s*\n\s*const completeState/.test(src), true);
check('当前项 s_pointerct 受 profile 保护',
  /if \(profileAllows\('whaty'\) &&\s*\n\s*\/\(s_pointerct\|pointerct\)/.test(src) ||
  /profileAllows\('whaty'\) &&[\s\S]{0,80}s_pointerct/.test(src), true);
check('自定义播放器模块（jxnu 引入）对网梯完全关闭',
  /function findCustomPlayerRoot\(\) \{\s*\n\s*if \(!profileAllows\('jxnu'\)\) return null;/.test(src), true);
check('三个 tick 均尊重前台平台开关',
  (/function customPlayerTick[\s\S]*?!activePlatformAllowed\(\)/.test(src) &&
   /function catalogDrivenTick[\s\S]*?!activePlatformAllowed\(\)/.test(src) &&
   /function ensurePlaying[\s\S]*?!activePlatformAllowed\(\)/.test(src)), true);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) console.log('\n门禁失败：网梯平台行为发生变化，改动不得合入。');
process.exit(fail ? 1 : 0);
