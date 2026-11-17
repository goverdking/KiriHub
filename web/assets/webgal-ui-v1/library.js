import { ENGINE_REGISTRY, STATUS, escapeHTML as e, icon, readState, saveState, recordFor, updateRecord,
  applyTheme, loadLibrary, parseManifest, relativeDate, downloadJSON } from './core.js';

const $ = id => document.getElementById(id);
const state = readState();
applyTheme(state.theme);
let games = [], nav = 'library', filter = 'all', detailId = '', toastTimer, loading = true;
const labels = { library: ['游戏库', '喜欢的故事，都在这里。'], recent: ['最近游玩', '回到上一次打开的故事。'], favorites: ['我的收藏', '把心动的作品，放在伸手可及的地方。'] };
const searchText = value => String(value).toLocaleLowerCase().replace(/[\s＊*·・\-_/]/g, '');
const configured = g => Object.hasOwn(ENGINE_REGISTRY, g.engine);
function persist() { if (!saveState(state)) toast('浏览器暂时无法保存资料，本次修改仅在当前页面有效。'); }
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 2800); }
function records(g) { return recordFor(state, g.id); }
function baseGames() { return games.filter(g => nav === 'favorites' ? records(g).favorite : nav === 'recent' ? records(g).lastLaunched > 0 : true); }
function launch(id) { location.href = '/player.html?id=' + encodeURIComponent(id); }
function art(g, cls = '', lazy = true) { return g.cover ? `<img src="${e(g.cover)}" alt="${e(g.name)}" class="${cls}" ${lazy ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async">` : `<span class="art-fallback">${icon('book')}</span>`; }
function favoriteButton(g, cls) { const on = records(g).favorite; return `<button class="icon-button ${cls} ${on ? 'favorite-on' : ''}" data-action="favorite" data-id="${g.id}" aria-label="${on ? '取消收藏' : '收藏'}${e(g.name)}" aria-pressed="${on}">${icon('heart')}</button>`; }

