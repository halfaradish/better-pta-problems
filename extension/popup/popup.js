const DEFAULTS = { enabled: true, grouped: true, badge: true, countdown: true, separators: '--,｜,|', rules: '', mergeSimilar: true };
const $ = id => document.getElementById(id);

async function load() {
  const { settings } = await chrome.storage.sync.get({ settings: {} });
  const s = { ...DEFAULTS, ...settings };
  for (const k of ['enabled', 'grouped', 'badge', 'countdown', 'mergeSimilar']) $(k).checked = !!s[k];
  $('separators').value = s.separators;
  $('rules').value = s.rules || '';
}

function collect() {
  return {
    enabled: $('enabled').checked,
    grouped: $('grouped').checked,
    badge: $('badge').checked,
    countdown: $('countdown').checked,
    mergeSimilar: $('mergeSimilar').checked,
    separators: $('separators').value.trim() || DEFAULTS.separators,
    rules: $('rules').value.trim(),
  };
}

function save() {
  chrome.storage.sync.set({ settings: collect() });
}

for (const k of ['enabled', 'grouped', 'badge', 'countdown', 'mergeSimilar']) $(k).addEventListener('change', save);
$('separators').addEventListener('input', save);
$('rules').addEventListener('input', save);
$('reset').addEventListener('click', async () => {
  await chrome.storage.sync.set({ settings: { ...DEFAULTS } });
  load();
});

load();
