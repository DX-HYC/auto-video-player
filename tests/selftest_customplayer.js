// 静态自检 v1.9.1：自定义播放器（无 <video> 的 canvas / WebAudio 型）接管
// 背景：jxnu zjpt 用百家云 bplayer —— 画面是 <canvas id="bplayer-ffplayer">，
// 声音走 <audio class="bplayer-audio">，页面里一个 <video> 都没有。
// 必须直接从播放器 DOM 读状态（播放位置/总时长/是否在播），才能驱动起播与跳下一集。
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

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' → ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(want) + '）');
  ok ? pass++ : fail++;
}

// ---------- 1. 源码级断言：防止 ReferenceError / 读数陷阱复发 ----------
check('已声明 catalogDriveAnnounced（v1.9.0 遗漏 → 严格模式下目录驱动每 3s 抛异常）',
  /(let|var)\s+catalogDriveAnnounced\s*=/.test(src), true);
check('已定义 currentItemPausedByIcon（v1.9.0 调用但未实现 → 起播级联全部执行不到）',
  /function\s+currentItemPausedByIcon\s*\(/.test(src), true);
check('ensurePlaying 的 playing 判定已只用真实 video（摄像头空壳不再冒充"在播"）',
  /const playing = videos\.some\(v => isRealVideo\(v\)/.test(src), true);
check('catalogDrivenTick 不再被 from:"custom" 的伪装条目挡回',
  /getAggregatedVideos\(\)\.some\(v => v\.from !== 'custom'\)/.test(src), true);
check('getLocalVideoState 已注入自定义播放器伪装状态',
  /const cs = customPlayerAsState\(\);/.test(src), true);
// v1.9.1 现场故障：占位 <audio class="bplayer-audio"> 让播放位置恒为 0
check('占位 media 元素（无 src/readyState 0）不再被采信',
  /usableMedia\s*=/.test(src) && /st\.media = null/.test(src), true);
check('UI 显示播放中时不再按 8s 判定卡住（给足 90s 耐心）',
  /stalled < \(st\.playing \? 90000 : 8000\)/.test(src), true);
check('读不到播放位置且 UI 显示播放中 → 不出手',
  /if \(st\.playing && !st\.trackable\) return;/.test(src), true);
check('复查时发现已在播立即收手（不再把播放中的视频点暂停）',
  /if \(s2\.playing\) \{ customPrev\.at = Date\.now\(\); customBooted = true; return; \}/.test(src), true);

// ---------- v1.9.3：刷新 / 进入视频页 / 跳下一集后的「首次自动起播」 ----------
// 现场：日志显示播放器停在 25:01 / 40:05 且 UI 明确未播放（svg id="play"），
// 但扩展 60 多秒毫无动作 —— 因为当时的起播闸门是
//   if (!settings.autoResume && !early && !justJumped) return;
// 而 autoResume 默认 false、cur=1501s 不满足 early(cur<=15)、也不是刚跳转 → 直接 return。
// 结论：cur=0 时会出手（于是反复点），停在中途却永远不动，"必须人工点一次"由此而来。
const bootSrc = extractFn('customPlayerTick');
// 冷启动块本体（到 4 空格缩进的收尾大括号为止），用于确认它内部没有 autoResume 残留
const bootBlock = (bootSrc.match(/if \(!customBooted\) \{[\s\S]*?\n    \}\n/) || [''])[0];
check('首次起播不再受 autoResume 闸门限制（v1.9.3 修复"停在中途不起播"）',
  /if \(settings\.autoStart === false\) return;/.test(bootBlock) && !/settings\.autoResume/.test(bootBlock), true);
check('冷启动达成条件：UI 显示播放中 或 播放位置推进过',
  /if \(st\.playing \|\| \(customBootBase >= 0 && st\.cur > customBootBase \+ 0\.5\)\) \{[\s\S]*?customBooted = true;[\s\S]*?return;/.test(bootSrc), true);
check('冷启动期间独占出手权（不与保播逻辑重复点击播放器）',
  /执行首次自动起播[\s\S]*?customPlayRecheck\(st\.cur\);[\s\S]*?\n    \}/.test(bootSrc), true);
check('首次起播有尝试窗口与次数上限（不无限骚扰）',
  /CUSTOM_BOOT_WINDOW/.test(src) && /CUSTOM_BOOT_MAX/.test(src) &&
  /customBootTries >= CUSTOM_BOOT_MAX/.test(bootSrc), true);
check('换课时信号①：本扩展发起跳转（lastClickAt 变化）会重置冷启动',
  /const newJump = lastClickAt && lastClickAt !== customJumpSeen;/.test(bootSrc) &&
  /if \(newJump\) \{ customJumpSeen = lastClickAt; customReboot\(now, st\.cur\); return; \}/.test(bootSrc), true);
check('换课时信号②：播放位置大幅倒退会重置冷启动（手工点了别的课时）',
  /const rewound = customBootBase >= 0 && st\.cur < customBootBase - 5;/.test(bootSrc), true);
check('路由变化（SPA 切课时）会重置冷启动窗口',
  /customBooted = false;[\s\S]*?customIgnoreUntil = 0;[\s\S]*?customJumpSeen = 0;/.test(src), true);
check('新增 autoStart 设置且默认开启',
  /autoStart: true,/.test(src) && /autoStart: true/.test(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'popup.js'), 'utf8')), true);
