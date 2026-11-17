/*
 * Lazy FS for krkrsdl2 Web.
 *
 * Parses a stored (method 0) ZIP's central directory over HTTP Range and
 * exposes every entry as a virtual Emscripten FS node. Original XP3 files
 * suspend through Asyncify when available, keeping the browser responsive.
 * Builds without stack suspension retain synchronous Range reads.
 */
(function () {
  'use strict';

  var BLOCK = 262144;
  var MAX_BLOCKS = 64;
  var MAX_READ_BLOCKS = 8;
  var blockCache = new Map();
  var FS = null;
  var zipUrl = null;
  var mountRoot = '';
  var recovery = null;

  function waitForConnection() {
    if (recovery) return recovery;
    if (typeof document === 'undefined') return Promise.reject(new Error('Resource connection failed'));
    recovery = new Promise(function (resolve) {
      var panel = document.createElement('div');
      panel.id = 'krkr-resource-recovery';
      panel.setAttribute('role', 'alertdialog');
      panel.setAttribute('aria-label', '网络连接中断');
      Object.assign(panel.style, {
        position: 'fixed', inset: '0', zIndex: '10000', display: 'grid',
        placeContent: 'center', textAlign: 'center', padding: '24px',
        background: 'rgba(0,0,0,.85)', color: 'white', font: '18px sans-serif'
      });
      var message = document.createElement('p');
      message.textContent = '网络连接中断，游戏已暂停。连接恢复后可继续加载。';
      var button = document.createElement('button');
      button.textContent = '重试加载';
      Object.assign(button.style, { padding: '12px 24px', font: 'inherit', cursor: 'pointer' });
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        panel.remove();
        recovery = null;
        resolve();
      });
      panel.append(message, button);
      document.body.appendChild(panel);
      button.focus();
    });
    return recovery;
  }

  function checkRange(url, status, range, start, end, size) {
    var match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range || '');
    if (status !== 206 || !match || +match[1] !== start || +match[2] !== end ||
        +match[3] <= end || (size !== undefined && +match[3] !== size)) {
      throw new Error('Invalid byte range for ' + url + ' (' + start + '-' + end +
        '): HTTP ' + status + ', Content-Range: ' + range);
    }
  }

  function readRangeSync(url, start, end, size) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.setRequestHeader('Range', 'bytes=' + start + '-' + end);
    xhr.send(null);
    checkRange(url, xhr.status, xhr.getResponseHeader('Content-Range'), start, end, size);
    var text = xhr.responseText;
    if (text.length !== end - start + 1) throw new Error('Incomplete byte range for ' + url);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  async function readRangeAsync(url, start, end, size) {
    for (var attempt = 1; attempt <= 3; attempt++) {
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 20000);
      try {
        var response = await fetch(url, {
          headers: { Range: 'bytes=' + start + '-' + end },
          cache: 'no-store', signal: controller.signal
        });
        if (response.status >= 500) throw new TypeError('Server returned HTTP ' + response.status);
        checkRange(url, response.status, response.headers.get('Content-Range'), start, end, size);
        var buffer = await response.arrayBuffer();
        if (buffer.byteLength !== end - start + 1) throw new Error('Incomplete byte range for ' + url);
        return new Uint8Array(buffer);
      } catch (error) {
        if (!(error instanceof TypeError || error.name === 'AbortError')) throw error;
        if (attempt === 3) {
          await waitForConnection();
          attempt = 0;
          continue;
        }
        console.warn('[lazyfs] retry ' + attempt + ' ' + url + ' bytes=' + start + '-' + end);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  function zipFileSize(url) {
    return fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HEAD ' + url + ': HTTP ' + r.status);
      return parseInt(r.headers.get('Content-Length') || '-1', 10);
    });
  }

  function parseZip(url) {
    var size;
    return zipFileSize(url).then(function (n) {
      if (!(n > 0)) throw new Error('ZIP size unknown');
      size = n;
      var tailLen = Math.min(65536 + 22, size);
      var tailStart = size - tailLen;
      return readRangeAsync(url, tailStart, size - 1).then(function (tail) {
        var eocd = -1;
        for (var i = tail.length - 22; i >= 0; i--) {
          if (tail[i] === 0x50 && tail[i + 1] === 0x4b &&
              tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
            eocd = i;
            break;
          }
        }
        if (eocd < 0) throw new Error('ZIP EOCD not found');
        var dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        var total = dv.getUint16(eocd + 10, true);
        var cdSize = dv.getUint32(eocd + 12, true);
        var cdOff = dv.getUint32(eocd + 16, true);
        if (total === 0xffff || cdOff === 0xffffffff) throw new Error('ZIP64 is not supported');
        return readRangeAsync(url, cdOff, cdOff + cdSize - 1).then(function (cd) {
          var out = [];
          var p = 0;
          var cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
          for (var n = 0; n < total && p + 46 <= cd.length; n++) {
            if (cdv.getUint32(p, true) !== 0x02014b50) break;
            var method = cdv.getUint16(p + 10, true);
            var compSize = cdv.getUint32(p + 20, true);
            var uncompSize = cdv.getUint32(p + 24, true);
            var nameLen = cdv.getUint16(p + 28, true);
            var extraLen = cdv.getUint16(p + 30, true);
            var commentLen = cdv.getUint16(p + 32, true);
            var localOff = cdv.getUint32(p + 42, true);
            var name = new TextDecoder('utf-8').decode(cd.subarray(p + 46, p + 46 + nameLen));
            out.push({
              name: name.replace(/\\/g, '/'),
              method: method,
              compSize: compSize,
              size: uncompSize,
              localOff: localOff,
              dataOff: -1
            });
            p += 46 + nameLen + extraLen + commentLen;
          }
          return out;
        });
      });
    });
  }

  function ensureDataOffset(entry) {
    if (entry.dataOff >= 0) return Promise.resolve(entry.dataOff);
    return readRangeAsync(zipUrl, entry.localOff, entry.localOff + 29).then(function (h) {
      if (h.length < 30) throw new Error('bad local header: ' + entry.name);
      var dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('bad local sig: ' + entry.name);
      var nameLen = dv.getUint16(26, true);
      var extraLen = dv.getUint16(28, true);
      entry.dataOff = entry.localOff + 30 + nameLen + extraLen;
      return entry.dataOff;
    });
  }

  function blockSync(entry, blockIndex) {
    var key = entry.name + '#' + blockIndex;
    var cached = blockCache.get(key);
    if (cached) return cached;
    var start = blockIndex * BLOCK;
    var end = Math.min(entry.size - 1, start + BLOCK - 1);
    var bytes = readRangeSync(zipUrl, entry.dataOff + start, entry.dataOff + end);
    blockCache.set(key, bytes);
    while (blockCache.size > MAX_BLOCKS) {
      var first = blockCache.keys().next().value;
      blockCache.delete(first);
    }
    return bytes;
  }

  function readSync(entry, pos, len) {
    var out = new Uint8Array(len);
    var done = 0;
    while (done < len) {
      var abs = pos + done;
      var block = blockSync(entry, Math.floor(abs / BLOCK));
      var off = abs % BLOCK;
      var take = Math.min(block.length - off, len - done);
      if (take <= 0) break;
      out.set(block.subarray(off, off + take), done);
      done += take;
    }
    return done === len ? out : out.subarray(0, done);
  }

  function makeStreamOps(entry) {
    return {
      read: function (stream, buffer, offset, length, position) {
        var pos = (position === undefined || position === null) ? stream.position : position;
        if (pos >= entry.size) return 0;
        var want = Math.min(length, entry.size - pos);
        if (want <= 0) return 0;
        var bytes = readSync(entry, pos, want);
        buffer.set(bytes, offset);
        if (position === undefined || position === null) stream.position += bytes.length;
        return bytes.length;
      },
      llseek: function (stream, offset, whence) {
        var pos = offset;
        if (whence === 1) pos += stream.position;
        else if (whence === 2) pos += entry.size;
        if (pos < 0) throw new FS.ErrnoError(28);
        stream.position = pos;
        return pos;
      },
      close: function () {}
    };
  }

  function makeNodeOps(entry) {
    return {
      getattr: function (node) {
        return {
          dev: 1,
          ino: node.id,
          mode: 0o100666,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: entry.size,
          atime: new Date(0),
          mtime: new Date(0),
          ctime: new Date(0),
          blksize: 4096,
          blocks: Math.ceil(entry.size / 4096)
        };
      }
    };
  }

  function mountEntry(entry) {
    var name = entry.name.replace(/^\/+/, '');
    if (!name) return;
    var parts = name.split('/').filter(Boolean);
    if (!parts.length) return;
    var parent = mountRoot ? FS.lookupPath(mountRoot).node : FS.root;
    for (var i = 0; i < parts.length - 1; i++) {
      var dirPath = mountRoot + '/' + parts.slice(0, i + 1).join('/');
      if (!FS.analyzePath(dirPath).exists) FS.mkdir(dirPath);
      parent = FS.lookupPath(dirPath).node;
    }
    var base = parts[parts.length - 1];
    if (entry.name.slice(-1) === '/') {
      var dirFull = mountRoot + '/' + parts.join('/');
      if (!FS.analyzePath(dirFull).exists) FS.mkdir(dirFull);
      return;
    }
    if (entry.method !== 0) {
      throw new Error('LazyFS only supports stored ZIP entries: ' + entry.name);
    }
    if (FS.analyzePath(mountRoot + '/' + parts.join('/')).exists) return;
    var node = FS.createNode(parent, base, 0o100666, 0);
    node.node_ops = makeNodeOps(entry);
    node.stream_ops = makeStreamOps(entry);
  }

  function install(module, url) {
    FS = module.FS;
    zipUrl = url;
    if (!FS) return Promise.reject(new Error('Module.FS is not ready'));
    if (mountRoot) { try { if (!FS.analyzePath(mountRoot).exists) FS.mkdir(mountRoot); } catch (e) {} }
    return parseZip(url).then(function (entries) {
      var chain = Promise.resolve();
      entries.forEach(function (entry) {
        if (entry.method !== 0 || entry.name.slice(-1) === '/') return;
        chain = chain.then(function () { return ensureDataOffset(entry); });
      });
      return chain.then(function () {
        var files = 0;
        for (var i = 0; i < entries.length; i++) {
          try {
            mountEntry(entries[i]);
            if (entries[i].method === 0) files++;
          } catch (e) {
            console.warn('[lazyfs] skip', entries[i].name, e.message);
          }
        }
        console.log('[lazyfs] mounted ' + files + ' file(s) from ' + url);
        var patchUrl = new URLSearchParams(location.search).get('patch');
        if (!patchUrl) return entries;
        return fetch(patchUrl, { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('patch fetch HTTP ' + r.status);
          return r.text();
        }).then(function (shim) {
          var patchPath = mountRoot + '/patch.tjs';
          var orig = new Uint8Array(0);
          try { orig = FS.readFile(patchPath); } catch (e) {}
          var NL = String.fromCharCode(10);
          var text = new TextDecoder().decode(orig) + NL + NL + '// ---- Kiri Hub patch shim ----' + NL + shim;
          try { FS.unlink(patchPath); } catch (e) {}
          FS.writeFile(patchPath, new TextEncoder().encode(text));
          console.log('[lazyfs] patched /patch.tjs with ' + patchUrl + ' (' + shim.length + ' chars)');
          return entries;
        });
      });
    });
  }

  // ------------------------------------------------------------------
  // Lazy remote files (used to expose original XP3 archives by Range).
  // ------------------------------------------------------------------

  var remoteCache = new Map();

  function cacheRemoteBlock(key, bytes) {
    remoteCache.set(key, bytes);
    if (remoteCache.size > MAX_BLOCKS) {
      remoteCache.delete(remoteCache.keys().next().value);
    }
  }

  function remoteBlock(entry, blockIndex, lastBlock) {
    var key = entry.url + '#' + blockIndex;
    var cached = remoteCache.get(key);
    if (cached) {
      remoteCache.delete(key);
      remoteCache.set(key, cached);
      return cached;
    }
    var start = blockIndex * BLOCK;
    var next = blockIndex + 1;
    while (next <= lastBlock && next < blockIndex + MAX_READ_BLOCKS &&
           !remoteCache.has(entry.url + '#' + next)) next++;
    var end = Math.min(entry.size - 1, next * BLOCK - 1);
    var bytes = readRangeSync(entry.url, start, end, entry.size);
    if (next === blockIndex + 1) {
      cacheRemoteBlock(key, bytes);
      return bytes;
    }
    for (var block = blockIndex; block < next; block++) {
      var offset = (block - blockIndex) * BLOCK;
      cacheRemoteBlock(entry.url + '#' + block, bytes.slice(offset, offset + BLOCK));
    }
    return remoteCache.get(key);
  }

  function remoteRead(entry, pos, len, buffer, offset) {
    var done = 0;
    var lastBlock = Math.floor((pos + len - 1) / BLOCK);
    while (done < len) {
      var abs = pos + done;
      var block = remoteBlock(entry, Math.floor(abs / BLOCK), lastBlock);
      var off = abs % BLOCK;
      var take = Math.min(block.length - off, len - done);
      if (take <= 0) break;
      buffer.set(block.subarray(off, off + take), offset + done);
      done += take;
    }
    return done;
  }

  async function remoteReadAsync(entry, pos, len, offset, getHeap) {
    var done = 0;
    while (done < len) {
      var absolute = pos + done;
      var index = Math.floor(absolute / BLOCK);
      var key = entry.url + '#' + index;
      var block = remoteCache.get(key);
      if (block) {
        remoteCache.delete(key);
        remoteCache.set(key, block);
      } else {
        var last = Math.min(Math.floor((pos + len - 1) / BLOCK), index + MAX_READ_BLOCKS - 1);
        var start = index * BLOCK;
        var end = Math.min(entry.size - 1, (last + 1) * BLOCK - 1);
        var fetched = await readRangeAsync(entry.url, start, end, entry.size);
        for (var number = index; number <= last; number++) {
          var begin = (number - index) * BLOCK;
          cacheRemoteBlock(entry.url + '#' + number, fetched.slice(begin, begin + BLOCK));
        }
        block = remoteCache.get(key);
      }
      var within = absolute % BLOCK;
      var take = Math.min(block.length - within, len - done);
      if (take <= 0) break;
      getHeap().set(block.subarray(within, within + take), offset + done);
      done += take;
    }
    return done;
  }

  async function prefetchXp3Index(entry) {
    async function prefetch(index) {
      var start = index * BLOCK;
      var end = Math.min(entry.size - 1, start + BLOCK - 1);
      var bytes = await readRangeAsync(entry.url, start, end, entry.size);
      cacheRemoteBlock(entry.url + '#' + index, bytes);
      return bytes;
    }

    var first = await prefetch(0);
    if (first.length < 19 || first[0] !== 0x58 || first[1] !== 0x50 || first[2] !== 0x33) return;
    var header = new DataView(first.buffer, first.byteOffset, first.byteLength);
    var offset = header.getUint32(11, true) + header.getUint32(15, true) * 0x100000000;
    if (offset >= BLOCK && offset < entry.size) await prefetch(Math.floor(offset / BLOCK));
  }

  function mountRemote(vpath, url, size) {
    var name = vpath.replace(/^\/+/, '');
    var parts = name.split('/').filter(Boolean);
    if (!parts.length) return;
    for (var i = 0; i < parts.length - 1; i++) {
      var dir = '/' + parts.slice(0, i + 1).join('/');
      if (!FS.analyzePath(dir).exists) FS.mkdir(dir);
    }
    var full = '/' + parts.join('/');
    if (FS.analyzePath(full).exists) return;
    var entry = { name: full, url: url, size: size };
    // mknod registers the file in the parent directory as well as the lookup cache.
    var node = FS.mknod(full, 0o100444, 0);
    node.krkrRemote = entry;
    node.node_ops = {
      getattr: function () {
        return {
          dev: 1,
          ino: node.id,
          mode: 0o100666,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: entry.size,
          atime: new Date(0),
          mtime: new Date(0),
          ctime: new Date(0),
          blksize: 4096,
          blocks: Math.ceil(entry.size / 4096)
        };
      }
    };
    node.stream_ops = {
      read: function (stream, buffer, offset, length, position) {
        var pos = (position === undefined || position === null) ? stream.position : position;
        if (pos >= entry.size) return 0;
        var want = Math.min(length, entry.size - pos);
        if (want <= 0) return 0;
        return remoteRead(entry, pos, want, buffer, offset);
      },
      llseek: function (stream, offset, whence) {
        var pos = offset;
        if (whence === 1) pos += stream.position;
        else if (whence === 2) pos += entry.size;
        if (pos < 0) throw new FS.ErrnoError(28);
        stream.position = pos;
        return pos;
      },
      close: function () {}
    };
  }

  function installFiles(module, files, warmXp3) {
    FS = module.FS;
    if (!FS) return Promise.reject(new Error('Module.FS is not ready'));
    module['lazyReadvCached'] = function (stream, iov, iovcnt, position, heap) {
      var entry = stream.node.krkrRemote;
      var pos = position === undefined ? stream.position : position;
      var view = new DataView(heap.buffer);
      for (var i = 0; i < iovcnt; i++) {
        var length = Math.min(view.getUint32(iov + i * 8 + 4, true), Math.max(0, entry.size - pos));
        var last = Math.floor((pos + length - 1) / BLOCK);
        for (var index = Math.floor(pos / BLOCK); length > 0 && index <= last; index++) {
          if (!remoteCache.has(entry.url + '#' + index)) return false;
        }
        pos += length;
      }
      return true;
    };
    module['lazyReadv'] = async function (stream, iov, iovcnt, position, pnum, getHeap) {
      var entry = stream.node.krkrRemote;
      var seeking = position !== undefined;
      var pos = seeking ? position : stream.position;
      // Capture all descriptors before awaiting; wasm memory can grow meanwhile.
      var descriptors = [];
      var view = new DataView(getHeap().buffer);
      for (var i = 0; i < iovcnt; i++) {
        descriptors.push([view.getUint32(iov + i * 8, true), view.getUint32(iov + i * 8 + 4, true)]);
      }
      var done = 0;
      for (var descriptor of descriptors) {
        var want = Math.min(descriptor[1], Math.max(0, entry.size - pos));
        var count = await remoteReadAsync(entry, pos, want, descriptor[0], getHeap);
        pos += count;
        done += count;
        if (count < descriptor[1]) break;
      }
      if (!seeking) stream.position = pos;
      new DataView(getHeap().buffer).setUint32(pnum, done, true);
    };
    return Promise.all(Object.keys(files).map(function (vpath) {
      var url = files[vpath];
      return fetch(url, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HEAD ' + url + ': HTTP ' + r.status);
        var size = Number(r.headers.get('Content-Length'));
        if (!Number.isSafeInteger(size) || size < 1) throw new Error('Size unknown for ' + url);
        return { path: vpath, url: url, size: size };
      });
    })).then(async function (entries) {
      if (warmXp3) {
        await Promise.all(entries.filter(function (entry) {
          return /\.xp3$/i.test(entry.path);
        }).map(prefetchXp3Index));
      }
      entries.forEach(function (entry) {
        mountRemote(entry.path, entry.url, entry.size);
      });
    });
  }

  window.LazyFS = { install: install, installFiles: installFiles };
})();
