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
// 平台清单须与 content.js 的 PLATFORMS 保持一致（顺序一致、id 一致）
const PLATFORMS = [
  { id: 'whaty', name: '网梯科技', desc: 'webtrn.cn · .s_point 目录 · completestate 完成标记', frozen: true },
  { id: 'jxnu', name: '江西师范大学', desc: 'jxnu.edu.cn · 百家云播放器接管 · 目录百分比进度' },
  { id: 'generic', name: '通用兜底', desc: '其余视频站点的基础连播能力' }
];
const DEFAULTS = {
  enabled: true,
  // 进入页面/跳下一集后的"首次自动起播"，默认开启；autoResume 是"暂停后续播"，默认关闭
  autoStart: true,
  autoResume: false,
  autoNext: true,
  resumeDelay: 1200,
  speedEnabled: false,
  playbackRate: 1,
  platforms: { whaty: true, jxnu: true, generic: true }
};
const CHECK_KEYS = ['enabled', 'autoStart', 'autoResume', 'autoNext', 'speedEnabled'];

const platState = {};

// ---------- 授权（v2.2.0：在线卡密为主 + 应急离线码兜底） ----------
// 状态一律向 background.js 查询：JWT / 5 秒心跳 / 断网宽限都在后台单点管理，
// 弹窗只负责展示与发起激活。license.js 仍用于作者信息、日期格式化与应急码验签。
const licBox = document.getElementById('licBox');
const licStatus = document.getElementById('licStatus');
const licInput = document.getElementById('licInput');
const licMeta = document.getElementById('licMeta');

function authorText() {
  const a = (typeof APLicense !== 'undefined' && APLicense && APLicense.AUTHOR) ? APLicense.AUTHOR : { name: '', contact: '' };
  return (a.name || '作者') + (a.contact ? ' · ' + a.contact : '');
}

function fmtExpire(ms) {
  if (!ms) return '永久 / 未知';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function renderLicense(state, note) {
  const st = state || { ok: false, mode: 'none', msg: '未授权：请输入授权卡密' };
  if (st.ok) {
    licBox.classList.add('ok');
    const icon = st.mode === 'grace' ? '⚠️' : (st.mode === 'offline' ? '🔑' : '✅');
    licStatus.textContent = icon + ' ' + (st.msg || '授权有效');
    let detail = '授权来源：' +
      (st.mode === 'offline' ? '旧版离线码（无需联网，升级后继续有效）' : (st.mode === 'grace' ? '在线（断网宽限中）' : '在线卡密（已连接服务器）'));
    if (st.expireAt) detail += '<br>到期：' + fmtExpire(st.expireAt);
    if (st.remainDays) detail += '<br>剩余：约 ' + st.remainDays + ' 天';
    if (st.deviceId) detail += '<br>设备码：' + escapeHtml(String(st.deviceId).slice(0, 12));
    detail += '<br>程序级授权：全部功能 · 全部已支持网站';
    detail += '<br>清除本机授权会同时移除在线卡密与旧版离线码';
    if (st.cloud && st.cloud.announcements && st.cloud.announcements.length) {
      const a = st.cloud.announcements[0];
      detail += '<br>服务器公告：' + escapeHtml(a.title || '');
    }
    licMeta.innerHTML = detail +
      '<br><button class="lic-clear" id="licRefresh">重新检测</button> ' +
      '<button class="lic-clear" id="licClear">清除本机授权</button>';
    const refresh = document.getElementById('licRefresh');
    if (refresh) refresh.addEventListener('click', () => {
      licStatus.textContent = '正在重新连接授权服务器…';
      chrome.runtime.sendMessage({ type: 'apAuthRefresh' }, (res) => {
        void chrome.runtime.lastError;
        renderLicense(res && res.state ? res.state : st, '');
      });
    });
    const clear = document.getElementById('licClear');
    if (clear) clear.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'apAuthClear' }, () => {
        void chrome.runtime.lastError;
        licInput.value = '';
        loadLicense();
      });
    });
  } else {
    licBox.classList.remove('ok');
    let msg = st.msg || '未授权：请输入授权卡密';
    if (msg.indexOf('联系') < 0) msg += '，请联系 ' + authorText() + ' 获取授权';
    licStatus.textContent = '🔒 ' + msg;
    licMeta.innerHTML = '未授权时插件<strong>不会工作</strong>：不会自动播放、不会自动下一集。' +
      '<br>购买请联系 <b>' + escapeHtml(authorText()) + '</b>' +
      '<br>两种授权均可使用：<b>在线卡密</b>由后台签发（需联网），<b>旧版离线码</b>以 AVP1 开头（无需联网，升级后自动继续有效）。' +
      (st.appKeyConfigured === false ? '<br>⚠️ 本版本尚未配置 AppKey，请联系作者获取可激活版本。' : '');
  }
  if (note) licStatus.textContent += '（' + note + '）';
}

