/*!
 * 自动连播助手 (Auto Video Player)
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。保留所有权利。
 *
 * 本文件为「自动连播助手」项目的组成部分，受《中华人民共和国著作权法》及
 * 国际著作权条约保护，作品自创作完成之日起自动享有著作权。
 *
 * 开源授权：本项目以 MIT 许可证开源，完整条款见 LICENSE 文件。
 *           依据 MIT 条款，任何副本或实质性部分均须保留本版权声明。
 *
 * 署名保护：不得删除、篡改、隐匿或伪造本版权头及作者署名；
 *           未经权利人书面许可，任何人不得宣称自己为本作品的原始作者，
 *           亦不得以作者名义进行宣传、推广或背书。
 *
 * 修改标注：修改本文件并再行分发时，须显著标注「已修改」及修改日期。
 *
 * 免责声明：本作品按「现状」（AS IS）提供，不提供任何明示或默示担保。
 *
 * Copyright (c) 2026 胡昱晨 (hu_yu_chen). All rights reserved.
 * Licensed under the MIT License - see the LICENSE file for full terms.
 * This copyright notice must be retained in all copies or substantial portions.
 * -----------------------------------------------------------------------------
 */
// 后台看门狗：浏览器窗口最小化/切到后台标签页时，Chrome 会对页面定时器实施节流
// （隐藏超过一定时间后 setInterval 被压缩到每分钟甚至更久），导致内容脚本里的目录扫描、
// 状态上报与"下一集"调度全部停摆。
//
// chrome.alarms 不受标签页节流影响：闹钟到点会唤醒本 Service Worker，
// 再由它向已注册的标签页发消息（消息投递会立即执行页面的 JS，同样不受节流限制），
// 从而让内容脚本在后台仍能定期检查并补跳下一集。

// ==========================================================================
// 在线授权总线（v2.2.0 · 接入 auth.dixunblog.cn V2 授权系统）
// --------------------------------------------------------------------------
// 所有网络请求集中在 Service Worker：content script 运行在 https 学习页面上，
// 直接 fetch http 授权接口会被混合内容策略拦截；由 SW 发起则不受影响。
// 状态单点存放在 chrome.storage.local，content / popup 只查询与订阅广播。
// ==========================================================================
let APOnlineClient = null;
try {
  if (typeof importScripts === 'function') {
    importScripts('license.js', 'auth-online.js');
    APOnlineClient = (typeof APOnline !== 'undefined' && APOnline) ? APOnline : null;
  } else if (typeof require === 'function') {
    // Node 自检环境：同一份模块直接 require，保证测试与运行是同一套算法
    APOnlineClient = require('./auth-online.js');
  }
} catch (e) { APOnlineClient = null; }

const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreating = null;
let lastAuthSnapshot = '';

function authSnapshot(state) {
  if (!state) return '';
  return [state.ok, state.mode, state.reason, state.msg, state.expireAt, state.source].join('|');
}

function broadcastAuth(state) {
  if (!state) return false;
  const snap = authSnapshot(state);
  if (snap === lastAuthSnapshot) return false;   // 5 秒一次心跳不产生消息风暴
  lastAuthSnapshot = snap;
  try {
    chrome.runtime.sendMessage({ type: 'apAuthChanged', state }, () => { void chrome.runtime.lastError; });
  } catch (e) {}
  return true;
}

// 幂等创建离屏文档：Chrome 116+ 用 getContexts 精确判断；老内核直接创建，
// "已存在"错误忽略即可。creating 承诺防止两个事件同时创建（只能存在一个）。
function ensureOffscreen() {
  return (async () => {
    try {
      if (!chrome.offscreen || !chrome.offscreen.createDocument) return;
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
        });
        if (contexts && contexts.length) return;
      }
      if (offscreenCreating) return offscreenCreating;
      offscreenCreating = Promise.resolve(chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['WORKERS'],
        justification: '用 Web Worker 承载授权服务端要求的 5 秒心跳定时器'
      })).catch(() => {}).finally(() => { offscreenCreating = null; });
      return offscreenCreating;
    } catch (e) { return null; }
  })();
}

// 在线会话结束（切回纯离线码 / 清除授权）后关闭离屏文档，停止 5 秒敲门。
// 老授权用户不该为了一套用不上的在线心跳常驻隐藏页面。
async function stopOffscreen() {
  try {
    if (!chrome.offscreen || !chrome.offscreen.closeDocument) return;
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
      });
      if (!contexts || !contexts.length) return;
    }
    await chrome.offscreen.closeDocument();
  } catch (e) {}
}

