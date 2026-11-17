(function () {
  'use strict';

  window.createKrkrWebVideo = function (module, media) {
    var active = new Map();
    var canvas = module.canvas;

    function updateBounds(entry) {
      var screen = canvas.getBoundingClientRect();
      var rect = entry.rect;
      var sx = screen.width / canvas.width;
      var sy = screen.height / canvas.height;
      Object.assign(entry.video.style, {
        left: screen.left + rect[0] * sx + 'px',
        top: screen.top + rect[1] * sy + 'px',
        width: rect[2] * sx + 'px',
        height: rect[3] * sy + 'px'
      });
    }

    function notify(key, entry, status) {
      // Browser callbacks only queue data. TJS events run from the engine loop,
      // never by re-entering a suspended Asyncify stack from the DOM.
      if (active.get(key) === entry) entry.events.push(status);
    }

    function frameReady(key, entry, mediaTime) {
      if (active.get(key) !== entry) return;
      var video = entry.video;
      if (video.readyState < 2) return;
      entry.frame = Math.max(0, Math.floor((mediaTime == null ? video.currentTime : mediaTime) * entry.info.fps + 0.001));
      entry.framePending = true;
      entry.pixels = null;
      if (entry.preparing && video.readyState >= 2 && !video.seeking) {
        entry.preparing = false;
        notify(key, entry, 3);
      }
    }

    function close(key) {
      var entry = active.get(key);
      if (!entry) return;
      active.delete(key);
      if (entry.frameCallback != null && entry.video.cancelVideoFrameCallback) entry.video.cancelVideoFrameCallback(entry.frameCallback);
      entry.resize.disconnect();
      entry.video.pause();
      entry.video.removeAttribute('src');
      entry.video.load();
      entry.video.remove();
    }

    function play(key, entry) {
      entry.video.play().catch(function (error) {
        console.error('[video] play failed', error.message);
        if (error.name === 'NotAllowedError') {
          notify(key, entry, 7);
          entry.video.controls = true;
          entry.video.style.pointerEvents = 'auto';
          entry.video.style.display = 'block';
        } else {
          notify(key, entry, 6);
        }
      });
    }

    function open(key, name) {
      var basename = name.replace(/\\/g, '/').split('/').pop().toLowerCase();
      var info = media[basename];
      if (!info) return 0;
      close(key);
      var video = document.createElement('video');
      video.playsInline = true;
      video.preload = 'auto';
      Object.assign(video.style, {
        position: 'fixed', zIndex: '20', objectFit: 'contain',
        background: 'black', pointerEvents: 'none', display: 'none'
      });
      var entry = { video: video, info: info, rect: [0, 0, canvas.width, canvas.height],
        events: [], frame: 0, framePending: false, preparing: false, layer: false, pixels: null, previousTime: 0 };
      entry.resize = new ResizeObserver(function () { updateBounds(entry); });
      active.set(key, entry);
      entry.resize.observe(canvas);
      video.addEventListener('loadedmetadata', function () { notify(key, entry, 1); });
      video.addEventListener('playing', function () { notify(key, entry, 2); });
      video.addEventListener('loadeddata', function () { frameReady(key, entry); });
      video.addEventListener('seeked', function () { frameReady(key, entry); });
      video.addEventListener('timeupdate', function () {
        if (video.loop && video.currentTime < entry.previousTime) notify(key, entry, 4);
        entry.previousTime = video.currentTime;
        if (!video.requestVideoFrameCallback) frameReady(key, entry);
      });
      video.addEventListener('ended', function () { notify(key, entry, 0); });
      video.addEventListener('error', function () {
        console.error('[video] media failed', info.url, video.error && video.error.code);
        notify(key, entry, 5);
      });
      video.src = info.url;
      document.body.appendChild(video);
      if (video.requestVideoFrameCallback) {
        var onFrame = function (now, metadata) {
          if (active.get(key) !== entry) return;
          frameReady(key, entry, metadata.mediaTime);
          entry.frameCallback = video.requestVideoFrameCallback(onFrame);
        };
        entry.frameCallback = video.requestVideoFrameCallback(onFrame);
      }
      updateBounds(entry);
      console.log('[video] open', basename);
      return 1;
    }

    function command(key, action, value) {
      var entry = active.get(key);
      if (!entry) return 0;
      var video = entry.video;
      switch (action) {
        case 0: close(key); break;
        case 1: entry.preparing = false; play(key, entry); break;
        case 2: entry.preparing = false; video.pause(); break;
        case 3:
          entry.framePending = false;
          video.currentTime = Math.max(0, Math.min(value, entry.info.duration));
          break;
        case 4: entry.visible = !!value; video.style.display = value && !entry.layer ? 'block' : 'none'; break;
        case 5: video.volume = Math.max(0, Math.min(1, value)); break;
        case 6: video.loop = !!value; break;
        case 7: video.playbackRate = value; break;
        case 10: return video.currentTime;
        case 11: return entry.info.duration;
        case 12: return entry.info.fps;
        case 13: return video.volume;
        case 14: return video.playbackRate;
        case 15: video.muted = !!value; break;
        case 16: return entry.info.width;
        case 17: return entry.info.height;
        case 18:
          if (!entry.framePending) return 0;
          entry.framePending = false;
          return entry.frame + 1;
        case 19: return entry.events.length ? entry.events.shift() + 1 : 0;
        case 20:
          video.pause();
          entry.preparing = true;
          // Drop obsolete playing/stopped events before preparing a new frame.
          entry.events.length = 0;
          if (video.currentTime !== 0) video.currentTime = 0;
          else frameReady(key, entry);
          break;
        case 21:
          entry.layer = !!value;
          video.style.display = entry.visible && !entry.layer ? 'block' : 'none';
          break;
      }
      return 0;
    }

    function getFrame(key) {
      var entry = active.get(key);
      if (!entry || entry.video.readyState < 2) return null;
      if (entry.pixels) return entry.pixels;
      if (!entry.frameCanvas) {
        entry.frameCanvas = document.createElement('canvas');
        entry.frameContext = entry.frameCanvas.getContext('2d', { willReadFrequently: true });
      }
      var video = entry.video, target = entry.frameCanvas;
      if (target.width !== video.videoWidth) target.width = video.videoWidth;
      if (target.height !== video.videoHeight) target.height = video.videoHeight;
      try {
        entry.frameContext.drawImage(video, 0, 0);
        entry.pixels = entry.frameContext.getImageData(0, 0, target.width, target.height);
        return entry.pixels;
      } catch (error) {
        if (!entry.reportedFrameError) console.error('[video] frame copy failed', error.message);
        entry.reportedFrameError = true;
        return null;
      }
    }

    function bounds(key, left, top, width, height) {
      var entry = active.get(key);
      if (!entry) return;
      entry.rect = [left, top, width, height];
      updateBounds(entry);
    }

    window.addEventListener('scroll', function () {
      active.forEach(updateBounds);
    }, { passive: true });
    return { open: open, command: command, bounds: bounds, getFrame: getFrame };
  };
})();
