import { readState, recordFor, updateRecord, loadLibrary, resolveLaunch } from './core.js';
const $ = id => document.getElementById(id);
const state = readState();
let game, runtime, ready = false, monitor, slowTimer, leaveConfirmed = false;
function setStatus(text) { $('launch-status').textContent = text; }
function fail(message) {
  clearInterval(monitor); clearTimeout(slowTimer);
  $('launch-screen').hidden = false; $('launch-screen').classList.add('error');
  $('launch-title').textContent = game?.name || '这段故事暂时无法打开';
  setStatus(message); $('retry').hidden = false;
  $('launch-note').textContent = '可以重新尝试，或返回游戏库。已有存档不会被删除。';
}
function reveal() {
  if (ready) return;
  ready = true; clearInterval(monitor); clearTimeout(slowTimer);
  $('launch-screen').hidden = true; $('player-hint').textContent = '点击游戏画面以启用声音';
  $('game-frame').contentWindow.focus();
}
function connectFrame() {
  const frame = $('game-frame');
  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return;
    try {
      const win = frame.contentWindow, doc = frame.contentDocument;
      const style = doc.createElement('style');
      style.textContent = 'html,body{background:#000;margin:0}body>a{display:none!important}.emscripten_border{border:0!important}';
      doc.head.append(style);
      if (runtime.engine === 'krkrsdl2') {
        monitor = setInterval(() => {
          const status = doc.querySelector('#status')?.textContent?.trim() || '';
          if (/加载失败|^Error:|Project download error/i.test(status)) { fail('游戏资源加载失败。请检查连接后重试。'); return; }
          if (doc.querySelector('#krkr-resource-recovery')) reveal();
          if (status && !ready) setStatus(/Downloading|Preparing|download/i.test(status) ? '正在加载游戏资源，首次打开会稍久一些…' : status);
        }, 400);
      } else reveal();
      win.addEventListener('error', event => {
        if (event.error && !ready) fail('引擎启动遇到错误，请稍后重试。');
      });
    } catch { fail('无法连接游戏画面。请检查启动配置。'); }
  });
  frame.src = runtime.url; frame.hidden = false;
  slowTimer = setTimeout(() => {
    if (!ready) { setStatus('加载比平时稍久，可以继续等待或重新加载。'); $('retry').hidden = false; }
  }, 90000);
}
async function boot() {
  try {
    const params = new URLSearchParams(location.search);
    const { games } = await loadLibrary(state, AbortSignal.timeout(15000));
    game = games.find(g => g.id === params.get('id'));
    if (!game) throw new Error('游戏库中没有找到这款游戏。请先返回书架。');
    document.title = game.name + ' · WebGAL'; $('game-name').textContent = game.name; $('launch-title').textContent = game.name;
    if (game.cover) $('launch-art').style.backgroundImage = `url(${JSON.stringify(game.cover)})`;
    runtime = resolveLaunch(game, params.get('engine') || '');
    setStatus('正在准备游戏画面…');
    const response = await fetch(runtime.entry, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('这款游戏的网页引擎还没有准备好。');
    const current = recordFor(state, game.id);
    updateRecord(state, game.id, { lastLaunched: Date.now(), status: current.status === 'completed' ? 'completed' : 'playing' });
    try { localStorage.setItem('kiri:last', game.id); } catch {}
    connectFrame();
  } catch (error) { fail(error.name === 'TimeoutError' ? '连接超时，请检查网络后重试。' : error.message); }
}
$('retry').addEventListener('click', () => { leaveConfirmed = true; location.reload(); });
window.addEventListener('message', event => {
  if (event.origin === location.origin && event.source === $('game-frame').contentWindow && event.data?.type === 'webgal:engine-ready') reveal();
});
$('back').addEventListener('click', () => { if (ready) $('leave-dialog').showModal(); else { leaveConfirmed = true; location.href = '/'; } });
$('confirm-leave').addEventListener('click', () => { leaveConfirmed = true; location.href = '/'; });
$('help').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { b.closest('dialog').close(); $('game-frame').contentWindow?.focus(); }));
document.querySelectorAll('dialog').forEach(d => d.addEventListener('close', () => { if (ready && !leaveConfirmed) $('game-frame').contentWindow?.focus(); }));
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { $('player-hint').textContent = '此浏览器未开放全屏，可使用浏览器菜单全屏'; }
});
document.addEventListener('fullscreenchange', () => { $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏'); });
$('exit-fullscreen').addEventListener('click', () => document.exitFullscreen());
window.addEventListener('beforeunload', event => { if (ready && !leaveConfirmed) { event.preventDefault(); event.returnValue = ''; } });
boot();
