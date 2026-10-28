// 静态自检 v2.1.2：全栈体检修复的回归
// 覆盖两类真行为测试 + 源码断言：
//   A. readCustomPlayer 行为测试（DOM 桩）—— 复现并锁死"pick 未定义"bug：
//      "时长读不到"分支一进去就抛 ReferenceError 被 try 静默吞掉，playing 判定与
//      进度条兜底整段丢失。现有用例都走 dur>0 分支，从未覆盖到这条路径。
//   B. background.js 行为测试（chrome API 桩）—— 标签页注册竞态（并发丢更新）、
//      Shadow 桥升级后不刷新 matches、sendMessage 回调/Promise 双形态兼容。
//   C. 其余修复的源码断言（SPA 监听防重入、video/目录缓存、空壳统计等）。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' → ' + JSON.stringify(got) + '（期望 ' + JSON.stringify(want) + '）');
  ok ? pass++ : fail++;
}
function checkTrue(name, cond) { check(name, !!cond, true); }

function extractFn(s, name) {
  const start = s.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let i = s.indexOf('{', start), depth = 0, end = -1;
  for (; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return s.slice(start, end);
}

// ==========================================================================
// A. readCustomPlayer 行为测试（极简 DOM 桩，支持 .class / [class*="x" i] / 标签）
// ==========================================================================
function walk(node, out) {
  (node._k || []).forEach(c => { out.push(c); walk(c, out); });
  return out;
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function matchesCompound(sel, el) {
  const cls = (typeof el.className === 'string' ? el.className : '');
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
    // 兼容 [class*="x" i] 的 i 标志：先规范化再去按空格切分
    const norm = one.trim().replace(/\s+i\]$/, ']');
    const parts = norm.split(/\s+/);
    return matchesCompound(parts[parts.length - 1], el);
  });
}
function El(o) {
  Object.assign(this, o || {});
  this._k = (o && o._k) ? o._k : [];
  if (!this.style) this.style = {};
}
El.prototype.getBoundingClientRect = function () {
  return { width: 1948, height: 1312, left: 0, top: 0, right: 1948, bottom: 1312 };
};
El.prototype.getClientRects = function () { return [1]; };
El.prototype.contains = function () { return false; };
El.prototype.closest = function () { return null; };
El.prototype.getAttribute = function () { return null; };
El.prototype.querySelectorAll = function (s) { return walk(this, []).filter(el => matches(s, el)); };
El.prototype.querySelector = function (s) { return this.querySelectorAll(s)[0] || null; };
global.getComputedStyle = function () { return { visibility: 'visible', display: 'block' }; };

const M = new Function([
  'let localList = { container: null };',
  'var __root = null;',
  'function findCustomPlayerRoot() { return __root; }',
  extractFn(src, 'parseClock'),
  extractFn(src, 'readPlayerClock'),
  extractFn(src, 'isVisible'),
  extractFn(src, 'readCustomPlayer'),
  'return { readCustomPlayer, setRoot(r) { __root = r; } };'
].join('\n'))();

console.log('== A. readCustomPlayer：「时长读不到」分支（v2.1.2 pick bug 修复） ==');
{
  // 场景 1：进度条 + 停止图标（在播），读不到任何时间文本 → dur=0 → else 分支
  const progressBar = new El({ tagName: 'DIV', className: 'progress-played', style: { width: '42%' } });
  const stopBtn = new El({ tagName: 'SPAN', className: 'bplayer-play-btn', innerHTML: '<svg id="stop"></svg>' });
  M.setRoot(new El({ tagName: 'DIV', className: 'bplayer-wrap', _k: [progressBar, stopBtn] }));
  const st = M.readCustomPlayer();
  check('场景1·playing 来自按钮图标（pick 正常工作）', st.playing, true);
  check('场景1·pct 来自进度条宽度（pick 正常工作）', st.pct, 42);
  check('场景1·时長读不到 → dur 0', st.dur, 0);
  check('场景1·trackable=false（读不到播放位置）', st.trackable, false);
  check('场景1·未误判播完', st.ended, false);
}
{
  // 场景 2：时间成对文本 "31:29 / 31:30"（总时长选择器抓不到）→ 应判定已播完
  const playedB = new El({ tagName: 'SPAN', className: 'played-time', textContent: '31:29' });
  const durB = new El({ tagName: 'SPAN', className: 'duration', textContent: '31:30' });
  M.setRoot(new El({ tagName: 'DIV', className: 'bplayer-wrap', _k: [playedB, durB] }));
  const st = M.readCustomPlayer();
  check('场景2·成对时间文本 → ended（pick 正常工作）', st.ended, true);
  check('场景2·cur=1889（31:29）', st.cur, 1889);
  check('场景2·无按钮 → playing=false', st.playing, false);
}
{
  // 场景 3：播放图标（暂停态）→ playing=false
  const playBtn = new El({ tagName: 'SPAN', className: 'bplayer-play-btn', innerHTML: '<svg id="play"></svg>' });
  M.setRoot(new El({ tagName: 'DIV', className: 'bplayer-wrap', _k: [playBtn] }));
  const st = M.readCustomPlayer();
  check('场景3·播放图标 → playing=false', st.playing, false);
}
checkTrue('源码·readCustomPlayer 内已定义 pick（v2.1.2 修复未定义调用）',
  /const pick = \(sel\)/.test(extractFn(src, 'readCustomPlayer')));