function renderFeature() {
  const pool = baseGames();
  const chosen = [...pool].sort((a, b) => records(b).lastLaunched - records(a).lastLaunched)[0];
  $('featured').hidden = !chosen || nav !== 'library';
  if (!chosen || nav !== 'library') return;
  const g = chosen, recent = records(g).lastLaunched > 0;
  $('featured').innerHTML = `<div class="featured-art">${art(g, '', false)}</div><div class="featured-content"><span class="feature-kicker">${icon(recent ? 'clock' : 'book')}${recent ? '再打开一段熟悉的故事' : '从这里，开启新的故事'}</span><h2>${e(g.name)}</h2><p class="feature-meta">${e(g.meta.studio || '视觉小说')}<span>·</span>${e(g.meta.subtitle || 'VISUAL NOVEL')}</p><p class="feature-description">${e(g.meta.summary || '把日常留在身后，走进另一个世界。属于你的下一段故事，随时开始。')}</p><div class="feature-actions"><button class="button button-accent" data-action="launch" data-id="${g.id}">${icon('play')}${recent ? '继续游玩' : '开始游玩'}</button>${favoriteButton(g, '')}<button class="button button-text" data-action="detail" data-id="${g.id}">游戏详情 ${icon('arrow')}</button></div></div><span class="feature-index">YOUR NEXT CHAPTER</span>`;
}
function renderGames() {
  const pool = baseGames();
  const query = searchText($('search').value.trim());
  let list = pool.filter(g => (filter === 'all' || records(g).status === filter) && (!query || searchText([g.name, g.meta.en, g.meta.studio, ...g.meta.tags].join(' ')).includes(query)));
  if ($('sort').value === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  if ($('sort').value === 'recent' || nav === 'recent') list.sort((a, b) => records(b).lastLaunched - records(a).lastLaunched);
  document.querySelectorAll('[data-filter]').forEach(button => {
    const key = button.dataset.filter;
    button.querySelector('span').textContent = key === 'all' ? pool.length : pool.filter(g => records(g).status === key).length;
    button.classList.toggle('active', key === filter); button.setAttribute('aria-pressed', key === filter);
  });
  $('result-count').textContent = list.length;
  $('games').classList.toggle('list-view', state.view === 'list');
  $('games').setAttribute('aria-busy', 'false');
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === state.view));
  $('games').innerHTML = list.map(g => `<article class="game-card" data-game-id="${g.id}"><button class="card-cover-button" data-action="detail" data-id="${g.id}" aria-label="查看${e(g.name)}详情">${art(g)}<span class="card-status">${e(STATUS[records(g).status])}</span></button>${favoriteButton(g, 'card-favorite')}<div class="card-body"><button class="card-title" data-action="detail" data-id="${g.id}">${e(g.name)}</button><p class="card-studio">${e(g.meta.studio || '视觉小说')}</p><div class="card-bottom">${icon('clock')}<span class="last-launched">${relativeDate(records(g).lastLaunched)}</span><button class="card-launch" data-action="launch" data-id="${g.id}">${configured(g) ? '启动' : '查看'}${icon('arrow')}</button></div></div></article>`).join('');
  if (nav === 'library' && filter === 'all' && !query && list.length) $('games').insertAdjacentHTML('beforeend', `<button class="add-tile" data-action="import">${icon('plus')}<strong>下一段故事，等你加入</strong><span>扩充你的私人游戏库</span></button>`);
  $('empty-state').hidden = list.length > 0;
  if (!list.length && !loading) {
    let title = '还没有游戏', text = '把第一部喜欢的作品放进书架。', action = `<button class="button button-secondary" data-action="import">${icon('plus')}添加游戏</button>`;
    if (query || filter !== 'all') { title = '暂时没有符合条件的游戏'; text = '试试其他名称、制作组，或重置筛选。'; action = '<button class="button button-secondary" data-action="reset">重置筛选</button>'; }
    else if (nav === 'favorites') { title = '收藏，还在等待第一份心动'; text = '点击游戏封面旁的爱心，就能把它收藏在这里。'; action = '<button class="button button-secondary" data-action="library">浏览游戏库</button>'; }
    else if (nav === 'recent') { title = '下一段故事，随时开始'; text = '启动过的游戏会出现在这里，方便下次回来。'; action = '<button class="button button-secondary" data-action="library">浏览游戏库</button>'; }
    $('empty-state').innerHTML = `${icon(nav === 'favorites' ? 'heart' : 'book')}<h3>${title}</h3><p>${text}</p>${action}`;
  }
}
function render() {
  const [title, subtitle] = labels[nav];
  $('page-title').innerHTML = e(title) + '<span class="heading-dot">.</span>';
  $('page-subtitle').textContent = subtitle; $('breadcrumb-current').textContent = title;
  document.title = title + ' · WebGAL';
  $('library-count').textContent = games.length; $('favorite-count').textContent = games.filter(g => records(g).favorite).length;
  $('footer-total').textContent = games.length + ' 款作品 · 每一次开始，都值得期待';
  document.querySelectorAll('[data-nav]').forEach(b => { const active = b.dataset.nav === nav; b.classList.toggle('active', active); if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('shelf-title').innerHTML = (nav === 'recent' ? '最近启动' : nav === 'favorites' ? '收藏的作品' : '我的游戏') + ' <span id="result-count">0</span>';
  renderFeature(); renderGames(); renderTheme();
}
function setNav(value) { nav = value; filter = 'all'; $('search').value = ''; render(); }
function showDialog(id) { document.querySelectorAll('dialog[open]').forEach(d => d.close()); $(id).showModal(); }
function showDetail(id) {
  const g = games.find(g => g.id === id); if (!g) return;
  detailId = id;
  $('detail-content').innerHTML = `<button class="icon-button dialog-close" data-close aria-label="关闭">${icon('close')}</button><div class="detail-layout"><div class="detail-art">${art(g, '', false)}</div><div class="detail-content"><p class="eyebrow">A STORY WORTH KEEPING</p><h2 id="detail-title">${e(g.name)}</h2><div class="detail-meta">${e(g.meta.studio || '视觉小说')}${g.meta.year ? ' · ' + e(g.meta.year) : ''}${g.meta.en ? ' · ' + e(g.meta.en) : ''}</div><div class="tag-list">${g.meta.tags.map(t => `<span class="tag">${e(t)}</span>`).join('')}</div><p class="detail-description">${e(g.meta.summary || '这部作品的详细介绍尚未添加。你可以先开始故事，也可以稍后补全资料。')}</p><label class="status-select">我的游玩状态<select id="game-status" aria-label="我的游玩状态">${Object.entries(STATUS).map(([key, label]) => `<option value="${key}" ${records(g).status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="detail-facts"><span>${e(ENGINE_REGISTRY[g.engine]?.label || '引擎待接入')}</span><span>最近启动：${relativeDate(records(g).lastLaunched)}</span></div><div class="detail-actions"><button class="button button-accent" data-action="launch" data-id="${g.id}">${icon('play')}${records(g).lastLaunched ? '继续游玩' : '开始游玩'}</button>${favoriteButton(g, '')}</div><p class="detail-note">启动后可在游戏内读取存档。</p></div></div>`;
  showDialog('detail-dialog');
}
function renderTheme() {
  applyTheme(state.theme);
  const dark = document.documentElement.dataset.theme === 'dark';
  $('quick-theme').innerHTML = icon(dark ? 'moon' : 'sun'); $('quick-theme').setAttribute('aria-label', dark ? '切换浅色外观' : '切换深色外观');
  document.querySelectorAll('[data-theme-option]').forEach(b => { const active = b.dataset.themeOption === state.theme; b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
}
document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]'); if (close) { close.closest('dialog').close(); return; }
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'launch') { const game = games.find(g => g.id === id); if (game && !configured(game)) showDetail(id); else launch(id); }
  if (action === 'detail') showDetail(id);
  if (action === 'favorite') {
    const focusScope = button.closest('.game-card') ? '#games' : '#featured';
    const restoreFocus = document.activeElement === button && !button.closest('dialog');
    const next = !recordFor(state, id).favorite; updateRecord(state, id, { favorite: next }); render();
    if (restoreFocus) document.querySelector(`${focusScope} [data-action="favorite"][data-id="${id}"]`)?.focus({ preventScroll: true });
    if ($('detail-dialog').open && detailId === id) {
      const b = $('detail-content').querySelector('[data-action=favorite]'); b.classList.toggle('favorite-on', next); b.setAttribute('aria-pressed', next); b.setAttribute('aria-label', (next ? '取消收藏' : '收藏') + games.find(g => g.id === id).name);
    }
    toast(next ? '已加入我的收藏' : '已取消收藏');
  }
  if (action === 'import') location.href = '/admin.html';
  if (action === 'library') setNav('library');
  if (action === 'reset') { filter = 'all'; $('search').value = ''; renderGames(); }
  if (action === 'reload') init();
});
document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => setNav(b.dataset.nav)));
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.filter; renderGames(); }));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; persist(); renderGames(); }));
$('search').addEventListener('input', renderGames); $('sort').addEventListener('change', renderGames);
$('add-game').addEventListener('click', () => { location.href = '/admin.html'; });
$('settings-button').addEventListener('click', () => showDialog('settings-dialog'));
$('detail-content').addEventListener('change', event => { if (event.target.id === 'game-status') { updateRecord(state, detailId, { status: event.target.value }); render(); toast('游玩状态已更新'); } });
document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', event => { if (event.target === d) { const r = d.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) d.close(); } }));
document.querySelectorAll('[data-theme-option]').forEach(b => b.addEventListener('click', () => { state.theme = b.dataset.themeOption; persist(); renderTheme(); }));
$('quick-theme').addEventListener('click', () => { state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; persist(); renderTheme(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.theme === 'system') renderTheme(); });
document.addEventListener('keydown', event => { if (event.key === '/' && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('search').focus(); } });
$('manifest-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MB 的清单文件。');
    const added = parseManifest(await file.text());
    const merged = new Map(state.imported.map(g => [g.id, g])); added.forEach(g => merged.set(g.id, g)); state.imported = [...merged.values()]; persist();
    ({ games } = await loadLibrary(state));
    $('import-message').textContent = '已导入 ' + added.length + ' 款游戏资料。';
    $('import-dialog').close(); setNav('library'); toast('已导入 ' + added.length + ' 款游戏资料');
  } catch (error) { $('import-message').textContent = error.message; }
  event.target.value = '';
});
$('download-example').addEventListener('click', () => downloadJSON('webgal-game-example.json', { schema: 1, games: [{ id: 'my-next-game', name: '我的下一部游戏', engine: 'krkrsdl2', cover: '/covers/my-next-game.webp', meta: { studio: '制作组', tags: ['中文'], summary: '在这里填写游戏简介。' }, webRuntime: { entry: '/engines/your-runtime/index.html', profile: 'my-next-game' } }] }));
$('export-manifest').addEventListener('click', () => downloadJSON('webgal-games.json', { schema: 1, updated: new Date().toISOString().slice(0, 10), games }));
$('export-state').addEventListener('click', () => downloadJSON('webgal-bookmarks.json', { format: 'webgal-bookmarks-v1', records: state.records }));
$('state-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MB 的标记文件。');
    const data = JSON.parse(await file.text());
    if (data.format !== 'webgal-bookmarks-v1' || !data.records || typeof data.records !== 'object') throw new Error('请选择 WebGAL 导出的标记文件。');
    for (const [id, record] of Object.entries(data.records)) if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) state.records[id] = recordFor({ records: { [id]: record } }, id);
    persist(); render(); $('settings-message').textContent = '标记已恢复。';
  } catch (error) { $('settings-message').textContent = error.message; }
  event.target.value = '';
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function init() {
  loading = true; $('games').setAttribute('aria-busy', 'true');
  try { ({ games } = await loadLibrary(state, AbortSignal.timeout(15000))); loading = false; render(); }
  catch (error) { loading = false; games = []; render(); $('featured').hidden = true; $('empty-state').hidden = false; $('empty-state').innerHTML = `${icon('server')}<h3>暂时无法打开书架</h3><p>请检查连接后重新加载，已有标记仍保存在浏览器中。</p><button class="button button-secondary" data-action="reload">${icon('refresh')}重新加载</button>`; console.error(error); }
}
init();
