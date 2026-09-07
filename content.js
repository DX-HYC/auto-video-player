// 自动连播助手 - 内容脚本（注入所有帧，含递归 iframe 扫描）
(function () {
  'use strict';

  const IS_TOP = (() => {
    try { return window.self === window.top; } catch (e) { return false; }
  })();

  const DEFAULTS = {
    enabled: true,
    autoResume: false,     // 默认关闭自动续播，降低被平台检测为违规插件的风险
    autoNext: true,
    resumeDelay: 1200,
    debug: false
  };

  let settings = Object.assign({}, DEFAULTS);
  const boundVideos = new WeakSet();
  let currentVideo = null;
  let lastEndedVideo = null;
  let handlingEnd = false;
  let lastClickAt = 0;
  let panel = null;
  let infoTimer = null;

  const FRAME_ID = Math.random().toString(36).slice(2);
  const TOP_LOGS = [];
  const MAX_LOGS = 80;

  let catalogHtmlBuffer = '';
  let pendingCatalogCopy = false;

  let localVideos = [];
  let localList = { container: null, all: [], leaves: [], chapterHeaders: [], current: null, completed: [], pending: [], leafCount: 0 };
  let frameStates = {};
  let lastGlobalNextAt = 0;

  // ---------- 设置同步 ----------
  const SETTINGS_VERSION = '1.7.7';
  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(Object.assign({ settingsVersion: '' }, DEFAULTS), (res) => {
        settings = Object.assign({}, DEFAULTS, res || {});
        // 版本迁移：新版默认关闭 autoResume，若旧设置仍开启则强制关闭一次
        if ((res || {}).settingsVersion !== SETTINGS_VERSION) {
          settings.autoResume = false;
          try {
            chrome.storage.sync.set({ autoResume: false, settingsVersion: SETTINGS_VERSION });
          } catch (e) {}
        }
        if (cb) cb();
      });
    } catch (e) { if (cb) cb(); }
  }
  function saveSettings() {
    try { chrome.storage.sync.set(settings); } catch (e) {}
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let dirty = false;
      for (const k of Object.keys(changes)) {
        if (k in settings) { settings[k] = changes[k].newValue; dirty = true; }
      }
      if (dirty && IS_TOP) updateUI();
    });
  } catch (e) {}

  // ---------- 日志 ----------
  function log() {
    try {
      const args = Array.from(arguments);
      console.log('[自动连播助手]', ...args);
      const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      const tag = getFrameTag();
      const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' [' + tag + '] ' + line;
      if (IS_TOP) {
        TOP_LOGS.push(stamp);
        if (TOP_LOGS.length > MAX_LOGS) TOP_LOGS.shift();
        updateLogs();
      } else {
        postToTop({ type: 'log', text: stamp });
      }
    } catch (e) {}
  }

  function getFrameTag() {
    try {
      return (IS_TOP ? 'TOP' : 'IFRAME') + '|' + location.pathname.split('/').pop() + '|' + FRAME_ID.slice(0, 4);
    } catch (e) { return 'frame'; }
  }

  // ---------- 工具 ----------
  function isVisible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    try {
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none') return false;
    } catch (e) {}
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
  }

  function queryVisible(sel, root) {
    root = root || document;
    let els;
    try { els = root.querySelectorAll(sel); } catch (e) { return null; }
    for (const el of els) if (isVisible(el)) return el;
    return null;
  }

  function copyText(text) {
    if (!text) return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    try {
      if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {}
    ta.remove();
    return ok;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
  }

  function playerRoot(video) {
    let node = video;
    for (let i = 0; i < 6 && node; i++) {
      const cls = (node.className && typeof node.className === 'string') ? node.className : '';
      if (/\b(player|video|bpx-player|vjs|html5-video)\b/i.test(cls) || node.tagName === 'VIDEO') return node;
      node = node.parentElement;
    }
    return video.parentElement || document;
  }

  // 递归查询 video（open Shadow DOM + 同域 iframe）
  function queryVideos(root, depth) {
    depth = depth || 0;
    if (depth > 6) return [];
    const out = [];
    try {
      root.querySelectorAll('video').forEach(v => out.push(v));
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) queryVideos(el.shadowRoot, depth + 1).forEach(v => out.push(v));
      });
      // 扫描同域 iframe
      root.querySelectorAll('iframe').forEach(f => {
        try {
          const d = f.contentWindow && f.contentWindow.document;
          if (d && d !== root) queryVideos(d, depth + 1).forEach(v => out.push(v));
        } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  // ---------- 通信 ----------
  function postToTop(msg) {
    try {
      const target = (() => { try { return window.top; } catch (e) { return window.parent; } })();
      if (target && target !== window.self) {
        target.postMessage(Object.assign({ __autoPlayer: true, frameId: FRAME_ID, frameTag: getFrameTag() }, msg), '*');
      }
    } catch (e) {}
  }

  function broadcastDown(msg) {
    document.querySelectorAll('iframe').forEach(f => {
      try {
        f.contentWindow.postMessage(Object.assign({ __autoPlayer: true, broadcastDown: true }, msg), '*');
      } catch (e) {}
    });
  }

  // ---------- 视频：暂停续播 ----------
  function resumeVideo(video) {
    if (!settings.enabled || !settings.autoResume) return;
    if (!video || video.ended) return;
    if (!video.paused) return;
    // 不再直接调用 video.play()，避免被平台检测到非自然播放行为；改为模拟点击播放按钮
    setTimeout(() => {
      if (!settings.enabled || !settings.autoResume) return;
      if (!video.paused || video.ended) return;
      clickPlayButton(video);
    }, settings.resumeDelay || 0);
  }

  function onPause(e) {
    const video = e.target;
    if (!video || video.ended) return;
    resumeVideo(video);
  }

  function onEnded(e) {
    const video = e.target;
    if (!settings.enabled || !settings.autoNext) return;
    if (handlingEnd && lastEndedVideo === video) return;
    handlingEnd = true;
    lastEndedVideo = video;
    log('视频播放结束');
    const handled = clickNext(false, true);
    postToTop({ type: 'ended', handled: !!handled });
    setTimeout(() => { handlingEnd = false; }, 2000);
  }

  function onPlaying(e) {
    const video = e.target;
    currentVideo = video;
    if (video === lastEndedVideo) { lastEndedVideo = null; handlingEnd = false; }
  }

  let lastTimeReport = 0;
  function onTimeUpdate() {
    const now = Date.now();
    if (now - lastTimeReport < 2000) return; // 降低上报频率，减少被检测风险
    lastTimeReport = now;
    reportVideoState();
  }

  function clickPlayButton(video) {
    const root = playerRoot(video);
    const sels = [
      '.bpx-player-ctrl-play',
      '[class*="player"] [class*="play"][class*="btn"]',
      '.ytp-play-button',
      '.vjs-play-control',
      'button[aria-label*="播放"]',
      'button[title*="播放"]',
      '[class*="play-btn" i]'
    ];
    for (const s of sels) {
      try {
        const btn = root.querySelector(s);
        if (btn && isVisible(btn)) { btn.click(); return; }
      } catch (e) {}
    }
  }

  function attachVideo(video) {
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('play', () => { currentVideo = video; });
    video.addEventListener('timeupdate', onTimeUpdate);
    log('绑定视频', video.currentSrc || video.src || '(无src)');
  }

  function scanVideos() {
    const videos = queryVideos(document);
    videos.forEach(attachVideo);
    return videos;
  }

  function getLocalVideoState() {
    return queryVideos(document).map(v => ({
      currentTime: v.currentTime || 0,
      duration: v.duration || 0,
      paused: v.paused,
      ended: v.ended,
      src: v.currentSrc || v.src || ''
    }));
  }

  function reportVideoState() {
    localVideos = getLocalVideoState();
    const payload = {
      type: 'state',
      videos: localVideos,
      list: localList,
      frameTag: getFrameTag(),
      frameUrl: location.href,
      ts: Date.now()
    };
    if (IS_TOP) {
      frameStates['__top__'] = { videos: localVideos, list: localList, frameTag: getFrameTag(), frameUrl: location.href, ts: Date.now() };
    } else {
      postToTop(payload);
    }
  }

  function observe() {
    scanVideos();
    const mo = new MutationObserver((mutations) => {
      let needScan = false;
      for (const m of mutations) {
        for (const n of m.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'VIDEO') attachVideo(n);
          else if (n.querySelector && n.querySelector('video')) needScan = true;
          else if (n.shadowRoot) needScan = true;
          else if (n.tagName === 'IFRAME') needScan = true;
        }
      }
      if (needScan) scanVideos();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---------- 课程目录解析 ----------
  function getAllText(el) {
    if (!el) return '';
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '').trim();
  }

  function hasClass(el, re) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    return re.test(cls);
  }

  function looksLikeCatalogContainer(el) {
    const text = getAllText(el);
    let score = 0;
    const cls = (typeof el.className === 'string') ? el.className : '';
    if (/\bs_learnlist\b|\bcatalog-list|\bcourse-catalog|\bchapter-list|\blearn-catalog|\bcourse-menu|\bcourse-outline|\bvideo-list/i.test(cls)) score += 20;
    if (/catalog|chapter|lesson|courseware|course-menu|course-outline|video-list|learn-catalog|目录|章节|课时|课件/i.test(cls)) score += 8;
    if (el.getAttribute('role') === 'tree') score += 10;
    if (el.getAttribute('role') === 'list') score += 4;

    const lists = el.querySelectorAll('ul, ol');
    const items = el.querySelectorAll('li');
    const durationMatches = (text.match(/\d{1,2}:\d{2}/g) || []).length;
    const sPointCount = el.querySelectorAll('.s_point[itemtype="video"]').length;
    const learnMenuCells = el.querySelectorAll('.learn-menu-cell').length;

    // 网梯平台：有真实视频课时节点就大幅加分；左侧导航菜单强烈减分，避免抢占课程目录
    if (sPointCount >= 2) score += 30 + sPointCount;
    if (learnMenuCells >= 1) score -= 40;
    if (/\blearn-menu\b|\bnav-menu\b|\bleft-menu\b|\bcourse-nav\b|\bsidebar\b/i.test(cls)) score -= 30;

    if (lists.length >= 1 && items.length >= 3) score += Math.min(items.length, 12);
    if (items.length >= 3) score += Math.min(items.length, 8);
    if (durationMatches >= 1) score += 4;
    if (/第\s*[0-9]+\s*[章讲节课]/i.test(text)) score += 4;
    if (/视频\s*[：:]/.test(text)) score += 2;

    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 120) score -= 5;
    } catch (e) {}
    return score;
  }

  // 网梯/whaty-learnspace 平台专用目录识别
  function findWangtiCatalog(doc) {
    // 只认真正的课程目录：id/class 含 learnMenu / s_learnlist / learnlist；
    // 注意 .learn-menu（左侧导航）不是课程目录，不在此列
    const directSelectors = '#learnMenu, .s_learnlist, [id*="learnMenu" i], [class*="learnlist" i], [class*="s_learnlist" i]';
    const direct = doc.querySelector(directSelectors);
    if (direct && direct.children.length >= 2) return direct;

    // 找包含最多 .s_point[itemtype="video"] 的 div（最可靠：真实视频课时节点）
    let best = null, bestCount = 0;
    doc.querySelectorAll('div').forEach(div => {
      const count = div.querySelectorAll('.s_point[itemtype="video"]').length;
      if (count > bestCount) { bestCount = count; best = div; }
    });
    if (bestCount >= 2) return best;

    // 找包含最多 itemtype="video" 的 div
    let best2 = null, bestCount2 = 0;
    doc.querySelectorAll('div').forEach(div => {
      const count = div.querySelectorAll('[itemtype="video"]').length;
      if (count > bestCount2) { bestCount2 = count; best2 = div; }
    });
    if (bestCount2 >= 2) return best2;

    return null;
  }

  function findCatalogContainerInDoc(doc) {
    // 网梯/whaty-learnspace 平台兜底：直接命中课程目录容器
    const wt = findWangtiCatalog(doc);
    if (wt) return { el: wt, score: 1000 };

    const candidates = [];
    const selectors = [
      '#learnMenu', '.s_learnlist', '.learn-menu', '[class*="learnlist" i]',
      '.s_sectionlist', '.s_sectionwrap',
      '.catalog-list', '.course-catalog', '.chapter-list', '.learn-catalog',
      '.course-menu', '.course-outline', '.lesson-list', '.video-list',
      '.catalog', '.chapters', '.outline', '.learn-menu', '.courseware-menu',
      '.tree-menu', '.el-tree', '.ant-tree', '.ztree',
      '[class*="catalog" i]', '[class*="chapter" i]', '[class*="lesson" i]',
      '[class*="courseware" i]', '[class*="outline" i]', '[class*="course-menu" i]',
      '[role="tree"]', '[role="list"]'
    ];
    for (const s of selectors) {
      try {
        doc.querySelectorAll(s).forEach(el => {
          if (el.offsetParent === null) return;
          const score = looksLikeCatalogContainer(el);
          if (score >= 4) candidates.push({ el, score });
        });
      } catch (e) {}
    }
    doc.querySelectorAll('ul, ol').forEach(el => {
      if (el.offsetParent === null) return;
      const score = looksLikeCatalogContainer(el);
      if (score >= 6) candidates.push({ el, score });
    });
    if (!candidates.length) {
      doc.querySelectorAll('div').forEach(el => {
        if (el.offsetParent === null) return;
        const liCount = el.querySelectorAll(':scope > div, :scope > li').length;
        if (liCount < 5) return;
        const score = looksLikeCatalogContainer(el) + liCount * 0.3;
        if (score >= 8) candidates.push({ el, score });
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0] : null;
  }

  // 递归查找目录容器（跨所有同域 iframe，取评分最高的容器）
  function findCatalogContainer(root) {
    root = root || document;
    const candidates = [];
    const visited = new Set();

    function collect(doc) {
      if (!doc || visited.has(doc)) return;
      visited.add(doc);
      try {
        const c = findCatalogContainerInDoc(doc);
        if (c) candidates.push(c);
        doc.querySelectorAll('iframe').forEach(f => {
          try {
            const d = f.contentWindow && f.contentWindow.document;
            if (d && d !== doc) collect(d);
          } catch (e) {}
        });
      } catch (e) {}
    }

    collect(root);
    candidates.sort((a, b) => b.score - a.score);
    return candidates.length ? candidates[0].el : null;
  }

  function getItemScore(el) {
    const text = getAllText(el);
    let score = 0;
    const cls = (typeof el.className === 'string') ? el.className : '';
    if (/第\s*[0-9]+\s*[章讲节课]/i.test(text)) score += 3;
    if (/视频[:：]|课件|课时|课程/i.test(text)) score += 2;
    if (/\d{1,2}:\d{2}/.test(text)) score += 2;
    if (hasClass(el, /item|row|node|lesson|chapter|video|course|title|section/i)) score += 2;
    if (el.tagName === 'LI' || el.getAttribute('role') === 'listitem') score += 2;
    if (el.querySelector('i, svg, [class*="icon" i]')) score += 1;
    return score;
  }

  function collectItems(container) {
    let candidates = [];
    const seen = new Set();

    function walk(node, depth) {
      if (depth > 8) return;
      if (node.nodeType !== 1) return;
      if (node === container) { Array.from(node.children).forEach(c => walk(c, depth + 1)); return; }

      const text = getAllText(node);
      if (text && text.length >= 2) {
        const tag = node.tagName;
        const cls = (typeof node.className === 'string') ? node.className : '';
        const isLi = tag === 'LI';
        const hasItemClass = /item|row|node|lesson|chapter|video|course|title|section|catalog/i.test(cls);
        const hasDuration = /\d{1,2}:\d{2}/.test(text);
        const hasChapterText = /第\s*[0-9]+\s*[章讲节课]|视频[:：]/i.test(text);

        if (isLi || hasItemClass || hasDuration || hasChapterText) {
          if (!seen.has(node)) {
            seen.add(node);
            candidates.push({ el: node, text, score: getItemScore(node) });
          }
        }
      }
      Array.from(node.children).forEach(c => walk(c, depth + 1));
    }

    walk(container, 0);

    // 网梯/whaty-learnspace 平台精准识别：.s_point[itemtype="video"] 直接作为视频课时叶子
    const sPoints = Array.from(container.querySelectorAll('.s_point[itemtype="video"]'));
    if (sPoints.length >= 2) {
      const sPointSet = new Set(sPoints);
      // 移除被 .s_point 包含的候选，避免取到内部 .wrap
      candidates = candidates.filter(it => !sPointSet.has(it.el) && !sPoints.some(p => p !== it.el && p.contains(it.el)));
      for (const el of sPoints) {
        if (!seen.has(el)) {
          seen.add(el);
          const text = getAllText(el);
          candidates.push({ el, text, score: getItemScore(el) + 10 });
        }
      }
    }

    const expandableSet = new Set();
    candidates.forEach(it => {
      if (isExpandableHeader(it.el)) expandableSet.add(it.el);
    });

    let leaves = candidates.filter(it => {
      if (expandableSet.has(it.el)) return false;
      const wrappedByLeaf = candidates.some(other => {
        if (other.el === it.el) return false;
        if (!other.el.contains(it.el)) return false;
        if (expandableSet.has(other.el)) return false;
        return true;
      });
      return !wrappedByLeaf;
    });

    const chapterHeaders = candidates.filter(it => expandableSet.has(it.el));

    if (leaves.length < 2 && chapterHeaders.length >= 2) {
      leaves.push(...chapterHeaders);
      chapterHeaders.length = 0;
    }

    // 剔除左侧导航菜单、播放器控件等明显非课时的项
    leaves = leaves.filter(it => {
      const t = it.text.trim();
      if (/^(课件|课程简介|学习进度|首页|目录|讨论区|作业|考试|资料)$/.test(t)) return false;
      if (/^(高清|标清|超清|全高清|720p|1080p|480p|speed|倍速|音量|全屏)$/.test(t)) return false;
      if (it.el.closest('.learn-menu, .left-menu, .nav-menu, .course-nav')) return false;
      if (it.el.classList.contains('screen-player-cell')) return false;
      return true;
    });

    // 只保留真正带播放时长的视频课时，剔除「第X讲」「章节」等非视频项
    const withDuration = leaves.filter(it => /\d{1,2}:\d{2}(:\d{2})?/.test(it.text));
    if (withDuration.length >= 2 && withDuration.length < leaves.length) {
      leaves = withDuration;
    }

    const sortByDoc = (arr) => arr.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    sortByDoc(leaves);
    sortByDoc(chapterHeaders);

    return { leaves, chapterHeaders };
  }

  // 更严格的已完成检测：避免 checkbox / checked 等误匹配
  function hasCompletedMarker(el) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    const text = getAllText(el);

    // 网梯/whaty-learnspace 平台：completestate="1" 表示已完成
    const completeState = el.getAttribute('completestate');
    if (completeState === '1' || completeState === 'true') return 'completestate';
    const dataStatus = el.getAttribute('data-status');
    if (dataStatus === '1' || dataStatus === 'completed' || dataStatus === 'finish') return 'data-status';

    const clsRe = /\b(completed|finished|done|watched|passed|learned|success|finish|complete|wancheng|yiwancheng|yixuexi|yikan|yibofang|gou|dui|checked(?![a-z]))\b/i;
    if (clsRe.test(cls)) return 'class';
    if (/已学完|已完成|已看|已播放|学习进度\s*100|100%/.test(text)) return 'text';

    // 只看可能是状态图标的子元素，排除 input checkbox
    const icons = el.querySelectorAll('i, svg, span, em, img, [class*="icon" i]');
    for (const icon of icons) {
      const c = (typeof icon.className === 'string') ? icon.className : '';
      if (/\b(completed|finished|done|watched|passed|learned|success|finish|complete|wancheng|yiwancheng|yixuexi|yikan|yibofang|gou|dui)\b/i.test(c)) return 'icon-class';
      const t = getAllText(icon);
      if (/已学完|已完成|已看|已播放/.test(t)) return 'icon-text';
      const aria = icon.getAttribute('aria-label') || '';
      if (/已学完|已完成|已看|已播放/.test(aria)) return 'icon-aria';
    }
    return false;
  }

  function hasCurrentMarker(el) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    // 网梯/whaty-learnspace：s_pointerct / pointerct 表示当前正在学
    if (/\b(s_pointerct|pointerct|active|current|playing|selected|on|focus|now|cur|zhengzaibofang|bofangzhong|xuexizhong)\b/i.test(cls)) return true;
    if (el.getAttribute('aria-current') === 'true' || el.getAttribute('aria-selected') === 'true') return true;
    const icon = el.querySelector('[class*="active" i], [class*="current" i], [class*="selected" i], [class*="bofang" i], [class*="playing" i]');
    if (icon) return true;
    try {
      const st = getComputedStyle(el);
      const color = st.color || '';
      if (/rgb\(49,\s*130,\s*246\)|#2f81f7|#1890ff|#0a6cff|rgb\(24,\s*144,\s*255\)|rgb\(10,\s*108,\s*255\)/.test(color)) return true;
    } catch (e) {}
    return false;
  }

  function getItemAnchor(item) {
    if (!item || !item.el) return null;
    let a = item.el.querySelector('a[href]');
    if (a) return a;
    a = item.el.closest('a[href]');
    if (a) return a;
    if (item.el.tagName === 'A' && item.el.getAttribute('href')) return item.el;
    return null;
  }

  function getItemUrl(item) {
    const a = getItemAnchor(item);
    if (a && a.getAttribute('href') && !/^(javascript|#|void)/i.test(a.getAttribute('href'))) return a.href;
    const el = item.el;
    for (const k of ['data-url', 'data-href', 'data-src', 'data-link']) {
      const v = el.getAttribute(k);
      if (v) return v;
      const c = el.querySelector('[' + k + ']');
      if (c && c.getAttribute(k)) return c.getAttribute(k);
    }
    const onclick = el.getAttribute('onclick') || (el.querySelector('[onclick]') ? el.querySelector('[onclick]').getAttribute('onclick') : '');
    if (onclick) {
      const m = onclick.match(/['"]([^'"]+)['"]/g);
      if (m) {
        for (const s of m) {
          const clean = s.replace(/['"]/g, '');
          if (/\.(action|do|jsp|html)|courseware|learn|view|study|play/i.test(clean)) return clean;
        }
      }
    }
    return null;
  }

  // 从元素中提取课程节点 id（网梯平台 openLearnResItem 的第一个参数）
  function getItemId(el) {
    if (!el) return null;
    // id 属性通常是 s_point_<uuid>
    const idAttr = el.getAttribute('id') || '';
    const m = idAttr.match(/s_point_([a-f0-9]{32})/i);
    if (m) return m[1];
    const onclick = el.getAttribute('onclick') || '';
    const om = onclick.match(/openLearnResItem\s*\(\s*['"]([a-f0-9\-]+)['"]/i);
    if (om) return om[1];
    return null;
  }

  function urlsLookRelated(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      const u1 = new URL(a, location.href);
      const u2 = new URL(b, location.href);
      const q1 = u1.searchParams.toString();
      const q2 = u2.searchParams.toString();
      if (!q1 || !q2) return false;
      if (u1.pathname === u2.pathname && (q1.includes(q2) || q2.includes(q1))) return true;
      // 路径不同但共享同一个带 id 的参数，也视为相关
      const ids1 = q1.match(/[?&]([a-zA-Z0-9_]*[iI]d[a-zA-Z0-9_]*)=([^&]+)/g) || [];
      const ids2 = q2.match(/[?&]([a-zA-Z0-9_]*[iI]d[a-zA-Z0-9_]*)=([^&]+)/g) || [];
      for (const x of ids1) for (const y of ids2) if (x === y) return true;
      return false;
    } catch (e) { return false; }
  }

  // 比较网梯平台的 itemId：URL 中的 params.itemId 通常是 uuid 前 8 位
  function idsLookRelated(itemId, url) {
    if (!itemId || !url) return false;
    try {
      const u = new URL(url, location.href);
      const urlItemId = u.searchParams.get('params.itemId') || u.searchParams.get('itemId') || '';
      if (!urlItemId) return false;
      if (itemId === urlItemId) return true;
      if (itemId.startsWith(urlItemId)) return true;
      if (urlItemId.startsWith(itemId)) return true;
      return false;
    } catch (e) { return false; }
  }

  function findCurrentByUrl(leaves) {
    const here = location.href;
    if (!here || here === 'about:blank') return null;
    for (const it of leaves) {
      const url = getItemUrl(it);
      if (url && urlsLookRelated(url, here)) return it;
      const itemId = getItemId(it.el);
      if (itemId && idsLookRelated(itemId, here)) return it;
    }
    return null;
  }

  function findCurrentByHeading(leaves) {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, .title, .courseware-title, .lesson-title, .video-title, [class*="title" i]'));
    // 排除目录容器内部的标题
    const valid = headings.filter(h => !localList.container || !localList.container.contains(h));
    for (const h of valid) {
      const ht = getAllText(h);
      if (!ht || ht.length < 3) continue;
      for (const it of leaves) {
        const t = it.text;
        if (!t) continue;
        if (t.includes(ht) || ht.includes(t) ||
            t.replace(/\s/g, '').includes(ht.replace(/\s/g, '')) ||
            ht.replace(/\s/g, '').includes(t.replace(/\s/g, ''))) {
          return it;
        }
      }
    }
    return null;
  }

  function isExpandableHeader(el) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    const text = getAllText(el);
    if (/chapter|section|folder|group|part/i.test(cls)) return true;
    if (/第\s*\d+\s*章/.test(text)) return true;
    if (/expand|collapse|toggle|arrow|folder/i.test(cls)) return true;
    if (el.querySelector('ul, ol')) return true;
    if (el.querySelector('[class*="arrow" i], [class*="expand" i], [class*="collapse" i], [class*="folder" i]')) return true;
    const next = el.nextElementSibling;
    const prev = el.previousElementSibling;
    if ((next && (next.tagName === 'UL' || next.tagName === 'OL')) ||
        (prev && (prev.tagName === 'UL' || prev.tagName === 'OL'))) return true;
    return false;
  }

  function isGenericTitle(t) {
    if (!t) return true;
    const g = /^(在线学习|课程学习|学习空间|首页|课程详情|详情|course|learn)$/i;
    return g.test(t.trim());
  }

  function analyzeList() {
    const container = findCatalogContainer();
    if (!container) {
      localList = { container: null, all: [], leaves: [], chapterHeaders: [], current: null, completed: [], pending: [], leafCount: 0 };
      return;
    }
    const { leaves, chapterHeaders } = collectItems(container);
    localList.container = container;
    localList.leaves = leaves;
    localList.chapterHeaders = chapterHeaders;
    localList.leafCount = leaves.length;

    if (!leaves.length) {
      localList.all = [];
      localList.current = null;
      localList.completed = [];
      localList.pending = [];
      return;
    }

    // 当前项识别：URL 匹配优先于 s_pointerct 类标记。
    // 平台可能在某项上保留 s_pointerct 高亮，但用户实际正在播放的是另一项（URL 不同）。
    // 例如网梯平台在课程目录上一直保留对当前章节的 s_pointerct，但用户可能手动点了别的课时。
    let current = findCurrentByUrl(leaves) || leaves.find(it => hasCurrentMarker(it.el)) || null;
    let completedByMarker = new Set(leaves.filter(it => hasCompletedMarker(it.el)).map(it => it.el));

    // 防误报：如果所有课时都被标成已完成，而当前还有正在播放且未结束的视频，大概率是误匹配
    const activeVideo = currentVideo;
    if (completedByMarker.size === leaves.length && leaves.length > 1 && activeVideo && !activeVideo.ended && isFinite(activeVideo.duration) && (activeVideo.duration - activeVideo.currentTime) > 10) {
      log('已播标记疑似误报（全部匹配），已清空，依赖当前项与顺序判断');
      completedByMarker = new Set();
    }

    // 多种方式定位当前课时：DOM 状态 -> URL 匹配 -> 页面标题 -> 章节标题
    if (!current) current = findCurrentByUrl(leaves);
    if (!current) current = findCurrentByHeading(leaves);
    if (!current) {
      const pageTitle = document.title || '';
      if (!isGenericTitle(pageTitle)) {
        current = leaves.find(it => {
          const t = it.text;
          return t && (pageTitle.includes(t) || t.includes(pageTitle.slice(0, 25)));
        }) || null;
      }
    }

    // 状态判定：只信任平台真实的完成/当前标记，不再把当前项之前的所有课时默认标为已播。
    // 这样可以避免用户跳过中间视频时，扩展把未看的视频也算成已看完。
    localList.all = leaves.map(it => {
      let state = 'pending';
      if (current && it.el === current.el) {
        state = 'current';
      } else if (completedByMarker.has(it.el)) {
        state = 'completed';
      }
      return Object.assign(it, { state });
    });

    localList.current = localList.all.find(it => it.state === 'current') || null;
    localList.completed = localList.all.filter(it => it.state === 'completed');
    localList.pending = localList.all.filter(it => it.state === 'pending');

    log('目录分析：共', leaves.length, '项，当前', current ? current.text.slice(0, 30) : '无', '，已播', localList.completed.length, '，待播', localList.pending.length);
    log('当前URL:', location.href.slice(0, 160), '| title:', (document.title || '').slice(0, 40));
    // 调试：输出全部课时的文本、类名、完成标记、链接，方便精准适配
    leaves.slice(0, 30).forEach((it, i) => {
      const cls = (typeof it.el.className === 'string') ? it.el.className.replace(/\s+/g, ' ').slice(0, 140) : '';
      const url = getItemUrl(it) || '';
      const tag = it.el.tagName;
      log(`  leaf[${i}][${tag}] ${it.text.slice(0, 40)} | class:${cls} | 完成:${hasCompletedMarker(it.el) || '-'} | url:${url.slice(0, 80)}`);
    });
  }

  function findNextItem(autoEnded) {
    analyzeList();
    const leaves = localList.all.slice();
    if (!leaves.length) return null;

    let currentIdx = -1;
    if (localList.current) {
      currentIdx = leaves.findIndex(it => it.el === localList.current.el);
    }

    // 如果 analyzeList 没识别出当前项，再用 URL 兜底
    if (currentIdx < 0) {
      const urlMatch = findCurrentByUrl(leaves);
      if (urlMatch) currentIdx = leaves.findIndex(it => it.el === urlMatch.el);
    }

    // 手动点击“下一集”：优先取当前项之后的下一个未完成课时，保持顺序感。
    if (!autoEnded && currentIdx >= 0) {
      for (let i = currentIdx + 1; i < leaves.length; i++) {
        if (leaves[i].state !== 'completed') {
          log('手动下一集：当前索引', currentIdx, '→ 目标索引', i, leaves[i].text.slice(0, 30));
          return leaves[i];
        }
      }
    }

    // 自动连播/兜底：按目录顺序取第一个未完成的课时，不限于当前项之后。
    // 这样即使前面有漏掉的视频，播完后也会回头继续播放，直到课程全部完成。
    for (let i = 0; i < leaves.length; i++) {
      if (leaves[i].state !== 'completed') {
        if (currentIdx >= 0) {
          log('自动下一集（首个未完成）：当前索引', currentIdx, '→ 目标索引', i, leaves[i].text.slice(0, 30));
        } else {
          log('自动下一集（首个未完成）：目标索引', i, leaves[i].text.slice(0, 30));
        }
        return leaves[i];
      }
    }

    log('全部课时已完成');
    return null;
  }

  // ---------- 下一集 ----------
  function findNextButton() {
    const sels = [
      '.bpx-player-ctrl-next',
      '.ytp-next-button',
      '[class*="next" i][class*="player" i]',
      '[class*="next" i][class*="ctrl" i]',
      '[class*="next" i][class*="video" i]',
      'button[aria-label*="下一"]',
      'button[title*="下一"]',
      '[aria-label*="下一集"]',
      '[title*="下一集"]',
      '[class*="next-lesson" i]', '[class*="next-chapter" i]',
      '[class*="next" i]'
    ];
    for (const s of sels) {
      const el = queryVisible(s);
      if (el) return el;
    }
    return null;
  }

  function getClickableTarget(el) {
    let a = el.querySelector('a');
    if (a && a.textContent.trim()) return a;
    a = el.closest('a');
    if (a) return a;
    if (el.tagName === 'A') return el;
    return el;
  }

  function visibleClickableAncestor(el, container) {
    let node = el;
    while (node && node !== container && node !== document.body) {
      if (node.tagName === 'A' || node.tagName === 'BUTTON' || isExpandableHeader(node)) {
        if (isVisible(node)) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function clickWangtiItem(el) {
    if (!el || !el.classList || !el.classList.contains('s_point')) return false;
    const onclick = el.getAttribute('onclick') || '';
    const m = onclick.match(/openLearnResItem\s*\(\s*['"]([a-f0-9\-]+)['"]\s*,\s*['"]([^'"]+)['"]/i);
    if (!m) return false;
    if (typeof window.openLearnResItem !== 'function') return false;
    try {
      window.openLearnResItem(m[1], m[2], null, el.getAttribute('title') || '');
      return true;
    } catch (e) { return false; }
  }

  function smartClick(el, cb, attempt) {
    attempt = attempt || 1;

    // 网梯平台：优先直接调用 openLearnResItem，避免目录项不可见时点击失效
    if (clickWangtiItem(el)) {
      if (cb) cb(true);
      return true;
    }

    const target = getClickableTarget(el);
    if (isVisible(target)) {
      try { target.scrollIntoView({ behavior: 'instant', block: 'nearest' }); } catch (e) {}
      target.click();
      if (cb) cb(true);
      return true;
    }
    const ancestor = visibleClickableAncestor(el, localList.container);
    if (ancestor && attempt <= 3) {
      log('展开父级目录', getAllText(ancestor).slice(0, 30));
      ancestor.click();
      setTimeout(() => smartClick(el, cb, attempt + 1), 600);
      return false;
    }
    try {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
      target.dispatchEvent(ev);
      if (cb) cb(true);
      return true;
    } catch (e) {
      if (cb) cb(false);
      return false;
    }
  }

  function clickNext(force, autoEnded) {
    if (!force && !settings.enabled) return false;
    if (!force && !settings.autoNext) return false;
    if (Date.now() - lastClickAt < 4000) return false;

    analyzeList();

    // 本帧必须含有真实视频课时（网梯平台的 .s_point[itemtype="video"]）
    // 内容帧（如播放器控件）即便识别出几项 leafCount 也不算数，必须让顶层调度到目录帧
    let hasRealCatalog = false;
    for (const it of localList.leaves) {
      try { if (it.el.matches && it.el.matches('.s_point[itemtype="video"]')) { hasRealCatalog = true; break; } } catch (e) {}
    }
    if (!hasRealCatalog) {
      log('本帧无真实视频课时目录（leafCount=', localList.leafCount, '），交由顶层调度');
      return false;
    }

    const btn = findNextButton();
    if (btn) {
      log('点击下一集按钮');
      btn.click();
      lastClickAt = Date.now();
      return true;
    }

    const next = findNextItem(!!autoEnded);
    if (next) {
      log('点击下一节课：', next.text.slice(0, 40));
      lastClickAt = Date.now();
      smartClick(next.el, (ok) => {
        if (ok) log('跳转成功');
        else log('跳转可能失败，元素不可见');
      });
      return true;
    }

    log('本帧未找到下一个视频（交由拥有目录的子帧处理）');
    return false;
  }

  // ---------- 浮动面板 UI（仅顶层） ----------
  function ensureUI() {
    if (!IS_TOP) return;
    if (panel && document.body && document.body.contains(panel)) { updateUI(); return; }
    if (!document.body) return;

    panel = document.createElement('div');
    panel.id = 'autoplayer-panel';
    panel.innerHTML =
      '<div class="ap-head">' +
        '<span class="ap-title">▶ 自动连播助手</span>' +
        '<span class="ap-status" id="ap-status">运行中</span>' +
        '<button class="ap-min" id="ap-min" title="折叠/展开">—</button>' +
      '</div>' +
      '<div class="ap-body" id="ap-body">' +
        '<label class="ap-row" title="部分平台可能检测到非自然播放行为并弹出警告"><span>暂停自动续播 ⚠️</span><input type="checkbox" id="ap-resume"></label>' +
        '<label class="ap-row"><span>播完自动下一集</span><input type="checkbox" id="ap-next"></label>' +
        '<div class="ap-progress">' +
          '<div class="ap-progress-label"><span id="ap-progress-text">当前进度 --:-- / --:--</span><span id="ap-progress-pct">0%</span></div>' +
          '<div class="ap-progress-bar"><div class="ap-progress-fill" id="ap-progress-fill"></div></div>' +
        '</div>' +
        '<div class="ap-info" id="ap-info">检测中…</div>' +
        '<div class="ap-stats" id="ap-stats"></div>' +
        '<button class="ap-btn" id="ap-nextbtn">▶ 立即播放下一集</button>' +
        '<button class="ap-btn ap-btn-ghost" id="ap-copylog">📋 复制日志</button>' +
        '<button class="ap-btn ap-btn-ghost" id="ap-copyhtml">📋 复制目录HTML</button>' +
        '<div class="ap-debug-toggle" id="ap-debug-toggle">显示调试日志 ▼</div>' +
        '<div class="ap-logs" id="ap-logs"></div>' +
      '</div>';
    document.body.appendChild(panel);

    const resumeChk = panel.querySelector('#ap-resume');
    const nextChk = panel.querySelector('#ap-next');
    const minBtn = panel.querySelector('#ap-min');
    const body = panel.querySelector('#ap-body');
    const nextBtn = panel.querySelector('#ap-nextbtn');
    const dbgToggle = panel.querySelector('#ap-debug-toggle');
    const logs = panel.querySelector('#ap-logs');
    const copyLogBtn = panel.querySelector('#ap-copylog');
    const copyHtmlBtn = panel.querySelector('#ap-copyhtml');

    resumeChk.addEventListener('change', () => { settings.autoResume = resumeChk.checked; saveSettings(); updateStatus(); });
    nextChk.addEventListener('change', () => { settings.autoNext = nextChk.checked; saveSettings(); updateStatus(); });
    minBtn.addEventListener('click', () => {
      const hide = body.classList.toggle('ap-hidden');
      minBtn.textContent = hide ? '+' : '—';
    });
    nextBtn.addEventListener('click', () => {
      log('手动触发下一集');
      if (Date.now() - lastGlobalNextAt < 8000) return;
      lastGlobalNextAt = Date.now();
      const best = pickBestFrameForNext();
      if (best) {
        if (best.isTop) {
          clickNext(true, false);
        } else {
          broadcastDown({ type: 'clickNext', bestFrameTag: best.frameTag, manual: true });
        }
      } else {
        log('未找到有效目录');
      }
    });
    copyLogBtn.addEventListener('click', () => {
      const ok = copyText(TOP_LOGS.join('\n'));
      log(ok ? '日志已复制到剪贴板' : '复制失败，请手动选中日志复制');
    });
    copyHtmlBtn.addEventListener('click', () => {
      catalogHtmlBuffer = '';
      pendingCatalogCopy = true;
      log('正在收集目录HTML…');
      broadcastDown({ type: 'dumpCatalog' });
      setTimeout(() => {
        if (pendingCatalogCopy && catalogHtmlBuffer) {
          pendingCatalogCopy = false;
          const ok = copyText(catalogHtmlBuffer);
          log(ok ? '目录HTML已复制（长度 ' + catalogHtmlBuffer.length + '）' : '复制失败');
        } else if (pendingCatalogCopy) {
          pendingCatalogCopy = false;
          log('未收到目录HTML（可能目录在顶层或未识别）');
        }
      }, 1200);
    });
    dbgToggle.addEventListener('click', () => {
      const show = logs.classList.toggle('ap-logs-show');
      dbgToggle.textContent = show ? '隐藏调试日志 ▲' : '显示调试日志 ▼';
      if (show) updateLogs();
    });

    makeDraggable(panel, panel.querySelector('.ap-head'));
    updateUI();
  }

  function updateUI() {
    if (!panel) return;
    panel.querySelector('#ap-resume').checked = !!settings.autoResume;
    panel.querySelector('#ap-next').checked = !!settings.autoNext;
    updateStatus();
    updateInfo();
  }

  function updateStatus() {
    if (!panel) return;
    const st = panel.querySelector('#ap-status');
    const running = settings.enabled && (settings.autoResume || settings.autoNext);
    st.textContent = running ? '运行中' : '已暂停';
    st.classList.toggle('ap-off', !running);
  }

  function getAggregatedVideos() {
    const now = Date.now();
    return Object.values(frameStates)
      .filter(entry => now - entry.ts < 10000)
      .reduce((a, b) => a.concat(b.videos || []), []);
  }

  function pickBestList() {
    const now = Date.now();
    const states = Object.values(frameStates).filter(e => now - e.ts < 12000);
    if (!states.length) return null;
    const withCurrent = states.filter(e => e.list && e.list.current);
    if (withCurrent.length) return withCurrent.sort((a, b) => b.list.leafCount - a.list.leafCount)[0].list;
    return states.sort((a, b) => (b.list && b.list.leafCount || 0) - (a.list && a.list.leafCount || 0))[0].list;
  }

  function hasRealCatalogInList(list) {
    const leaves = (list && list.leaves) || [];
    for (const it of leaves) {
      try { if (it.el && it.el.matches && it.el.matches('.s_point[itemtype="video"]')) return true; } catch (e) {}
    }
    return false;
  }

  function pickBestFrameForNext() {
    const now = Date.now();
    const states = Object.values(frameStates).filter(e => now - e.ts < 12000 && e.list && e.list.leafCount >= 3 && hasRealCatalogInList(e.list));
    if (IS_TOP && localList.leafCount >= 3 && hasRealCatalogInList(localList)) {
      states.push({ frameTag: getFrameTag(), frameUrl: location.href, list: localList, ts: Date.now() });
    }
    if (!states.length) return null;
    states.sort((a, b) => b.list.leafCount - a.list.leafCount);
    const best = states[0];
    if (best.frameTag === getFrameTag() && IS_TOP) return { isTop: true, frameTag: best.frameTag };
    return { isTop: false, frameTag: best.frameTag, frameUrl: best.frameUrl };
  }

  function updateInfo() {
    if (!panel) return;
    const info = panel.querySelector('#ap-info');
    const stats = panel.querySelector('#ap-stats');
    const progressText = panel.querySelector('#ap-progress-text');
    const progressPct = panel.querySelector('#ap-progress-pct');
    const progressFill = panel.querySelector('#ap-progress-fill');

    const agg = getAggregatedVideos();
    const activeVideo = agg.find(v => v.duration > 0 && !v.paused && !v.ended) ||
                        agg.find(v => v.duration > 0) || agg[0] || null;

    if (activeVideo && isFinite(activeVideo.duration) && activeVideo.duration > 0) {
      const pct = Math.min(100, Math.max(0, (activeVideo.currentTime / activeVideo.duration) * 100));
      progressText.textContent = `当前 ${fmtTime(activeVideo.currentTime)} / ${fmtTime(activeVideo.duration)}`;
      progressPct.textContent = pct.toFixed(0) + '%';
      progressFill.style.width = pct + '%';
    } else {
      progressText.textContent = '当前进度 --:-- / --:--';
      progressPct.textContent = '0%';
      progressFill.style.width = '0%';
    }

    const bestList = pickBestList() || { all: [], current: null, completed: [], pending: [], leafCount: 0 };
    const total = bestList.all.length;
    const done = bestList.completed.length;
    const pend = bestList.pending.length;
    const cur = bestList.current ? 1 : 0;

    if (total > 0) {
      const coursePct = total > 0 ? Math.round(((done + cur) / total) * 100) : 0;
      stats.innerHTML = `<span class="ap-stat ap-done">已播 ${done}</span><span class="ap-stat ap-cur">播放中 ${cur}</span><span class="ap-stat ap-pend">待播 ${pend}</span>` +
                        `<div class="ap-course-bar"><div class="ap-course-fill" style="width:${coursePct}%"></div></div><div class="ap-course-pct">课程总进度 ${coursePct}%</div>`;
    } else {
      stats.innerHTML = '';
    }

    const frameCount = Object.keys(frameStates).length;
    info.textContent = `检测到 ${agg.length} 个视频（${frameCount} 帧） · 目录 ${total} 项`;

    updateLogs();
  }

  function updateLogs() {
    if (!panel) return;
    const logs = panel.querySelector('#ap-logs');
    if (!logs.classList.contains('ap-logs-show')) return;
    const html = TOP_LOGS.slice(-15).map(l => `<div class="ap-log-line">${escapeHtml(l)}</div>`).join('');
    logs.innerHTML = html || '<div class="ap-log-line">暂无日志</div>';
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (ox + e.clientX - sx) + 'px';
      el.style.top = (oy + e.clientY - sy) + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ---------- 跨帧通信 ----------
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__autoPlayer !== true) return;

    if (d.type === 'state') {
      if (IS_TOP) {
        frameStates[d.frameId] = { videos: d.videos || [], list: d.list || { all: [], current: null, completed: [], pending: [] }, frameTag: d.frameTag, frameUrl: d.frameUrl, ts: d.ts || Date.now() };
      }
      return;
    }

    if (d.type === 'log' && IS_TOP) {
      TOP_LOGS.push(d.text);
      if (TOP_LOGS.length > MAX_LOGS) TOP_LOGS.shift();
      updateLogs();
      return;
    }

    if (d.type === 'ping') {
      // 收到 ping 立即扫描上报
      analyzeAndReport();
      return;
    }

    if (d.type === 'dumpCatalog' && d.broadcastDown) {
      // 子帧把自己的目录 HTML 上报给顶层，供“复制目录HTML”使用
      try {
        analyzeList();
        if (localList.container) {
          const html = localList.container.outerHTML || '';
          postToTop({ type: 'catalogHtml', html: html.slice(0, 300000), frameTag: getFrameTag() });
        }
      } catch (e) { postToTop({ type: 'log', text: 'dumpCatalog error ' + e.message }); }
      return;
    }

    if (d.type === 'catalogHtml' && IS_TOP) {
      if (d.html && d.html.length > (catalogHtmlBuffer || '').length) catalogHtmlBuffer = d.html;
      if (pendingCatalogCopy) {
        pendingCatalogCopy = false;
        const ok = copyText(catalogHtmlBuffer);
        log(ok ? '目录HTML已复制（长度 ' + catalogHtmlBuffer.length + '）' : '复制失败');
      }
      return;
    }

    if (d.type === 'clickNext' && d.broadcastDown) {
      // 仅目标帧执行，避免多个 iframe 同时点击导致乱跳
      if (d.bestFrameTag && getFrameTag() !== d.bestFrameTag) {
        broadcastDown({ type: 'clickNext', bestFrameTag: d.bestFrameTag, manual: d.manual });
        return;
      }
      const ok = clickNext(true, !d.manual);
      if (ok) {
        postToTop({ type: 'log', text: getFrameTag() + ' 已执行下一集跳转' });
        return;
      }
      // 本帧没有目录或执行失败，继续向下级 iframe 广播
      broadcastDown({ type: 'clickNext', bestFrameTag: d.bestFrameTag, manual: d.manual });
      return;
    }

    if (d.type === 'ended' && IS_TOP) {
      if (!d.handled && settings.enabled && settings.autoNext) {
        if (Date.now() - lastGlobalNextAt < 8000) return;
        lastGlobalNextAt = Date.now();
        const best = pickBestFrameForNext();
        if (best) {
          if (best.isTop) {
            log('顶层执行下一集');
            clickNext(true, true);
          } else {
            log('委派下一集到', best.frameTag);
            broadcastDown({ type: 'clickNext', bestFrameTag: best.frameTag, manual: false });
          }
        } else {
          log('未找到有效目录帧，无法自动下一集');
        }
      }
    }
  });

  // ---------- 初始化 ----------
  function analyzeAndReport() {
    try {
      analyzeList();
    } catch (e) { log('analyzeList error', e.message); }
    reportVideoState();
  }

  function init() {
    loadSettings(() => {
      observe();
      if (IS_TOP) {
        ensureUI();
        if (infoTimer) clearInterval(infoTimer);
        infoTimer = setInterval(() => {
          analyzeAndReport();
          if (panel) updateInfo();
          // 定时 ping 子帧，防止 iframe 加载晚于 content script（降低频率减少开销与风险）
          broadcastDown({ type: 'ping' });
        }, 3000);
        setInterval(scanVideos, 2000);
        setInterval(() => {
          const now = Date.now();
          for (const k of Object.keys(frameStates)) {
            if (now - frameStates[k].ts > 15000) delete frameStates[k];
          }
        }, 5000);
        log('顶层初始化完成', location.href);
      } else {
        setInterval(() => { analyzeAndReport(); }, 1500);
        setInterval(scanVideos, 2000);
        log('子帧初始化完成', location.href);
      }
    });
  }

  // 等待 document 和 iframe 内部资源尽量就绪后再开始
  function runInit() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        setTimeout(init, 300);
      });
    } else {
      setTimeout(init, 300);
    }
    // 页面完全加载后再扫一次（处理 iframe 晚加载）
    window.addEventListener('load', () => {
      setTimeout(() => {
        scanVideos();
        analyzeAndReport();
      }, 1000);
    });
  }

  runInit();
})();