let heartbeatInFlight = null;
function onHeartbeatTick() {
  if (!APOnlineClient || heartbeatInFlight) return heartbeatInFlight;
  heartbeatInFlight = (async () => {
    try {
      // 纯离线码用户（v2.1.x 老授权）没有在线令牌：不发请求、不查状态，
      // 直接收手并关掉离屏文档，避免每 5 秒无谓唤醒 Service Worker。
      const s0 = await APOnlineClient.loadState();
      if (!s0 || !s0.token) { await stopOffscreen(); return; }
      const r = await APOnlineClient.heartbeat();
      const state = (r && r.state) || await APOnlineClient.getStatus();
      broadcastAuth(state);
      if (state && state.source === 'online') ensureOffscreen();
    } catch (e) {}
    finally { heartbeatInFlight = null; }
  })();
  return heartbeatInFlight;
}

// 页面/弹窗启动时的会话恢复：令牌过期自动 refresh 并补一次心跳。
// 多个 iframe 同时查询时去重 + 10 秒节流，避免重复刷新令牌。
let sessionEnsureAt = 0;
let sessionPromise = null;
function ensureSessionThrottled(force) {
  if (!APOnlineClient) return Promise.resolve(null);
  const now = Date.now();
  if (sessionPromise) return sessionPromise;
  if (!force && now - sessionEnsureAt < 10000) return Promise.resolve(null);
  sessionEnsureAt = now;
  sessionPromise = Promise.resolve(APOnlineClient.ensureSession())
    .then((r) => { if (r && r.state) broadcastAuth(r.state); return r; })
    .catch(() => null)
    .finally(() => { sessionPromise = null; });
  return sessionPromise;
}

// SW 里在线模块加载失败时的降级：仍允许作者签发的应急离线码工作
function localOfflineState() {
  return new Promise((resolve) => {
    let raw = '';
    try {
      chrome.storage.sync.get({ licenseKey: '' }, (r) => {
        raw = (r && r.licenseKey) || '';
        finish();
      });
    } catch (e) { finish(); }
    function finish() {
      const L = (typeof APLicense !== 'undefined' && APLicense) ? APLicense : null;
      const st = (raw && L && L.verifyLicense)
        ? L.verifyLicense(raw, '', Date.now()) : { ok: false, msg: '未授权：请输入授权码', reason: 'missing' };
      resolve({
        ok: !!st.ok, mode: st.ok ? 'offline' : 'none', source: st.ok ? 'offline' : 'none',
        reason: st.reason || 'missing', msg: st.msg, appKeyConfigured: false,
        expireAt: 0, remainDays: 0, lastOkAt: 0, deviceId: '', cloud: null,
        offlineAvailable: !!st.ok
      });
    }
  });
}

async function currentAuthState() {
  try { return APOnlineClient ? await APOnlineClient.getStatus() : await localOfflineState(); }
  catch (e) { return localOfflineState(); }
}

const TABS_KEY = 'apTabs';
const ALARM_NAME = 'apWatchdog';
const MAX_TABS = 30;

// ---------- Shadow DOM 桥的原生注册 ----------
// 必须抢在页面脚本之前把桥注入 MAIN world：播放器库若先创建了 closed shadowRoot，
// attachShadow 钩子就永远截获不到引用。chrome.scripting.registerContentScripts 支持
// world:'MAIN' + runAt:'document_start'，由浏览器原生注入 —— 零竞态、不受页面 CSP
// 限制，比 <script src> / executeScript 动态注入都可靠（Chrome 111+，Edge 同步支持）。
//
// v2.1.2 修复：此前 onInstalled 时若发现桥已注册就直接返回，不比较 matches ——
// 扩展升级后若 manifest 的域名清单变了（新增平台），已注册的桥不会更新，
// 新域名上永远注入不了 MAIN world 桥。现在逐项比对，不一致就更新。
const BRIDGE_SCRIPT_ID = 'ap-shadow-bridge-main';
function registerShadowBridge() {
  try {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const matches = (chrome.runtime.getManifest().content_scripts || [])
      .flatMap(cs => cs.matches || []);
    if (!matches.length) return;
    const keyOf = (list) => JSON.stringify([...list].sort());
    chrome.scripting.getRegisteredContentScripts((scripts) => {
      const existing = (scripts || []).find(s => s.id === BRIDGE_SCRIPT_ID) || null;
      // 已注册且 matches 一致：无需动作
      if (existing && keyOf(existing.matches || []) === keyOf(matches)) return;
      const doRegister = () => {
        chrome.scripting.registerContentScripts([{
          id: BRIDGE_SCRIPT_ID,
          js: ['shadow_bridge.js'],
          matches: matches,
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: true,
          persistAcrossSessions: true
        }], () => { void chrome.runtime.lastError; });
      };
      if (!existing) { doRegister(); return; }
      // 已注册但 matches 过期：优先原地更新，老内核没有 updateContentScripts 则
      // 走"注销 → 重注册"
      if (chrome.scripting.updateContentScripts) {
        chrome.scripting.updateContentScripts([{
          id: BRIDGE_SCRIPT_ID,
          matches: matches
        }], () => {
          if (chrome.runtime.lastError) {
            chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] }, () => doRegister());
          }
        });
      } else {
        chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] }, () => doRegister());
      }
    });
  } catch (e) {}
}
registerShadowBridge();
chrome.runtime.onInstalled.addListener(registerShadowBridge);
chrome.runtime.onStartup.addListener(registerShadowBridge);