check('版本升级不再强制抹掉用户手动设置的 autoResume',
  /const virgin = !r\.settingsVersion;/.test(src) && !/settingsVersion !== SETTINGS_VERSION/.test(src), true);
// v1.9.1 第二层保险：目录进度（几十秒才涨 0.1%）不得再拿去点击画面/空格
check('自定义播放器可追踪时，目录进度不再触发起播点击',
  /if \(cp && cp\.trackable\)/.test(src), true);
check('播放位置近期推进过 → 目录驱动也判定为"正在播放"',
  /st\.trackable && customPrev\.at && Date\.now\(\) - customPrev\.at < 60000/.test(src), true);

// ---------- 2. 极简 DOM 桩：支持 .class / [class*="x" i] / 标签选择器 ----------
function walk(node, out) {
  (node._k || []).forEach(c => { out.push(c); walk(c, out); });
  return out;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matchesCompound(sel, el) {
  const cls = (typeof el.className === 'string') ? el.className : '';
  const re = /\.([-\w]+)|\[class\*="([^"]+)"\s*i?\]|^([a-zA-Z][\w-]*)$/g;
  let m, any = false, ok = true;
  while ((m = re.exec(sel))) {
    if (m[1]) { any = true; if (!new RegExp('(^|\\s)' + esc(m[1]) + '(\\s|$)').test(cls)) ok = false; }
    else if (m[2]) { any = true; if (cls.toLowerCase().indexOf(m[2].toLowerCase()) < 0) ok = false; }
    else if (m[3]) { any = true; if (String(el.tagName || '').toLowerCase() !== m[3].toLowerCase()) ok = false; }
  }
  return any && ok;
}
function matches(sel, el) {
  return sel.split(',').some(one => {
    const parts = one.trim().split(/\s+/);
    return matchesCompound(parts[parts.length - 1], el);
  });
}

function El(o) {
  Object.assign(this, o || {});
  this._k = o && o._k ? o._k : [];
}
El.prototype.getBoundingClientRect = function () {
  return { width: 1948, height: 1312, left: 0, top: 0, right: 1948, bottom: 1312 };
};
El.prototype.getClientRects = function () { return [1]; };
El.prototype.contains = function () { return false; };
El.prototype.closest = function () { return null; };
El.prototype.getAttribute = function () { return null; };
El.prototype.querySelectorAll = function (s) {
  return walk(this, []).filter(el => matches(s, el));
};
El.prototype.querySelector = function (s) {
  return this.querySelectorAll(s)[0] || null;
};

global.getComputedStyle = function () { return { visibility: 'visible', display: 'block' }; };

const CODE = [
  'let localList = { container: null };',
  'function findCustomPlayerRoot() { return __root; }',
  'var __root = null;',
  extractFn('parseClock'),
  extractFn('readPlayerClock'),
  extractFn('isOwnEl'),
  extractFn('isVisible'),
  extractFn('readCustomPlayer'),
  'return { readCustomPlayer, readPlayerClock, setRoot(r) { __root = r; }, setList(l) { localList = l; } };'
].join('\n');
const M = new Function(CODE)();

// ---------- 3. 纯函数 parseClock ----------
//  recreate 独立的 parseClock 实例
const P = new Function([extractFn('parseClock'), 'return { parseClock };'].join('\n'))();
check('parseClock("31:30")', P.parseClock('31:30'), 1890);
check('parseClock("00:38")', P.parseClock('00:38'), 38);
check('parseClock("1:02:03")', P.parseClock('1:02:03'), 3723);
check('parseClock("00:38/31:30") → -1（拼接文本不算合法时间）', P.parseClock('00:38/31:30'), -1);
check('parseClock("abc")', P.parseClock('abc'), -1);

