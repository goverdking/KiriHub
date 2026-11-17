import { escapeHTML as e, readState, applyTheme } from '/assets/webgal-ui-v1/core.js';
applyTheme(readState().theme);
const $ = id => document.getElementById(id);
const labels = { queued: '排队中', scanning: '扫描中', ready: '待试运行', probing: '试运行中', checked: '启动通过', 'probe-failed': '启动失败', blocked: '待适配', interrupted: '已中断', published: '已加入' };
let imports = [], selectedEngine = 'krkrsdl2', browserLocation = '', browserParent = '', selectedPath = '', pollTimer, activeProbe, refreshBusy = false;
async function api(path, body) {
  const response = await fetch('/api/' + path, { cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { throw new Error('管理服务未连接，请稍后重试。'); }
  if (!response.ok) { if (response.status === 401 && path !== 'login') showLogin(); throw new Error(result.error || '请求失败'); }
  return result;
}
function showLogin() { clearInterval(pollTimer); $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('service-message').textContent = ''; }
async function showWorkspace() {
  $('workspace').hidden = false; $('login-panel').hidden = true; $('logout').hidden = false; $('service-message').textContent = '';
  const { engines } = await api('engines');
  $('engines').innerHTML = engines.map(engine => `<button class="engine-card" data-engine="${e(engine.id)}" aria-pressed="true"><span class="engine-emblem">K</span><div><b>${e(engine.label)}</b><small>${e(engine.description)}</small></div><span>✓</span></button>`).join('');
  selectedEngine = engines[0]?.id;
  await refresh(); clearInterval(pollTimer); pollTimer = setInterval(() => refresh().catch(error => { $('service-message').textContent = error.message; }), 2500);
}
function renderJobs() {
  $('job-count').textContent = imports.length ? '· ' + imports.length : '';
  if (!imports.length) { $('jobs').innerHTML = '<div class="empty-jobs"><span>✳</span><b>下一段故事，从这里开始</b><p>选择游戏路径，扫描结果会出现在这里。</p></div>'; return; }
  $('jobs').innerHTML = imports.map(job => {
    const r = job.result, bad = ['blocked', 'probe-failed', 'interrupted'].includes(job.status), good = ['published', 'checked'].includes(job.status);
    const canProbe = ['ready', 'checked', 'probe-failed', 'probing', 'published'].includes(job.status);
    return `<article class="job" data-job="${job.id}"><div class="job-top"><h3>${e(job.name || job.requestedName || job.source.split('/').pop())}</h3><span class="badge ${good ? 'good' : bad ? 'bad' : ''}">${labels[job.status] || e(job.status)}</span></div><p class="job-path">${e(job.source)}</p><p class="job-message">${e(job.message)}</p>${r ? `<div class="job-facts"><span>${r.archiveCount} 个 XP3</span><span>${(r.totalBytes / 1024 ** 3).toFixed(2)} GB</span><span>${r.verifiedAdapter ? '已匹配兼容配置' : '标准 Krkr 试适配'}</span></div>` : ''}<div class="job-actions">${canProbe ? `<button class="button button-secondary" data-probe="${job.id}">${job.status === 'published' ? '再次试运行' : '启动检查并添加'}</button>` : ''}${job.status === 'published' ? `<a class="button button-accent" href="/player.html?id=${e(job.gameId)}">开始游玩 →</a>` : ''}${bad ? `<button class="button button-secondary" data-retry="${job.id}">重新扫描</button>` : ''}</div>${r || job.check ? `<details><summary>查看检查详情</summary>${r ? `<p>适配器：${e(r.adapter)} · ${r.resourceCount} 条归档资源</p><p>${r.warnings.map(e).join('<br>')}</p><p>发现的 DLL：${e(r.plugins.join('、') || '无')}</p>` : ''}${job.check ? `<p>浏览器检查：${job.check.passed ? '启动通过（不等于全剧情回归）' : job.check.errors.map(e).join('<br>')}</p>` : ''}</details>` : ''}</article>`;
  }).join('');
}
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try { ({ imports } = await api('imports')); renderJobs(); } finally { refreshBusy = false; }
}
async function browse(path = '') {
  $('browser-message').textContent = '正在读取文件夹…'; $('select-folder').disabled = true;
  try {
    const result = await api('browse?path=' + encodeURIComponent(path));
    browserLocation = result.path; browserParent = result.parent; selectedPath = result.path;
    $('current-folder').textContent = result.path || '游戏目录'; $('parent-folder').disabled = result.parent === null;
    $('folder-list').innerHTML = result.entries.map(item => `<button class="folder-row" data-path="${e(item.path)}" data-kind="${item.type}"><i>${item.type === 'directory' ? '▱' : '▤'}</i><span>${e(item.name)}</span><small>${item.type === 'directory' ? '进入 →' : '压缩包'}</small></button>`).join('') || '<p class="muted">这个文件夹下没有其他文件夹或压缩包，可直接选择当前目录。</p>';
    $('browser-message').textContent = ''; $('select-folder').disabled = !selectedPath;
  } catch (error) { $('browser-message').textContent = error.message; }
}
$('browse').addEventListener('click', async () => { $('browser-dialog').showModal(); await browse(); });
$('parent-folder').addEventListener('click', () => browse(browserParent));
$('folder-list').addEventListener('click', event => {
  const button = event.target.closest('[data-path]'); if (!button) return;
  if (button.dataset.kind === 'directory') browse(button.dataset.path);
  else { selectedPath = button.dataset.path; document.querySelectorAll('.folder-row').forEach(b => b.classList.toggle('selected', b === button)); $('browser-message').textContent = '已选择：' + selectedPath; $('select-folder').disabled = false; }
});
$('select-folder').addEventListener('click', () => { $('source-path').value = selectedPath; $('browser-dialog').close(); });
$('scan').addEventListener('click', async () => {
  $('scan').disabled = true; $('scan-message').textContent = '正在创建扫描任务…';
  try { const job = await api('imports', { engine: selectedEngine, path: $('source-path').value.trim(), name: $('game-name').value.trim() }); $('scan-message').textContent = job.status === 'published' ? '这款游戏已添加，可在添加记录中直接启动。' : '任务已创建，结果会显示在添加记录中。'; await refresh(); }
  catch (error) { $('scan-message').textContent = error.message; }
  finally { $('scan').disabled = false; }
});
function endProbe() {
  if (activeProbe) { clearInterval(activeProbe.timer); clearTimeout(activeProbe.timeout); activeProbe = null; }
  $('probe-frame').src = 'about:blank';
}
async function startProbe(id) {
  endProbe();
  const job = imports.find(j => j.id === id); if (!job) return;
  $('probe-title').textContent = '试运行 · ' + job.name; $('probe-status').textContent = '正在启动游戏引擎…';
  $('probe-indicator').className = ''; $('publish').hidden = false; $('publish').disabled = true;
  $('publish').textContent = '检查通过后加入书架'; $('play-published').hidden = true;
  $('confirm-label').hidden = job.result.verifiedAdapter; $('confirm-playable').checked = false;
  $('probe-note').textContent = job.result.verifiedAdapter ? '已匹配游戏版本。启动检查通过后自动加入；已添加的游戏不会重复生成书架卡片。' : '此游戏使用标准试适配。检查通过后，还需确认标题、声音与操作正常再加入。';
  if (!$('probe-dialog').open) $('probe-dialog').showModal();
  try {
    const start = await api('imports/' + id + '/probe', {});
    activeProbe = { job, token: start.token, errors: [], readyAt: 0, started: Date.now(), finished: false, reporting: false };
    $('probe-frame').src = start.url;
    activeProbe.timeout = setTimeout(() => probeFailure('启动检查超过 120 秒。请检查资源连接或兼容配置。'), 120000);
    activeProbe.timer = setInterval(checkProbe, 500);
  } catch (error) { $('probe-status').textContent = error.message; }
}
async function probeFailure(message) {
  const p = activeProbe; if (!p || p.errors.length) return;
  p.errors.push(message); p.finished = false; p.reporting = true;
  clearTimeout(p.timeout); clearInterval(p.timer); $('publish').disabled = true; $('play-published').hidden = true; $('publish').hidden = false;
  $('probe-indicator').className = ''; $('probe-status').textContent = '检查失败：' + message;
  try { await api('imports/' + p.job.id + '/result', { token: p.token, ready: false, errors: p.errors }); await refresh(); }
  catch (error) { $('probe-status').textContent += ' · ' + error.message; }
}
async function checkProbe() {
  const p = activeProbe; if (!p || p.errors.length || p.reporting) return;
  try {
    const frame = $('probe-frame').contentWindow;
    const status = frame.document.querySelector('#status')?.textContent || '';
    if (/加载失败|^Error:|Project download error/i.test(status)) return probeFailure(status);
    if (frame.document.querySelector('#krkr-resource-recovery')) return probeFailure('有游戏资源加载失败，请检查 NAS 文件或连接后重新试运行');
  } catch { return; }
  if (!p.readyAt) return;
  const remaining = Math.ceil((20000 - (Date.now() - p.readyAt)) / 1000);
  if (remaining > 0) { $('probe-status').textContent = '引擎已启动，继续观察画面与错误… ' + remaining + ' 秒'; return; }
  p.reporting = true; clearTimeout(p.timeout); clearInterval(p.timer);
  try {
    await api('imports/' + p.job.id + '/result', { token: p.token, ready: true, errors: [] });
    if (p !== activeProbe || p.errors.length) return;
    p.finished = true; p.reporting = false;
    $('probe-indicator').className = 'good'; $('probe-status').textContent = '启动检查通过。';
    if (p.job.result.verifiedAdapter || p.job.status === 'published') await publish();
    else { $('publish').textContent = '确认并加入书架'; $('publish').disabled = !$('confirm-playable').checked; }
    await refresh();
  } catch (error) { p.reporting = false; $('probe-status').textContent = error.message; }
}
async function publish() {
  const p = activeProbe; if (!p || !p.finished || p.errors.length) return;
  $('publish').disabled = true;
  try {
    const job = await api('imports/' + p.job.id + '/publish', { confirmed: $('confirm-playable').checked });
    $('probe-status').textContent = job.message; $('publish').hidden = true;
    $('play-published').href = '/player.html?id=' + encodeURIComponent(job.gameId); $('play-published').hidden = false;
    await refresh();
  } catch (error) { $('probe-status').textContent = error.message; $('publish').disabled = false; }
}
window.addEventListener('message', event => {
  if (!activeProbe || event.origin !== location.origin || event.source !== $('probe-frame').contentWindow) return;
  if ((event.data?.type === 'webgal:probe' && event.data.event === 'ready') || event.data?.type === 'webgal:engine-ready') activeProbe.readyAt ||= Date.now();
  if (event.data?.type === 'webgal:probe' && event.data.event === 'error') probeFailure(event.data.detail || '游戏启动失败');
});
$('confirm-playable').addEventListener('change', () => { $('publish').disabled = !activeProbe?.finished || !$('confirm-playable').checked; });
$('publish').addEventListener('click', publish);
$('close-probe').addEventListener('click', () => { $('probe-dialog').close(); });
$('probe-dialog').addEventListener('close', endProbe);
$('jobs').addEventListener('click', async event => {
  const probe = event.target.closest('[data-probe]'); if (probe) return startProbe(probe.dataset.probe);
  const retry = event.target.closest('[data-retry]'); if (!retry) return;
  const job = imports.find(j => j.id === retry.dataset.retry);
  $('source-path').value = job.source; $('game-name').value = job.requestedName || ''; $('scan').focus(); $('scan-message').textContent = '已填回原路径，点击扫描即可重试。';
});
$('refresh').addEventListener('click', () => refresh().catch(error => { $('service-message').textContent = error.message; }));
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-message').textContent = '正在登录…';
  try { await api('login', { password: $('password').value }); $('password').value = ''; $('login-message').textContent = ''; await showWorkspace(); }
  catch (error) { $('login-message').textContent = error.message; }
});
$('logout').addEventListener('click', async () => { try { await api('logout', {}); endProbe(); $('probe-dialog').close(); showLogin(); } catch (error) { $('service-message').textContent = error.message; } });
$('change-password').addEventListener('click', () => $('password-dialog').showModal());
$('engines').addEventListener('click', event => {
  const button = event.target.closest('[data-engine]'); if (!button) return;
  selectedEngine = button.dataset.engine;
  document.querySelectorAll('[data-engine]').forEach(b => b.setAttribute('aria-pressed', b === button));
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('password', { password: $('new-password').value }); $('new-password').value = ''; $('password-dialog').close(); showLogin(); $('login-message').textContent = '密码已修改，请重新登录。'; }
  catch (error) { $('password-message').textContent = error.message; }
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
window.addEventListener('pagehide', endProbe);
try { const session = await api('session'); if (session.authenticated) await showWorkspace(); else showLogin(); }
catch (error) { $('service-message').textContent = error.message; }