function ensureAlarm() {
  try {
    chrome.alarms.get(ALARM_NAME, (existing) => {
      if (!existing) {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
      }
    });
  } catch (e) {}
}

// 部分旧版本 Chrome 没有 chrome.storage.session，这里统一降级到内存缓存。
// v2.1.2 修复：此前 addTab/removeTab 是"异步读 storage → 改 → 写回"的
// 读-改-写模式，两个标签页几乎同时注册时后写会覆盖先写（丢更新），
// 被丢掉的标签页再也收不到看门狗唤醒。现在 memTabs 是唯一事实源：
// 改动同步作用于内存数组再落盘，SW 重启后首次使用前从 session storage 恢复一次
// （loadTabsOnce 用单 Promise 去重，恢复期间的并发改动排队在其后，不会丢）。
const memTabs = [];
let tabsLoaded = false;
let tabsLoadPromise = null;

function loadTabsOnce() {
  if (tabsLoaded) return Promise.resolve();
  if (tabsLoadPromise) return tabsLoadPromise;
  tabsLoadPromise = new Promise((resolve) => {
    try {
      if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.get(TABS_KEY, (r) => {
          const v = chrome.runtime.lastError ? null : (r && r[TABS_KEY]);
          if (Array.isArray(v)) {
            memTabs.length = 0;
            v.forEach(x => { if (x && x.id != null) memTabs.push(x); });
          }
          tabsLoaded = true;
          resolve();
        });
        return;
      }
    } catch (e) {}
    tabsLoaded = true;
    resolve();
  });
  return tabsLoadPromise;
}

function persistTabs() {
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ [TABS_KEY]: memTabs.slice(-MAX_TABS) });
    }
  } catch (e) {}
}

function readTabs(cb) {
  loadTabsOnce().then(() => cb(memTabs.slice()));
}

function addTab(tabId) {
  if (tabId == null) return;
  loadTabsOnce().then(() => {
    const filtered = memTabs.filter(x => x && x.id !== tabId);
    filtered.push({ id: tabId, ts: Date.now() });
    memTabs.length = 0;
    filtered.slice(-MAX_TABS).forEach(x => memTabs.push(x));
    persistTabs();
  });
}

function removeTab(tabId) {
  if (tabId == null) return;
  loadTabsOnce().then(() => {
    const filtered = memTabs.filter(x => x && x.id !== tabId);
    memTabs.length = 0;
    filtered.forEach(x => memTabs.push(x));
    persistTabs();
  });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());