// ==========================================================================
// B. background.js 行为测试（chrome API 桩）
// ==========================================================================
async function runBackgroundTests() {
  console.log('\n== B. background：标签页注册竞态 / 桥注册刷新 / 消息兼容 ==');
  const sessionData = { apTabs: [{ id: 1, ts: 1 }] }; // 预置：模拟 SW 重启后 session 里的旧表
  let registeredScripts = [];
  let regCount = 0, updCount = 0, unregCount = 0, execCount = 0;
  let msgListener = null, alarmListener = null;
  const installedListeners = [];
  const sentMessages = [];
  const failIds = new Set(); // 这些标签页的 sendMessage 走失败路径

  global.chrome = {
    runtime: {
      id: 'test-ext',
      lastError: null,
      getManifest: () => ({ content_scripts: [{ matches: ['*://*.jxnu.edu.cn/*'] }] }),
      onInstalled: { addListener: (f) => { installedListeners.push(f); } },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: (f) => { msgListener = f; } },
      sendMessage: () => {}
    },
    scripting: {
      getRegisteredContentScripts: (cb) => cb(registeredScripts),
      registerContentScripts: (arr, cb) => { regCount++; registeredScripts = arr.slice(); if (cb) cb(); },
      updateContentScripts: (arr, cb) => { updCount++; if (cb) cb(); },
      unregisterContentScripts: (o, cb) => { unregCount++; if (cb) cb(); },
      executeScript: (o, cb) => { execCount++; if (cb) cb(); }
    },
    alarms: {
      get: (n, cb) => cb(null),
      create: () => {},
      onAlarm: { addListener: (f) => { alarmListener = f; } }
    },
    storage: {
      session: {
        get: (key, cb) => setImmediate(() => cb(key in sessionData ? { [key]: sessionData[key] } : {})),
        set: (obj, cb) => { Object.assign(sessionData, obj); if (cb) cb(); }
      }
    },
    tabs: {
      sendMessage: (tabId, msg, cb) => {
        sentMessages.push({ tabId, msg });
        if (failIds.has(tabId)) {
          global.chrome.runtime.lastError = { message: 'no receiving end' };
          if (cb) cb();
          return { catch: (fn) => { fn(); return undefined; } };
        }
        global.chrome.runtime.lastError = null;
        if (cb) cb();
        return undefined;
      }
    }
  };

  // 加载 background.js（顶层代码随即执行：注册桥 + 装监听器）
  require(path.join(__dirname, '..', 'background.js'));
  const tick = () => new Promise(r => setImmediate(r));
  const fireInstalled = () => { installedListeners.forEach(f => { try { f(); } catch (e) {} }); };

  // --- B0. 真竞态：loadTabsOnce 尚未 resolve 时并发注册 2 和 3，两个都不许丢 ---
  // （旧实现是"异步读 → 改 → 写回"，并发时后写覆盖先写，被丢的标签页再也收不到看门狗）
  msgListener({ type: 'apRegister' }, { tab: { id: 2 } }, () => {});
  msgListener({ type: 'apRegister' }, { tab: { id: 3 } }, () => {});
  await tick();
  await tick();
  check('B0·SW 重启后并发注册不丢更新（旧表1 + 新注册2,3 全部在册）',
    JSON.stringify((sessionData.apTabs || []).map(x => x.id).sort()), JSON.stringify([1, 2, 3]));

  // --- B1. 桥注册：首次无注册 → registerContentScripts ---
  check('B1·首次启动注册桥（MAIN world）', regCount, 1);
  check('B1·注册参数含 world:MAIN 与 document_start',
    JSON.stringify(registeredScripts[0]).indexOf('"world":"MAIN"') >= 0 &&
    JSON.stringify(registeredScripts[0]).indexOf('"runAt":"document_start"') >= 0, true);

  // --- B2. 已注册且 matches 一致 → 不重复注册/更新（防每启动都重注册） ---
  const before = { regCount, updCount, unregCount };
  fireInstalled();
  await tick();
  check('B2·matches 一致时不重复注册', regCount - before.regCount, 0);
  check('B2·matches 一致时不调用 update', updCount - before.updCount, 0);

  // --- B3. 已注册但 matches 过期（升级后新增域名）→ updateContentScripts ---
  registeredScripts = [{ id: 'ap-shadow-bridge-main', matches: ['*://*.old-domain.com/*'] }];
  fireInstalled();
  await tick();
  check('B3·matches 过期 → 调用 updateContentScripts（v2.1.2 修复升级不刷新）',
    updCount - before.updCount, 1);

  // --- B4. 老内核无 updateContentScripts → 注销后重注册 ---
  const origUpdate = global.chrome.scripting.updateContentScripts;
  delete global.chrome.scripting.updateContentScripts;
  registeredScripts = [{ id: 'ap-shadow-bridge-main', matches: ['*://*.old-domain.com/*'] }];
  const b4 = { regCount, updCount, unregCount };
  fireInstalled();
  await tick();
  check('B4·老内核：先注销再重注册', unregCount - b4.unregCount, 1);
  check('B4·老内核：重注册被执行', regCount - b4.regCount, 1);
  global.chrome.scripting.updateContentScripts = origUpdate;

  // --- B5. 注销 ---
  msgListener({ type: 'apUnregister' }, { tab: { id: 2 } }, () => {});
  await tick();
  check('B5·注销后剩 1 和 3',
    JSON.stringify((sessionData.apTabs || []).map(x => x.id).sort()), JSON.stringify([1, 3]));

  // --- B6. 看门狗闹钟：向在册标签页发消息 ---
  sentMessages.length = 0;
  alarmListener({ name: 'apWatchdog' });
  await tick();
  check('B6·闹钟触发向全部在册标签页发 apWatchdog', sentMessages.length, 2);
  check('B6·消息类型正确', sentMessages.every(m => m.msg && m.msg.type === 'apWatchdog'), true);

  // --- B7. 发送失败（callback lastError）→ 仅该标签页被移出名单 ---
  failIds.add(1);
  alarmListener({ name: 'apWatchdog' });
  await tick();
  check('B7·发送失败的标签页被移除（callback 形态），其它不受影响',
    JSON.stringify((sessionData.apTabs || []).map(x => x.id)), JSON.stringify([3]));
  failIds.clear();

  // --- B8. 发送失败（Promise reject）→ 同样被移出 ---
  msgListener({ type: 'apRegister' }, { tab: { id: 9 } }, () => {});
  await tick();
  failIds.add(9);
  alarmListener({ name: 'apWatchdog' });
  await tick();
  check('B8·发送失败的标签页被移除（Promise 形态）',
    (sessionData.apTabs || []).some(x => x.id === 9), false);
  failIds.clear();

  // --- B9. apInjectShadowBridge：经 background 注入主世界 ---
  let resp = null;
  const r = msgListener({ type: 'apInjectShadowBridge' }, { tab: { id: 5 } }, (x) => { resp = x; });
  check('B9·executeScript 注入 shadow_bridge.js', execCount, 1);
  check('B9·返回 ok', resp && resp.ok, true);
  check('B9·监听器返回 true（异步 sendResponse）', r, true);
}