function localLicenseState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get({ licenseKey: '' }, (r) => {
        const raw = (r && r.licenseKey) || '';
        const st = (raw && typeof APLicense !== 'undefined')
          ? APLicense.verifyLicense(raw, '', Date.now())
          : { ok: false, msg: '后台服务暂不可用，请稍后重试' };
        resolve(st.ok
          ? { ok: true, mode: 'offline', source: 'offline', reason: 'ok', msg: '旧版离线授权有效（无需联网） · ' + st.msg, appKeyConfigured: true }
          : { ok: false, mode: 'none', source: 'none', reason: 'missing', msg: st.msg, appKeyConfigured: true });
      });
    } catch (e) {
      resolve({ ok: false, mode: 'none', msg: '后台服务暂不可用，请稍后重试', appKeyConfigured: true });
    }
  });
}

function loadLicense(note) {
  try {
    chrome.runtime.sendMessage({ type: 'apAuthState' }, async (res) => {
      void chrome.runtime.lastError;
      renderLicense(res && res.state ? res.state : await localLicenseState(), note);
    });
  } catch (e) { localLicenseState().then(st => renderLicense(st, note)); }
}

document.getElementById('licActivate').addEventListener('click', () => {
  const raw = licInput.value.trim();
  const btn = document.getElementById('licActivate');
  if (!raw) { loadLicense('请输入授权码'); return; }
  btn.disabled = true;
  btn.textContent = '处理中…';
  let done = false;
  const finish = (res) => {
    if (done) return;
    done = true;
    btn.disabled = false;
    btn.textContent = '激活';
    if (res && res.ok) { licInput.value = ''; loadLicense(); return; }
    // 后台 Service Worker 暂不可达时，旧版离线码仍可本地验签激活（与网页提示卡一致）
    if (raw.toUpperCase().indexOf('AVP1') === 0 &&
        typeof APLicense !== 'undefined' && APLicense && APLicense.verifyLicense) {
      const local = APLicense.verifyLicense(raw, '', Date.now());
      if (local.ok) {
        try {
          chrome.storage.sync.set({ licenseKey: raw }, () => {
            void chrome.runtime.lastError;
            licInput.value = '';
            loadLicense();
          });
        } catch (e) { loadLicense(); }
        return;
      }
    }
    loadLicense((res && res.msg) || '激活失败，请稍后重试');
  };
  try {
    chrome.runtime.sendMessage({ type: 'apAuthActivate', code: raw }, (res) => {
      void chrome.runtime.lastError;
      finish(res || null);
    });
  } catch (e) { finish(null); }
  setTimeout(() => finish({ ok: false, msg: '激活超时，请检查网络' }), 25000);
});

// 后台心跳导致的授权变化（到期 / 强制下线 / 恢复在线）实时反映到弹窗
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'apAuthChanged' && msg.state) renderLicense(msg.state, '');
    return false;
  });
} catch (e) {}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  CHECK_KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) el.checked = !!s[k];
  });
  const rateEl = document.getElementById('playbackRate');
  if (rateEl) {
    const rv = String(s.playbackRate || 1);
    // 存储了选项外的倍率时动态补选项，避免 select 显示空白
    if (!Array.prototype.some.call(rateEl.options, o => o.value === rv)) {
      const opt = document.createElement('option');
      opt.value = rv;
      opt.textContent = rv + 'x';
      rateEl.appendChild(opt);
    }
    rateEl.value = rv;
  }

  const saved = (s.platforms && typeof s.platforms === 'object') ? s.platforms : {};
  const list = document.getElementById('platList');
  PLATFORMS.forEach((p) => {
    platState[p.id] = saved[p.id] !== false;
    const label = document.createElement('label');
    label.className = 'plat';
    label.innerHTML =
      '<input type="checkbox" data-plat="' + p.id + '"' + (platState[p.id] ? ' checked' : '') + '>' +
      '<span class="plat-main">' +
        '<span class="plat-name">' + p.name +
          (p.frozen ? '<span class="plat-frozen">已冻结</span>' : '') +
        '</span>' +
        '<span class="plat-desc">' + p.desc + '</span>' +
      '</span>';
    const box = label.querySelector('input');
    box.addEventListener('change', () => { platState[p.id] = box.checked; });
    list.appendChild(label);
  });
  loadLicense();
});

document.getElementById('apply').addEventListener('click', () => {
  const patch = {};
  CHECK_KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) patch[k] = el.checked;
  });
  const rateEl = document.getElementById('playbackRate');
  if (rateEl) patch.playbackRate = parseFloat(rateEl.value) || 1;
  // 平台启停是扁平的 boolean map，直接整体写入
  patch.platforms = Object.assign({}, platState);
  chrome.storage.sync.set(patch, () => window.close());
});