// 内容脚本注册/注销，以及看门狗唤醒后的 ping 应答
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // ---------- 在线授权通道 ----------
  if (msg.type === 'apAuthState') {
    (async () => {
      try { await ensureSessionThrottled(false); } catch (e) {}
      const state = await currentAuthState();
      try { sendResponse({ ok: true, state }); } catch (e) {}
    })();
    return true;   // 保持通道，等待异步 sendResponse
  }
  if (msg.type === 'apAuthActivate') {
    (async () => {
      let res;
      try {
        res = APOnlineClient ? await APOnlineClient.activate(msg.code)
          : { ok: false, msg: '在线授权模块未加载' };
      } catch (e) { res = { ok: false, msg: '激活异常：' + ((e && e.message) || e) }; }
      if (res && res.ok) {
        const st = res.state || await currentAuthState();
        // 只有在线卡密才需要 5 秒心跳通道；AVP1 离线码是本地凭证，不常驻离屏文档
        if (st && st.source === 'online') {
          try { await ensureOffscreen(); } catch (e) {}
          try { await onHeartbeatTick(); } catch (e) {}
        }
        broadcastAuth(st);
      }
      try {
        sendResponse({ ok: !!(res && res.ok), msg: (res && res.msg) || '',
          reason: (res && res.reason) || '', state: (res && res.state) || await currentAuthState() });
      } catch (e) {}
    })();
    return true;
  }
  if (msg.type === 'apAuthClear') {
    (async () => {
      let state = null;
      try {
        if (APOnlineClient) await APOnlineClient.clear();
        else if (chrome.storage && chrome.storage.sync) chrome.storage.sync.set({ licenseKey: '' });
        state = await currentAuthState();
        broadcastAuth(state);
      } catch (e) {}
      try { sendResponse({ ok: true, state }); } catch (e) {}
    })();
    return true;
  }
  if (msg.type === 'apAuthRefresh') {
    (async () => {
      try { await ensureSessionThrottled(true); } catch (e) {}
      const state = await currentAuthState();
      broadcastAuth(state);
      try { sendResponse({ ok: true, state }); } catch (e) {}
    })();
    return true;
  }
  if (msg.type === 'apAuthTrial') {
    (async () => {
      let res;
      try { res = APOnlineClient ? await APOnlineClient.trial() : { ok: false, msg: '在线授权模块未加载' }; }
      catch (e) { res = { ok: false, msg: '试用异常：' + ((e && e.message) || e) }; }
      if (res && res.ok) { try { await ensureOffscreen(); } catch (e) {} broadcastAuth(res.state || await currentAuthState()); }
      try { sendResponse({ ok: !!(res && res.ok), msg: (res && res.msg) || '', state: (res && res.state) || await currentAuthState() }); } catch (e) {}
    })();
    return true;
  }

  if (msg.type === 'apRegister') {
    ensureAlarm();
    if (sender.tab) addTab(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'apUnregister') {
    if (sender.tab) removeTab(sender.tab.id);
    sendResponse({ ok: true });
    return true;
  }
  // 内容脚本请求把 shadow_bridge.js 注入页面主世界（MAIN world）。
  // 场景：播放器藏在关闭的 Shadow DOM 里，且页面 CSP 拦截了内联 <script> 注入，
  // 只能用 chrome.scripting 以文件方式注入（需要 "scripting" 权限）。
  if (msg.type === 'apInjectShadowBridge') {
    try {
      if (!sender.tab) { sendResponse({ ok: false }); return true; }
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, allFrames: true },
        world: 'MAIN',
        files: ['shadow_bridge.js']
      }, () => { void chrome.runtime.lastError; sendResponse({ ok: true }); });
    } catch (e) { try { sendResponse({ ok: false }); } catch (e2) {} }
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== ALARM_NAME) return;
  // 授权兜底：Service Worker 曾被回收 / 离屏文档被关闭时补建并补一次心跳。
  // 每分钟闹钟与 5 秒 Worker 节拍互为冗余，任一存活都能维持在线状态。
  (async () => {
    try {
      if (!APOnlineClient) return;
      const s = await APOnlineClient.loadState();
      if (s && s.token) { await ensureOffscreen(); await onHeartbeatTick(); }
    } catch (e) {}
  })();
  readTabs((list) => {
    list.forEach((entry) => {
      if (!entry || entry.id == null) return;
      try {
        // 兼容两种 API 形态：新版返回 Promise（catch 里移除失效标签页），
        // 老版只有 callback（lastError 里移除）。v2.1.2 修复：此前直接
        // .catch()，在只支持 callback 的内核上会抛 TypeError 导致后续
        // 标签页全部漏 ping。
        const maybePromise = chrome.tabs.sendMessage(entry.id, { type: 'apWatchdog' }, () => {
          if (chrome.runtime.lastError) removeTab(entry.id);
        });
        if (maybePromise && typeof maybePromise.catch === 'function') {
          maybePromise.catch(() => removeTab(entry.id));
        }
      } catch (e) {}
    });
  });
});

// 离屏文档通过 runtime.Port 每 5 秒敲一次；Port 是点对点的，
// 不会像 sendMessage 那样把节拍广播给所有标签页/iframe。
try {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'apHeartbeat') return;
    try {
      port.onMessage.addListener((m) => {
        if (m && m.type === 'apHeartbeatTick') onHeartbeatTick();
      });
    } catch (e) {}
  });
} catch (e) {}

// Service Worker 每次被唤醒都做一次轻量恢复：已激活则确保心跳通道存在，
// 未激活则只校验本地状态，不产生任何网络请求。
setTimeout(() => {
  (async () => {
    try {
      if (!APOnlineClient) return;
      const s = await APOnlineClient.loadState();
      if (s && s.token) { await ensureOffscreen(); await onHeartbeatTick(); }
      else await currentAuthState();
    } catch (e) {}
  })();
}, 0);
