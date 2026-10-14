/*!
 * 自动连播助手 (Auto Video Player) - Shadow DOM 桥（注入页面主世界 MAIN world）
 * -----------------------------------------------------------------------------
 * 著作权所有 (c) 2026 胡昱晨 (hu_yu_chen)。MIT 授权，禁止删除署名。
 * -----------------------------------------------------------------------------
 * 用途：jxnu zjpt 等平台的课程播放器把 <video> 藏在「关闭的 Shadow DOM」里
 * （closed shadowRoot，querySelectorAll 永远查不到，页面上能看到的 video 全是
 * 摄像头/人脸检测的空壳）。内容脚本与页面脚本处于不同 JS 世界，无法直接访问，
 * 因此把本脚本注入主世界：
 *   1. 包装 Element.prototype.attachShadow，截获所有 closed shadowRoot 的引用；
 *   2. 每秒把其中的 video 状态（时间/时长/暂停/结束/倍率）写入
 *      documentElement 的 data-ap-shadow-videos 属性（content script 可读）；
 *   3. 每 300ms 检查 data-ap-cmd 属性，执行内容脚本下发的 play/rate 命令。
 * 与页面同源策略无冲突：本脚本运行在页面自身的主世界里。
 */
(function () {
  if (window.__apShadowBridgeInstalled) return;
  window.__apShadowBridgeInstalled = true;
  try { document.documentElement.setAttribute('data-ap-shadow-ok', '1@' + Math.round(performance.now())); } catch (e) {}

  var roots = [];

  // 1) 截获 closed shadowRoot
  try {
    var origAttach = Element.prototype.attachShadow;
    if (origAttach && !origAttach.__apPatched) {
      var patched = function (init) {
        var root = origAttach.apply(this, arguments);
        try { if (root && init && init.mode === 'closed') roots.push(root); } catch (e) {}
        return root;
      };
      patched.__apPatched = true;
      Object.defineProperty(Element.prototype, 'attachShadow', {
        value: patched, configurable: true, writable: true
      });
    }
  } catch (e) {}

  // 2) 递归收集 video 状态（含 shadow 内同源 iframe，跨域 iframe 只上报地址）
  function collect(doc, out, els, depth) {
    if (!doc || depth > 5) return;
    try {
      var vs = doc.querySelectorAll('video');
      for (var i = 0; i < vs.length; i++) {
        var v = vs[i];
        out.push({
          t: v.currentTime || 0,
          d: isFinite(v.duration) ? v.duration : 0,
          p: !!v.paused,
          e: !!v.ended,
          r: v.playbackRate || 1,
          s: String(v.currentSrc || v.src || '').slice(0, 200)
        });
        if (els) els.push(v);
      }
      var fs = doc.querySelectorAll('iframe, object, embed');
      for (var j = 0; j < fs.length; j++) {
        var ok = false;
        try {
          var d = fs[j].contentDocument || (fs[j].contentWindow && fs[j].contentWindow.document);
          if (d) { collect(d, out, els, depth + 1); ok = true; }
        } catch (e) {}
        if (!ok) out.push({ iframe: String(fs[j].src || fs[j].data || '').slice(0, 200) });
      }
    } catch (e) {}
  }

  function elementList() {
    var els = [];
    for (var i = 0; i < roots.length; i++) collect(roots[i], [], els, 0);
    return els;
  }

  // 状态上报（1s）：closed 容器数量 + 其中 video 状态（含容器内同源 iframe 递归）
  setInterval(function () {
    try {
      var out = [];
      for (var i = 0; i < roots.length; i++) collect(roots[i], out, null, 0);
      document.documentElement.setAttribute('data-ap-shadow-roots', String(roots.length));
      document.documentElement.setAttribute('data-ap-shadow-videos', JSON.stringify(out));
    } catch (e) {}
  }, 1000);

  // 容器内找"播放类"按钮兜底：play() 被浏览器的自动播放策略拒绝时，
  // 平台自定义播放器往往只认自己的按钮/内部 API
  function clickPlayInside(doc, depth) {
    if (!doc || depth > 4) return false;
    try {
      var sel = '[class*="play" i]:not([class*="pause" i]):not([class*="next" i]):not([class*="prev" i])';
      var els = doc.querySelectorAll(sel);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (!el.offsetWidth && !el.offsetHeight) continue;
        var cls = (el.getAttribute && el.getAttribute('class')) || '';
        var txt = (el.textContent || '').trim();
        if (/下一|倍速|全屏|音量|清晰度|列表|设置|弹幕/i.test(txt)) continue;
        try { el.click(); } catch (e) {}
        try {
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } catch (e) {}
        return true;
      }
      var fs = doc.querySelectorAll('iframe');
      for (var j = 0; j < fs.length; j++) {
        try { if (fs[j].contentDocument && clickPlayInside(fs[j].contentDocument, depth + 1)) return true; } catch (e) {}
      }
    } catch (e) {}
    return false;
  }

  // 命令执行（300ms）
  setInterval(function () {
    try {
      var raw = document.documentElement.getAttribute('data-ap-cmd');
      if (!raw) return;
      document.documentElement.removeAttribute('data-ap-cmd');
      var cmd = JSON.parse(raw);
      var els = elementList();
      for (var i = 0; i < els.length; i++) {
        try {
          var v = els[i];
          if (cmd.action === 'play' && !v.ended) {
            var p = v.play();
            if (p && p.catch) p.catch(function () {
              // play() 被拒（自动播放策略/播放器私有控制）：退回点击容器内播放按钮
              for (var k = 0; k < roots.length; k++) { clickPlayInside(roots[k], 0); }
            });
          } else if (cmd.action === 'rate' && cmd.value) {
            v.playbackRate = cmd.value;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }, 300);
})();
