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

const TABS_KEY = 'apTabs';
const ALARM_NAME = 'apWatchdog';
const MAX_TABS = 30;

// ---------- Shadow DOM 桥的原生注册 ----------
// 必须抢在页面脚本之前把桥注入 MAIN world：播放器库若先创建了 closed shadowRoot，
// attachShadow 钩子就永远截获不到引用。chrome.scripting.registerContentScripts 支持
// world:'MAIN' + runAt:'document_start'，由浏览器原生注入 —— 零竞态、不受页面 CSP
// 限制，比 <script src> / executeScript 动态注入都可靠（Chrome 111+，Edge 同步支持）。
const BRIDGE_SCRIPT_ID = 'ap-shadow-bridge-main';
function registerShadowBridge() {
  try {
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const matches = (chrome.runtime.getManifest().content_scripts || [])
      .flatMap(cs => cs.matches || []);
    if (!matches.length) return;
    chrome.scripting.getRegisteredContentScripts((scripts) => {
      if (chrome.runtime.lastError) { doRegister(); return; }
      if ((scripts || []).some(s => s.id === BRIDGE_SCRIPT_ID)) return;
      doRegister();
    });
    function doRegister() {
      chrome.scripting.registerContentScripts([{
        id: BRIDGE_SCRIPT_ID,
        js: ['shadow_bridge.js'],
        matches: matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true
      }], () => { void chrome.runtime.lastError; });
    }
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

// 部分旧版本 Chrome 没有 chrome.storage.session，这里统一降级到内存缓存
const memTabs = [];

function readTabs(cb) {
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.get(TABS_KEY, (r) => {
        const v = chrome.runtime.lastError ? null : (r && r[TABS_KEY]);
        cb(Array.isArray(v) ? v : memTabs.slice());
      });
      return;
    }
  } catch (e) {}
  cb(memTabs.slice());
}

function writeTabs(list) {
  const trimmed = list.slice(-MAX_TABS);
  memTabs.length = 0;
  memTabs.push(...trimmed);
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ [TABS_KEY]: trimmed });
    }
  } catch (e) {}
}

function addTab(tabId) {
  if (tabId == null) return;
  readTabs((list) => {
    const filtered = list.filter(x => x && x.id !== tabId);
    filtered.push({ id: tabId, ts: Date.now() });
    writeTabs(filtered);
  });
}

function removeTab(tabId) {
  if (tabId == null) return;
  readTabs((list) => {
    writeTabs(list.filter(x => x && x.id !== tabId));
  });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
chrome.runtime.onStartup.addListener(() => ensureAlarm());

// 内容脚本注册/注销，以及看门狗唤醒后的 ping 应答
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
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
  readTabs((list) => {
    list.forEach((entry) => {
      if (!entry || entry.id == null) return;
      try {
        chrome.tabs.sendMessage(entry.id, { type: 'apWatchdog' })
          .catch(() => removeTab(entry.id));
      } catch (e) {}
    });
  });
});
