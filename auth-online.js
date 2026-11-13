/*!
 * 自动连播助手 (Auto Video Player) · 在线授权模块
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
 *
 * 【V2 授权系统 · 浏览器扩展接入层】
 * 注意：本公开仓库为脱敏副本，APP_KEY / CLIENT_SECRET 为占位符；
 *       可运行的完整配置见作者分发的安装包。
 *
 * 服务端：https://auth.dixunblog.cn/api/v2/{init,activate,heartbeat,refresh,trial}.php
 *          （2026-11-13 授权站启用 SSL，http 已由服务器 301 跳转到 https）
 * 协议要点（依据官方开发文档）：
 *   1. init.php  POST {app_key}                → RSA 公钥 / server_time / heartbeat_interval
 *   2. activate  POST {app_key, data}          → data 为内层 JSON 经 RSA-2048 PKCS#1 v1.5
 *                                               分块加密后 Base64；内层含 timestamp/nonce/
 *                                               sign/auth_code/fingerprint/device_info
 *   3. heartbeat POST {timestamp,nonce,sign,token} 固定 5 秒，15 秒无心跳判离线
 *   4. refresh   POST {timestamp,nonce,sign,token,refresh_token,fingerprint}
 *   5. 错误码：401 令牌无效 / 403 强制下线 / 410 已过期 / 423 待审核 / 429 过频
 *
 * 浏览器侧三个特殊处理（桌面 SDK 不需要考虑）：
 *   - WebCrypto 不支持 RSAES-PKCS1-v1_5「加密」（只支持 OAEP），这里用 BigInt 手写；
 *   - 浏览器拿不到 CPU/硬盘/MAC/主板序列号，用扩展安装 ID + 运行环境信息构造
 *     符合文档格式（≥3 个 64 位十六进制 SHA-256 组件）的设备指纹；
 *   - MV3 Service Worker 会被回收，5 秒心跳由 offscreen 文档里的 Worker 驱动。
 *
 * 本模块是纯算法 + 状态机，不直接依赖 chrome.*：运行环境通过 configure() 注入，
 * 因此可以在 Service Worker、popup、Node（自检/签发工具）三处复用同一份实现。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.APOnline = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // ============================== 作者配置区 ==============================
  // APP_KEY 由作者用 `node tools/set-appkey.js --app-key <后台AppKey>` 写入。
  // 在填入前本模块不会向服务器发起任何请求（isAppKeyConfigured() === false）。
  const CONFIG = {
    API_BASE: 'https://auth.dixunblog.cn/api/v2/',
    APP_KEY: '__APP_KEY__',
    // 开发文档「配置」表公开的客户端密钥（服务端同值），参与 SHA-256 签名
    CLIENT_SECRET: '__CLIENT_SECRET__',
    HEARTBEAT_MS: 5000,                 // 服务端固定 5 秒
    ONLINE_FRESH_MS: 17000,             // 17 秒内有过成功心跳 → 视为在线
    GRACE_MS: 5 * 60 * 1000,            // 断网宽限：5 分钟内继续可用
    PUBLIC_KEY_TTL_MS: 12 * 3600 * 1000,
    REQUEST_TIMEOUT_MS: 12000,
    STATE_KEY: 'apOnlineState',
    SIGN_MODE: 'values'                 // 'values'=文档安全章节/C#/Java；'kv'=Python 示例写法
  };
  // =========================================================================

  // ---------- 运行环境（可注入，便于 Node 测试） ----------
  let injected = null;
  const memStore = {};

  function chromeStorage() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    return {
      get: (key) => new Promise((resolve) => {
        try {
          chrome.storage.local.get(key, (r) => resolve((r && r[key]) || null));
        } catch (e) { resolve(null); }
      }),
      set: (key, val) => new Promise((resolve) => {
        try { chrome.storage.local.set({ [key]: val }, () => resolve()); }
        catch (e) { resolve(); }
      })
    };
  }

  async function defaultOfflineKey() {
    // 优先读本地 state：activate 刚写入即可见，避免 storage.sync 异步写回的竞态
    try {
      const s = await env().storage.get(CONFIG.STATE_KEY);
      if (s && s.offlineKey) return s.offlineKey;
    } catch (e) {}
    return new Promise((resolve) => {
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) { resolve(''); return; }
        // 兼容 v2.1.x 老用户：离线码原先只存在 sync.licenseKey
        chrome.storage.sync.get({ licenseKey: '' }, (r) => resolve((r && r.licenseKey) || ''));
      } catch (e) { resolve(''); }
    });
  }

  function env() {
    if (injected) return injected;
    const store = chromeStorage() || {
      get: async (k) => (k in memStore ? memStore[k] : null),
      set: async (k, v) => { memStore[k] = v; }
    };
    injected = {
      storage: store,
      fetchFn: (url, opts) => fetch(url, opts),
      now: () => Date.now(),
      random: (len) => {
        const b = new Uint8Array(len);
        (globalThis.crypto || {}).getRandomValues(b);
        return b;
      },
      offlineKey: defaultOfflineKey,
      license: getLicenseApi()
    };
    return injected;
  }

  /** 注入测试替身；传 null 可恢复默认环境 */
  function configure(overrides) {
    injected = overrides ? Object.assign({
      storage: { get: async () => null, set: async () => {} },
      fetchFn: async () => ({ text: async () => '{}' }),
      now: () => Date.now(),
      random: (len) => {
        const b = new Uint8Array(len);
        (globalThis.crypto || {}).getRandomValues(b);
        return b;
      },
      offlineKey: async () => '',
      license: getLicenseApi()
    }, overrides) : null;
    return injected;
  }

  function getLicenseApi() {
    if (typeof APLicense !== 'undefined' && APLicense) return APLicense;
    if (globalThis.APLicense) return globalThis.APLicense;
    if (typeof require === 'function') {
      try { return require('./license.js'); } catch (e) {}
    }
    return null;
  }

  function isAppKeyConfigured() {
    return !!(CONFIG.APP_KEY && CONFIG.APP_KEY.indexOf('__') !== 0);
  }

  // ---------- 基础工具 ----------
  const enc = (s) => new TextEncoder().encode(String(s));
  const hexOf = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

  function sha256Hex(str) {
    const L = env().license || getLicenseApi();
    if (!L || typeof L.sha256 !== 'function') throw new Error('SHA-256 实现不可用（license.js 未加载）');
    return hexOf(L.sha256(enc(str)));
  }

  function base64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function bytesFromBase64(b64) {
    const s = atob(String(b64).replace(/\s/g, ''));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function concatBytes(arrs) {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    arrs.forEach(a => { out.set(a, p); p += a.length; });
    return out;
  }

  function randomHex(bytesLen) {
    return hexOf(env().random(bytesLen));
  }

  // ---------- 签名 ----------
  /**
   * 文档「安全机制」：SHA256(timestamp + nonce + 按参数名排序后的**值**拼接 + client_secret)
   * 文档 Python 示例却是 `k=v&...&timestamp=...&nonce=...&client_secret=...`，
   * 两者矛盾。默认按前者（C#/Java/易语言 SDK 一致）；activate 失败时会自动用
   * 后者重试一次并记住可用模式，避免不同服务端版本导致签不进去。
   */
  function calcSign(bizParams, timestamp, nonce, mode) {
    const keys = Object.keys(bizParams || {}).sort();
    let s;
    if (mode === 'kv') {
      const paramStr = keys.map(k => k + '=' + String(bizParams[k])).join('&');
      s = paramStr + '&timestamp=' + timestamp + '&nonce=' + nonce + '&client_secret=' + CONFIG.CLIENT_SECRET;
    } else {
      s = String(timestamp) + String(nonce) +
        keys.map(k => String(bizParams[k])).join('') + CONFIG.CLIENT_SECRET;
    }
    return sha256Hex(s);
  }

  function stamp(signMode) {
    const timestamp = String(Math.floor(env().now() / 1000));
    const nonce = randomHex(8);
    return { timestamp, nonce };
  }

  function signedBody(bizParams, extra, signMode) {
    const { timestamp, nonce } = stamp();
    const body = {
      timestamp: timestamp,
      nonce: nonce,
      sign: calcSign(bizParams, timestamp, nonce, signMode)
    };
    return Object.assign(body, extra || {});
  }

  // ---------- RSA-2048 PKCS#1 v1.5 加密（WebCrypto 不提供） ----------
  function readTLV(buf, pos) {
    const tag = buf[pos++];
    let len = buf[pos++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++];
    }
    return { tag, start: pos, end: pos + len, value: buf.subarray(pos, pos + len) };
  }

  function parsePublicKey(pem) {
    const b64 = String(pem || '')
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s/g, '');
    const der = bytesFromBase64(b64);
    const spki = readTLV(der, 0);
    const alg = readTLV(der, spki.start);
    const bit = readTLV(der, alg.end);           // BIT STRING
    const inner = bit.value.subarray(1);         // 首字节 = unused bits
    const rs = readTLV(inner, 0);                // RSAPublicKey ::= SEQUENCE { n, e }
    const nTlv = readTLV(inner, rs.start);
    const eTlv = readTLV(inner, nTlv.end);
    let nb = nTlv.value;
    if (nb[0] === 0) nb = nb.subarray(1);        // INTEGER 前导 0
    let eb = eTlv.value;
    if (eb[0] === 0) eb = eb.subarray(1);
    return {
      n: bytesToBigInt(nb),
      e: bytesToBigInt(eb),
      k: nb.length
    };
  }

  function bytesToBigInt(b) {
    let x = 0n;
    for (let i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]);
    return x;
  }

  function bigIntToBytes(x, len) {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
    return out;
  }

  function modPow(base, exp, mod) {
    let r = 1n, x = base % mod;
    let e = exp;
    while (e > 0n) {
      if (e & 1n) r = (r * x) % mod;
      x = (x * x) % mod;
      e >>= 1n;
    }
    return r;
  }

  function randomNonZero(len) {
    const out = new Uint8Array(len);
    let i = 0;
    let guard = 0;
    while (i < len && guard++ < 32) {
      const chunk = env().random(len - i);
      for (let j = 0; j < chunk.length && i < len; j++) {
        if (chunk[j] !== 0) out[i++] = chunk[j];
      }
    }
    // 随机数源异常（全 0）时退化填充，保证 PKCS#1 的 PS 段绝不含 0x00
    while (i < len) out[i++] = 1;
    return out;
  }

  /** 返回 Base64（多块密文顺序拼接），与桌面 SDK 的 RsaEncrypt 完全一致 */
  function rsaEncryptPkcs1(publicKeyPem, plaintext) {
    const { n, e, k } = parsePublicKey(publicKeyPem);
    const msg = enc(plaintext);
    const blockSize = k - 11;                    // PKCS#1 v1.5 至少 11 字节开销
    const blocks = [];
    const count = Math.max(1, Math.ceil(msg.length / blockSize));
    for (let i = 0; i < count; i++) {
      const m = msg.subarray(i * blockSize, (i + 1) * blockSize);
      const ps = randomNonZero(k - 3 - m.length);
      // EM = 0x00 || 0x02 || PS(非零) || 0x00 || M
      const em = concatBytes([new Uint8Array([0, 2]), ps, new Uint8Array([0]), m]);
      const c = modPow(bytesToBigInt(em), e, n);
      blocks.push(bigIntToBytes(c, k));
    }
    return base64FromBytes(concatBytes(blocks));
  }

  // ---------- 设备指纹 ----------
  async function loadState() {
    const s = await env().storage.get(CONFIG.STATE_KEY);
    return (s && typeof s === 'object') ? s : {};
  }

  async function saveState(patch) {
    const s = Object.assign({}, await loadState(), patch);
    await env().storage.set(CONFIG.STATE_KEY, s);
    return s;
  }

  function navInfo() {
    const n = (typeof navigator !== 'undefined' && navigator) ? navigator : {};
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    return {
      ua: n.userAgent || '',
      lang: n.language || '',
      platform: n.platform || '',
      cores: n.hardwareConcurrency || 0,
      tz: tz,
      extId: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) || 'node'
    };
  }

  /** 文档要求：final + components（≥3 个组件，每个 64 位十六进制 SHA-256） */
  async function buildFingerprint() {
    const state = await loadState();
    let deviceId = state.deviceId;
    if (!deviceId) {
      deviceId = randomHex(16);
      await saveState({ deviceId });
    }
    const n = navInfo();
    const components = {
      // 主组件：扩展本地持久 ID（重装/换浏览器会变，服务端据此绑定设备）
      device: sha256Hex('AVP-DEVICE|' + deviceId),
      // 运行环境
      runtime: sha256Hex('AVP-RUNTIME|' + n.extId + '|' + n.ua + '|' + n.cores),
      // 区域/语言
      locale: sha256Hex('AVP-LOCALE|' + n.lang + '|' + n.tz + '|' + n.platform),
      // 系统信息
      system: sha256Hex('AVP-SYSTEM|' + n.platform + '|' + n.ua.length + '|' + n.cores)
    };
    const keys = Object.keys(components).sort();
    const final = sha256Hex(keys.map(k => components[k]).join(''));
    return { final, components, deviceId };
  }

  function deviceInfo() {
    const n = navInfo();
    return {
      // 服务端只定义了 windows / android 两种；浏览器扩展运行在桌面端，统一按 windows 上报
      platform: 'windows',
      os_version: n.platform || n.ua || 'Windows',
      is_virtual: false,
      virtual_type: ''
    };
  }

  // ---------- HTTP ----------
  async function post(api, body) {
    const E = env();
    let res;
    try {
      res = await E.fetchFn(CONFIG.API_BASE + api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
          ? AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS) : undefined
      });
      const text = await res.text();
      try { return JSON.parse(text); }
      catch (e) { return { code: -1, message: '服务器返回内容不是 JSON', raw: String(text).slice(0, 120) }; }
    } catch (e) {
      return { code: -1, message: '无法连接授权服务器：' + ((e && e.message) || e) };
    }
  }

  function errMsg(r, fallback) {
    if (!r) return fallback;
    return r.message || r.msg || fallback;
  }

  // ---------- 状态判定（纯函数，便于测试） ----------
  function computeStatus(s, offlineResult, now) {
    const out = {
      ok: false,
      mode: 'none',
      source: 'none',
      reason: 'missing',
      msg: '未授权：请输入授权码',
      appKeyConfigured: isAppKeyConfigured(),
      expireAt: s.expireAt || 0,
      remainDays: s.remainDays || 0,
      lastOkAt: s.lastOkAt || 0,
      deviceId: s.deviceId || '',
      cloud: s.cloud || null,
      offlineAvailable: !!(offlineResult && offlineResult.ok)
    };
    const hasOffline = !!(offlineResult && offlineResult.ok);

    // 在线会话有效时优先按在线展示（心跳新鲜 / 断网宽限内）
    if (!s.revoked && s.token && s.lastOkAt) {
      const age = now - s.lastOkAt;
      if (age <= CONFIG.ONLINE_FRESH_MS) {
        Object.assign(out, {
          ok: true, mode: 'online', source: 'online', reason: 'ok',
          msg: '在线授权有效' + (s.expireAt ? ' · 到期 ' + fmtDateMs(s.expireAt) : '')
        });
        return out;
      }
      if (age <= CONFIG.GRACE_MS) {
        Object.assign(out, {
          ok: true, mode: 'grace', source: 'online', reason: 'ok',
          msg: '授权有效 · 暂未连上服务器（宽限中，' +
            Math.ceil((CONFIG.GRACE_MS - age) / 60000) + ' 分钟内请恢复网络）'
        });
        return out;
      }
    }

    // v2.2.1 兼容策略：作者签发的 AVP1 离线码是**独立凭证**。
    // v2.1.x 老用户升级后不需要联网、不需要重新激活，也不受在线会话过期、
    // 后台 403/410 停用或到期的影响 —— 这是"旧授权不受新机制影响"的核心保证。
    // 纯在线用户手上没有离线码，因此后台强制下线对他们依然立即生效。
    if (hasOffline) {
      Object.assign(out, {
        ok: true, mode: 'offline', source: 'offline', reason: 'ok',
        msg: '离线授权有效' + (offlineResult.msg ? ' · ' + offlineResult.msg : '')
      });
      return out;
    }

    // 后台明确禁用 / 到期：仅在没有任何有效离线码时停手
    if (s.revoked) {
      out.reason = s.revokedReason || 'revoked';
      out.msg = s.revokedMsg || '授权已被后台停用或已到期，请联系作者';
      return out;
    }
    if (s.token && s.lastOkAt) {
      out.reason = 'session-lost';
      out.msg = '与授权服务器断开过久，请检查网络或重新激活';
    }
    return out;
  }

  function fmtDateMs(ms) {
    if (!ms) return '永久';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  async function getStatus() {
    const E = env();
    const s = await loadState();
    let offline = null;
    try {
      const raw = await E.offlineKey();
      const L = E.license || getLicenseApi();
      if (raw && L && typeof L.verifyLicense === 'function') {
        offline = L.verifyLicense(raw, '', E.now());
      }
    } catch (e) {}
    return computeStatus(s, offline, E.now());
  }

  // ---------- 接口封装 ----------
  async function getPublicKey(force) {
    const s = await loadState();
    if (!force && s.publicKey && s.publicKeyAt && (env().now() - s.publicKeyAt < CONFIG.PUBLIC_KEY_TTL_MS)) {
      return s.publicKey;
    }
    const r = await post('init.php', { app_key: CONFIG.APP_KEY });
    if (r.code !== 200 || !r.data || !r.data.public_key) {
      throw new Error(errMsg(r, '获取服务器公钥失败'));
    }
    await saveState({ publicKey: r.data.public_key, publicKeyAt: env().now() });
    return r.data.public_key;
  }

  function parseExpire(data) {
    if (!data) return 0;
    if (data.remain_seconds) return env().now() + Number(data.remain_seconds) * 1000;
    if (data.expire_time) {
      const ms = Date.parse(String(data.expire_time).replace(' ', 'T'));
      if (!isNaN(ms)) return ms;
    }
    return 0;
  }

  async function saveOfflineKey(raw) {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) return false;
      await new Promise((resolve) => {
        chrome.storage.sync.set({ licenseKey: raw }, () => resolve());
      });
      return true;
    } catch (e) { return false; }
  }

  /**
   * 激活。在线卡密走 activate.php；以 AVP1 开头的是作者签发的应急离线码，
   * 直接本地校验后写入 storage.sync（与 v2.1.x 兼容）。
   */
  async function activate(rawCode) {
    const E = env();
    const code = String(rawCode || '').trim();
    if (!code) return { ok: false, msg: '请输入授权码' };
    const L = E.license || getLicenseApi();

    // 应急离线码：不联网，本地验签
    if (code.toUpperCase().indexOf('AVP1') === 0) {
      const st = (L && L.verifyLicense) ? L.verifyLicense(code, '', E.now())
        : { ok: false, msg: '离线授权模块未加载' };
      if (!st.ok) return { ok: false, msg: st.msg, reason: st.reason };
      await saveOfflineKey(code);
      await saveState({ offlineKey: code });
      return {
        ok: true, msg: '应急离线授权已生效', mode: 'offline',
        state: computeStatus(await loadState(), st, E.now())
      };
    }

    if (!isAppKeyConfigured()) {
      return { ok: false, msg: '插件尚未配置 AppKey，请联系作者获取可激活版本', reason: 'appkey' };
    }

    let publicKey;
    try { publicKey = await getPublicKey(); }
    catch (e) { return { ok: false, msg: e.message, reason: 'network' }; }

    const fp = await buildFingerprint();
    const s0 = await loadState();
    const signMode = s0.signMode || CONFIG.SIGN_MODE;

    const doActivate = async (mode) => {
      const inner = signedBody(
        { app_key: CONFIG.APP_KEY, auth_code: code },
        {
          auth_code: code,
          fingerprint: { final: fp.final, components: fp.components },
          device_info: deviceInfo()
        },
        mode
      );
      let data;
      try { data = rsaEncryptPkcs1(publicKey, JSON.stringify(inner)); }
      catch (e) { return { code: -1, message: 'RSA 加密失败：' + e.message }; }
      return post('activate.php', { app_key: CONFIG.APP_KEY, data: data });
    };

    let r = await doActivate(signMode);
    // 文档两种签名写法矛盾：首次失败且疑似验签问题时，自动换另一种再试一次
    if (r.code !== 200 && (r.code === 400 || r.code === 401 || /签名|sign/i.test(errMsg(r, '')))) {
      const alt = signMode === 'values' ? 'kv' : 'values';
      const r2 = await doActivate(alt);
      if (r2.code === 200) { r = r2; await saveState({ signMode: alt }); }
    }

    if (r.code !== 200 || !r.data || !r.data.token) {
      const msg = errMsg(r, '激活失败');
      if (r.code === 423) return { ok: false, msg: '设备变更待审核：' + msg + '，请联系作者', reason: 'review' };
      if (r.code === 404) return { ok: false, msg: '授权码不存在或不属于本软件：' + msg, reason: 'notfound' };
      if (r.code === 410) return { ok: false, msg: '授权码已过期：' + msg, reason: 'expired' };
      if (r.code === 429) return { ok: false, msg: '操作过于频繁，请稍后再试', reason: 'ratelimit' };
      return { ok: false, msg: msg, reason: r.code < 0 ? 'network' : 'server' };
    }

    const d = r.data;
    await saveState({
      token: d.token,
      refreshToken: d.refresh_token || '',
      machineCode: fp.final,
      deviceId: fp.deviceId,
      expireAt: parseExpire(d),
      remainDays: Number(d.remain_days) || 0,
      lastOkAt: E.now(),
      revoked: false,
      revokedReason: '',
      revokedMsg: '',
      activatedAt: E.now(),
      authCode: code
    });
    return { ok: true, msg: '激活成功' + (d.remain_days ? ' · 剩余 ' + d.remain_days + ' 天' : ''), state: await getStatus() };
  }

  /** 刷新 JWT（服务端：24 小时有效，过期后 1 小时内可刷新） */
  async function refresh() {
    const s = await loadState();
    if (!s.token || !s.refreshToken) return { ok: false, msg: '没有可刷新的令牌', reason: 'notoken' };
    const mode = s.signMode || CONFIG.SIGN_MODE;
    const body = signedBody(
      { fingerprint: s.machineCode, refresh_token: s.refreshToken, token: s.token },
      {
        token: s.token,
        refresh_token: s.refreshToken,
        fingerprint: s.machineCode
      },
      mode
    );
    const r = await post('refresh.php', body);
    if (r.code !== 200 || !r.data || !r.data.token) {
      return { ok: false, msg: errMsg(r, '刷新令牌失败'), code: r.code, reason: r.code === 401 ? 'refresh-expired' : 'network' };
    }
    await saveState({
      token: r.data.token,
      refreshToken: r.data.refresh_token || s.refreshToken,
      lastOkAt: env().now()
    });
    return { ok: true, msg: '令牌已刷新' };
  }

  /** 一次心跳。返回 { ok, state, changed }；网络失败不立即判失效，交给宽限状态机 */
  async function heartbeat() {
    const E = env();
    const s = await loadState();
    if (!s.token) return { ok: false, msg: '尚未激活', state: await getStatus(), changed: false };
    const mode = s.signMode || CONFIG.SIGN_MODE;
    const body = signedBody({ token: s.token }, { token: s.token }, mode);
    let r = await post('heartbeat.php', body);

    if (r.code === 401) {
      const rf = await refresh();
      if (rf.ok) {
        const s2 = await loadState();
        r = await post('heartbeat.php', signedBody({ token: s2.token }, { token: s2.token }, mode));
      }
    }

    if (r.code === 403 || r.code === 410) {
      await saveState({
        revoked: true,
        revokedReason: r.code === 410 ? 'expired' : 'banned',
        revokedMsg: r.code === 410 ? '授权已到期，请联系作者续费' : '授权已被后台停用，请联系作者'
      });
      return { ok: false, msg: errMsg(r, '授权已失效'), state: await getStatus(), changed: true };
    }

    if (r.code !== 200) {
      // 429 过频 / 网络异常：不动 lastOkAt，宽限计时自然推进
      return { ok: false, msg: errMsg(r, '心跳失败'), state: await getStatus(), changed: false };
    }

    const d = r.data || {};
    const patch = {
      lastOkAt: E.now(),
      revoked: false,
      revokedReason: '',
      revokedMsg: '',
      cloud: d.cloud || s.cloud || null
    };
    const exp = parseExpire(d);
    if (exp) patch.expireAt = exp;
    if (d.remain_seconds) patch.remainDays = Math.ceil(Number(d.remain_seconds) / 86400);
    await saveState(patch);
    return { ok: true, msg: '在线', state: await getStatus(), changed: true };
  }

  /** 启动/唤醒时调用：会话不新鲜就刷新令牌并补一次心跳 */
  async function ensureSession() {
    const E = env();
    const s = await loadState();
    if (!s.token) return { ok: false, state: await getStatus() };
    const stale = (E.now() - (s.lastOkAt || 0)) > CONFIG.ONLINE_FRESH_MS;
    const nearExpiry = s.expireAt && (s.expireAt - E.now() < 60 * 60 * 1000);
    if (!stale && !nearExpiry) return { ok: true, state: await getStatus(), fresh: true };
    if (nearExpiry) await refresh();
    return heartbeat();
  }

  async function clear() {
    const s = await loadState();
    // 保留 deviceId（重装/清授权不应改变设备指纹，防止刷试用）
    await env().storage.set(CONFIG.STATE_KEY, {
      deviceId: s.deviceId || '',
      signMode: s.signMode || CONFIG.SIGN_MODE
    });
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
        chrome.storage.sync.set({ licenseKey: '' });
      }
    } catch (e) {}
    return getStatus();
  }

  /** 试用（每设备一次）；是否开放入口由前台决定 */
  async function trial() {
    if (!isAppKeyConfigured()) return { ok: false, msg: '插件尚未配置 AppKey', reason: 'appkey' };
    let publicKey;
    try { publicKey = await getPublicKey(); }
    catch (e) { return { ok: false, msg: e.message, reason: 'network' }; }
    const fp = await buildFingerprint();
    const s0 = await loadState();
    const mode = s0.signMode || CONFIG.SIGN_MODE;
    const inner = signedBody(
      { app_key: CONFIG.APP_KEY },
      { fingerprint: { final: fp.final, components: fp.components }, device_info: deviceInfo() },
      mode
    );
    let data;
    try { data = rsaEncryptPkcs1(publicKey, JSON.stringify(inner)); }
    catch (e) { return { ok: false, msg: 'RSA 加密失败：' + e.message }; }
    const r = await post('trial.php', { app_key: CONFIG.APP_KEY, data: data });
    if (r.code !== 200 || !r.data || !r.data.token) {
      return { ok: false, msg: errMsg(r, '试用申请失败'), reason: 'server' };
    }
    const d = r.data;
    await saveState({
      token: d.token, refreshToken: d.refresh_token || '', machineCode: fp.final,
      deviceId: fp.deviceId, expireAt: parseExpire(d), lastOkAt: env().now(),
      revoked: false, revokedReason: '', revokedMsg: '', activatedAt: env().now(), isTrial: true
    });
    return { ok: true, msg: '试用已开通', state: await getStatus() };
  }

  return {
    CONFIG, configure, isAppKeyConfigured,
    calcSign, rsaEncryptPkcs1, parsePublicKey, buildFingerprint, deviceInfo,
    computeStatus, sha256Hex,
    getStatus, getPublicKey, activate, heartbeat, refresh, ensureSession, trial, clear,
    loadState, saveState, fmtDateMs
  };
});
