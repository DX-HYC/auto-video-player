/*!
 * 自动连播助手 (Auto Video Player) · 离屏心跳桥
 * Copyright (c) 2026 胡昱晨 (hu_yu_chen). Licensed under the MIT License.
 * 离屏文档只允许使用 chrome.runtime API，因此这里只做两件事：
 *   1. 启动 heartbeat-worker.js 拿到稳定的 5 秒节拍；
 *   2. 用 runtime.Port 点对点敲醒 Service Worker（不用 sendMessage，避免每 5 秒
 *      把消息广播给所有标签页/iframe 的 content script）。
 * 真正的网络请求、令牌刷新与授权状态判定全部在 Service Worker 里单点完成。
 */
'use strict';

const PORT_NAME = 'apHeartbeat';
let port = null;
let connecting = false;
let worker = null;

function connect() {
  if (port || connecting) return;
  connecting = true;
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onDisconnect.addListener(() => {
      port = null;
      // Service Worker 被回收后端口会断开；下一拍会重连并再次唤醒它
      setTimeout(connect, 800);
    });
  } catch (e) {
    port = null;
    setTimeout(connect, 1000);
  } finally {
    connecting = false;
  }
}

function tick() {
  if (!port) connect();
  try {
    if (port) port.postMessage({ type: 'apHeartbeatTick', at: Date.now() });
  } catch (e) {
    port = null;
    setTimeout(connect, 500);
  }
}

try {
  worker = new Worker('heartbeat-worker.js');
  worker.onmessage = (e) => { if (e && e.data && e.data.type === 'tick') tick(); };
  worker.onerror = () => {
    // Worker 意外退出时降级为文档内定时器（可能被节流，但总比完全没有强）
    setInterval(tick, 5000);
  };
  connect();
} catch (e) {
  setInterval(tick, 5000);
}

// 离屏文档重新加载时立刻补一拍（激活/重启后不要等满 5 秒）
tick();
