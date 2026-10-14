/*!
 * 自动连播助手 (Auto Video Player)
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。保留所有权利。
 * 本文件为项目自检用例，MIT 授权，详见 LICENSE。禁止删除作者署名。
 * -----------------------------------------------------------------------------
 *
 * 行为级仿真：直接驱动 content.js 里的 customPlayerTick()，验证 v1.9.3 的
 * 「刷新 / 进入视频页 / 跳下一集后自动起播」真的会发生，而不是只写对了源码文本。
 *
 * 复现的用户现场（日志 15:59:56 - 16:01:02）：
 *   自定义播放器: bplayer-wrap (25:01/40:05 未播)   ← UI 明确处于暂停态
 *   60 多秒内扩展毫无动作                            ← 缺一次起播
 * 原因：起播闸门 `if (!settings.autoResume && !early && !justJumped) return;`
 *       其中 autoResume 默认 false、cur=1501s 不满足 early(cur<=15)、也没刚跳转 → 直接 return。
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

// 取出「自定义播放器心跳」整段（含冷启动状态机与 tick 本体），保证测试跑的是真实代码
const START = src.indexOf('  // 自定义播放器心跳');
const END = src.indexOf('  // 启动播放');
if (START < 0 || END < 0) { console.log('FAIL - 未能定位 customPlayerTick 源码块'); process.exit(1); }
const HEART = src.slice(START, END);

const CODE = [
  'var __st = null, __plays = 0, __rechecks = 0, __jumps = 0;',
  'var settings = { enabled: true, autoStart: true, autoNext: true, autoResume: false };',
  'var lastClickAt = 0;',
  'var localList = { current: null };',
  'var customTry = { idx: 0, lastAt: 0 };',
  'function readCustomPlayer() { return __st; }',
  'function customPlayerPlay() { __plays++; return true; }',
  'function log() {}',
  'function fmtTime(s) {',
  '  s = Math.max(0, Math.floor(s || 0));',
  '  var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;',
  '  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(x).padStart(2, "0");',
  '}',
  'function dispatchNext() { __jumps++; }',
  'function markLocalDone() {}',
  // 平台闸门桩：默认放行（测试聚焦起播时序本身，平台隔离另有 selftest_whaty_frozen.js 覆盖）
  'function activePlatformAllowed() { return true; }',
  'function profileAllows() { return true; }',
  HEART,
  // 覆盖真实的复查函数：它依赖 setTimeout，这里只记录"有没有被安排"，避免异步干扰
  'function customPlayRecheck(base) { __rechecks++; }',
  'return {',
  '  tick: customPlayerTick,',
  '  set(s) { __st = s; },',
  '  setSetting(k, v) { settings[k] = v; },',
  '  setJump(t) { lastClickAt = t; },',
  '  plays() { return __plays; }, rechecks() { return __rechecks; }, jumps() { return __jumps; },',
  '  reset() { __plays = 0; __rechecks = 0; __jumps = 0; },',
  '  booted() { return customBooted; }, tries() { return customBootTries; }',
  '};'
].join('\n');

const M = new Function(CODE)();

// 虚拟时钟：让 tick 的时间线完全可控
let t = 1700000000000;
const realNow = Date.now;
Date.now = () => t;
function step(ms) { t += ms; }

// 用户现场：停在 25:01 / 40:05，UI 明确未播放，autoResume 关闭
function pausedState(cur, dur, playing, label) {
  return {
    root: {}, label: label || 'bplayer-wrap', media: null,
    cur: cur, dur: dur, paused: !playing, ended: false,
    pct: (cur / dur) * 100, trackable: true, playing: !!playing
  };
}

// 开一个新会话：改变播放器容器的类名，让 tick 认定"换了一个播放器实例"，
// 等价于用户刷新页面或平台重建了播放器。
let sessionLabel = '';
function newSession(cur, dur, playing) {
  sessionLabel = 'bplayer-wrap s' + Math.random().toString(36).slice(2, 6);
  M.set(pausedState(cur, dur, playing, sessionLabel));
  M.tick();          // 接管 tick：只重置基准，不出手
  M.reset();         // 清零计数，从干净状态开始断言
}

console.log('== 场景 1：刷新后停在 25:01，UI 显示暂停（用户现场）==');
M.set(pausedState(1501, 2405, false));
M.tick();                      // 首次 tick：接管，重置判停基准
check('接管瞬间不立刻点（先给播放器挂载时间）', M.plays(), 0);
step(3000);
M.tick();                      // 3s 后：停滞达到首次阈值 2.5s
check('刷新后约 3 秒内完成首次自动起播', M.plays(), 1);
check('起播后安排了复查（确认是否真的播起来）', M.rechecks(), 1);

console.log('\n== 场景 2：正常播放中不得去点（点了会变成暂停）==');
M.reset();
M.set(pausedState(1520, 2405, true, sessionLabel));   // 播放中
step(3000);
M.tick();
check('播放中不会触发任何点击', M.plays(), 0);
check('冷启动窗口因观察到播放而关闭', M.booted(), true);

console.log('\n== 场景 2b：起播成功后用户手动暂停，不得再打扰 ==');
M.reset();
M.set(pausedState(1520, 2405, false, sessionLabel));  // 用户手动暂停（autoResume 仍为 false）
step(120000);
M.tick();
check('冷启动已结束后，未开自动续播时不抢起播', M.plays(), 0);

console.log('\n== 场景 3：跳到下一集后（lastClickAt 变化）重新获得起播机会 ==');
newSession(1501, 2405, true);          // 新会话，先正常播起来（冷启动已关闭）
M.setJump(t);                          // 本扩展发起跳转
M.set(pausedState(0, 2405, false, sessionLabel));   // 新课时：位置回到 0
M.tick();
check('检测到本扩展发起的跳转，重置冷启动窗口', M.booted(), false);
step(3000);
M.tick();
check('跳到下一集后自动起播（此前的核心痛点）', M.plays(), 1);

console.log('\n== 场景 4：用户手工切换到别的课时（播放位置大幅倒退）==');
newSession(900, 2405, true);                         // 正在正常播放
M.reset();
M.set(pausedState(10, 2405, false, sessionLabel));   // 手工切课：位置从 900 倒退到 10
M.tick();                                            // 本轮识别到换课时并重置，不出手
check('检测到换课时重置冷启动窗口', M.booted(), false);
step(6000);          // 需越过与上一次出手之间的 5s 节流
M.tick();
check('换课后自动起播', M.plays(), 1);

console.log('\n== 场景 5：关闭「进入页面自动起播」开关后必须完全停手 ==');
M.setSetting('autoStart', false);
newSession(600, 2405, false);
step(60000); M.tick(); step(60000); M.tick();
check('开关关闭时不再自动起播', M.plays(), 0);

console.log('\n== 场景 6：起播尝试有次数上限，不会无限骚扰 ==');
M.setSetting('autoStart', true);
newSession(300, 2405, false);
step(3000);
for (let i = 0; i < 40; i++) { M.tick(); step(8000); }
check('尝试轮次被限制在上限内（<=6）', M.tries() <= 6, true);
check('点击次数等于尝试轮次（不重复出手）', M.plays(), M.tries());

console.log('\n== 场景 7：播完应触发下一集，且不被冷启动逻辑抢走 ==');
newSession(2404, 2405, false);
step(3000);
M.tick();
check('播完触发自动下一集', M.jumps(), 1);

Date.now = realNow;
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
