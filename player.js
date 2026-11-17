/* Reproductor de LibreStream: HLS (hls.js) + archivos locales, sin Blazor. */
(function () {
  'use strict';

  var hls = null;
  var videoEl = null;

  function video() {
    if (!videoEl || !document.body.contains(videoEl)) {
      videoEl = document.getElementById('videoPlayer');
    }
    return videoEl;
  }

  function disposeHls() {
    if (hls) { try { hls.destroy(); } catch (_) { } hls = null; }
  }

  function status(text) {
    var el = document.getElementById('playerStatus');
    if (el) el.textContent = text || '';
  }

  function isHls(url) {
    return /\.m3u8(\?|$)/i.test(url) || /master\.m3u8/i.test(url);
  }

  function playUrl(url) {
    var v = video();
    if (!v) { status('No se encontró el elemento de video.'); return; }
    disposeHls();
    status('Cargando…');

    var done = function () {
      v.play().then(function () { status(''); })
        .catch(function (e) { status('Reproducción bloqueada: ' + e.message); });
    };

    if (isHls(url) && typeof window.Hls !== 'undefined' && window.Hls.isSupported()) {
      hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30
      });
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.MANIFEST_PARSED, done);
      hls.on(window.Hls.Events.ERROR, function (_evt, data) {
        if (data && data.fatal) {
          status('Error HLS: ' + (data.details || 'desconocido'));
          switch (data.type) {
            case window.Hls.ErrorTypes.NETWORK_ERROR: hls.startLoad(); break;
            case window.Hls.ErrorTypes.MEDIA_ERROR: hls.recoverMediaError(); break;
            default: disposeHls(); break;
          }
        }
      });
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      v.addEventListener('loadedmetadata', done, { once: true });
    } else {
      v.src = url;
      done();
    }
  }

  window.librePlayer = {
    attach: function () { videoEl = document.getElementById('videoPlayer'); },

    playStream: function (url) { playUrl(url); },

    playLocalIndex: function (index, files) {
      var item = files && files[index];
      if (!item) { status('Archivo no disponible.'); return; }
      disposeHls();
      var v = video();
      if (!v) return;
      status('Reproduciendo ' + item.name);
      v.src = item.url;
      v.play().then(function () { status(''); })
        .catch(function (e) { status('Reproducción bloqueada: ' + e.message); });
    },

    stop: function () {
      disposeHls();
      var v = video();
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
      status('');
    },

    setVolume: function (value) {
      var v = video();
      if (v) v.volume = Math.max(0, Math.min(1, value));
    },

    toggleFullscreen: function () {
      var v = video();
      if (!v) return;
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else if (v.requestFullscreen) {
        v.requestFullscreen();
      }
    }
  };
})();
