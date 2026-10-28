/*!
 * 自动连播助手 (Auto Video Player) · 授权模块
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
 * 【商业化授权模块 · 离线授权码方案】
 *
 * 设计目标：
 *   1. 未授权时插件完全不工作（不扫描、不建面板、不自动播放），并提示联系作者；
 *   2. 授权码由作者用 tools/gen-license.js 本地签发，**不需要服务器**，买家联网与否都能激活；
 *   3. 程序级授权：不绑定域名、不绑定平台——授权码只证明"这个人有权使用本程序"，
 *      激活后全部功能、全部已支持网站均可使用（v2.1.1 起取消域名绑定）。
 *
 * 安全边界（请作者知悉）：
 *   离线授权码的签名密钥在本文件内，专业逆向可以提取密钥、伪造任意授权码。
 *   它能挡住 99% 的普通用户（手动改码必然校验失败），但挡不住专业破解。
 *   如需更强保护，应改为「服务器在线校验」——那需要你自建后端，不在本方案内。
 *   轮换密钥：修改下方 SIGN_SECRET 后重新打包，此前签发的所有授权码立即全部失效。
 *
 * 兼容性：不依赖 crypto.subtle（http 网站没有该 API），SHA-256/HMAC 为同步实现，
 *         content script / popup / Node（生成器）三处共用同一份代码，算法永不漂移。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // Node：授权码生成器
  else root.APLicense = api; // 浏览器：content script / popup
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================== 作者配置区 ==============================
  // 签名密钥：改这里 = 此前签发的所有授权码立即作废（用于泄露后轮换）
  const SIGN_SECRET = 'AP-LIC-2026-hYc9#Kq7mX2pL8sR4tW6yZ1bN5cD0gH3jF';
  // 授权码格式版本：payload.v 与此不符的旧码一律判为 version 过旧
  const LICENSE_VERSION = 1;
  // 授权码前缀：AVP1 = Auto Video Player v1 授权
  const KEY_PREFIX = 'AVP1';
  // 未授权提示里展示的作者联系方式
  const AUTHOR = {
    name: '胡昱晨 (hu_yu_chen)',
    contact: 'QQ：2657449167 · 微信：Evil_Hu123456'
  };
  // =========================================================================

  // ---------- UTF-8 ----------
  const enc = (s) => new TextEncoder().encode(String(s));
  const dec = (b) => new TextDecoder().decode(b);

  // ---------- SHA-256（同步实现） ----------
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256(bytes) {
    let H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    const l = bytes.length;
    const blocks = Math.ceil((l + 9) / 64);
    const total = blocks * 64;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = l * 8;
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(total - 4, bitLen >>> 0);
    const w = new Uint32Array(64);
    for (let b = 0; b < blocks; b++) {
      const off = b * 64;
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const x15 = w[i - 15], x2 = w[i - 2];
        const s0 = rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3);
        const s1 = rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & bb) ^ (a & c) ^ (bb & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = bb; bb = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    const B = 64;
    let k = keyBytes;
    if (k.length > B) k = sha256(k);
    const ki = new Uint8Array(B), ko = new Uint8Array(B);
    for (let i = 0; i < B; i++) {
      ki[i] = k[i] ^ 0x36;
      ko[i] = k[i] ^ 0x5c;
    }
    const inner = sha256(new Uint8Array([...ki, ...msgBytes]));
    return sha256(new Uint8Array([...ko, ...inner]));
  }

  // ---------- Base32（Crockford：无 I/L/O/U，避免肉眼误读） ----------
  const B32A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function bytesToB32(bytes) {
    let bits = 0, val = 0, out = '';
    for (let i = 0; i < bytes.length; i++) {
      val = (val << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) { out += B32A[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32A[(val << (5 - bits)) & 31];
    return out;
  }
  function b32ToBytes(str) {
    const clean = String(str).toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
    let bits = 0, val = 0;
    const out = [];
    for (let i = 0; i < clean.length; i++) {
      const idx = B32A.indexOf(clean[i]);
      if (idx < 0) continue;
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
    }
    return new Uint8Array(out);
  }

  // ---------- 授权码签发 / 校验 ----------
  // opts: { expire: unix秒(0=永久), customer: 'CUST-001', note: '备注' }
  // 程序级授权：payload 不含域名/平台字段，签出的码在任何网站都能用。
  // opts.domains 仍被接受但忽略（兼容旧调用方，v2.1.1 前生成的带域名码同样全站有效）。
  function makeKey(opts, secret) {
    const payload = {
      v: LICENSE_VERSION,
      x: Number((opts && opts.expire) || 0) || 0,
      c: String((opts && opts.customer) || ''),
      n: String((opts && opts.note) || '')
    };
    const body = bytesToB32(enc(JSON.stringify(payload)));
    const sig = bytesToB32(hmacSha256(enc(secret || SIGN_SECRET), enc(body)).slice(0, 10));
    return KEY_PREFIX + body + sig;
  }

  // 展示用：每 5 个字符一组（可安全地插入空格/连字符，normalizeKey 会清理）
  function prettyKey(key) {
    const k = String(key || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    return (k.match(/.{1,5}/g) || []).join('-');
  }

  // 用户输入容错：去空格/连字符、转大写
  function normalizeKey(raw) {
    return String(raw || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  function fmtDate(unixSec) {
    if (!unixSec) return '永久';
    const d = new Date(unixSec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 校验入口。rawKey: 用户输入；nowMs: 当前时间毫秒（测试可注入）。
  // hostname 参数保留但已不使用：v2.1.1 起授权为程序级，不校验网站域名；
  // 旧版（含域名绑定的）授权码同样不再受域名限制，签一次即全站全功能可用。
  function verifyLicense(rawKey, hostname, nowMs) {
    const key = normalizeKey(rawKey);
    if (!key || !key.startsWith(KEY_PREFIX) || key.length <= KEY_PREFIX.length + 16) {
      return { ok: false, reason: 'format', msg: '授权码格式不正确（示例：AVP1-XXXXX-…）' };
    }
    const sigStr = key.slice(-16);
    const body = key.slice(KEY_PREFIX.length, -16);
    const expect = bytesToB32(hmacSha256(enc(SIGN_SECRET), enc(body)).slice(0, 10));
    if (sigStr !== expect) {
      return { ok: false, reason: 'signature', msg: '授权码无效：非官方签发，或字符被改动过' };
    }
    let payload;
    try {
      payload = JSON.parse(dec(b32ToBytes(body)));
    } catch (e) {
      return { ok: false, reason: 'format', msg: '授权码内容无法解析' };
    }
    if (!payload || payload.v !== LICENSE_VERSION) {
      return { ok: false, reason: 'version', msg: '授权码版本过旧，请联系作者重新签发', payload: payload };
    }
    if (payload.x && (nowMs || Date.now()) / 1000 > payload.x) {
      return {
        ok: false, reason: 'expired', payload: payload,
        msg: '授权已于 ' + fmtDate(payload.x) + ' 到期，请联系 ' + AUTHOR.name + ' 续期'
      };
    }
    return {
      ok: true, reason: 'ok', payload: payload,
      msg: '已授权' + (payload.c ? ' · 客户 ' + payload.c : '') +
        (payload.x ? ' · 到期 ' + fmtDate(payload.x) : ' · 永久有效')
    };
  }

  function reasonText(r) {
    if (!r) return '未授权：请输入授权码';
    if (r.ok) return r.msg;
    return (r.msg || '未授权') + '，请联系 ' + AUTHOR.name + ' 获取授权（' + AUTHOR.contact + '）';
  }

  return {
    AUTHOR, LICENSE_VERSION, KEY_PREFIX, SIGN_SECRET,
    sha256, hmacSha256, bytesToB32, b32ToBytes,
    makeKey, prettyKey, normalizeKey, verifyLicense,
    reasonText, fmtDate
  };
});
