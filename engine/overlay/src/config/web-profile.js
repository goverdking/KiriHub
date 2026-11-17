(function () {
  'use strict';

  var Audio = window.AudioContext || window.webkitAudioContext;
  if (Audio) {
    var contexts = [];
    function GameAudioContext() {
      var context = new Audio(...arguments);
      contexts.push(context);
      return context;
    }
    GameAudioContext.prototype = Audio.prototype;
    Object.setPrototypeOf(GameAudioContext, Audio);
    window.AudioContext = window.webkitAudioContext = GameAudioContext;
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (event) {
      document.addEventListener(event, function () {
        contexts.forEach(function (context) {
          if (context.state === 'suspended') context.resume().catch(function () {});
        });
      }, { capture: true, passive: true });
    });
  }

  function localUrl(path) {
    var url = new URL(path, location.href);
    if (!path.startsWith('/') || url.origin !== location.origin) {
      throw new Error('Game files must use same-origin paths');
    }
    return url.href;
  }

  function read(url) {
    return fetch(localUrl(url)).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status + ' loading ' + url);
      return response;
    });
  }

  async function load(id) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid game ID');
    var manifest = await (await read('/data/web-games/' + id + '.json')).json();
    if (!manifest.files || !Object.prototype.hasOwnProperty.call(manifest.files, '/data.xp3')) {
      throw new Error('Game manifest must supply /data.xp3');
    }
    var files = {};
    Object.entries(manifest.files).forEach(function ([path, url]) {
      if (!/^\/(?:[a-z0-9_-]+\/)*[a-z0-9_.-]+$/i.test(path) || /\/\.{1,2}$/.test(path)) {
        throw new Error('Invalid game file path: ' + path);
      }
      files[path] = localUrl(url);
    });
    var compatibility = Object.entries(manifest.compatibility || {}).map(function ([name, url]) {
      if (!/^[a-z0-9_-]+\.(?:tjs|ttf|otf)$/i.test(name)) {
        throw new Error('Invalid compatibility file name: ' + name);
      }
      return { name: name, url: url };
    });
    if (compatibility.length && !compatibility.some(function (file) { return file.name === 'startup.tjs'; })) {
      throw new Error('A compatibility profile must include startup.tjs');
    }
    var media = {};
    Object.entries(manifest.media || {}).forEach(function ([name, info]) {
      if (!/^[a-z0-9_.-]+$/i.test(name) || !info ||
          !(info.width > 0 && info.height > 0 && info.duration > 0 && info.fps > 0)) {
        throw new Error('Invalid media description: ' + name);
      }
      media[name.toLowerCase()] = Object.assign({}, info, { url: localUrl(info.url) });
    });
    var saveId = manifest.saveId || id;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(saveId)) throw new Error('Invalid save ID');
    return { files: files, compatibility: compatibility, media: media,
      saveDirectory: '/libsdl/krkrsdl2/' + saveId, migrateLegacySaves: manifest.migrateLegacySaves === true };
  }

  async function mount(module, profile) {
    var fs = module.FS;
    await Promise.all([
      LazyFS.installFiles(module, profile.files, true),
      Promise.all(profile.compatibility.map(async function (file) {
        var response = await read(file.url);
        return { name: file.name, bytes: new Uint8Array(await response.arrayBuffer()) };
      })).then(function (files) {
        if (!files.length) return;
        fs.mkdir('/webcompat');
        files.forEach(function (file) {
          fs.writeFile('/webcompat/' + file.name, file.bytes, { canOwn: true });
        });
      })
    ]);
  }

  function prepareSaves(module, profile) {
    if (!profile) return;
    var fs = module.FS;
    var directory = profile.saveDirectory;
    fs.mkdirTree(directory);
    if (!profile.migrateLegacySaves || fs.readdir(directory).length !== 2) return;
    fs.readdir('/libsdl/krkrsdl2').forEach(function (name) {
      if (!/^(?:data[^/]*\.(?:ksd|bmp)|[^/]*\.cfu|savecheck)$/i.test(name)) return;
      var path = '/libsdl/krkrsdl2/' + name;
      if (fs.isFile(fs.stat(path).mode)) fs.writeFile(directory + '/' + name, fs.readFile(path));
    });
  }

  window.KrkrWebProfile = { load: load, mount: mount, prepareSaves: prepareSaves };
})();
