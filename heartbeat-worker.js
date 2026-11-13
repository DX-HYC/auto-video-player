/*!
 * 自动连播助手 (Auto Video Player) · 心跳定时器 Worker
 * Copyright (c) 2026 胡昱晨 (hu_yu_chen). Licensed under the MIT License.
 * 授权服务端要求固定 5 秒心跳，连续 15 秒无心跳判定离线。
 * 隐藏文档里的 setInterval 会被浏览器节流到每分钟，Web Worker 的定时器不受
 * 页面可见性节流影响，因此把节拍放在这里。
 */
'use strict';
const INTERVAL = 5000;
let timer = null;

function start() {
  if (timer) return;
  timer = setInterval(() => {
    try { self.postMessage({ type: 'tick', at: Date.now() }); } catch (e) {}
  }, INTERVAL);
  // 立刻打一拍，避免激活后要等 5 秒才有第一次心跳
  try { self.postMessage({ type: 'tick', at: Date.now() }); } catch (e) {}
}

self.onmessage = (e) => {
  if (!e || !e.data) return;
  if (e.data.type === 'start' || e.data.type === 'restart') start();
  if (e.data.type === 'stop' && timer) { clearInterval(timer); timer = null; }
};

start();