// ---------- 4. 百家云真实 DOM：外层容器也叫 duration 的陷阱 ----------
// <span class="text duration"><span class="played-time">00:38</span>/<span class="total-time">31:30</span></span>
const playedEl = new El({ tagName: 'SPAN', className: 'played-time', textContent: '00:38' });
const spliter  = new El({ tagName: 'SPAN', className: 'spliter', textContent: '/' });
const totalEl  = new El({ tagName: 'SPAN', className: 'total-time', textContent: '31:30' });
const wrapSpan = new El({ tagName: 'SPAN', className: 'text duration', _k: [playedEl, spliter, totalEl] });

// 占位 audio（无 src / readyState 0）——百家云模板里的摆设元素
const audioEl = new El({ tagName: 'AUDIO', className: 'bplayer-audio', paused: true, ended: false, currentTime: 0, duration: NaN, readyState: 0, src: '', currentSrc: '' });
const canvas  = new El({ tagName: 'CANVAS', id: 'bplayer-ffplayer' });
const playBtn = new El({ tagName: 'SPAN', className: 'icon bplayer-play-btn', innerHTML: '<svg id="stop"></svg>' });
const rootPlaying = new El({ tagName: 'DIV', className: 'bplayer-wrap bplayer-playing', _k: [wrapSpan, canvas, audioEl, playBtn] });

M.setList({ container: null });
M.setRoot(rootPlaying);
let st = M.readCustomPlayer();
check('陷阱样例：读不到 media 占位 → 改用控制条文本 → 位置 38s', st.cur, 38);
check('陷阱样例：总时长 1890s（不再被外层 .duration 容器坑成 0）', st.dur, 1890);
check('陷阱样例：media 占位未被采信 → st.media 为 null', st.media, null);
check('陷阱样例：可追踪播放位置', st.trackable, true);
check('陷阱样例：UI 类 bplayer-playing → 播放中', st.playing, true);
check('陷阱样例：百分比 = 38/1890', Math.round(st.pct * 1000) / 1000, Math.round((38 / 1890) * 100 * 1000) / 1000);

// ---------- 5. 其它形态 ----------
// ⑤ 播完判定：位置已达 总时长 - 1.5s 内
const playedEnd = new El({ tagName: 'SPAN', className: 'played-time', textContent: '31:29' });
const totalEnd  = new El({ tagName: 'SPAN', className: 'total-time', textContent: '31:30' });
const wrapEnd   = new El({ tagName: 'SPAN', className: 'text duration', _k: [playedEnd, totalEnd] });
const rootEnd   = new El({ tagName: 'DIV', className: 'bplayer-wrap', _k: [wrapEnd] });
M.setRoot(rootEnd);
check('播完（31:29 / 31:30）：ended = true', M.readCustomPlayer().ended, true);

// ⑥ 暂停态：类名 bplayer-paused + 按钮渲染播放三角（svg id=play）
const audioReal = new El({ tagName: 'AUDIO', className: 'bplayer-audio', paused: true, ended: false, currentTime: 300, duration: 1890, readyState: 4, currentSrc: 'blob:https://x.cn/abc' });
const btnPlay = new El({ tagName: 'SPAN', className: 'icon bplayer-play-btn', innerHTML: '<svg id="play"></svg>' });
const rootPaused = new El({ tagName: 'DIV', className: 'bplayer-wrap bplayer-paused', _k: [audioReal, btnPlay] });
M.setRoot(rootPaused);
st = M.readCustomPlayer();
check('真实 media 元素（有 currentSrc）：位置 300s', st.cur, 300);
check('UI 类 bplayer-paused → 未播放', st.playing, false);

// ⑦ 没有自定义播放器 → null（网梯等原生 video 平台的常态）
M.setRoot(null);
check('页面无自定义播放器 → null', M.readCustomPlayer(), null);

// ⑧ 目录容器内的元素不得被误认成播放器
const fakeCatalog = new El({ tagName: 'UL' });
fakeCatalog.contains = function () { return true; };
M.setList({ container: fakeCatalog });
check('目录区内的元素被排除', M.readCustomPlayer(), null);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
