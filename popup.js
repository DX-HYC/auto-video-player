const DEFAULTS = { enabled: true, autoResume: false, autoNext: true, resumeDelay: 1200, speedEnabled: false, playbackRate: 1 };
const CHECK_KEYS = ['enabled', 'autoResume', 'autoNext', 'speedEnabled'];

chrome.storage.sync.get(DEFAULTS, (s) => {
  CHECK_KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) el.checked = !!s[k];
  });
  const rateEl = document.getElementById('playbackRate');
  if (rateEl) rateEl.value = String(s.playbackRate || 1);
});

document.getElementById('apply').addEventListener('click', () => {
  const patch = {};
  CHECK_KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) patch[k] = el.checked;
  });
  const rateEl = document.getElementById('playbackRate');
  if (rateEl) patch.playbackRate = parseFloat(rateEl.value) || 1;
  chrome.storage.sync.set(patch, () => window.close());
});
