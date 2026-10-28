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
// 自动连播助手 - 内容脚本（仅在常见视频/网课平台注入）
(function () {
  'use strict';

  const IS_TOP = (() => {
    try { return window.self === window.top; } catch (e) { return false; }
  })();

  // 已知视频/网课平台域名：顶层 frame 在这些网站或包含 video 元素时正常工作。
  // 其余页面顶层 frame 直接退出，不绑定事件、不创建面板，避免无关网页触发。
  const KNOWN_VIDEO_HOSTS = [
    'webtrn.cn', 'jxnu.edu.cn', 'bilibili.com', 'youku.com', 'iqiyi.com', 'v.qq.com',
    'study.163.com', 'icourse163.org', 'xuetangx.com', 'zhihuishu.com',
    'imooc.com', 'chaoxing.com', 'open.163.com', 'ke.qq.com', 'gaodun.com',
    'gaoxiaobang.com', 'duobei.com', 'xuexi.cn', 'docin.com', 'doc88.com',
    'youtube.com', 'vimeo.com', 'twitch.tv', 'douyin.com', 'kuaishou.com',
    'huya.com', 'douyu.com'
  ];

  // ---------------------------------------------------------------------------
  // 平台策略隔离（v2.0.0）
  // 目的：让每个平台的专属逻辑拥有明确的边界，改动其中一个平台时不会波及另一个。
  //  - whitelist 由域名自动判定 → ACTIVE_PROFILE
  //  - 平台专属代码块统一走 profileAllows(id) 准入
  //  - 未识别的平台归为 'generic'，此时两套专属逻辑都被放行（向后兼容，
  //    不会因为平台换了域名就彻底失效）
  //  - 前台可单独关闭某个平台：关闭后该域名上扩展完全不动（早退）
  // ---------------------------------------------------------------------------
  const PLATFORMS = [
    {
      id: 'whaty', name: '网梯科技', hosts: ['webtrn.cn'],
      desc: '.s_point 目录 · completestate 完成标记',
      frozen: true  // 已冻结：非必要不再改动，改动必须通过 tests/selftest_whaty_frozen.js
    },
    {
      id: 'jxnu', name: '江西师范大学', hosts: ['jxnu.edu.cn'],
      desc: '百家云播放器接管 · 目录百分比进度'
    },
    { id: 'generic', name: '通用兜底', hosts: [], desc: '其余视频站点的基础连播能力' }
  ];
  const PLATFORM_IDS = PLATFORMS.map(p => p.id);

  function detectPlatformByHost() {
    const h = (location.hostname || '').toLowerCase();
    for (const p of PLATFORMS) {
      for (const d of p.hosts) {
        if (h === d || h.endsWith('.' + d)) return p.id;
      }
    }
    return 'generic';
  }

  let ACTIVE_PROFILE = 'generic';
  function refreshProfile() { ACTIVE_PROFILE = detectPlatformByHost(); return ACTIVE_PROFILE; }
  function platformInfo(id) { return PLATFORMS.filter(p => p.id === (id || ACTIVE_PROFILE))[0] || PLATFORMS[2]; }
  function plateinfoFrozen() { const p = platformInfo(); return !!p.frozen; }

  // 某个平台的前台开关是否打开（默认全部开启）
  function platformEnabled(id) {
    const ps = settings.platforms;
    if (!ps || typeof ps !== 'object') return true;
    return ps[id] !== false;
  }
  // 当前页面所属平台是否被允许工作
  function activePlatformAllowed() { return platformEnabled(ACTIVE_PROFILE); }

  // 平台专属代码的准入闸门：
  //   明确处于该平台 → 放行；明确处于"另一个"平台 → 拦住（这就是隔离的核心）；
  //   处于 generic（未识别到已知平台）→ 放行，避免平台换域名后功能整体失效。
  function profileAllows(id) {
    if (ACTIVE_PROFILE === id) return platformEnabled(id);
    if (ACTIVE_PROFILE === 'generic') return true;
    return false;
  }

  function isKnownHost() {
    const h = (location.hostname || '').toLowerCase();
    for (let i = 0; i < KNOWN_VIDEO_HOSTS.length; i++) {
      const k = KNOWN_VIDEO_HOSTS[i];
      if (h === k || h.endsWith('.' + k)) return true;
    }
    return false;
  }

  function hasVideoElement() {
    try { return document.querySelectorAll('video').length > 0; } catch (e) { return false; }
  }

  // 顶层 frame 严格早退：不在已知平台且没有 video 元素时，不绑定监听、不建面板、不扫描。
  // 注意：v1.8.8 起 content script 在 document_start 运行（为抢在播放器库之前装
  // Shadow DOM 钩子），此时 DOM 还没解析、video 元素多半不存在，因此把判断
  // 延迟到 init() 里做 —— 若在顶层立即判断，带视频的普通网页会被误判早退。
  function shouldEarlyExit() {
    // 前台关闭了当前页面所属平台：连面板都不建，彻底不动作
    if (!activePlatformAllowed()) return true;
    return IS_TOP && !isKnownHost() && !hasVideoElement();
  }

  // ==========================================================================
  // 商业授权闸门（v2.1.0，v2.1.1 起为程序级授权：不绑定域名/平台）
  // 未授权 → 插件完全不工作：不扫描、不起播、不建面板、不注册看门狗，
  // 只在页面上给出联系作者获取授权的提示卡。授权码的签发/校验在 license.js
  // （APLicense），此处只负责"拿码 → 判定 → 放行或拦下"。
  // ==========================================================================
  function verifyCurrentLicense() {
    if (typeof APLicense === 'undefined' || !APLicense || typeof APLicense.verifyLicense !== 'function') {
      // license.js 未被注入（异常情况）：按未授权处理，商业策略不因缺文件而失效
      return { ok: false, reason: 'missing', msg: '授权模块加载失败' };
    }
    // 程序级授权（v2.1.1）：不传域名，任何网站同一授权码均有效
    return APLicense.verifyLicense(licenseKey, '', Date.now());
  }

  function checkLicense(cb) {
    try {
      chrome.storage.sync.get({ licenseKey: '' }, (res) => {
        const v = (res && typeof res.licenseKey === 'string') ? res.licenseKey : '';
        if (v) licenseKey = v;
        licenseState = verifyCurrentLicense();
        if (cb) cb();
      });
    } catch (e) {
      licenseState = verifyCurrentLicense();
      if (cb) cb();
    }
  }

  // 授权码在 popup / 其他标签页被激活或清除后的重新判定
  function recheckLicense() {
    const prevOk = !!(licenseState && licenseState.ok);
    licenseState = verifyCurrentLicense();
    if (licenseState.ok) {
      hideLicenseOverlay();
      if (!prevOk && !fullStarted) { log('授权已生效：' + licenseState.msg); boot(); }
      return;
    }
    // 授权被清除 / 变为无效：立刻停手并提示（没有授权就无法使用）
    log('授权已失效：' + licenseState.msg);
    if (fullStarted) enterStandby('授权失效');
    showLicenseOverlay();
  }

  function licenseAuthor() {
    return (typeof APLicense !== 'undefined' && APLicense && APLicense.AUTHOR)
      ? APLicense.AUTHOR : { name: '', contact: '' };
  }

  function showLicenseOverlay() {
    if (!IS_TOP) return;
    hideLicenseOverlay();
    const st = licenseState || { ok: false, msg: '未授权' };
    const author = licenseAuthor();
    const reason = (typeof APLicense !== 'undefined' && APLicense.reasonText)
      ? APLicense.reasonText(st) : ('未授权，' + (author.contact || '请联系作者获取授权'));
    const card = document.createElement('div');
    card.id = 'ap-license-card';
    // 标记为扩展自有元素：页面级扫描（找下一集按钮/播放按钮/目录）必须跳过它
    card.setAttribute('data-ap-own', '1');
    card.innerHTML =
      '<div class="ap-lic-title">🔒 插件未授权</div>' +
      '<div class="ap-lic-reason">' + escapeHtml(reason) + '</div>' +
      '<div class="ap-lic-author">作者：' + escapeHtml(author.name || '') +
        (author.contact ? '<br>联系方式：' + escapeHtml(author.contact) : '') + '</div>' +
      '<div class="ap-lic-row">' +
        '<input class="ap-lic-input" id="ap-lic-input" type="text" placeholder="粘贴授权码（空格/连字符均可）" spellcheck="false">' +
        '<button class="ap-lic-btn" id="ap-lic-btn">激活</button>' +
      '</div>' +
      '<div class="ap-lic-foot">激活成功后自动生效，无需刷新页面</div>';
    (document.body || document.documentElement).appendChild(card);
    const btn = card.querySelector('#ap-lic-btn');
    const input = card.querySelector('#ap-lic-input');
    const doActivate = () => tryActivate(input ? input.value : '');
    if (btn) btn.addEventListener('click', doActivate);
    if (input) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doActivate(); });
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 50);
    }
  }

  function hideLicenseOverlay() {
    try {
      const old = document.getElementById('ap-license-card');
      if (old && old.parentNode) old.parentNode.removeChild(old);
    } catch (e) {}
  }

  // 页面提示卡里输入授权码 → 校验 → 通过则写入 storage 并立即启动
  function tryActivate(raw) {
    const st = (typeof APLicense !== 'undefined' && APLicense.verifyLicense)
      ? APLicense.verifyLicense(raw, '', Date.now())
      : { ok: false, msg: '授权模块加载失败' };
    licenseState = st;
    if (!st.ok) {
      log('授权码校验失败：' + st.msg);
      showLicenseOverlay(); // 重新渲染，展示具体失败原因
      return st;
    }
    licenseKey = (typeof raw === 'string') ? raw : '';
    try { chrome.storage.sync.set({ licenseKey: licenseKey }, () => { void chrome.runtime.lastError; }); } catch (e) {}
    hideLicenseOverlay();
    log('授权通过：' + st.msg);
    if (!fullStarted) boot();
    return st;
  }

  // ==========================================================================
  // 启动状态机（v2.1.0）
  // 旧行为：域名在白名单里就建面板 + 3s 心跳，于是白名单站的普通页面（首页、
  // 空间页等没有视频的页面）也永远挂着面板 —— "任何网页都蹦出插件"的成因。
  // 新行为：
  //   boot() → 检测到播放内容特征 → startFull() 完整启动
  //          → 没有任何特征       → startProbe() 只挂一个轻量 MutationObserver
  //          → 8 秒后仍无特征     → enterStandby() 停掉一切主动行为
  // 待命期间观察器保留：页面之后真的出现播放内容（SPA 路由、延迟加载）会自动唤醒。
  // ==========================================================================
  let fullStarted = false;
  let mainMo = null;          // observe() 建立的主观察器
  let probeMo = null;         // 待命观察器（enterStandby 后唯一保留的东西）
  let tickTimers = [];        // startFull 建立的全部定时器（enterStandby 时统一清）
  let watchdogPingTimer = null;
  const PROBE_WINDOW = 8000;

  function isKnownIframeSrc(src) {
    try { return isKnownHost(new URL(src, location.href).hostname); } catch (e) { return false; }
  }

  // 页面是否存在"值得启动"的播放内容特征。
  // 宁可放宽（误判的代价只是面板出现，与旧行为一致），不可漏判（漏判=功能不工作）。
  function hasPlaybackHints() {
    try {
      if (document.querySelector(
        'video, audio[src], object, embed, .s_point,' +
        '[class*=bplayer], [class*=course-detail], [id*=learnMenu],' +
        '[class*=player], [id*=player], [class*=video], [id*=video]'
      )) return true;
      const frames = document.querySelectorAll('iframe[src]');
      for (let i = 0; i < frames.length; i++) {
        if (isKnownIframeSrc(frames[i].src)) return true;
      }
    } catch (e) {}
    return false;
  }

  function boot() {
    if (fullStarted) return;
    if (hasPlaybackHints()) { startFull(); return; }
    startProbe();
  }

  function startProbe() {
    log('未检测到播放内容，进入待命观察（不建面板、不扫描）');
    let last = 0;
    if (typeof MutationObserver === 'function') {
      try {
        probeMo = new MutationObserver(() => {
          const now = Date.now();
          if (now - last < 500) return;
          last = now;
          if (fullStarted) return;
          if (hasPlaybackHints()) startFull();
        });
        probeMo.observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }
    setTimeout(() => { if (!fullStarted) enterStandby(); }, PROBE_WINDOW);
  }

  // 停掉一切主动行为，但保留待命观察器（页面出现播放内容时自动 startFull 唤醒）
  function enterStandby(reason) {
    tickTimers.forEach(t => { try { clearInterval(t); } catch (e) {} });
    tickTimers = [];
    if (watchdogPingTimer) { try { clearInterval(watchdogPingTimer); } catch (e) {} watchdogPingTimer = null; }
    watchdogRegistered = false;
    // SPA 轮询定时器随待命清除；监听器保留（有 fullStarted 守卫，不会误动作），
    // 唤醒时 watchSpaRoute 会按需重建轮询（spaPollTimer 已置 null）
    if (spaPollTimer) { try { clearInterval(spaPollTimer); } catch (e) {} spaPollTimer = null; }
    // 自定义播放器的起播复查定时器（3s/8s/16s 三连）待命时全部作废
    customRecheckTimers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
    customRecheckTimers = [];
    if (mainMo) { try { mainMo.disconnect(); } catch (e) {} mainMo = null; }
    if (panel && panel.parentNode) { try { panel.parentNode.removeChild(panel); } catch (e) {} }
    panel = null;
    fullStarted = false;
    try { chrome.runtime.sendMessage({ type: 'apUnregister' }, () => { void chrome.runtime.lastError; }); } catch (e) {}
    log('扩展已待命收手：' + (reason || '页面没有播放内容') + '（发现播放内容会自动恢复）');
  }

  const DEFAULTS = {
    enabled: true,
    // 各平台是否启用（前台可勾选）。关闭的平台所属域名上，扩展完全不动作。
    platforms: { whaty: true, jxnu: true, generic: true },
    // 「进入页面 / 跳到下一集后，自动开始播放第一次」——连播的核心诉求，默认开启。
    // 与 autoResume 的区别：autoResume 是"已在播却停了要不要救回来"（受平台检测风险约束，
    // 默认关闭）；autoStart 只负责每一节的首次起播，之后若用户主动暂停就不会再插手。
    autoStart: true,
    autoResume: false,     // 默认关闭自动续播，降低被平台检测为违规插件的风险
    autoNext: true,
    resumeDelay: 1200,
    speedEnabled: false,   // 默认关闭倍速，避免与平台倍速冲突或触发检测
    playbackRate: 1,       // 默认 1 倍速，最高 5 倍速
    debug: false
  };

  // 可选倍速档位（最高 5x）
  const SPEED_OPTIONS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5];

  let settings = Object.assign({}, DEFAULTS);
  const boundVideos = new WeakSet();
  // 用户主动暂停的视频：前台可见时的暂停（且未开启自动续播）视为人为操作，
  // 保播/起播逻辑不得抢启，避免和用户"手动暂停"打架；重新播放后自动解除。
  const userPaused = new WeakSet();
  // 运行时已完成记账：部分 SPA 平台（如 jxnu zjpt）跳转后 URL 与目录高亮不变、
  // 完成状态延迟更新，若不本地记账会反复跳回同一集。
  // 带 10 分钟有效期：万一当前项识别偶发错误，误标的课时会自行恢复为"未完成"，
  // 不会永久跳过，保证"播完自动补齐漏看课时"的能力不受影响。
  const localDoneMap = new Map(); // el -> 记账时间戳
  const LOCAL_DONE_TTL = 10 * 60 * 1000;
  function markLocalDone(el) {
    try { if (el) localDoneMap.set(el, Date.now()); } catch (e) {}
  }
  let currentVideo = null;
  let lastEndedVideo = null;
  let handlingEnd = false;
  let lastClickAt = 0;
  let panel = null;
  let infoTimer = null;

  // video 元素清单缓存（v2.1.2 性能优化）。
  // queryVideos() 会用 querySelectorAll('*') 遍历全文档每一个元素来查找 shadow
  // 宿主，而它原先被状态上报（1.5s）、保播（3s）、倍速应用、目录兜底等多条路径
  // 高频重复调用，大页面（上万元素）下是主要 CPU 热点。
  // 策略：绑定路径 scanVideos() 永远全量刷新（保证新 video 立即绑上事件）；
  // 读取路径用 cachedVideoList() 取 1.5s TTL 缓存，新增元素由 MutationObserver
  // 即时触发 scanVideos 刷新，既不漏绑也不再重复全扫。
  let videoListCache = null;
  let videoListCacheAt = 0;
  function cachedVideoList() {
    if (videoListCache && Date.now() - videoListCacheAt < 1500) {
      // 过滤已脱离文档的（SPA 换课时后旧播放器被移除）。
      // 必须用 isConnected 而不是 document.contains：queryVideos 会把同源 iframe
      // 里的 video 也收进来，那些元素属于子文档，document.contains 对它们恒为 false。
      return videoListCache.filter(v => { try { return v.isConnected !== false; } catch (e) { return true; } });
    }
    return scanVideos();
  }

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
  const SETTINGS_VERSION = '2.0.0';
  // 授权码（chrome.storage.sync 的 licenseKey，与 settings 同库不同义：settings 管行为，它管能不能用）
  let licenseKey = '';
  let licenseState = null;
  function loadSettings(cb) {
    try {
      chrome.storage.sync.get(Object.assign({ settingsVersion: '', licenseKey: '' }, DEFAULTS), (res) => {
        const r = res || {};
        settings = Object.assign({}, DEFAULTS, r);
        licenseKey = typeof r.licenseKey === 'string' ? r.licenseKey : '';
        // platforms 可能被存成不完整对象或 null（其他版本写入过），补齐缺失项，缺的一律视为启用
        const ps = (settings.platforms && typeof settings.platforms === 'object') ? settings.platforms : {};
        settings.platforms = {};
        PLATFORM_IDS.forEach(id => { settings.platforms[id] = ps[id] !== false; });
        // 只在"从未初始化过"时补写默认值与版本号。
        // 旧版本曾在这里每逢升级就强制把 autoResume 关掉 —— 那会把用户手动开启的选择
        // 悄悄抹掉（表现为"明明勾了自动续播却没反应"）。用户的选择必须被尊重。
        const virgin = !r.settingsVersion;
        if (virgin) {
          settings.autoResume = false;
          settings.autoStart = true;
        }
        // 旧版本没有 autoStart 字段：升级后按"已初始化"处理会读到 undefined，
        // 此处兜底为默认开启（否则升级后反而不会自动起播）。
        if (typeof settings.autoStart !== 'boolean') settings.autoStart = true;
        try {
          if (virgin) chrome.storage.sync.set({ autoResume: false, autoStart: true, settingsVersion: SETTINGS_VERSION });
        } catch (e) {}
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
      // 授权码在 popup 里被激活 / 清除：立即重新判定，失效则停手
      if ('licenseKey' in changes) {
        licenseKey = typeof changes.licenseKey.newValue === 'string' ? changes.licenseKey.newValue : '';
        recheckLicense();
      }
      if (dirty) {
        // platforms 可能被存成不完整对象，补齐缺失项，缺的一律视为启用
        const ps = (settings.platforms && typeof settings.platforms === 'object') ? settings.platforms : {};
        const fixed = {};
        PLATFORM_IDS.forEach(id => { fixed[id] = ps[id] !== false; });
        settings.platforms = fixed;
        if (changes.playbackRate || changes.speedEnabled) applySpeedToAll();
        if (IS_TOP) updateUI();
      }
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
  // 判断元素是否属于本扩展自己的悬浮面板。
  // 面板是注入到页面 DOM 里的，若不排除，扩展在页面里查找"下一集"按钮 / 播放按钮 /
  // 目录容器时会命中自己的按钮（例如面板上的"▶ 立即播放下一集"），导致点击无效。
  function isOwnEl(el) {
    try {
      return !!(el && el.closest && el.closest('[data-ap-own]'));
    } catch (e) { return false; }
  }

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
    // 排除本扩展自己的面板元素，避免把自己注入的按钮当成平台的按钮
    for (const el of els) if (isVisible(el) && !isOwnEl(el)) return el;
    return null;
  }

  // 派发一套完整的鼠标事件序列（pointerdown → mousedown → mouseup → click）。
  // Vue / Ant Design 这类框架常监听 pointerdown 或用 .self 修饰符，
  // 单纯 el.click() 不会触发它们的处理器，表现为"点了没反应"。
  function fireFullClick(el) {
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, detail: 1 };
      const seq = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      seq.forEach(type => {
        try {
          const E = (type === 'pointerdown' || type === 'pointerup') ? window.PointerEvent : window.MouseEvent;
          el.dispatchEvent(new E(type, common));
        } catch (e) {}
      });
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
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

  // 递归查询 video（open Shadow DOM + 同域 iframe + 同域 object/embed 嵌套文档）
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
      // 扫描同域 object/embed（也是嵌套浏览上下文，部分播放器藏在里面）
      root.querySelectorAll('object, embed').forEach(f => {
        try {
          const d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (d) queryVideos(d, depth + 1).forEach(v => out.push(v));
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

  // ---------- Shadow DOM 桥：找到藏在「关闭 shadowRoot」里的真实播放器 ----------
  // jxnu zjpt 等平台把课程播放器的 <video> 放在 closed Shadow DOM 里，
  // querySelectorAll 永远查不到（页面上可见的 video 全是摄像头/人脸检测空壳）。
  // 对策：把 shadow_bridge.js 注入页面主世界（先试内联 <script>，被页面 CSP 拦截
  // 就请 background 用 chrome.scripting 注入）。桥会截获 attachShadow 的 closed
  // 引用，把 video 状态写到 documentElement 的 data-ap-shadow-videos 属性，
  // 本侧轮询读取，并经 data-ap-cmd 下发 play/rate 命令。
  let shadowBridgeRequested = false;
  function injectShadowBridge() {
    if (shadowBridgeRequested) return;
    shadowBridgeRequested = true;
    const requestViaBackground = () => {
      try {
        chrome.runtime.sendMessage({ type: 'apInjectShadowBridge' }, () => { void chrome.runtime.lastError; });
      } catch (e) {}
    };
    // 三通道并行（桥脚本自带一次性守卫，重复注入无害）：
    // A. 同步内联：XHR 取回桥源码后以内联脚本执行 —— 在 document_start 阶段同步跑在
    //    所有页面脚本之前，保证 attachShadow 钩子先于播放器库安装（错过时机，
    //    closed shadowRoot 的引用就永远拿不到了）。这是 <script src> 异步加载给不了的保证。
    // B. 原生注册：background 已用 chrome.scripting.registerContentScripts(world:'MAIN',
    //    runAt:'document_start') 常驻注册，由浏览器在每帧文档创建时原生注入（首选，Chrome 111+）。
    // C. script src 直连 + D. chrome.scripting 主世界注入：兜底。
    let inlineOk = false;
    try {
      const url = chrome.runtime.getURL('shadow_bridge.js');
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, false); // 同步：确保钩子在本轮立即安装
      xhr.send(null);
      if (xhr.status === 200 && /__apShadowBridgeInstalled/.test(xhr.responseText)) {
        const s = document.createElement('script');
        s.textContent = xhr.responseText;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
        inlineOk = /^1@/.test(document.documentElement.getAttribute('data-ap-shadow-ok') || '');
      }
    } catch (e) {}
    try {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL('shadow_bridge.js');
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
    requestViaBackground();
    // 2s 后校验：桥是否真的装上了（原生注册的通道在重载扩展后的首个页面不生效，
    // 需要下一次导航才注入 —— 所以这里给用户明确提示）
    setTimeout(() => {
      try {
        const attr = document.documentElement.getAttribute('data-ap-shadow-ok') || '';
        const ok = /^1@/.test(attr);
        const timing = parseInt((attr.split('@')[1] || '0'), 10) || 0;
        const roots = document.documentElement.getAttribute('data-ap-shadow-roots');
        if (ok) {
          // 时机很关键：>1000ms 说明桥是后补注入的，attachShadow 钩子错过了
          // 早期创建的 closed 容器，"容器 0" 就不可信
          log('Shadow桥已注入（主世界，内联:' + (inlineOk ? '是' : '否') +
              '，时机:' + timing + 'ms' + (timing > 1000 ? ' ⚠偏晚' : '') + '）',
              '已截获关闭Shadow容器:', roots == null ? '0' : roots, '个');
        } else {
          log('Shadow桥注入未生效：请彻底关闭并重开浏览器后重试（原生注册需要重新导航才生效）');
        }
      } catch (e) {}
    }, 2000);
  }

  function readShadowVideos() {
    try {
      const raw = document.documentElement.getAttribute('data-ap-shadow-videos');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function shadowRealVideos() {
    return readShadowVideos().filter(v => v && !v.iframe);
  }

  function hasShadowVideo() {
    try { return shadowRealVideos().length > 0; } catch (e) { return false; }
  }

  // 把桥上报的 shadow video 转成与 getLocalVideoState 同构的数据，参与全局聚合
  function shadowAsState() {
    return shadowRealVideos().map(v => ({
      currentTime: v.t || 0,
      duration: v.d || 0,
      paused: !!v.p,
      ended: !!v.e,
      src: v.s || '',
      readyState: 1,
      real: true,
      from: 'shadow'
    }));
  }

  let lastShadowCmdAt = 0;
  function shadowCmd(action, value) {
    try {
      const now = Date.now();
      if (action === 'play' && now - lastShadowCmdAt < 800) return;
      if (action === 'play') lastShadowCmdAt = now;
      document.documentElement.setAttribute('data-ap-cmd', JSON.stringify({ action: action, value: value, ts: now }));
    } catch (e) {}
  }

  let shadowAnnounced = false;
  let lastShadowEndedHandledAt = 0;
  let lastShadowPlayLogAt = 0;
  // 周期检查：起播 / 倍速 / 播完跳下一集（仅顶层调度）
  function checkShadowVideos() {
    try {
      const vids = readShadowVideos();
      const real = vids.filter(v => v && !v.iframe);
      const crossFrames = vids.filter(v => v && v.iframe);
      if (!shadowAnnounced && (real.length || crossFrames.length)) {
        shadowAnnounced = true;
        log('已在关闭 Shadow DOM 中找到播放器：video', real.length, '个',
            crossFrames.length ? ('| 跨域iframe ' + crossFrames.length + '个: ' + crossFrames.map(f => f.iframe).join(' | ').slice(0, 300)) : '');
      }
      if (!IS_TOP || !settings.enabled) return;

      if (real.length) {
        // 起播：开启自动续播，或还没怎么播（ currentTime < 15，刚跳转来的新课时）。
        // v2.1.2：新课时首次起播改判 autoStart（与自定义播放器模块的冷启动口径
        // 一致）—— autoStart 才是"每一节第一次播放"的开关，autoResume 只管续播。
        const needPlay = real.some(v => !v.e && v.p &&
          (settings.autoResume || (settings.autoStart !== false && (v.t || 0) < 15)));
        if (needPlay) {
          // 同一播放命令最多每 15 秒提示一次，避免日志每 3 秒刷屏
          const nowP = Date.now();
          if (nowP - (lastShadowPlayLogAt || 0) > 15000) {
            lastShadowPlayLogAt = nowP;
            log('Shadow播放器未起播，下发播放命令');
          }
          shadowCmd('play');
        }
        // 倍速
        if (settings.speedEnabled) shadowCmd('rate', currentRate());
      }

      // 播完 → 下一集（顶层调度，8 秒去抖）
      const now = Date.now();
      if (settings.autoNext && real.some(v => v.e) && now - lastShadowEndedHandledAt > 8000) {
        lastShadowEndedHandledAt = now;
        log('Shadow播放器播完，自动下一集');
        try { if (localList.current) markLocalDone(localList.current.el); } catch (e) {}
        dispatchNext('Shadow播放器：', true);
      }
    } catch (e) {}
  }


  // ---------- 视频：暂停续播 ----------
  // force=true 表示绕过"暂停自动续播"开关强制恢复（用于页面不可见时的被动暂停）
  function resumeVideo(video, force) {
    if (!settings.enabled) return;
    if (!force && !settings.autoResume) return;
    if (!video || video.ended) return;
    if (!video.paused) return;
    // 后台定时器会被节流，被动恢复不再等待，尽快拉起播放
    const delay = force ? 0 : (settings.resumeDelay || 0);
    setTimeout(() => {
      if (!settings.enabled) return;
      if (!force && !settings.autoResume) return;
      if (!video.paused || video.ended) return;
      startPlayback(video);
    }, delay);
  }

  function onPause(e) {
    const video = e.target;
    if (!video || video.ended) return;
    // 页面不可见（窗口最小化 / 切到后台标签页）时发生的暂停，通常来自浏览器节流行为
    // 或平台的防挂机检测，而不是用户主动暂停 —— 这种应当尝试恢复，否则挂机看课会被中断。
    const passive = isDocHidden();
    if (passive) {
      userPaused.delete(video);
      log('检测到后台被动暂停，尝试恢复播放');
    } else if (!settings.autoResume && video.currentTime > 15) {
      // 前台且未开启"暂停自动续播"、且已经看了一会儿 —— 才认定为用户主动暂停，
      // 记录下来防止起播逻辑抢启。开头（currentTime <= 15）的暂停可能是平台切集、
      // 缓冲或防挂机导致的被动暂停，仍需要由 ensurePlaying 拉起（网梯平台常见）。
      userPaused.add(video);
    }
    resumeVideo(video, passive);
  }

  function onEnded(e) {
    const video = e.target;
    if (!settings.enabled || !settings.autoNext) return;
    if (handlingEnd && lastEndedVideo === video) return;
    handlingEnd = true;
    lastEndedVideo = video;
    userPaused.delete(video);
    log('视频播放结束');
    // 本地记账：把当前课时标记为已完成，防止平台完成状态延迟导致反复跳同一集
    try { if (localList.current && localList.current.el) markLocalDone(localList.current.el); } catch (err) {}
    const handled = clickNext(false, true);
    postToTop({ type: 'ended', handled: !!handled });
    setTimeout(() => { handlingEnd = false; }, 2000);
  }

  function onPlaying(e) {
    const video = e.target;
    currentVideo = video;
    userPaused.delete(video);
    if (video === lastEndedVideo) { lastEndedVideo = null; handlingEnd = false; }
    // 播放器可能在加载新视频时重置倍速，这里重新应用
    applySpeed(video);
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
        if (btn && isVisible(btn)) { btn.click(); return true; }
      } catch (e) {}
    }
    return false;
  }

  // 视频是否真的有可播放的媒体源（MSE/自定义播放器可能没有 src 属性）
  function hasMediaSource(v) {
    try {
      if (v.src || v.currentSrc) return true;
      if (v.srcObject) return true;
      if (v.querySelector && v.querySelector('source[src]')) return true;
    } catch (e) {}
    return false;
  }

  // 判断一个 video 是不是"真实可播放的媒体"，而不是页面模板里的空壳占位元素。
  // jxnu zjpt 等平台会把摄像头 / 人脸检测的 <video>（无 src、readyState=0、duration=NaN）
  // 常驻在页面上（父级如 show-face / show_camera / my-video）。这些元素既无法起播也读不到
  // 进度，若把它们当成"播放器已可控"，会直接关掉按目录进度驱动的兜底逻辑 ——
  // v1.8.6 之前"播完不跳下一集"正是栽在这里。
  function isRealVideo(v) {
    if (!v) return false;
    try {
      if (hasMediaSource(v)) return true;
      if (v.readyState > 0) return true;
      if (isFinite(v.duration) && v.duration > 0) return true;
      if (v.currentTime > 0) return true;
    } catch (e) {}
    return false;
  }

  // 同上，但作用于跨帧传递过来的纯数据对象（只有 currentTime/duration/src 等字段）
  function isRealVideoObj(o) {
    if (!o) return false;
    try {
      if (o.real === false) return false;
      if (o.src) return true;
      if (o.readyState > 0) return true;
      if (isFinite(o.duration) && o.duration > 0) return true;
      if (o.currentTime > 0) return true;
    } catch (e) {}
    return false;
  }

  // 点击播放器画面区域：绝大多数自定义播放器点击画面=播放/暂停切换。
  // 只在"目录进度确认卡住"的兜底路径调用（有进度反馈保护），不会打断正在播的视频。
  function clickVideoScreen() {
    const RE_PLAYER = /player|video|bofang|shipin|media/i;
    const RE_BAD = /face|camera|haij?\w*|danmu|danmaku|catalog|menu|list|panel|nav/i;
    let best = null, bestArea = 0;
    try {
      document.querySelectorAll('div, section').forEach(el => {
        if (isOwnEl(el)) return;
        const cls = (el.getAttribute('class') || '') + ' ' + (el.id || '');
        if (!RE_PLAYER.test(cls) || RE_BAD.test(cls)) return;
        if (!isVisible(el)) return;
        const r = el.getBoundingClientRect();
        const area = r.width * r.height;
        // 播放器画面通常占屏幕很大一块
        if (area > bestArea && r.width > 200 && r.height > 150) { best = el; bestArea = area; }
      });
      if (best) {
        fireFullClick(best);
        log('点击播放器画面区域：', ((best.getAttribute('class') || best.tagName) + '').slice(0, 40),
            '(', Math.round(best.getBoundingClientRect().width), 'x',
            Math.round(best.getBoundingClientRect().height), ')');
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 向播放器容器派发空格键：不少播放器绑定空格=播放/暂停。合成键盘事件虽然
  // isTrusted=false，但页面的 keydown 监听器照常触发。
  function pressSpaceOnPlayer() {
    try {
      const opts = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
      let el = null;
      try {
        document.querySelectorAll('div').forEach(d => {
          if (el) return;
          const cls = (d.getAttribute('class') || '');
          if (/player|video-box|my-video/i.test(cls) && isVisible(d) && !isOwnEl(d)) el = d;
        });
      } catch (e) {}
      const t = el || document.body;
      t.dispatchEvent(new KeyboardEvent('keydown', opts));
      t.dispatchEvent(new KeyboardEvent('keyup', opts));
      document.body.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.body.dispatchEvent(new KeyboardEvent('keyup', opts));
      log('已向播放器容器派发空格键（' + ((el && el.getAttribute('class')) || 'body').slice(0, 30) + '）');
      return true;
    } catch (e) { return false; }
  }

  // 页面级播放按钮兜底：用于"页面上找不到可控制的 video"（自定义播放器）的情况。
  // 只命中"明确的播放控件"，且排除下一集/倍速/全屏等干扰按钮，避免误点。
  function clickPagePlayButton() {
    const RE_BAD = /下一|上一|上一个|下一个|倍速|全屏|音量|静音|清晰度|弹幕|投屏|下载|收藏|暂停|目录|章节|课时/;
    const SELS = [
      '.vjs-big-play-button', '.vjs-play-control',
      '.bpx-player-ctrl-play', '.prism-play-btn',
      '.xgplayer-play', '.dplayer-play-icon',
      '.video-player-play', '.player-play-btn', '.play-btn',
      'button[aria-label*="播放"]', 'button[title*="播放"]',
      '[class*="play" i][class*="btn" i]', '[class*="play" i][class*="icon" i]',
      '[class*="bofang" i]',
      // 最后的宽泛兜底：任何类名含 play 的可见元素（已排除目录区与自身面板）
      '[class*="play" i]'
    ];
    try {
      for (const s of SELS) {
        let els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(s)); } catch (e) { continue; }
        for (const el of els) {
          if (isOwnEl(el)) continue;
          // 排除课程目录区：目录里的播放图标（如 anticon-play-circle）点了会跳课时，不是"恢复播放"
          try { if (localList.container && localList.container.contains(el)) continue; } catch (e) {}
          if (!isVisible(el)) continue;
          const t = (getAllText(el) || '').trim();
          const label = (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '');
          const cls = (el.getAttribute('class') || '');
          const all = t + ' ' + label + ' ' + cls;
          if (RE_BAD.test(t + ' ' + label)) continue;
          // 播放器控件：类名/文案含 play/播放，或可见文本就是"播放"
          if (/play|bofang/i.test(cls) || /播放|开始播放/.test(t + ' ' + label)) {
            fireFullClick(el);
            log('点击页面播放按钮：', (t || label || cls).slice(0, 30));
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  // ==================================================================
  // 无 <video> 元素的自定义播放器接管模块（canvas / WebAudio 型）
  // ------------------------------------------------------------------
  // jxnu zjpt 使用百家云 bplayer：画面渲染在 <canvas id="bplayer-ffplayer">，
  // 声音走 <audio class="bplayer-audio">（或 WebAudio），页面里根本没有 <video>。
  // 后果有三：① 面板读不到进度（永远 0%）；② 收不到 ended 事件（播完不跳下一集）；
  // ③ 所有"存在真实 video 才起播"的分支全部落空，连播彻底失效。
  // 对策：直接从播放器的 DOM / 控制条里读状态，点它自己的控件，并把它伪装成
  // 一条标准 video 状态（from:'custom'）注入既有流水线，复用 ended → 下一集逻辑。
  // 关键保护：本模块只在"本帧找不到真实可播 video"时生效，网梯等原生 video
  // 平台完全不会走到这里。
  // ==================================================================

  // 解析 "31:30" / "1:02:03" 形式的播放时间文本
  function parseClock(t) {
    if (t == null) return -1;
    const m = String(t).trim().match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return -1;
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (m[3]) return a * 3600 + b * 60 + parseInt(m[3], 10);
    return a * 60 + b;
  }

  // 从播放器 DOM 读出播放位置 / 总时长。
  // 坑点：百家云的时间容器是 <span class="text duration">（内部包着 played-time 与
  // total-time）。若用 [class*="duration"] 去找总时长，querySelector 会先命中这个外层
  // 容器，textContent 变成 "00:38/31:30"，parseClock 必然失败 → 时长永远是 0。
  // 因此这里：① 只用精确类名，跳过还包着其它时间元素的容器；② 实在选不到时，
  //    在播放器文本里按 "00:38 / 31:30" 的成对格式兜底扫描。
  function readPlayerClock(root) {
    const out = { cur: -1, dur: -1 };
    const grab = (sel, key) => {
      try {
        const els = root.querySelectorAll(sel);
        for (const el of els) {
          // 跳过容器：内部还嵌套着别的时间元素的一律不算叶子节点
          if (el.querySelector('[class*="time" i], [class*="duration" i]')) continue;
          const v = parseClock(el.textContent);
          if (v >= 0) { out[key] = v; return true; }
        }
      } catch (e) {}
      return false;
    };
    grab('.played-time, [class*="played-time" i], .current-time, [class*="current-time" i], .bplayer-current', 'cur');
    grab('.total-time, [class*="total-time" i], .duration-time, [class*="duration-time" i], .vjs-duration-display', 'dur');
    if (out.cur < 0 || out.dur < 0) {
      try {
        const txt = String(root.textContent || '').replace(/\s+/g, ' ');
        const m = txt.match(/(\d{1,3}:\d{2}(?::\d{2})?)\s*[\/／|]\s*(\d{1,3}:\d{2}(?::\d{2})?)/);
        if (m) {
          if (out.cur < 0) out.cur = parseClock(m[1]);
          if (out.dur < 0) out.dur = parseClock(m[2]);
        }
      } catch (e) {}
    }
    return out;
  }

  const CUSTOM_PLAYER_ROOT_SELS = [
    '.bplayer-wrap', '.bplayer-container', '.bplayer-media-wrap',
    '.prism-player', '.xgplayer', '.dplayer', '.vjs-player', '.jwplayer',
    '.player-container', '.player-wrap', '.video-player', '#play_box', '.play_box', '#player'
  ];

  // 找出页面上的自定义播放器容器（取面积最大的那个）
  // 结果做 500ms 缓存：本函数会被多个 tick 反复调用，每次遍历十余组选择器并读取
  // getBoundingClientRect（强制回流）会拖慢页面。
  //
  // 【平台隔离 v2.0.0】整个「无 <video> 的自定义播放器接管」模块是应 jxnu（百家云
  // bplayer）需求引入的，放在这里做总闸门：网梯 profile 下直接返回 null，
  // 于是后续所有自定义播放器逻辑都不会执行 —— 新平台的改动物理上无法影响网梯。
  let customRootCache = { el: null, ts: 0 };
  function findCustomPlayerRoot() {
    if (!profileAllows('jxnu')) return null;
    try {
      const c = customRootCache;
      if (c.el && Date.now() - c.ts < 500 && document.contains(c.el)) return c.el;
    } catch (e) {}
    const seen = new Set();
    let best = null, bestArea = 0;
    const tryAdd = (el) => {
      try {
        if (!el || !el.getBoundingClientRect || isOwnEl(el) || seen.has(el)) return;
        seen.add(el);
        // 目录区里的东西永远不是播放器
        if (localList.container && localList.container.contains(el)) return;
        const cls = (el.id ? el.id + ' ' : '') + (typeof el.className === 'string' ? el.className : '');
        if (!/bplayer|jwplayer|dplayer|xgplayer|videojs|vjs-|prism|player|video/i.test(cls)) return;
        // 必须具备播放器特征之一：canvas 画面 / media 元素 / 控制条按钮 / 时间显示
        const hasCanvas = !!el.querySelector('canvas');
        const hasMedia  = !!el.querySelector('audio, video, object, embed');
        const hasTime   = !!el.querySelector('[class*="played-time" i], [class*="total-time" i], [class*="current-time" i], [class*="duration" i]');
        const hasBtn    = !!el.querySelector('[class*="play-btn" i], [class*="play-control" i], [class*="play-icon" i]');
        if (!(hasCanvas || hasMedia || (hasTime && hasBtn))) return;
        if (!isVisible(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 120) return;
        const area = r.width * r.height;
        if (area > bestArea) { best = el; bestArea = area; }
      } catch (e) {}
    };
    try {
      CUSTOM_PLAYER_ROOT_SELS.forEach(s => {
        try { Array.prototype.forEach.call(document.querySelectorAll(s), tryAdd); } catch (e) {}
      });
    } catch (e) {}
    // 精细化：若选中的是播放器外层壳（#play_box / #player），而下级有带"播放状态类"的
    // 真正容器（如 .bplayer-wrap.bplayer-playing），改用它 —— 播放中/暂停的判定信号就在那上面，
    // 直接用外层壳会丢失这唯一的 UI 状态来源。
    if (best) {
      try {
        const inner = Array.prototype.slice.call(
          best.querySelectorAll('[class*="bplayer-wrap" i], [class*="player-wrap" i], [class*="player-container" i]')
        ).filter(el => {
          const c = (typeof el.className === 'string') ? el.className : '';
          return isVisible(el) && /bplayer-(playing|paused)|\bis-playing\b|\bis-paused\b/i.test(c);
        })[0];
        if (inner) best = inner;
      } catch (e) {}
    }
    customRootCache = { el: best, ts: Date.now() };
    return best;
  }

  // 读取自定义播放器的实时状态（当前时间 / 总时长 / 是否在播 / 是否播完）
  function readCustomPlayer() {
    const root = findCustomPlayerRoot();
    if (!root) return null;
    const st = { root: root, media: null, cur: 0, dur: 0, paused: true, ended: false, pct: -1, label: '' };
    // root 作用域内的 querySelector。
    // v2.1.2 修复：此前这里直接调用未定义的 pick()，"时长读不到"分支一进去就抛
    // ReferenceError，被外层 try 静默吞掉 —— playing 判定与进度条兜底整段丢失，
    // 自定义播放器会被永远当成"暂停中"。
    const pick = (sel) => { try { return root.querySelector(sel); } catch (e) { return null; } };
    try {
      const rootCls = (root.id ? root.id + ' ' : '') + (typeof root.className === 'string' ? root.className : '');
      st.label = String(rootCls).replace(/\s+/g, ' ').slice(0, 40);

      const media = root.querySelector('audio, video');
      // 只有当 media 元素真的加载了资源时才优先采信它。
      // 反例：<audio class="bplayer-audio"> 是百家云模板里的占位元素（无 src、
      // readyState 0、currentTime 恒为 0）——若采信它，播放位置会被永远读成 0。
      let usableMedia = false;
      try {
        let srcObjVal = null;
        try { srcObjVal = media && media.srcObject; } catch (e) {}
        usableMedia = !!media && (!!(media.src || media.currentSrc || srcObjVal || (media.querySelector && media.querySelector('source[src]'))) ||
                                 media.readyState > 0 || media.currentTime > 0);
      } catch (e) {}

      const clock = readPlayerClock(root);
      if (usableMedia) {
        st.media = media;
        st.cur = media.currentTime || 0;
        st.dur = isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
        st.paused = !!media.paused;
        st.ended = !!media.ended;
        // media 能拿到时长就信它，否则仍用控制条上的总时长文本
        if (!st.dur && clock.dur > 0) st.dur = clock.dur;
      } else {
        st.media = null;
        if (clock.cur >= 0) st.cur = clock.cur;
        if (clock.dur > 0) st.dur = clock.dur;
      }
      // 能否追踪播放位置（读不到就不能用"位置没动"当故障依据）
      st.trackable = usableMedia || clock.cur >= 0 || clock.dur > 0;
      // 进度百分比：优先用已播/总时长，否则读取度条宽度
      if (st.dur > 0) {
        st.pct = Math.min(100, Math.max(0, (st.cur / st.dur) * 100));
        if (st.cur >= st.dur - 1.5) st.ended = true;
      } else {
        const bar = pick('[class*="progress-played" i], [class*="progress-current" i], [class*="played-bar" i]');
        const w = bar && bar.style ? bar.style.width : '';
        const m2 = String(w || '').match(/([\d.]+)%/);
        if (m2) st.pct = parseFloat(m2[1]);
        const tEl = pick('[class*="played-time" i], [class*="current-time" i]');
        const ttEl = pick('[class*="total-time" i], [class*="duration" i]');
        const c2 = parseClock(tEl && tEl.textContent), d2 = parseClock(ttEl && ttEl.textContent);
        if (d2 > 0 && c2 >= 0 && c2 >= d2 - 2) st.ended = true;
      }

      // 播放状态判定：UI 信号优先（UI 最贴近用户感知），其次 media 元素
      let uiPlaying = null;
      if (/\bbplayer-playing\b|\bis-playing\b|\bplaying-state\b|\bpaused\b/i.test(rootCls)) {
        uiPlaying = /bplayer-playing|is-playing|playing-state/i.test(rootCls) && !/\bbplayer-paused\b|\bis-paused\b/i.test(rootCls);
      }
      if (uiPlaying === null) {
        const btn = pick('[class*="play-btn" i], [class*="play-control" i], [class*="play-icon" i]');
        if (btn) {
          const html = (btn.innerHTML || '').slice(0, 500);
          const bcls = (typeof btn.className === 'string') ? btn.className : '';
          const sig = bcls + ' ' + html;
          // 按钮显示的是"暂停条"，说明此刻正在播放
          if (/\b(pause|stop)\b|icon-pause|pause-icon/i.test(sig)) uiPlaying = true;
          else if (/\b(play)\b/i.test(sig)) uiPlaying = false;
        }
      }
      st.playing = (uiPlaying === null) ? (!!media && !media.paused && !media.ended) : uiPlaying;
    } catch (e) {}
    return st;
  }

  // 把自定义播放器伪装成标准 video 状态上报（仅在"本帧无真实 video"时注入）
  function customPlayerAsState() {
    try {
      if (cachedVideoList().some(isRealVideo)) return null;
      if (hasShadowVideo()) return null;
      const st = readCustomPlayer();
      if (!st) return null;
      return {
        currentTime: st.cur || 0,
        duration: st.dur || 0,
        paused: !st.playing,
        ended: !!st.ended,
        src: '',
        readyState: 1,
        real: true,
        from: 'custom'
      };
    } catch (e) { return null; }
  }

  function getCustomPlayer() {
    try { return readCustomPlayer(); } catch (e) { return null; }
  }

  // 起播动作级联（按"破坏性从小到大"排序，任何一种奏效即止）
  const customTry = { idx: 0, lastAt: 0 };
  function customPlayerPlay(step) {
    const st = readCustomPlayer();
    if (!st) return false;
    const root = st.root;
    const methods = [
      // ① 直接调 media.play()：幂等，已在播不会有任何副作用
      function m_media() {
        const m = st.media;
        if (!m || m.ended) return false;
        // 从未加载过资源的占位元素（如百家云模板里的 <audio class="bplayer-audio">）：
        // 对它调 play() 必然被拒，白等一轮重试，直接跳到点按钮的方式
        try {
          let srcObjVal = null;
          try { srcObjVal = m.srcObject; } catch (e) {}
          const hasSrc = !!(m.src || m.currentSrc || srcObjVal || (m.querySelector && m.querySelector('source[src]')));
          if (!hasSrc && m.readyState === 0 && !m.currentTime) return false;
        } catch (e) {}
        try {
          const p = m.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
          log('[自定义播放器] 调用 media.play()');
          return true;
        } catch (e) { return false; }
      },
      // ② 点播放器自带的播放/暂停按钮
      function m_btn() {
        const sels = ['[class*="play-btn" i]', '[class*="play-control" i]', '[class*="play-icon" i]',
                      'button[aria-label*="播放"]', '[class*="big-play" i]', '.vjs-big-play-button'];
        for (const s of sels) {
          let el = null;
          try {
            Array.prototype.forEach.call(root.querySelectorAll(s), x => { if (!el && isVisible(x)) el = x; });
          } catch (e) {}
          if (el) { fireFullClick(el); log('[自定义播放器] 点击自带播放按钮'); return true; }
        }
        return false;
      },
      // ③ 点画面（canvas）
      function m_canvas() {
        let el = null;
        try { Array.prototype.forEach.call(root.querySelectorAll('canvas'), x => { if (!el && isVisible(x)) el = x; }); } catch (e) {}
        if (el) { fireFullClick(el); log('[自定义播放器] 点击画面(canvas)'); return true; }
        return false;
      },
      // ④ 点画面容器
      function m_stage() {
        const el = (function () {
          for (const s of ['[class*="media-wrap" i]', '[class*="video-wrap" i]', '[class*="stage" i]', '[class*="screen" i]']) {
            try {
              const n = Array.prototype.slice.call(root.querySelectorAll(s)).filter(isVisible)[0];
              if (n) return n;
            } catch (e) {}
          }
          return null;
        })();
        if (el) { fireFullClick(el); log('[自定义播放器] 点击播放器画面区'); return true; }
        return false;
      },
      // ⑤ 派发空格键
      function m_key() {
        try {
          const o = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true };
          root.dispatchEvent(new KeyboardEvent('keydown', o));
          root.dispatchEvent(new KeyboardEvent('keyup', o));
          log('[自定义播放器] 派发空格键');
          return true;
        } catch (e) { return false; }
      }
    ];
    const start = (typeof step === 'number') ? step : customTry.idx;
    for (let k = 0; k < methods.length; k++) {
      const idx = (start + k) % methods.length;
      try {
        if (methods[idx]()) { customTry.idx = (idx + 1) % methods.length; return true; }
      } catch (e) {}
    }
    return false;
  }

  // 自定义播放器心跳：起播保活 + 播完跳下一集（精度到秒，远快于目录百分比驱动）
  let customPrev = { cur: -1, at: 0, key: '' };
  let customAnnounced = false;
  let customLastJumpAt = 0;
  let customIgnoreUntil = 0;   // 跳转后的"播完判定静默期"，防止读到上一节的收尾位置连跳两级

  // ---------- 冷启动：每一节的"第一次起播" ----------
  // 场景：刷新页面 / 点进某个课时 / 由本扩展跳到下一集之后，播放器停在暂停态，
  //       需要扩展代替用户点下第一个"播放"。
  // 它与「暂停自动续播」是两件事，必须分开：
  //   · autoResume 管"播着播着停了要不要救回来" —— 默认关闭以规避平台检测；
  //   · autoStart 只负责首次起播 —— 一旦播起来就永久收手，之后用户再暂停绝不插手。
  // 因此这里不能沿用 autoResume 那套 early/currentTime<15 的门槛：
  // 视频停在 25:01 这种"播放中途"的位置同样必须起播（这正是用户反馈的"必须人工点一次"）。
  let customBootAt = 0;        // 本次接管（或换源）的起始时刻
  let customBootBase = -1;     // 接管时的播放位置，用于识别"位置是否推进过"
  let customBooted = false;    // 本次接管是否已完成首次起播
  let customBootTries = 0;     // 已尝试轮次
  let customJumpSeen = 0;      // 已处理过的 lastClickAt 值
  const CUSTOM_BOOT_WINDOW = 8 * 60 * 1000;   // 冷启动尝试窗口
  const CUSTOM_BOOT_MAX = 6;                  // 最多尝试轮次，避免无限骚扰

  // 点完起播后按 3s / 8s / 16s 三次复查：没有真的播起来就升级到下一种点击方式。
  // 铁律：任何一条证据表明"已经在播了"都必须立刻收手 —— 继续点只会把它点成暂停。
  // v2.1.2：复查定时器句柄统一收集，每次重新调度前先作废未执行的旧句柄 ——
  // 否则播放卡住时每 6 秒触发一轮 customPlayerPlay 就多排 3 个 setTimeout，
  // 几分钟内能积压十几个，既浪费又可能在播放恢复后连环误点。
  let customRecheckTimers = [];
  function customPlayRecheck(base) {
    customRecheckTimers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
    customRecheckTimers = [];
    [3000, 8000, 16000].forEach(delay => {
      customRecheckTimers.push(setTimeout(() => {
        try {
          if (!settings.enabled) return;
          const s2 = readCustomPlayer();
          if (!s2) return;
          if (s2.ended || (s2.dur > 0 && s2.cur >= s2.dur - 2)) return;
          if (s2.playing) { customPrev.at = Date.now(); customBooted = true; return; }
          if (s2.cur > base + 0.5) { customPrev.at = Date.now(); customBooted = true; return; }
          customPlayerPlay();
        } catch (e) {}
      }, delay));
    });
  }

  // 认定为"换了一节课 / 页面重新打开过" → 冷启动状态重置，重新获得一次首次起播机会
  function customReboot(now, cur) {
    // 上一轮的起播复查定时器全部作废：它们持有的 base 是旧播放器的位置，
    // 若残留会在新课时上误判"位置没推进"而重复点击
    customRecheckTimers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
    customRecheckTimers = [];
    customBootAt = now;
    customBootBase = cur;
    customBooted = false;
    customBootTries = 0;
    customTry.idx = 0;          // 新播放器一律从最温和的方式重新开始
    customPrev.at = now;
    customPrev.cur = cur;
  }

  function customPlayerTick() {
    // 平台被前台停用 → 立刻停手（不撤掉面板，方便用户直接重新打开）
    if (!settings.enabled || !activePlatformAllowed()) return;
    let st = null;
    try { st = readCustomPlayer(); } catch (e) {}
    if (!st) { customPrev.key = ''; customAnnounced = false; return; }
    if (!customAnnounced) {
      customAnnounced = true;
      log('已接管自定义播放器（本页无 <video>）：', st.label,
          '| 位置', fmtTime(st.cur) + ' / ' + fmtTime(st.dur),
          '| 控件', st.trackable
            ? ('可追踪：' + (st.media ? ('media<' + st.media.tagName.toLowerCase() + '>') : '控制条文本'))
            : '读不到播放位置（只读 UI 状态）');
    }
    const now = Date.now();

    // 「换了新课时」的三个信号，任一命中都重开冷启动窗口：
    //   ① 播放器容器本身变了（root 类名不同）
    //   ② 本扩展刚发起过跳转（lastClickAt 变化）—— 解决"跳到下一集却不起播"
    //   ③ 播放位置大幅倒退 —— 用户手工点了别的课时
    // ② 尤其关键：SPA 平台切课时播放器 DOM 会被复用，root 类名可能完全一样，
    //   只靠 ① 会把"新的一节课"误认为"同一个播放器"，导致跳过去之后永远不起播。
    const newJump = lastClickAt && lastClickAt !== customJumpSeen;
    // 换 criteria: position dropped significantly relative to last seen
    const rewound = customBootBase >= 0 && st.cur < customBootBase - 5;
    if (customPrev.key !== st.label) {
      customPrev.key = st.label;
      if (newJump) customJumpSeen = lastClickAt;
      customReboot(now, st.cur);
      return;
    }
    if (newJump) { customJumpSeen = lastClickAt; customReboot(now, st.cur); return; }
    if (rewound) {
      customReboot(now, st.cur);
      log('[自定义播放器] 检测到切换课时（播放位置回到 ' + fmtTime(st.cur) + '），重新进入首次起播流程');
      return;
    }
    if (st.cur !== customPrev.cur) { customPrev.cur = st.cur; customPrev.at = now; }
    const stalled = now - customPrev.at;

    // ① 播完 → 下一集
    //    跳转后 20 秒内不做"播完"判定：SPA 平台切课时播放器是先复用再重建的，
    //    这期间读到的可能还是上一节的收尾位置，若立即判定播完会连跳跳过一节课。
    const finished = st.ended || (st.pct >= 99.5 && st.pct >= 0) || (st.dur > 0 && st.cur >= st.dur - 2);
    if (finished && now >= customIgnoreUntil) {
      if (!settings.autoNext) return;
      if (now - customLastJumpAt < 10000) return;
      // 目录进度驱动等其他路径刚跳转过：不重复跳转，交给新一轮播放器
      if (lastClickAt && now - lastClickAt < 20000) { customPrev.at = now; return; }
      customLastJumpAt = now;
      customPrev.at = now;
      customIgnoreUntil = now + 20000;
      try { if (localList.current) markLocalDone(localList.current.el); } catch (e) {}
      log('[自定义播放器] 已播完（' + fmtTime(st.cur) + ' / ' + fmtTime(st.dur) + '），自动下一集');
      dispatchNext('自定义播放器播完：', true);
      return;
    }
    // 处于跳转后的静默期且仍显示"已播完"（多半是上一节的残留状态）：
    // 刷新判停基准让新一轮播放器有干净计时，暂不重复跳转
    if (finished) { customPrev.at = now; return; }

    // ② 冷启动：本节第一次起播。不受 autoResume 约束，由 settings.autoStart 单独控制。
    //    冷启动期间独占出手权，避免与下面的保播逻辑重复点击把播放器来回切换。
    if (!customBooted) {
      if (settings.autoStart === false) return;
      // 已经播起来了 → 冷启动达成，窗口关闭
      if (st.playing || (customBootBase >= 0 && st.cur > customBootBase + 0.5)) {
        customBooted = true;
        return;
      }
      if (now - customBootAt > CUSTOM_BOOT_WINDOW || customBootTries >= CUSTOM_BOOT_MAX) return;
      // 给播放器挂载留时间：首次 2.5s 出手（刷新后要尽快开播），重试间隔 6s
      const wait = customBootTries === 0 ? 2500 : 6000;
      if (stalled >= wait && now - customTry.lastAt >= 5000) {
        customBootTries++;
        customTry.lastAt = now;
        customPrev.at = now;
        log('[自定义播放器] 尚未开始播放（停在 ' + fmtTime(st.cur) + ' / ' + fmtTime(st.dur) +
            '），执行首次自动起播');
        customPlayerPlay();
        customPlayRecheck(st.cur);
      }
      return;
    }

    // ③ 保播：本节已经播起来过、后来又停下。除非用户开了"暂停自动续播"，否则视为人为暂停，不救。
    //    判定基准是"播放位置若干秒没动"，而不是"看起来暂停了"。
    //    UI 明确显示"播放中"时给足耐心（90 秒）：控制条上的 bplayer-playing 是最贴近
    //    用户感知的真实状态，仅凭它没被观察到就出手，会把正在播的视频点成暂停。
    //    极端情况：读不到播放位置（trackable=false）且 UI 说在播 → 一律不动手。
    if (st.playing && !st.trackable) return;
    if (stalled < (st.playing ? 90000 : 8000)) return;
    if (now - customTry.lastAt < 6000) return;
    const early = st.cur <= 15;                                        // 几乎没开始播
    const justJumped = lastClickAt && (now - lastClickAt < 90000);      // 刚由本扩展跳过来
    if (!settings.autoResume && !early && !justJumped) return;
    customTry.lastAt = now;
    customPrev.at = now;
    log('[自定义播放器] 播放位置停在 ' + fmtTime(st.cur) + ' / ' + fmtTime(st.dur) +
        '（' + Math.round(stalled / 1000) + 's 未推进' + (st.playing ? '，但 UI 显示播放中' : '') + '），尝试起播');
    const base = st.cur;
    customPlayerPlay();
    // 复查：未推进则升级到下一种方式（新课时播放器常需几秒才挂载完成）
    customPlayRecheck(base);
  }

  // 启动播放：优先模拟点击播放按钮（更接近真人操作），失败再用 play() 兜底
  function startPlayback(video) {
    if (!video || video.ended) return false;
    try {
      if (!video.paused) return true;
      // 没有媒体源的空壳 video（部分平台模板里的占位元素）点了也没用
      if (!hasMediaSource(video)) return false;
      if (clickPlayButton(video)) return true;
      const p = video.play();
      if (p && typeof p.catch === 'function') {
        p.catch((err) => {
          log('play() 失败：', (err && err.name) || '未知', (err && err.message) || '');
          // 自定义播放器：video 不受控时退回到点击页面上的播放按钮
          clickPagePlayButton();
        });
      }
      return true;
    } catch (e) { return false; }
  }

  // 保持播放：供后台看门狗调用。
  // - 若用户开启了"暂停自动续播"，任何时候的暂停都尝试恢复；
  // - 否则只在视频几乎没开始播（currentTime 很小）时恢复，用于保证"跳到下一集后能真的播起来"，
  //   不会打断用户主动的中途暂停。
  let lastPagePlayAt = 0;
  function ensurePlaying() {
    if (!settings.enabled) return;
    if (!activePlatformAllowed()) return;
    try {
      const videos = cachedVideoList();
      // 只统计"真实可播"的 video：页面常驻的摄像头/人脸检测 <video> 一直处于 playing
      // 状态，若算进来会误判"已有视频在播"，把页面播放按钮兜底这条唯一出路也堵死。
      const playing = videos.some(v => isRealVideo(v) && !v.paused && !v.ended);
      let handled = 0;
      videos.forEach(v => {
        if (v.ended) return;
        if (userPaused.has(v)) return;
        if (!v.paused) return;
        // 没有媒体源的空壳 video（平台模板占位元素）起播没有意义，直接跳过
        if (!hasMediaSource(v)) return;
        handled++;
        // 部分平台自定义播放器（如 jxnu zjpt）duration 为 0/未知，不能因此放弃起播：
        // 未知时长时只按"几乎没有开始播"（currentTime < 2）来判断
        const unknownDur = !isFinite(v.duration) || v.duration <= 0;
        const early = unknownDur ? v.currentTime < 2 : v.currentTime < 15;
        if (!settings.autoResume && !early) return;
        if (early) log('视频未自动起播，尝试启动');
        startPlayback(v);
      });

      // 页面上没有任何可控 video（自定义播放器场景）：退化为点击页面播放按钮。
      // 仅在"刚跳转过（60 秒内）"或"用户开了自动续播"时才做，避免打断用户手动暂停。
      // 页面上只有空壳 video（自定义播放器 / 播放器不在 video 元素里）时才点页面播放按钮。
      // 注意：不能因为"当前有视频在播"以外的条件就乱点，否则可能把正在播的视频点暂停；
      // 真实 video 存在与否由 isRealVideo 判断，空壳（摄像头/占位）不算。
      // 若播放器已在关闭 Shadow DOM 中找到（桥已生效），交给 checkShadowVideos 下发命令，不点页面按钮。
      if (!handled && !playing && !videos.some(isRealVideo) && !hasShadowVideo()) {
        const now = Date.now();
        const justJumped = lastClickAt && (now - lastClickAt < 60000);
        if ((settings.autoResume || justJumped) && now - lastPagePlayAt > 30000) {
          lastPagePlayAt = now;
          log('未发现可控 video，尝试接管播放器');
          // 优先交给自定义播放器模块（带播放位置校验，不会把正在播的视频点成暂停）
          if (!getCustomPlayer()) clickPagePlayButton();
        }
      }
    } catch (e) {}
  }

  // ---------- 视频：倍速播放 ----------
  function currentRate() {
    const r = parseFloat(settings.playbackRate);
    return isFinite(r) && r > 0 ? r : 1;
  }

  function applySpeed(video) {
    if (!video) return;
    try {
      const rate = settings.speedEnabled ? currentRate() : 1;
      if (video.playbackRate !== rate) {
        video.playbackRate = rate;
      }
    } catch (e) {}
  }

  function applySpeedToAll() {
    try {
      cachedVideoList().forEach(applySpeed);
      // 关闭 Shadow DOM 里的播放器：经主世界桥下发倍率命令
      if (IS_TOP && hasShadowVideo()) shadowCmd('rate', currentRate());
    } catch (e) {}
  }

  function attachVideo(video) {
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('play', () => { currentVideo = video; userPaused.delete(video); applySpeed(video); });
    video.addEventListener('timeupdate', onTimeUpdate);
    // 立即应用一次倍速（若已开启）
    applySpeed(video);
    // 诊断：输出视频源与状态，便于判断哪些是真实播放器、哪些是模板占位元素
    try {
      const parentCls = (video.parentElement && typeof video.parentElement.className === 'string')
        ? video.parentElement.className.slice(0, 40) : '';
      log('绑定视频', (video.currentSrc || video.src || '(无src)'),
          '| 有源:', hasMediaSource(video),
          '| readyState:', video.readyState,
          '| duration:', video.duration,
          '| paused:', video.paused,
          '| class:', (typeof video.className === 'string' ? video.className : '').slice(0, 40),
          '| 父级:', parentCls);
    } catch (e) { log('绑定视频'); }
  }

  function scanVideos() {
    const videos = queryVideos(document);
    videoListCache = videos;
    videoListCacheAt = Date.now();
    videos.forEach(attachVideo);
    return videos;
  }

  function getLocalVideoState() {
    const arr = cachedVideoList().map(v => ({
      currentTime: v.currentTime || 0,
      duration: v.duration || 0,
      paused: v.paused,
      ended: v.ended,
      src: v.currentSrc || v.src || '',
      readyState: v.readyState || 0,
      real: isRealVideo(v)
    }));
    // 没有 <video> 的自定义播放器：伪装成一条标准状态上报，让面板进度、
    // 卡结尾检测、"播完自动下一集"等既有逻辑照常生效
    const cs = customPlayerAsState();
    if (cs) arr.push(cs);
    return arr;
  }

  function reportVideoState() {
    localVideos = getLocalVideoState().concat(shadowAsState());
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
    mainMo = mo; // 存句柄：enterStandby() 需要断开它
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
  // 【已冻结 v2.0.0】本函数及其相关分支不再随其他平台的开发改动；
  // 任何变更必须先让 tests/selftest_whaty_frozen.js 全绿。
  // 准入：仅在当前 profile 为网梯（或未识别平台的兼容模式）下执行，
  // 这样 jxnu 分支的改动在物理上不可能影响网梯以外的行为。
  function findWangtiCatalog(doc) {
    if (!profileAllows('whaty')) return null;
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
          if (isOwnEl(el)) return; // 排除本扩展自己的面板
          const score = looksLikeCatalogContainer(el);
          if (score >= 4) candidates.push({ el, score });
        });
      } catch (e) {}
    }
    doc.querySelectorAll('ul, ol').forEach(el => {
      if (el.offsetParent === null) return;
      if (isOwnEl(el)) return; // 排除本扩展自己的面板
      const score = looksLikeCatalogContainer(el);
      if (score >= 6) candidates.push({ el, score });
    });
    if (!candidates.length) {
      doc.querySelectorAll('div').forEach(el => {
        if (el.offsetParent === null) return;
        if (isOwnEl(el)) return; // 排除本扩展自己的面板
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
  // v2.1.2 性能：analyzeList 每 1.5~3 秒被调用一次，而本函数会跑三十多组
  // querySelectorAll 全文档扫描 + 对每个候选读 getBoundingClientRect（强制回流），
  // 是页面 CPU 占用的另一大热点。目录容器结构本身变化缓慢，加 1.2s TTL 缓存
  // （document.contains 校验）：SPA 换课时旧容器被移除会立即失效重扫，
  // clickNext 的跳转后校验（+2s）也必然拿到新结果，不影响正确性。
  let catalogContainerCache = { el: null, ts: 0 };
  function findCatalogContainer(root) {
    root = root || document;
    if (root === document) {
      try {
        if (catalogContainerCache.el && Date.now() - catalogContainerCache.ts < 1200 &&
            document.contains(catalogContainerCache.el)) {
          return catalogContainerCache.el;
        }
      } catch (e) {}
    }
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
    const result = candidates.length ? candidates[0].el : null;
    if (root === document) catalogContainerCache = { el: result, ts: Date.now() };
    return result;
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
    // 【平台隔离】仅网梯 profile 下生效，避免在整站开了 Anti-Design 结构的其他平台上被误命中
    const sPoints = profileAllows('whaty')
      ? Array.from(container.querySelectorAll('.s_point[itemtype="video"]'))
      : [];
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
      // 排除播放器内部控件（时长、画质、进度条、倍速菜单等）
      if (isPlayerControl(it.el)) return false;
      return true;
    });

    // 只保留真正带播放时长的视频课时，剔除「第X讲」「章节」等非视频项
    const withDuration = leaves.filter(it => /\d{1,2}:\d{2}(:\d{2})?/.test(it.text));
    if (withDuration.length >= 2 && withDuration.length < leaves.length) {
      leaves = withDuration;
    }

    // 兜底：SPA 平台（Vue/React）的目录项常无典型 class、无时长文本，
    // 此时按"同级重复结构"识别：容器下 tag+首个类名相同且数量 >= 2 的一组元素。
    if (leaves.length < 2) {
      const groups = new Map();
      Array.from(container.children).forEach(c => {
        if (!c || c.nodeType !== 1) return;
        const cls = (typeof c.className === 'string' ? c.className : '').split(/\s+/)[0] || '';
        const key = c.tagName + '|' + cls;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      });
      let best = null;
      groups.forEach(arr => {
        if (arr.length >= 2 && (!best || arr.length > best.length)) best = arr;
      });
      if (best) {
        const fallbackLeaves = best
          .filter(el => !isPlayerControl(el))
          .map(el => ({ el, text: getAllText(el), score: getItemScore(el) }))
          .filter(it => (it.text || '').trim().length >= 2);
        if (fallbackLeaves.length >= 2) {
          log('目录项兜底识别：同级重复结构', fallbackLeaves.length, '项');
          leaves = fallbackLeaves;
        }
      }
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
    // 【平台隔离】仅网梯 profile 下采信；在其他平台上这个属性可能有别的含义
    if (profileAllows('whaty')) {
      const completeState = el.getAttribute('completestate');
      if (completeState === '1' || completeState === 'true') return 'completestate';
    }

    // 目录项文本里的学习进度百分比（如 "100%"、"100.0%"）达到 100 视为已完成。
    // jxnu zjpt 等平台不用 class 标记完成，只在课时上显示百分比进度。
    // 【平台隔离】百分比达标才算完成，误判会把"还没看完"的课时标成已完成并跳过，
    // 因此限定在 jxnu profile 下启用。
    if (profileAllows('jxnu')) {
      const pm = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (pm && parseFloat(pm[1]) >= 99.5) return 'progress';
    }

    const clsRe =/\b(completed|finished|done|watched|passed|learned|success|finish|complete|wancheng|yiwancheng|yixuexi|yikan|yibofang|gou|dui|checked(?![a-z]))\b/i;
    if (clsRe.test(cls)) return 'class';
    if (/已学完|已完成|已看|已播放|学习进度\s*100|100%/.test(text)) return 'text';

    // 只看可能是状态图标的子元素，排除 input checkbox
    const icons = el.querySelectorAll('i, svg, span, em, img, [class*="icon" i]');
    for (const icon of icons) {
      const c = (typeof icon.className === 'string') ? icon.className : '';
      if (/\b(completed|finished|done|watched|passed|learned|success|finish|complete|wancheng|yiwancheng|yixue|yixuexi|yikan|yibofang|xuewan|gou|dui)\b/i.test(c)) return 'icon-class';
      // Ant Design 完成图标：anticon-check-circle / anticon-check（jxnu zjpt 等平台用）
      if (/anticon-check-circle|check-circle|checkcircle|icon-check|icon-gou|icon-success/i.test(c)) return 'icon-check';
      const t = getAllText(icon);
      if (/已学完|已学习|已学|已完成|已修完|已看|已播放/.test(t)) return 'icon-text';
      const aria = icon.getAttribute('aria-label') || '';
      if (/已学完|已完成|已看|已播放/.test(aria)) return 'icon-aria';
    }

    // 课时内的进度条被撑满（内联样式 width:100%）视为已完成
    try {
      const bars = el.querySelectorAll('[style*="width" i]');
      for (const b of bars) {
        const m = (b.getAttribute('style') || '').match(/width\s*:\s*([\d.]+)%/i);
        if (m && parseFloat(m[1]) >= 99.5) return 'progress-bar';
      }
    } catch (e) {}
    return false;
  }

  function hasCurrentMarker(el) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    // 网梯/whaty-learnspace：s_pointerct / pointerct 表示当前正在学
    // 【平台隔离】这两个类名仅在网梯 profile 下采信
    if (profileAllows('whaty') &&
        /\b(s_pointerct|pointerct)\b/i.test(cls)) return true;
    if (/\b(active|current|playing|selected|on|focus|now|cur|zhengzaibofang|bofangzhong|xuexizhong)\b/i.test(cls)) return true;
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

  // 目录日志降噪：状态没变化时不重复输出（原先每 3 秒刷一大段，把前面日志全冲掉了）
  let lastListSig = '';
  let lastListLogAt = 0;

  // 兜底驱动：当完全监听不到 video 元素时（播放器位于跨域 iframe，content script 无法注入，
  // 收不到 pause/ended 事件），改用"目录课时进度百分比"驱动连播：
  // 当前课时进度达到 100% 即自动跳下一节。jxnu zjpt 等平台正是这种情况。
  let fallbackLastPct = -1;
  let fallbackLastChangeAt = 0;
  let fallbackLastJumpAt = 0;
  let fallbackLastResumeAt = 0;
  let fallbackCurrentKey = '';
  let catalogDriveSkipLogAt = 0;
  let catalogDriveAnnounced = false;   // v1.9.1 修复：此前未声明，严格模式下读取直接抛
                                       // ReferenceError，导致整个目录驱动 tick 每 3 秒崩一次，
                                       // 起播级联（含四级兜底）一行都执行不到 —— "换个版本还是不自动播放"的真凶。

  // 判断平台是否把当前课时标记为"正在播放"。
  // 返回 false=确认正在播（不干预）｜true=确认暂停｜null=无法判断。
  // 实测 jxnu 平台目录上的 pause-circle 是"课时状态"（已开始未完成），并非实时播放状态，
  // 因此绝不拿它当依据 —— v1.8.7 正因为误判"在播"而永远不起播。改由自定义播放器模块的
  // "播放位置是否推进"来判定；本函数默认返回 null（不挡路）。
  // v1.9.1 修复：此前该函数从未定义，调用时抛 ReferenceError。
  function currentItemPausedByIcon(cur) {
    try {
      const st = getCustomPlayer();
      if (st && st.playing) return false;
      // UI 没给信号，但播放位置近期推进过 —— 同样按"正在播放"处理
      if (st && st.trackable && customPrev.at && Date.now() - customPrev.at < 60000) return false;
    } catch (e) {}
    return null;
  }

  // 当前课时的状态图标（Ant Design）。实测（jxnu zjpt）三种图标含义是"课时状态"而非
  // 实时播放状态：check-circle=已完成、pause-circle=已开始未完成、play-circle=未开始。
  // 注意：**不能**把 pause-circle 当成"正在播放"——v1.8.7 曾因此误判"在播不干预"，
  // 导致进度卡住也永远不起播。这里只用来识别"已完成"。
  function currentItemStateIcon(cur) {
    try {
      const icons = cur.el.querySelectorAll('i, span, div, svg');
      for (const el of icons) {
        const c = (el.getAttribute && el.getAttribute('class')) || '';
        if (!c) continue;
        if (/check-circle|icon-check|icon-wancheng/i.test(c)) return 'check';
      }
    } catch (e) {}
    return null;
  }

  // 点击当前课时行上的"播放"图标（平台自己的控件），用于自定义播放器无法直接控制的场景
  function clickCurrentItemPlayIcon(cur) {
    try {
      const icons = cur.el.querySelectorAll('i, span, div, svg');
      for (const el of icons) {
        const c = (el.getAttribute && el.getAttribute('class')) || '';
        if (!c || !/play-circle|icon-play|icon-bofang/i.test(c)) continue;
        // 往上找到真正带点击处理的外层（图标本身通常不绑事件）
        let node = el;
        for (let i = 0; i < 3 && node.parentElement; i++) {
          node = node.parentElement;
          if (node && /course-status|status|play/i.test((node.getAttribute && node.getAttribute('class')) || '')) break;
        }
        if (isVisible(node)) {
          fireFullClick(node);
          log('点击当前课时的播放图标：', (getAllText(cur.el) || '').slice(0, 24));
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function catalogDrivenTick() {
    if (!settings.enabled || !settings.autoNext) return;
    if (!activePlatformAllowed()) return;
    if (!IS_TOP) return;
    // 页面里有"真实可播"的 video 时，交给 video 的 ended 事件驱动，这里不插手。
    // 注意：由自定义播放器模块伪装的 from:'custom' 条目不算 —— 它没有 ended 事件，
    // 仍需目录进度驱动兜底。
    if (getAggregatedVideos().some(v => v.from !== 'custom')) return;
    if (!catalogDriveAnnounced) {
      catalogDriveAnnounced = true;
      log('已进入「目录进度驱动」模式：页面无可控 video，按课时进度百分比自动起播与跳下一集');
    }

    const cur = localList.current;
    if (!cur) return;
    const pct = parseItemPercent(cur.text);
    if (pct < 0) return; // 目录里没有百分比进度，无法驱动

    const now = Date.now();
    const key = cur.text.slice(0, 48);
    // 换了课时：重置基准，避免用上一节的进度判断本节
    if (key !== fallbackCurrentKey) {
      fallbackCurrentKey = key;
      fallbackLastPct = pct;
      fallbackLastChangeAt = now;
      return;
    }
    if (pct !== fallbackLastPct) {
      fallbackLastPct = pct;
      fallbackLastChangeAt = now;
    }
    const stalled = now - fallbackLastChangeAt;

    // ① 播完 → 跳下一节
    // 平台把进度刷到 100% 即视为播完；少数平台停在 99%/90% 就不再涨，
    // 连续无变化超过阈值也判定播完，避免整门课卡死在这一节。
    // 另外平台把当前课时图标刷成 check-circle（已完成）时，无论百分比多少都立即跳。
    const iconState = currentItemStateIcon(cur);
    const finished = iconState === 'check' || pct >= 99.5 ||
                     (pct >= 95 && stalled > 240000) || (pct >= 90 && stalled > 480000);
    if (finished) {
      if (now - fallbackLastJumpAt < 10000) return;
      fallbackLastJumpAt = now;
      fallbackLastChangeAt = now;
      markLocalDone(cur.el);
      log('课时进度 ' + pct + '% 已播完（播放器不可直接控制，按目录进度驱动下一集）');
      clickNext(true, true);
      return;
    }

    // ② 进度长时间不动 → 说明这一节没播起来（或中途停了），尝试恢复
    //    只在"确实没在播"时才动手，避免把正在播放的视频点暂停。
    //    0% 起不来时 35 秒就介入（平台约每 30 秒刷新一次百分比，不能更早误判），
    //    中途停顿则给 45 秒宽限（可能是网络缓冲）。
    // 自定义播放器处于可追踪状态时，起播交给 customPlayerTick（按秒级播放位置判定）。
    // 这里若仍用目录的百分比来判定"卡住"，会因为长视频几十秒才涨 0.1% 而误判，
    // 进而去点播放按钮/画面/空格键 —— 那几个动作都是"播放↔暂停"开关，会把正在播的视频点停。
    try {
      const cp = getCustomPlayer();
      if (cp && cp.trackable) {
        if (now - (catalogDriveSkipLogAt || 0) > 60000) {
          catalogDriveSkipLogAt = now;
          log('自定义播放器可精准追踪播放位置，起播交由其接管，目录进度只用于判断"是否播完"');
        }
        return;
      }
    } catch (e) {}
    if (stalled < (pct <= 0 ? 35000 : 45000)) return;
    if (now - fallbackLastResumeAt < 60000) return;
    fallbackLastResumeAt = now;
    fallbackLastChangeAt = now; // 重新计时，防止连点
    const pausedByIcon = currentItemPausedByIcon(cur);
    if (pausedByIcon === false) {
      log('进度停在 ' + pct + '%，但平台显示正在播放中，不干预');
      return;
    }
    log('课时进度停在 ' + pct + '%（' + Math.round(stalled / 1000) + 's 未变化），尝试起播');
    // 桥已找到 Shadow 播放器：直接下发播放命令（最精准），不再点页面按钮
    if (hasShadowVideo()) {
      shadowCmd('play');
      log('已向 Shadow 播放器下发播放命令');
      return;
    }
    // 起播级联：控制条播放按钮 → 播放器画面点击 → 空格键 → 课时行播放图标
    if (clickPagePlayButton()) return;
    if (clickVideoScreen()) return;
    if (pressSpaceOnPlayer()) return;
    clickCurrentItemPlayIcon(cur);
  }
  // 从候选中剔除"章节标题"这类非课时元素。
  // 依据：真正的课时文本通常带课时序号（"1-1"、"2.3"），而章节标题（如 jxnu 平台
  // 的 SPAN.nav-title）没有序号。仅在"带序号的占多数"时才过滤，避免误伤不带序号的平台。
  // 判断元素是否是"货真价实的课时项"（带打开资源的 onclick / itemtype=video / 课时类名）。
  // 用于保护已适配的平台（尤其是网梯），避免序号规则把真课时误判成章节标题。
  function looksLikeLessonItem(el) {
    if (!el || !el.getAttribute) return false;
    try {
      const onclick = el.getAttribute('onclick') || '';
      if (/openLearnResItem|openResource|openRes|playVideo|play\(|learnRes|openItem|clickItem/i.test(onclick)) return true;
      const it = (el.getAttribute('itemtype') || '').toLowerCase();
      if (it === 'video' || it === 'course' || it === 'lesson') return true;
      if (el.getAttribute('completestate') != null) return true; // 网梯课时带 completestate
      const cls = (typeof el.className === 'string') ? el.className : '';
      if (/\b(s_point|point|lesson|keshi|kecheng|task|resource|res-item|video-item)\b/i.test(cls)) return true;
    } catch (e) {}
    return false;
  }

  function filterLessonLeaves(leaves) {
    if (!leaves || leaves.length < 2) return { lessons: leaves || [], headers: [] };

    // 【平台隔离 v2.0.0】序号过滤是为 jxnu 的 "课程序号 + 章节标题混排" 目录设计的，
    // 它的行为是"剔除不带序号的项"，本质上是有破坏力的（会丢目录项）。
    // 因此只在 jxnu profile 下启用，其他平台一律不过滤，宁可多认、不可漏认。
    if (!profileAllows('jxnu')) return { lessons: leaves, headers: [] };

    // 保护 1：网梯/whaty 平台已有精准识别（.s_point[itemtype="video"]），直接跳过过滤，
    // 绝不让通用规则影响已验证可用的平台。
    try {
      const isWangti = leaves.some(x => x.el && x.el.matches &&
        (x.el.matches('.s_point[itemtype="video"]') || x.el.matches('[itemtype="video"]')));
      if (isWangti) return { lessons: leaves, headers: [] };
    } catch (e) {}

    // 先剥掉进度百分比（"80.4%\n1-1 …"），否则 "80.4" 会被误当课时序号
    const stripPct = (t) => String(t || '').replace(/\d{1,3}(?:\.\d+)?\s*%/g, ' ').replace(/^\s+/, '');
    const numRe = /^\s*\d{1,2}\s*[-.．、:：]\s*\d{1,2}\b/;
    const lessons = [], headers = [];
    leaves.forEach(x => { (numRe.test(stripPct(x.text)) ? lessons : headers).push(x); });
    if (lessons.length >= 2 && headers.length > 0 && lessons.length >= headers.length) {
      // 保护 2：若被剔除的候选里有明显是课时的元素，说明序号规则不适用，放弃过滤
      const risky = headers.some(x => looksLikeLessonItem(x.el));
      if (risky) return { lessons: leaves, headers: [] };
      return { lessons, headers };
    }
    return { lessons: leaves, headers: [] };
  }

  // 解析课时项上的学习进度百分比（jxnu 等平台在目录项里显示 "80.4%"）
  function parseItemPercent(text) {
    if (!text) return -1;
    const m = String(text).match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    if (!m) return -1;
    const v = parseFloat(m[1]);
    return isFinite(v) ? v : -1;
  }

  function analyzeList() {
    const container = findCatalogContainer();
    if (!container) {
      localList = { container: null, all: [], leaves: [], chapterHeaders: [], current: null, completed: [], pending: [], leafCount: 0 };
      return;
    }
    const { leaves: rawLeaves, chapterHeaders: rawHeaders } = collectItems(container);
    // 剔除混进来的章节标题（非课时元素），只保留真课时
    const { lessons: leaves, headers: titleHeaders } = filterLessonLeaves(rawLeaves);
    localList.container = container;
    localList.leaves = leaves;
    localList.chapterHeaders = rawHeaders.concat(titleHeaders);
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

    // 合并运行时本地记账的已完成课时（元素仍在当前目录容器内才有效，
    // SPA 重渲染导致元素被替换后旧记录自动失效）
    try {
      const nowDone = Date.now();
      localDoneMap.forEach((ts, el) => {
        if (!el || nowDone - ts > LOCAL_DONE_TTL) { localDoneMap.delete(el); return; }
        if (container.contains(el)) completedByMarker.add(el);
      });
    } catch (e) {}

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

    // 当前课时的学习进度百分比（无 video 可用时用它驱动连播与面板显示）
    localList.currentPct = localList.current ? parseItemPercent(localList.current.text) : -1;

    const sig = [leaves.length, current ? current.text.slice(0, 30) : '无',
                 localList.completed.length, localList.pending.length,
                 localList.currentPct].join('|');
    const nowMs = Date.now();
    if (sig === lastListSig && nowMs - lastListLogAt < 60000) return;
    lastListSig = sig;
    lastListLogAt = nowMs;

    log('目录分析：共', leaves.length, '项，当前', current ? current.text.slice(0, 30) : '无',
        '，进度', localList.currentPct >= 0 ? localList.currentPct + '%' : '未知',
        '，已播', localList.completed.length, '，待播', localList.pending.length);
    log('当前URL:', location.href.slice(0, 160), '| title:', (document.title || '').slice(0, 40));
    log('当前平台：' + platformInfo().name + '（' + ACTIVE_PROFILE + '）' +
        (plateinfoFrozen() ? ' · 已冻结' : '') +
        (activePlatformAllowed() ? '' : ' · 已在前台停用，不执行任何自动化'));
    // 诊断：本页 video 元素与 iframe 清单 —— 用于判断播放器是否在跨域 iframe 里
    try {
      const all = Array.from(document.querySelectorAll('video'));
      const real = all.filter(isRealVideo).length;
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const objects = Array.from(document.querySelectorAll('object, embed'));
      const srcs = iframes.concat(objects).map(f => (f.src || f.data || '').slice(0, 120)).filter(Boolean);
      const rootCnt = document.documentElement.getAttribute('data-ap-shadow-roots');
      const sv = shadowRealVideos().length;
      const bridgeOk = /^1@/.test(document.documentElement.getAttribute('data-ap-shadow-ok') || '');
      // 自定义播放器（无 <video> 的 canvas / WebAudio 型，如百家云 bplayer）
      let cpm = '';
      try {
        const cp = readCustomPlayer();
        if (cp) cpm = ' | 自定义播放器: ' + cp.label + ' (' + fmtTime(cp.cur) + '/' + fmtTime(cp.dur) +
                      (cp.playing ? ' 播放中' : ' 未播') + ')';
      } catch (e) {}
      log('诊断：本页 video 元素', all.length, '个（可播', real, '，空壳', all.length - real,
          '）| iframe', iframes.length, '个 | object/embed', objects.length, '个',
          srcs.length ? '→ ' + srcs.join(' | ').slice(0, 400) : '',
          '| Shadow桥:', bridgeOk ? ('已安装(容器' + (rootCnt || '0') + ',video' + sv + ')') : '未安装',
          cpm);
    } catch (e) {}
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
      '[class*="next-lesson" i]', '[class*="next-chapter" i]'
    ];
    for (const s of sels) {
      const el = queryVisible(s);
      if (el) return el;
    }

    // 中文平台：按可见文本查找「下一节 / 下一讲 / 下一集 / 下一个」按钮
    const byText = findNextButtonByText();
    if (byText) return byText;

    // 最后才用宽泛的 next 类名兜底
    const loose = queryVisible('[class*="next" i]');
    return loose;
  }

  // 按中文可见文本查找"下一节/下一讲/下一集/下节课"按钮
  function findNextButtonByText() {
    const RE = /下一[节讲章集个步课]?|下[一节讲集]|下节课|继续下一|播放下一/;
    const EXCLUDE = /下一页|下一批|下一组|下一步\s*说明/;
    const sel = 'button, a[href], [role="button"], [class*="btn" i], [class*="button" i]';
    let fallback = null;
    try {
      document.querySelectorAll(sel).forEach(el => {
        if (fallback) return;
        // 关键：跳过本扩展自己的面板按钮（否则会命中面板上的"▶ 立即播放下一集"，点了等于没点）
        if (isOwnEl(el)) return;
        const t = (getAllText(el) || '').trim();
        if (!t || t.length > 12) return;
        if (EXCLUDE.test(t)) return;
        if (!RE.test(t)) return;
        if (!isVisible(el)) return;
        fallback = el;
      });
    } catch (e) {}
    if (fallback) log('按文本命中下一集按钮：', getAllText(fallback).slice(0, 20));
    return fallback;
  }

  function getClickableTarget(el) {
    let a = el.querySelector('a');
    if (a && a.textContent.trim()) return a;
    a = el.closest('a');
    if (a) return a;
    if (el.tagName === 'A') return el;
    // Vue / React 平台（如 jxnu zjpt）通常把点击事件绑在目录项的"内层容器"上
    // （例：li > div.course-detail），点外层 li 不会触发内层处理器；
    // 而点内层元素时事件会向上冒泡，两种绑定方式都能命中，因此优先点内层。
    try {
      const inner = el.querySelector('[class*="detail" i], [class*="title" i], [class*="name" i]');
      if (inner && isVisible(inner)) return inner;
    } catch (e) {}
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

    // 本帧必须含有真实课程目录（网梯平台用专属标记，其他平台走通用判断）。
    // 播放器帧即便识别出几项 leafCount 也不算数，必须让顶层调度到真正的目录帧。
    if (!hasRealCatalogInList(localList)) {
      log('本帧无真实课程目录（leafCount=', localList.leafCount, '），交由顶层调度');
      return false;
    }

    // 目录优先：目录能精确定位"下一个课时"，顺序可控。
    // 平台自带的"下一集"按钮只在目录不可用时兜底（按钮无法保证顺序，历史上有乱跳问题）。
    const next = findNextItem(!!autoEnded);
    if (next) {
      log('点击下一节课：', next.text.slice(0, 40));
      lastClickAt = Date.now();
      // 本地记账：仅自动连播（当前视频已播完）时把当前课时视为已完成，
      // 手动跳转不算，平台完成状态延迟也不影响下一轮自动推进
      try {
        if (autoEnded && localList.current && localList.current.el && localList.current.el !== next.el) {
          markLocalDone(localList.current.el);
        }
      } catch (e) {}
      const beforeText = localList.current ? localList.current.text.slice(0, 40) : '';
      smartClick(next.el, (ok) => {
        if (ok) log('跳转成功');
        else log('跳转可能失败，元素不可见');
        // 校验：2 秒后复查当前项是否真的切换了（Vue 平台点击不生效时能立刻发现）
        setTimeout(() => {
          try {
            analyzeList();
            const after = localList.current ? localList.current.text.slice(0, 40) : '(无)';
            log('跳转校验：' + (after !== beforeText ? '已切换' : '⚠️ 当前项未变化'), '→', after);
          } catch (e) {}
        }, 2000);
      });
      return true;
    }

    // 目录不可用时，才退回平台自带的"下一集"按钮
    const btn = findNextButton();
    if (btn) {
      log('目录不可用，改用页面下一集按钮');
      btn.click();
      lastClickAt = Date.now();
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
    // 标记为"本扩展自有元素"：页面级扫描（找下一集按钮/播放按钮/目录）一律跳过，
    // 否则扩展会把自己面板上的按钮当成平台按钮去点。
    panel.setAttribute('data-ap-own', '1');
    panel.innerHTML =
      '<div class="ap-head">' +
        '<span class="ap-title">▶ 自动连播助手</span>' +
        '<span class="ap-status" id="ap-status">运行中</span>' +
        '<button class="ap-min" id="ap-min" title="折叠/展开">—</button>' +
      '</div>' +
      '<div class="ap-body" id="ap-body">' +
        '<label class="ap-row" title="刷新页面或跳到下一集后，自动替你点下第一次播放；之后你手动暂停就不再插手"><span>进入页面自动起播</span><input type="checkbox" id="ap-start"></label>' +
        '<div class="ap-plat-title">平台启停<span class="ap-plat-now" id="ap-plat-now"></span></div>' +
        '<div class="ap-plat-list" id="ap-platlist"></div>' +
        '<label class="ap-row" title="部分平台可能检测到非自然播放行为并弹出警告"><span>暂停自动续播 ⚠️</span><input type="checkbox" id="ap-resume"></label>' +
        '<label class="ap-row"><span>播完自动下一集</span><input type="checkbox" id="ap-next"></label>' +
        '<label class="ap-row"><span>倍速播放</span><input type="checkbox" id="ap-speed"></label>' +
        '<div class="ap-speed-row">' +
          '<span class="ap-speed-label">播放速度</span>' +
          '<select id="ap-speed-val">' +
            '<option value="1">1.0x</option>' +
            '<option value="1.25">1.25x</option>' +
            '<option value="1.5">1.5x</option>' +
            '<option value="2">2.0x</option>' +
            '<option value="2.5">2.5x</option>' +
            '<option value="3">3.0x</option>' +
            '<option value="4">4.0x</option>' +
            '<option value="5">5.0x</option>' +
          '</select>' +
        '</div>' +
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
        '<div class="ap-copyright" title="本扩展为原创作品，著作权归 胡昱晨 (hu_yu_chen) 所有，禁止删除署名或冒称原创">' +
          '© 2026 胡昱晨 (hu_yu_chen) · 原创作品 · MIT 授权' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    const startChk = panel.querySelector('#ap-start');
    const resumeChk = panel.querySelector('#ap-resume');
    const nextChk = panel.querySelector('#ap-next');
    const speedChk = panel.querySelector('#ap-speed');
    const speedVal = panel.querySelector('#ap-speed-val');
    const minBtn = panel.querySelector('#ap-min');
    const body = panel.querySelector('#ap-body');
    const nextBtn = panel.querySelector('#ap-nextbtn');
    const dbgToggle = panel.querySelector('#ap-debug-toggle');
    const logs = panel.querySelector('#ap-logs');
    const copyLogBtn = panel.querySelector('#ap-copylog');
    const copyHtmlBtn = panel.querySelector('#ap-copyhtml');
    const platList = panel.querySelector('#ap-platlist');
    const platNow = panel.querySelector('#ap-plat-now');

    // 平台启停列表：与 PLATFORMS 一一对应，勾选状态实时写回 storage，
    // 关闭当前页面所属平台后所有 tick 立即停手。
    if (platList) {
      PLATFORMS.forEach(p => {
        const row = document.createElement('label');
        row.className = 'ap-plat';
        row.innerHTML =
          '<input type="checkbox" data-plat="' + p.id + '"' + (platformEnabled(p.id) ? ' checked' : '') + '>' +
          '<span class="ap-plat-main">' +
            '<span class="ap-plat-name">' + p.name +
              (p.frozen ? '<span class="ap-plat-frozen">已冻结</span>' : '') +
            '</span>' +
            '<span class="ap-plat-desc">' + p.desc + '</span>' +
          '</span>';
        const box = row.querySelector('input');
        box.addEventListener('change', () => {
          settings.platforms = settings.platforms || {};
          settings.platforms[p.id] = box.checked;
          saveSettings();
          row.classList.toggle('ap-plat-off', !box.checked);
          log('平台「' + p.name + '」已' + (box.checked ? '启用' : '停用') +
              (box.checked ? '' : '：该平台所属页面上不再执行任何自动化'));
          updateStatus();
          if (!box.checked && ACTIVE_PROFILE === p.id) updateInfo();
        });
        row.classList.toggle('ap-plat-off', !platformEnabled(p.id));
        platList.appendChild(row);
      });
    }
    // 当前页面识别到的平台名（域名判定，一眼确认有没有走错分支）
    if (platNow) platNow.textContent = '当前：' + platformInfo().name;

    startChk.addEventListener('change', () => { settings.autoStart = startChk.checked; saveSettings(); updateStatus(); });
    resumeChk.addEventListener('change', () => { settings.autoResume = resumeChk.checked; saveSettings(); updateStatus(); });
    nextChk.addEventListener('change', () => { settings.autoNext = nextChk.checked; saveSettings(); updateStatus(); });
    speedChk.addEventListener('change', () => {
      settings.speedEnabled = speedChk.checked;
      saveSettings();
      applySpeedToAll();
      updateStatus();
    });
    speedVal.addEventListener('change', () => {
      settings.playbackRate = parseFloat(speedVal.value) || 1;
      saveSettings();
      applySpeedToAll();
    });
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
      // 关键：顶层自己的目录也要放进缓冲区。此前只向子帧广播请求，
      // 导致目录在顶层时缓冲区始终为空，"复制目录HTML"点了没反应。
      try {
        if (localList && localList.container) {
          catalogHtmlBuffer += '<!-- TOP ' + location.href + ' -->\n' +
            localList.container.outerHTML.slice(0, 6000) + '\n';
        }
      } catch (e) {}
      // 附上 iframe 清单，便于判断播放器是否位于跨域 iframe
      try {
        const srcs = Array.from(document.querySelectorAll('iframe, object, embed'))
          .map(f => (f.src || f.data || '').slice(0, 150)).filter(Boolean);
        if (srcs.length) catalogHtmlBuffer += '<!-- IFRAMES -->\n' + srcs.join('\n') + '\n';
      } catch (e) {}
      // 附上播放器区域候选 DOM（控制条/画面容器），用于自定义播放器的精准适配
      try {
        const seen = new Set();
        const cands = [];
        document.querySelectorAll('[class*="player" i], [class*="video" i], [class*="bofang" i], .my-video')
          .forEach(el => {
            if (isOwnEl(el) || seen.has(el)) return;
            if (localList.container && localList.container.contains(el)) return;
            if (!isVisible(el)) return;
            const r = el.getBoundingClientRect();
            if (r.width < 250 || r.height < 120) return; // 只要画面级的大容器
            // 只取最外层：已被已选候选包含的跳过
            for (const c of cands) { if (c.contains(el)) return; }
            for (let i = cands.length - 1; i >= 0; i--) { if (el.contains(cands[i])) cands.splice(i, 1); }
            seen.add(el);
            cands.push(el);
          });
        cands.slice(0, 3).forEach((el, i) => {
          catalogHtmlBuffer += '\n<!-- PLAYER-REGION-' + i + ' <' + el.tagName.toLowerCase() +
            ' class="' + (el.getAttribute('class') || '') + '"> -->\n' +
            el.outerHTML.slice(0, 9000) + '\n';
        });
        if (cands.length) log('已收集播放器区域候选', cands.length, '个（随目录HTML一并复制）');
      } catch (e) {}
      // 明确附上"已识别的自定义播放器"DOM（不受上面的尺寸筛选限制）
      try {
        const cp = readCustomPlayer();
        if (cp && cp.root) {
          catalogHtmlBuffer += '\n<!-- CUSTOM-PLAYER <' + cp.root.tagName.toLowerCase() +
            ' class="' + (cp.root.getAttribute('class') || '') + '"> -->\n' +
            cp.root.outerHTML.slice(0, 12000) + '\n';
        }
      } catch (e) {}
      broadcastDown({ type: 'dumpCatalog' });
      setTimeout(() => {
        pendingCatalogCopy = false;
        if (catalogHtmlBuffer) {
          const ok = copyText(catalogHtmlBuffer);
          log(ok ? '目录HTML已复制（长度 ' + catalogHtmlBuffer.length + '）' : '复制失败，请手动选中日志复制');
        } else {
          log('未收到目录HTML：本页未识别到目录容器');
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
    const startChk = panel.querySelector('#ap-start'); if (startChk) startChk.checked = settings.autoStart !== false;
    // 逐个空值保护：面板 DOM 未来若调整，缺一个元素不应让整个 updateUI 抛错
    const resumeChk = panel.querySelector('#ap-resume'); if (resumeChk) resumeChk.checked = !!settings.autoResume;
    const nextChk = panel.querySelector('#ap-next'); if (nextChk) nextChk.checked = !!settings.autoNext;
    const speedChk = panel.querySelector('#ap-speed'); if (speedChk) speedChk.checked = !!settings.speedEnabled;
    // 面板内的平台勾选框同步一次（popup 里改过之后这里要跟上）
    try {
      panel.querySelectorAll('.ap-plat').forEach(row => {
        const box = row.querySelector('input[data-plat]');
        if (!box) return;
        box.checked = platformEnabled(box.getAttribute('data-plat'));
        row.classList.toggle('ap-plat-off', !box.checked);
      });
      const pn = panel.querySelector('#ap-plat-now');
      if (pn) pn.textContent = '当前：' + platformInfo().name;
    } catch (e) {}
    const sv = panel.querySelector('#ap-speed-val');
    if (sv) {
      const rate = String(currentRate());
      // 存储了选项外的倍率（历史数据/手动改 storage）时动态补一个选项，
      // 否则 select.value 赋不上值会显示空白
      if (!Array.prototype.some.call(sv.options, o => o.value === rate)) {
        const opt = document.createElement('option');
        opt.value = rate;
        opt.textContent = rate + 'x';
        sv.appendChild(opt);
      }
      sv.value = rate;
    }
    updateStatus();
    updateInfo();
  }

  function updateStatus() {
    if (!panel) return;
    const st = panel.querySelector('#ap-status');
    // 当前页面所属平台被停用 —— 优先级高于其它开关状态
    if (!activePlatformAllowed()) {
      st.textContent = '本平台已停用';
      st.classList.add('ap-off');
      return;
    }
    const running = settings.enabled && (settings.autoStart !== false || settings.autoResume || settings.autoNext || settings.speedEnabled);
    st.textContent = running ? '运行中' : '已暂停';
    st.classList.toggle('ap-off', !running);
  }

  // includeShell=true 时返回全部（含空壳），默认只返回真实可播的视频。
  // 调用方（面板统计 / 卡结尾检测 / 目录进度兜底的开关）都只关心真实视频。
  function getAggregatedVideos(includeShell) {
    const now = Date.now();
    const arr = Object.values(frameStates)
      .filter(entry => now - entry.ts < 10000)
      .reduce((a, b) => a.concat(b.videos || []), []);
    if (includeShell) return arr;
    return arr.filter(isRealVideoObj);
  }

  function pickBestList() {
    const now = Date.now();
    const states = Object.values(frameStates).filter(e => now - e.ts < frameStateMaxAge());
    if (!states.length) return null;
    const withCurrent = states.filter(e => e.list && e.list.current);
    if (withCurrent.length) return withCurrent.sort((a, b) => b.list.leafCount - a.list.leafCount)[0].list;
    return states.sort((a, b) => (b.list && b.list.leafCount || 0) - (a.list && a.list.leafCount || 0))[0].list;
  }

  // 播放器容器选择器：位于其中的元素一律不视为课时目录项
  const PLAYER_CONTAINER_SELECTOR =
    'video, audio, canvas, .player, .jwplayer, .video-player, .vjs-control-bar, .bpx-player-container, ' +
    '[class*="jwplayer" i], [class*="player-wrap" i], [class*="video-player" i], [class*="player-container" i], ' +
    '[class*="bplayer" i]';

  // 判断一个元素是否只是播放器控件（而非课程目录项）
  function isPlayerControl(el) {
    if (!el || !el.closest) return false;
    try { return !!el.closest(PLAYER_CONTAINER_SELECTOR); } catch (e) { return false; }
  }

  // 判断某帧的目录是否为"真实课程目录"。
  // 网梯/whaty 平台有专属标记；其余平台走通用判断，避免写死导致新平台失效。
  function hasRealCatalogInList(list) {
    const leaves = (list && list.leaves) || [];
    if (!leaves.length) return false;

    // 网梯/whaty-learnspace：真实视频课时节点
    for (const it of leaves) {
      try {
        if (it.el && it.el.matches && it.el.matches('.s_point[itemtype="video"], [itemtype="video"]')) return true;
      } catch (e) {}
    }

    if (leaves.length < 2) return false;

    // 通用平台：统计"像课时"的项（不在播放器容器内、标题有一定长度）
    let valid = 0;
    for (const it of leaves) {
      if (!it.el) continue;
      if (isPlayerControl(it.el)) continue;
      const t = (it.text || '').trim();
      if (t.length >= 3) valid++;
    }
    return valid >= Math.max(2, Math.ceil(leaves.length * 0.6));
  }

  // ------------------------------------------------------------------
  // 后台/最小化抗节流
  // 浏览器窗口最小化或标签页转入后台时，Chrome 会节流页面定时器（隐藏一段时间后
  // setInterval 被压缩到每分钟才跑一次），导致状态上报停滞、frameStates 全部过期，
  // 进而 pickBestFrameForNext 选不出目录帧、下一集不跳转。
  // 对策：页面不可见时大幅放宽时效判定，目录结构本身不会因后台而改变。
  // ------------------------------------------------------------------
  function isDocHidden() {
    try { return document.hidden === true || document.visibilityState === 'hidden'; } catch (e) { return false; }
  }

  function frameStateMaxAge() {
    return isDocHidden() ? 300000 : 15000;   // 后台 5 分钟 / 前台 15 秒
  }

  function pickBestFrameForNext() {
    const now = Date.now();
    const maxAge = frameStateMaxAge();
    const states = Object.values(frameStates).filter(e => now - e.ts < maxAge && e.list && e.list.leafCount >= 3 && hasRealCatalogInList(e.list));
    if (IS_TOP && localList.leafCount >= 3 && hasRealCatalogInList(localList)) {
      states.push({ frameTag: getFrameTag(), frameUrl: location.href, list: localList, ts: Date.now() });
    }
    if (!states.length) return null;
    states.sort((a, b) => b.list.leafCount - a.list.leafCount);
    const best = states[0];
    if (best.frameTag === getFrameTag() && IS_TOP) return { isTop: true, frameTag: best.frameTag };
    return { isTop: false, frameTag: best.frameTag, frameUrl: best.frameUrl };
  }

  // 统一的"下一集"调度入口：视频结束、后台看门狗补跳都走这里
  function dispatchNext(reason, allowRetry) {
    if (!settings.enabled || !settings.autoNext) return false;
    if (Date.now() - lastGlobalNextAt < 8000) return false;

    // 刷新自身并唤醒子帧重新上报：
    // postMessage 投递不受后台定时器节流影响，可在后台即时拉到最新目录状态
    analyzeAndReport();
    broadcastDown({ type: 'ping' });

    lastGlobalNextAt = Date.now();
    const best = pickBestFrameForNext();
    if (!best) {
      log(reason, '暂未找到有效目录帧' + (allowRetry ? '，稍后重试' : '，放弃本次跳转'));
      // 子帧的上报可能晚于本次判断（尤其后台节流时），安排一次重试
      if (allowRetry) {
        lastGlobalNextAt = 0;
        setTimeout(() => dispatchNext(reason + '（重试）', false), 900);
      }
      return false;
    }
    if (best.isTop) {
      log(reason, '顶层执行下一集');
      return clickNext(true, true);
    }
    log(reason, '委派下一集到', best.frameTag);
    broadcastDown({ type: 'clickNext', bestFrameTag: best.frameTag, manual: false });
    return true;
  }

  function updateInfo() {
    if (!panel) return;
    const info = panel.querySelector('#ap-info');
    const stats = panel.querySelector('#ap-stats');
    const progressText = panel.querySelector('#ap-progress-text');
    const progressPct = panel.querySelector('#ap-progress-pct');
    const progressFill = panel.querySelector('#ap-progress-fill');

    const agg = getAggregatedVideos();
    // 去重统计：部分平台页面里存在多个重复 src 的 video 元素（清晰度切换预置等），
    // 按 src 去重后更接近用户感知的"视频数"
    const seenSrc = new Set();
    let videoCount = 0;
    agg.forEach(v => {
      const s = (v.src || '').split('#')[0];
      if (s) { if (!seenSrc.has(s)) { seenSrc.add(s); videoCount++; } }
      else videoCount++;
    });
    // 活动视频：优先"正在播放"的那个；部分平台自定义播放器 duration 为 0/未知，
    // 不能因 duration 无效就选不到正在播的视频（否则进度永远显示 0%）
    const activeVideo =
      agg.find(v => !v.paused && !v.ended && (v.duration > 0 || v.currentTime > 0)) ||
      agg.find(v => v.duration > 0 && v.currentTime > 0) ||
      agg.find(v => v.duration > 0) || agg[0] || null;

    if (activeVideo && isFinite(activeVideo.duration) && activeVideo.duration > 0) {
      const pct = Math.min(100, Math.max(0, (activeVideo.currentTime / activeVideo.duration) * 100));
      progressText.textContent = `当前 ${fmtTime(activeVideo.currentTime)} / ${fmtTime(activeVideo.duration)}`;
      progressPct.textContent = pct.toFixed(0) + '%';
      progressFill.style.width = pct + '%';
    } else if (activeVideo && activeVideo.currentTime > 0) {
      // 时长未知但确有播放位置：显示已播时间，百分比暂不可知
      progressText.textContent = `当前 ${fmtTime(activeVideo.currentTime)} / 未知时长`;
      progressPct.textContent = '--%';
      progressFill.style.width = '0%';
    } else if (localList && localList.current && localList.currentPct >= 0) {
      // 监听不到 video（跨域播放器 iframe）时，用平台目录上的课时进度百分比兜底显示
      const pct = Math.min(100, Math.max(0, localList.currentPct));
      progressText.textContent = `课时进度 ${pct.toFixed(1)}%（播放器跨域，无法读取播放位置）`;
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
    // 空壳数直接按 isRealVideoObj 统计（v2.1.2 修复：此前用"全部 - 按 src 去重后的
    // 真实视频数"相减，页面存在重复 src 的 video 时会虚报空壳数量）
    const shellCount = getAggregatedVideos(true).filter(v => !isRealVideoObj(v)).length;
    const hasCustomPlayer = agg.some(v => v.from === 'custom');
    let noVideoHint = '';
    if (hasCustomPlayer) {
      noVideoHint = ' · 已接管画布型播放器（本页无 <video>）';
    } else if (videoCount === 0 && total > 0) {
      noVideoHint = ' · 播放器不可直接控制，按目录进度驱动';
      if (shellCount > 0) noVideoHint += `（页面 ${shellCount} 个空壳 video 已忽略）`;
    }
    info.textContent = `检测到 ${videoCount} 个视频（${frameCount} 帧） · 目录 ${total} 项${noVideoHint}` +
      (licenseState && licenseState.ok ? ` · ${licenseState.msg}` : '');

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
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
      // 收到 ping 立即扫描上报，并继续向本级子 iframe 转发 ——
      // 否则孙辈 iframe（iframe 里的 iframe）永远收不到顶层的心跳
      analyzeAndReport();
      if (d.broadcastDown) { try { broadcastDown({ type: 'ping' }); } catch (e) {} }
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
      if (!d.handled) dispatchNext('视频结束：', true);
    }
  });

  // ---------- SPA 路由变化监听 ----------
  // 现代学习平台（Vue/React，如江西师范大学 zjpt）切换视频时不刷新页面，
  // content script 不会被重新执行，必须主动感知 URL 变化后重新扫描视频与目录。
  //
  // v2.1.2 修复：此前 watchSpaRoute 没有防重入标志 —— 页面先待命（enterStandby）
  // 再被播放内容唤醒（startFull）时会再次调用本函数，导致 popstate/hashchange
  // 监听器叠加、history.pushState 被反复包装（每层包装多触发一次 onChange）、
  // 1500ms 轮询 interval 越积越多；且该 interval 不在 tickTimers 里，待命时清不掉。
  // 现在：监听器只装一次（spaListenersInstalled），轮询定时器纳入 tickTimers 统一
  // 管理（待命清除、唤醒时按需重建）。
  let spaListenersInstalled = false;
  let spaPollTimer = null;
  let spaLastUrl = '';
  function watchSpaRoute() {
    try { spaLastUrl = location.href; } catch (e) { spaLastUrl = ''; }
    const onChange = () => {
      // 待命期间不响应路由变化（本页无播放内容，跳转扫描交给待命观察器判断）
      if (!fullStarted) return;
      let now;
      try { now = location.href; } catch (e) { return; }
      if (!now || now === spaLastUrl) return;
      spaLastUrl = now;
      log('检测到路由变化，重新分析：', now.slice(0, 120));
      // 重置上一轮跳转状态，避免旧锁与旧视频残留影响新一轮
      lastClickAt = 0;
      handlingEnd = false;
      lastEndedVideo = null;
      // 切换课时后播放器会重建：重置自定义播放器的位置追踪，给它一个全新的判停窗口
      customPrev.key = '';
      customPrev.cur = -1;
      customPrev.at = Date.now();
      // 重开冷启动窗口：新课时必须重新走一次"首次自动起播"，否则会一直停在暂停态
      customBootAt = Date.now();
      customBootBase = -1;
      customBooted = false;
      customBootTries = 0;
      customIgnoreUntil = 0;
      customJumpSeen = 0;
      lastPagePlayAt = 0;
      customTry.idx = 0;
      const redo = () => {
        scanVideos();
        try { analyzeList(); } catch (e) { log('analyzeList error', e.message); }
        reportVideoState();
        if (IS_TOP && panel) updateInfo();
      };
      setTimeout(redo, 800);
      setTimeout(redo, 2500);
    };

    if (!spaListenersInstalled) {
      spaListenersInstalled = true;
      window.addEventListener('popstate', onChange);
      window.addEventListener('hashchange', onChange);

      // 劫持 pushState / replaceState：SPA 路由常用，且不触发原生事件
      try {
        const wrap = (name) => {
          const orig = history[name];
          if (typeof orig !== 'function' || orig.__apWrapped) return; // 防重复包装
          const wrapped = function () {
            const r = orig.apply(this, arguments);
            try { onChange(); } catch (e) {}
            return r;
          };
          wrapped.__apWrapped = true;
          history[name] = wrapped;
        };
        wrap('pushState');
        wrap('replaceState');
      } catch (e) {}
    }

    // 兜底轮询：部分框架直接改地址栏，不走 history API。
    // 纳入 tickTimers：待命时随 enterStandby 清除，唤醒时若已被清则重建。
    if (!spaPollTimer) {
      spaPollTimer = setInterval(onChange, 1500);
      tickTimers.push(spaPollTimer);
    }
  }

  // ---------- 后台保活：看门狗 ----------
  // 窗口最小化 / 标签页转入后台后，Chrome 会节流页面定时器（setInterval 被压缩为每分钟
  // 甚至更低频率），目录扫描、状态上报、"下一集"调度随之停摆 —— 这正是"最小化后不播也不跳"的原因。
  // 对策：background service worker 用 chrome.alarms 每分钟触发一次，再通过 chrome.tabs.sendMessage
  // 唤醒本页面。消息投递会立即执行页面脚本，不受定时器节流限制。
  let watchdogRegistered = false;
  function registerWatchdog() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      const ping = () => {
        try {
          chrome.runtime.sendMessage({ type: 'apRegister' }, () => { void chrome.runtime.lastError; });
        } catch (e) {}
      };
      if (watchdogRegistered) return;
      watchdogRegistered = true;
      ping();
      // 周期性重注册，顺带唤醒 service worker；只要注册成功一次，闹钟就会持续生效
      watchdogPingTimer = setInterval(ping, 45000); // 存句柄：enterStandby() 需要清掉它
      tickTimers.push(watchdogPingTimer);
    } catch (e) {}
  }

  // 是否存在"已经播完 / 卡在结尾却没有跳转"的视频
  function hasStuckEndedVideo() {
    try {
      const agg = IS_TOP ? getAggregatedVideos() : getLocalVideoState();
      if (!agg.length) return false;
      return agg.some(v =>
        v && isFinite(v.duration) && v.duration > 0 &&
        (v.ended || (!v.paused && v.duration - v.currentTime <= 2))
      );
    } catch (e) { return false; }
  }

  // 看门狗心跳：刷新状态 -> 保播 -> 必要时补跳下一集
  function watchdogTick() {
    try {
      scanVideos();
      analyzeAndReport();
      ensurePlaying();
      try { customPlayerTick(); } catch (e) {}
      try { broadcastDown({ type: 'ping' }); } catch (e) {}
      checkShadowVideos();
      if (IS_TOP) {
        if (panel) updateInfo();
        if (settings.enabled && settings.autoNext && hasStuckEndedVideo()) {
          dispatchNext('后台看门狗：', true);
        }
      }
    } catch (e) {}
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'apWatchdog') {
        // 待命期间不响应看门狗：没有播放内容的页面不应被反复唤醒扫描
        if (!fullStarted) return false;
        watchdogTick();
        if (sendResponse) sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  } catch (e) {}

  // 页面从后台恢复可见时，立即补齐后台节流期间遗漏的动作
  document.addEventListener('visibilitychange', () => {
    if (isDocHidden()) return;
    // 待命期间不动作：本页没有播放内容，恢复可见也不该开始扫描
    if (!fullStarted) return;
    setTimeout(() => {
      try {
        scanVideos();
        analyzeAndReport();
        ensurePlaying();
        if (IS_TOP && settings.enabled && settings.autoNext && hasStuckEndedVideo()) {
          dispatchNext('恢复可见：', true);
        }
      } catch (e) {}
    }, 300);
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
      // 平台判定必须在所有扫描之前完成：后续所有平台专属分支都以它为准
      refreshProfile();
      if (shouldEarlyExit()) {
        if (!activePlatformAllowed()) {
          log('平台「' + platformInfo().name + '」已在前台关闭，本页不启用任何自动化');
        } else {
          log('非视频页面，跳过初始化');
        }
        return;
      }
      // 授权闸门优先于一切启动：未授权只显示联系作者的提示卡，不扫描、不起播、不建面板
      checkLicense(() => {
        if (!licenseState || !licenseState.ok) {
          log('未授权，插件不工作：' + (licenseState ? licenseState.msg : ''));
          showLicenseOverlay();
          return;
        }
        boot();
      });
    });
  }

  // 完整启动（授权通过 + 有播放内容特征时才走到这里）
  function startFull() {
    if (fullStarted) return;
    fullStarted = true;
    // 待命观察器已完成使命（唤醒了本次启动）：断开它，避免与 observe() 的主观察器
    // 重复触发同一批扫描（v2.1.2 修复：此前唤醒后 probeMo 一直挂着）
    if (probeMo) { try { probeMo.disconnect(); } catch (e) {} probeMo = null; }
    log('当前平台：' + platformInfo().name + '（' + ACTIVE_PROFILE + '）· ' + platformInfo().desc);
    if (licenseState && licenseState.ok) log('授权状态：' + licenseState.msg);
    observe();
    watchSpaRoute();
    registerWatchdog();
    if (IS_TOP) {
      ensureUI();
      if (infoTimer) clearInterval(infoTimer);
      infoTimer = setInterval(() => {
        try {
          analyzeAndReport();
          ensurePlaying();
          customPlayerTick();
          checkShadowVideos();
          catalogDrivenTick();
          if (panel) updateInfo();
        } catch (e) { log('tick error', (e && e.message) || e); }
        // 定时 ping 子帧，防止 iframe 加载晚于 content script（降低频率减少开销与风险）
        try { broadcastDown({ type: 'ping' }); } catch (e) {}
      }, 3000);
      tickTimers.push(infoTimer);
      tickTimers.push(setInterval(scanVideos, 2000));
      // 心跳集中 try 包裹：任何一个环节抛错都不能拖垮整条连播链路
      tickTimers.push(setInterval(() => { try { customPlayerTick(); } catch (e) {} }, 2000));
      tickTimers.push(setInterval(() => {
        const now = Date.now();
        const maxAge = frameStateMaxAge();
        for (const k of Object.keys(frameStates)) {
          if (now - frameStates[k].ts > maxAge) delete frameStates[k];
        }
      }, 5000));
      log('顶层初始化完成', location.href);
    } else {
      tickTimers.push(setInterval(() => { analyzeAndReport(); }, 1500));
      tickTimers.push(setInterval(() => { try { customPlayerTick(); } catch (e) {} }, 2000));
      tickTimers.push(setInterval(scanVideos, 2000));
      log('子帧初始化完成', location.href, '| 已知平台:', isKnownHost(), '| video元素:', hasVideoElement());
    }
  }

  // 等待 document 和 iframe 内部资源尽量就绪后再开始
  function runInit() {
    // 尽早注入 Shadow DOM 桥：必须抢在播放器库创建 closed shadowRoot 之前，
    // 否则 attachShadow 钩子截获不到引用（document_start 运行正是为此）
    injectShadowBridge();
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
        // 待命期间不扫描：没有播放内容的页面加载完成也不该启动
        if (!fullStarted) return;
        scanVideos();
        analyzeAndReport();
        // 诊断：输出页面全部 iframe 地址，便于判断播放器是否位于跨域 iframe
        if (IS_TOP) {
          try {
            const srcs = Array.from(document.querySelectorAll('iframe'))
              .map(f => (f.src || f.getAttribute('data-src') || '').slice(0, 120))
              .filter(Boolean);
            if (srcs.length) log('页面iframe(' + srcs.length + '):', srcs.join(' | ').slice(0, 600));
          } catch (e) {}
        }
      }, 1000);
    });
  }

  runInit();
})();
