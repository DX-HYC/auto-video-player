// 静态自检：验证"空壳 video 不再被当成可控播放器"（源码直接提取，非副本）
// 背景：jxnu zjpt 页面上有 3 个摄像头/人脸检测的 <video>（无 src、readyState=0、
// duration=NaN）。若把它们算作"播放器已可控"，按目录进度驱动的兜底会被关掉，
// 表现为"播完不跳下一集 / 不自动播放"。
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

const code = [
  'let frameStates = {};',
  extractFn('hasMediaSource'),
  extractFn('isRealVideo'),
  extractFn('isRealVideoObj'),
  extractFn('getAggregatedVideos'),
  extractFn('parseItemPercent'),
  'return { isRealVideo, isRealVideoObj, getAggregatedVideos, parseItemPercent,' +
  ' setFrames(f){ frameStates = f; } };'
].join('\n');
const M = new Function(code)();

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + ' → ' + got + '（期望 ' + want + '）');
  ok ? pass++ : fail++;
}

// 1. jxnu 空壳 video（摄像头 / 人脸检测，父级 show-face / show_camera / my-video）
const shell = { src: '', currentSrc: '', readyState: 0, duration: NaN, currentTime: 0, paused: true };
check('空壳 video（无 src / readyState 0 / duration NaN）→ 不可控', M.isRealVideo(shell), false);
check('空壳 video（跨帧数据对象）→ 不可控',
  M.isRealVideoObj({ currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0, real: false }), false);

// 2. 网梯等正常平台的真实 video
check('真实 video（有 src）→ 可控', M.isRealVideo({ src: 'https://x.cn/a.mp4', readyState: 0, duration: NaN }), true);
check('真实 video（MSE blob currentSrc，无 src 属性）→ 可控',
  M.isRealVideo({ src: '', currentSrc: 'blob:https://x.cn/123', readyState: 0 }), true);
check('真实 video（srcObject 媒体流）→ 可控', M.isRealVideo({ srcObject: {}, readyState: 0 }), true);
check('真实 video（已缓冲有 duration）→ 可控',
  M.isRealVideoObj({ src: '', currentTime: 0, duration: 3600, readyState: 0 }), true);

// 3. 聚合：jxnu 的 3 个空壳不应阻塞目录进度兜底
M.setFrames({
  __top__: {
    ts: Date.now(),
    videos: [
      { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0, real: false },
      { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0, real: false },
      { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0, real: false }
    ]
  }
});
check('jxnu：3 个空壳 → 可控视频数 0（目录进度兜底可启用）', M.getAggregatedVideos().length, 0);
check('jxnu：includeShell 时仍能看到 3 个', M.getAggregatedVideos(true).length, 3);

// 4. 聚合：网梯有真实视频时兜底应保持关闭
M.setFrames({
  __top__: { ts: Date.now(), videos: [{ currentTime: 10, duration: 900, paused: false, ended: false, src: 'https://x.cn/a.mp4', readyState: 4, real: true }] }
});
check('网梯：1 个真实视频 → 可控视频数 1（走 video 事件驱动）', M.getAggregatedVideos().length, 1);

// 5. 目录进度百分比解析（jxnu 目录项文本形如 "15.8%\n1-2 …"）
check('解析 "15.8%\\n1-2 …"', M.parseItemPercent('15.8%\n1-2 确保基本实现…'), 15.8);
check('解析 "100%\\n1-1 …"', M.parseItemPercent('100%\n1-1 确保基本实现…'), 100);
check('网梯无百分比 → -1（兜底不介入，不影响网梯）', M.parseItemPercent('1-1 课程导学'), -1);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
