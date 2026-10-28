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

// ---------- 授权 ----------
// 与 content.js 共用 license.js。v2.1.1 起授权为程序级（不绑定域名/平台），
// popup 里的校验即最终校验：签名 + 有效期 + 客户号，通过后全部功能可用。
const licBox = document.getElementById('licBox');
const licStatus = document.getElementById('licStatus');
const licInput = document.getElementById('licInput');
const licMeta = document.getElementById('licMeta');

function renderLicense(state, rawKey) {
  const author = (typeof APLicense !== 'undefined' && APLicense.AUTHOR) ? APLicense.AUTHOR : { name: '', contact: '' };
  if (state && state.ok) {
    licBox.classList.add('ok');
    licStatus.textContent = '✅ ' + state.msg;
    const p = state.payload || {};
    let detail = '授权信息：';
    if (p.c) detail += '客户 ' + p.c + ' · ';
    detail += '程序级授权（全部功能 · 全部已支持网站） · ';
    detail += (p.x ? '到期 ' + APLicense.fmtDate(p.x) : '永久有效');
    licMeta.innerHTML = escapeHtml(detail) +
      '<br>更换设备/浏览器时，用同一授权码再次激活即可（设置随 chrome 账号同步）。' +
      '<br><button class="lic-clear" id="licClear">清除本机授权</button>';
    const clear = document.getElementById('licClear');
    if (clear) clear.addEventListener('click', () => {
      chrome.storage.sync.set({ licenseKey: '' }, () => {
        licInput.value = '';
        loadLicense();
      });
    });
  } else {
    licBox.classList.remove('ok');
    const reason = (typeof APLicense !== 'undefined' && APLicense.reasonText) ? APLicense.reasonText(state) : '未授权';
    licStatus.textContent = '🔒 ' + reason;
    licMeta.innerHTML = '未授权时插件<strong>不会工作</strong>：不会自动播放、不会自动下一集。' +
      '<br>请联系作者购买授权并获取授权码：<b>' + escapeHtml(author.name || '') +
      (author.contact ? ' · ' + escapeHtml(author.contact) : '') + '</b>' +
      '<br>授权为程序级：不绑定网站，激活后全部功能可用；随 chrome 账号同步，换电脑登录同一账号即可。';
  }
  if (rawKey && !state.ok) licInput.value = rawKey;
}

function loadLicense() {
  chrome.storage.sync.get({ licenseKey: '' }, (s) => {
    const raw = (s && typeof s.licenseKey === 'string') ? s.licenseKey : '';
    const st = (typeof APLicense !== 'undefined')
      ? APLicense.verifyLicense(raw, '', Date.now())   // 程序级授权：不传域名
      : { ok: false, msg: '授权模块加载失败' };
    renderLicense(st, '');
  });
}

document.getElementById('licActivate').addEventListener('click', () => {
  const raw = licInput.value;
  const st = (typeof APLicense !== 'undefined')
    ? APLicense.verifyLicense(raw, '', Date.now())
    : { ok: false, msg: '授权模块加载失败' };
  if (!st.ok) { renderLicense(st, raw); return; }
  chrome.storage.sync.set({ licenseKey: raw }, () => {
    renderLicense(st, '');
    licInput.value = '';
  });
});

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