// ==========================================================================
// C. 其余修复的源码断言
// ==========================================================================
function runSourceAssertions() {
  console.log('\n== C. 源码断言：SPA 防重入 / 缓存 / 统计修复 ==');
  const spaSrc = extractFn(src, 'watchSpaRoute');
  checkTrue('C1·watchSpaRoute 有防重入标志（standby→wake 后不叠加监听器）',
    /let spaListenersInstalled = false;/.test(src) && /if \(!spaListenersInstalled\)/.test(spaSrc));
  checkTrue('C2·history 包装有防重复标记', /orig\.__apWrapped/.test(spaSrc) && /wrapped\.__apWrapped = true;/.test(spaSrc));
  checkTrue('C3·SPA 轮询 interval 纳入 tickTimers（待命可清、唤醒可重建）',
    /spaPollTimer = setInterval\(onChange, 1500\);[\s\S]*?tickTimers\.push\(spaPollTimer\);/.test(spaSrc));
  checkTrue('C4·enterStandby 清 SPA 轮询与起播复查定时器',
    /if \(spaPollTimer\) \{[\s\S]*?clearInterval\(spaPollTimer\)/.test(src) &&
    /customRecheckTimers\.forEach/.test(src));
  checkTrue('C5·startFull 唤醒后断开待命观察器（不与主观察器重复触发）',
    /if \(probeMo\) \{ try \{ probeMo\.disconnect\(\); \} catch \(e\) \{\} probeMo = null; \}/.test(src));
  checkTrue('C6·video 清单缓存：scanVideos 全量刷新 + 读取路径走 TTL 缓存',
    /videoListCache = videos;/.test(src) && /function cachedVideoList\(\)/.test(src) &&
    /videoListCacheAt < 1500/.test(src));
  checkTrue('C7·目录容器缓存 1.2s TTL + document.contains 校验',
    /catalogContainerCache = \{ el: null, ts: 0 \};/.test(src) &&
    /catalogContainerCache\.ts < 1200/.test(src) &&
    /document\.contains\(catalogContainerCache\.el\)/.test(src));
  checkTrue('C8·空壳统计改用 isRealVideoObj 过滤（不再用去重数相减虚报）',
    /getAggregatedVideos\(true\)\.filter\(v => !isRealVideoObj\(v\)\)\.length/.test(src) &&
    !/getAggregatedVideos\(true\)\.length - videoCount/.test(src));
  checkTrue('C9·ping 向孙辈 iframe 转发',
    /if \(d\.broadcastDown\) \{ try \{ broadcastDown\(\{ type: .ping. \}\); \} catch \(e\) \{\} \}/.test(src));
  checkTrue('C10·起播复查定时器先作废旧句柄再重排（防定时器堆积）',
    /customRecheckTimers\.forEach\(t => \{ try \{ clearTimeout\(t\); \} catch \(e\) \{\} \}\);[\s\S]*?customRecheckTimers = \[\];[\s\S]*?\[3000, 8000, 16000\]/.test(src));
  checkTrue('C11·Shadow 起播条件对齐 autoStart（不再绕过开关直接起播）',
    /settings\.autoResume \|\| \(settings\.autoStart !== false && \(v\.t \|\| 0\) < 15\)/.test(src));
  checkTrue('C12·updateUI 对面板控件逐个空值保护',
    /const resumeChk = panel\.querySelector\('#ap-resume'\); if \(resumeChk\)/.test(src));
  checkTrue('C13·倍速值不在选项内时动态补选项（面板）',
    /Array\.prototype\.some\.call\(sv\.options/.test(src));
  checkTrue('C14·pressSpaceOnPlayer 死代码已清理',
    !/const target = clickVideoScreen \? document\.body : document\.body;/.test(src));
  checkTrue('C18·video 清单缓存用 isConnected 过滤（document.contains 会误滤同源 iframe 里的 video）',
    /videoListCache\.filter\(v => \{ try \{ return v\.isConnected !== false;/.test(src));
  // background 源码断言
  checkTrue('C15·background：标签页表以内存为单一事实源（loadTabsOnce 去重恢复）',
    /function loadTabsOnce\(\)/.test(bgSrc) && /let tabsLoadPromise = null;/.test(bgSrc));
  checkTrue('C16·background：桥注册前比对 matches，过期则更新',
    /keyOf\(existing\.matches \|\| \[\]\) === keyOf\(matches\)/.test(bgSrc) &&
    /chrome\.scripting\.updateContentScripts/.test(bgSrc));
  checkTrue('C17·background：sendMessage 同时兼容 callback 与 Promise 两种形态',
    /const maybePromise = chrome\.tabs\.sendMessage/.test(bgSrc) &&
    /maybePromise\.catch/.test(bgSrc));
}

(async () => {
  await runBackgroundTests();
  runSourceAssertions();
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
