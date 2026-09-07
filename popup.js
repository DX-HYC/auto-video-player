const DEFAULTS = { enabled: true, autoResume: false, autoNext: true, resumeDelay: 1200 };
const KEYS = ['enabled', 'autoResume', 'autoNext'];

chrome.storage.sync.get(DEFAULTS, (s) => {
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) el.checked = !!s[k];
  });
});

document.getElementById('apply').addEventListener('click', () => {
  const patch = {};
  KEYS.forEach((k) => {
    const el = document.getElementById(k);
    if (el) patch[k] = el.checked;
  });
  chrome.storage.sync.set(patch, () => window.close());
});
