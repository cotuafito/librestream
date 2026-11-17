/* Reproductor de LibreStream: HLS (hls.js), MP4 directo y archivos locales, sin Blazor. */
(function () {
  'use strict';

  var hls = null;
  var videoEl = null;
  var loadToken = 0;

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

  function clearHandlers(v) {
    var hs = v.__lsHandlers || {};
    Object.keys(hs).forEach(function (evt) {
      try { v.removeEventListener(evt, hs[evt]); } catch (_) { }
    });
    v.__lsHandlers = {};
  }

  function addHandler(v, evt, fn) {
    v.__lsHandlers = v.__lsHandlers || {};
    v.__lsHandlers[evt] = fn;
    v.addEventListener(evt, fn);
  }

  function isHls(url) {
    return /\.m3u8(\?|$)/i.test(url) || /master\.m3u8/i.test(url);
  }

  function mediaErrorText(v) {
    var e = v && v.error;
    if (!e) return '';
    var map = {
      1: 'la carga se interrumpió',
      2: 'error de red',
      3: 'no se pudo decodificar',
      4: 'formato no soportado'
    };
    return ' (' + (map[e.code] || ('código ' + e.code)) + ')';
  }

  function shortLabel(label) {
    var s = String(label || '');
    return s.length > 48 ? s.slice(0, 45) + '…' : s;
  }

  function playUrl(url, opts) {
    opts = opts || {};
    var token = ++loadToken;
    var label = shortLabel(opts.title || '');
    var v = video();

    if (!v) { status('No se encontró el elemento de video.'); return; }
    if (!url) { status('No hay una URL de video para reproducir.'); return; }

    disposeHls();
    clearHandlers(v);
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.muted = false;
    v.preload = 'auto';
    status('Cargando' + (label ? ' «' + label + '»' : '') + '…');

    var settled = false;
    var timer = setTimeout(function () {
      fail('La fuente tarda demasiado en responder. Comprueba tu conexión o elige otra película.');
    }, opts.timeout || 35000);

    function ready() {
      if (settled || token !== loadToken) return;
      settled = true;
      clearTimeout(timer);
      status('');
      var p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function (e) {
          if (token === loadToken) {
            status('Pulsa el botón de reproducción del video. ' + (e && e.message ? '(' + e.message + ')' : ''));
          }
        });
      }
    }

    function fail(message) {
      if (settled || token !== loadToken) return;
      settled = true;
      clearTimeout(timer);
      status(message);
    }

    if (isHls(url) && typeof window.Hls !== 'undefined' && window.Hls.isSupported()) {
      hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30
      });
      addHandler(v, 'error', function () {
        fail('No se pudo cargar el stream HLS' + mediaErrorText(v) + '.');
      });
      hls.loadSource(url);
      hls.attachMedia(v);
      hls.on(window.Hls.Events.MANIFEST_PARSED, ready);
      hls.on(window.Hls.Events.ERROR, function (_evt, data) {
        if (!data || !data.fatal || token !== loadToken) return;
        status('Error HLS: ' + (data.details || 'desconocido'));
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          fail('No se pudo cargar el stream HLS.');
        }
      });
      return;
    }

    addHandler(v, 'loadedmetadata', ready);
    addHandler(v, 'canplay', ready);
    addHandler(v, 'error', function () {
      fail('No se pudo cargar el video' + mediaErrorText(v) + '. Puede que esa película no esté disponible ahora.');
    });
    v.src = url;
    v.load();
  }

  window.librePlayer = {
    attach: function () { videoEl = document.getElementById('videoPlayer'); },

    playStream: function (url, opts) { playUrl(url, opts); },

    playLocalIndex: function (index, files) {
      var item = files && files[index];
      if (!item) { status('Archivo no disponible.'); return; }
      playUrl(item.url, { title: item.name, timeout: 15000 });
    },

    stop: function () {
      loadToken++;
      disposeHls();
      var v = video();
      if (v) {
        clearHandlers(v);
        v.pause();
        v.removeAttribute('src');
        v.load();
      }
      status('');
    },

    setStatus: status,

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
