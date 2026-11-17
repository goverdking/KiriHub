export const ASSETS = '/assets/webgal-ui-v1/';
export const ENGINE_REGISTRY = {
  krkrsdl2: { label: 'KiriKiri', entry: '/engines/krkrsdl2/index.html' },
  krkr2: { label: 'KiriKiri', entry: '/engines/krkr2/index.html' },
  onsyuri: { label: 'ONScripter', entry: '/engines/onsyuri/onsyuri.html' },
  renpy: { label: "Ren’Py", entry: '/engines/renpy/index.html' },
  tyrano: { label: 'Tyrano', entry: '/engines/tyrano/index.html' }
};
export const STATUS = { unplayed: '未开始', playing: '在玩', planned: '想玩', completed: '已通关' };
const STORAGE_KEY = 'webgal:library:v1';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="${ASSETS}icons.svg#${name}"></use></svg>`;

export function localPath(value, fallback = '') {
  if (!value || typeof value !== 'string') return fallback;
  try {
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) return fallback;
    return url.pathname + url.search;
  } catch { return fallback; }
}
export function normalizeGame(raw) {
  if (!raw || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id) || typeof raw.name !== 'string' || !raw.name.trim()) throw new Error('每款游戏需要有效的英文 ID 和游戏名称。');
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const game = { ...raw, name: raw.name.trim().slice(0, 160), cover: localPath(raw.cover),
    meta: { ...meta, tags: Array.isArray(meta.tags) ? meta.tags.filter(t => typeof t === 'string').slice(0, 16) : [] } };
  game.art = localPath(raw.art || meta.art || raw.cover);
  return game;
}
export function parseManifest(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('无法读取这个文件，请选择有效的 JSON 游戏清单。'); }
  const list = Array.isArray(doc) ? doc : doc?.games;
  if (!Array.isArray(list) || list.length > 1000) throw new Error('游戏清单需要包含 games 数组，最多支持 1000 款。');
  const ids = new Set();
  return list.map(raw => { const game = normalizeGame(raw); if (ids.has(game.id)) throw new Error('游戏清单存在重复 ID：' + game.id); ids.add(game.id); return game; });
}
export function readState() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch {}
  return { records: raw.records && typeof raw.records === 'object' ? raw.records : {},
    imported: Array.isArray(raw.imported) ? raw.imported.flatMap(g => { try { return [normalizeGame(g)]; } catch { return []; } }) : [],
    view: raw.view === 'list' ? 'list' : 'grid', theme: ['light', 'dark', 'system'].includes(raw.theme) ? raw.theme : 'light' };
}
export function saveState(state) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; } catch { return false; } }
export function recordFor(state, id) {
  const raw = Object.hasOwn(state.records, id) ? state.records[id] : {};
  return { favorite: raw?.favorite === true, status: Object.hasOwn(STATUS, raw?.status) ? raw.status : 'unplayed',
    lastLaunched: Number.isFinite(raw?.lastLaunched) && raw.lastLaunched > 0 ? raw.lastLaunched : 0 };
}
export function updateRecord(state, id, patch) { state.records[id] = { ...recordFor(state, id), ...patch }; return saveState(state); }
export function applyTheme(theme) { document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'; }
export async function loadLibrary(state, signal) {
  const response = await fetch('/data/games.json', { cache: 'no-store', signal });
  if (!response.ok) throw new Error('暂时无法读取游戏库，请稍后重试。');
  const server = parseManifest(await response.text());
  const merged = new Map(server.map(g => [g.id, g]));
  state.imported.forEach(g => merged.set(g.id, g));
  return { games: [...merged.values()], server };
}
export function resolveLaunch(game, forced = '') {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const engine = forced || (mobile && game.altEngine ? game.altEngine : game.engine);
  if (!Object.hasOwn(ENGINE_REGISTRY, engine)) throw new Error('这款游戏的网页引擎尚未接入。');
  const config = ENGINE_REGISTRY[engine];
  let entry = config.entry;
  const query = new URLSearchParams();
  const data = game.data || {};
  if (engine === 'krkrsdl2') {
    if (game.webRuntime) {
      if (!/^\/engines\/[a-z0-9-]+\/index\.html$/.test(game.webRuntime.entry || '') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(game.webRuntime.profile || '')) throw new Error('游戏启动配置不完整，请检查引擎路径和资源清单。');
      entry = game.webRuntime.entry; query.set('game', game.webRuntime.profile);
    } else query.set('lazyxp3', '1');
  } else {
    if (data.url) { const url = localPath(data.url); if (!url) throw new Error('游戏资源需要使用本站地址。'); query.set('game', url); }
    if (engine === 'krkr2') { if (data.entry) query.set('entry', data.entry); query.set('loadMode', data.loadMode || 'lazy'); }
    if (engine === 'onsyuri' && data.index) { const index = localPath(data.index); if (!index) throw new Error('游戏索引需要使用本站地址。'); query.set('index', index); }
  }
  return { engine, label: config.label, entry, url: entry + '?' + query.toString() };
}
export function relativeDate(timestamp) {
  if (!timestamp) return '尚未启动';
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  return days <= 0 ? '今天' : days === 1 ? '昨天' : days < 7 ? days + ' 天前' : new Date(timestamp).toLocaleDateString('zh-CN');
}
export function downloadJSON(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
