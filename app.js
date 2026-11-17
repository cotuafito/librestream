/* LibreStream — logica de la interfaz (sin Blazor, solo JS del navegador). */
(function () {
  'use strict';

  var state = {
    mode: 'pluto',
    channels: [],
    localFiles: [],
    current: null,
    currentId: null,
    search: '',
    group: 'Todos',
    plutoPage: '',
    customUrl: '',
    lastSourceKey: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- utilidades ---------- */

  function clean(s) {
    s = String(s || '').replace(/\[[^\]]*\]/g, '').trim();
    return s.length ? s : 'Canal';
  }

  function getAttr(attrs, key) {
    var re = new RegExp(key + '\\s*=\\s*"([^"]*)"', 'i');
    var m = re.exec(attrs);
    return m ? m[1] : null;
  }

  function parseM3u(text) {
    var result = [];
    if (!text || !text.trim()) return result;

    var lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var pending = null;

    function reset() { pending = null; }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (/^#EXTINF:/i.test(line)) {
        var rest = line.slice(8);
        var comma = rest.lastIndexOf(',');
        var attrs = comma >= 0 ? rest.slice(0, comma) : rest;
        var name = (comma >= 0 && comma + 1 < rest.length)
          ? rest.slice(comma + 1).trim()
          : 'Canal ' + (result.length + 1);
        pending = {
          name: name,
          group: getAttr(attrs, 'group-title'),
          logo: getAttr(attrs, 'tvg-logo') || '',
          id: getAttr(attrs, 'tvg-id') || null,
          extGroup: null
        };
        continue;
      }

      if (/^#EXTGRP:/i.test(line)) {
        if (!pending) pending = { name: null, group: null, logo: '', id: null, extGroup: null };
        pending.extGroup = line.slice(8).trim();
        continue;
      }

      if (line.charAt(0) === '#') continue;

      var isHttp = /^https?:\/\//i.test(line);
      if (!isHttp) { reset(); continue; }

      var p = pending || {};
      result.push({
        name: clean(p.name || ('Canal ' + (result.length + 1))),
        group: clean(p.group || p.extGroup || 'General'),
        logo: p.logo || '',
        id: p.id || ('ch' + result.length + '-' + Date.now().toString(36)),
        url: line
      });
      reset();
    }
    return result;
  }

  function showStatus(message, isError) {
    var el = $('status');
    if (!el) return;
    if (!message) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    el.className = 'status' + (isError ? ' error' : '');
    el.textContent = message;
  }

  /* ---------- render ---------- */

  function groups() {
    var seen = {}, out = [];
    state.channels.forEach(function (c) {
      if (c.group && !seen[c.group]) { seen[c.group] = 1; out.push(c.group); }
    });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }

  function filtered() {
    var q = state.search.trim().toLowerCase();
    return state.channels.filter(function (c) {
      if (state.group !== 'Todos' && c.group !== state.group) return false;
      if (!q) return true;
      return (c.name + ' ' + c.group).toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderGroups() {
    var host = $('groups');
    host.innerHTML = '';
    var all = document.createElement('button');
    all.className = 'chip' + (state.group === 'Todos' ? ' on' : '');
    all.textContent = 'Todos';
    all.addEventListener('click', function () { state.group = 'Todos'; renderGroups(); renderList(); });
    host.appendChild(all);

    groups().forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'chip' + (state.group === g ? ' on' : '');
      b.textContent = g;
      b.addEventListener('click', function () { state.group = g; renderGroups(); renderList(); });
      host.appendChild(b);
    });
  }

  function renderList() {
    var host = $('channelList');
    var items = filtered();
    $('itemCount').textContent = state.channels.length + ' elementos';
    host.innerHTML = '';

    if (!items.length) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = 'No hay elementos. Carga una fuente arriba.';
      host.appendChild(p);
      return;
    }

    items.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'channel' + (state.currentId === c.id ? ' playing' : '');
      if (c.logo) {
        var img = document.createElement('img');
        img.src = c.logo; img.alt = ''; img.loading = 'lazy';
        img.onerror = function () { img.style.visibility = 'hidden'; };
        b.appendChild(img);
      } else {
        var ph = document.createElement('span');
        ph.className = 'chan-ph'; ph.textContent = '▶';
        b.appendChild(ph);
      }
      var info = document.createElement('span');
      info.className = 'chan-info';
      var nm = document.createElement('span'); nm.className = 'chan-name'; nm.textContent = c.name;
      var gr = document.createElement('span'); gr.className = 'chan-group'; gr.textContent = c.group;
      info.appendChild(nm); info.appendChild(gr);
      b.appendChild(info);
      b.addEventListener('click', function () { play(c); });
      host.appendChild(b);
    });
  }

  /* ---------- acciones ---------- */

  function switchMode(mode) {
    state.mode = mode;
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });
    ['pluto', 'm3u', 'file', 'local'].forEach(function (m) {
      $('panel-' + m).style.display = (m === mode ? '' : 'none');
    });
    var isPluto = (mode === 'pluto');
    $('view-pluto').style.display = isPluto ? '' : 'none';
    $('view-player').style.display = isPluto ? 'none' : '';
    showStatus('');
    if (!isPluto) window.librePlayer.stop();
  }

  function setPlutoPage(page) {
    state.plutoPage = page;
    var url = page ? ('https://pluto.tv/' + page) : 'https://pluto.tv/';
    $('plutoFrame').src = url;
    $('plutoOpenTab').href = url;
    document.querySelectorAll('[data-pluto]').forEach(function (b) {
      b.classList.toggle('sel', b.getAttribute('data-pluto') === page);
    });
  }

  function setChannels(items, key, message) {
    state.channels = items;
    state.localFiles = [];
    state.current = null;
    state.currentId = null;
    state.group = 'Todos';
    state.search = '';
    $('search').value = '';
    state.lastSourceKey = key;
    window.librePlayer.stop();
    $('nowTitle').textContent = 'Selecciona un canal o película';
    $('nowGroup').textContent = 'Elige un elemento de la lista para reproducir.';
    renderGroups();
    renderList();
    showStatus(message, false);
  }

  function loadFromUrl(url) {
    url = (url || '').trim();
    if (!url) { showStatus('Escribe una URL de lista M3U.', true); return; }
    state.customUrl = url;
    showStatus('Descargando lista…', false);
    fetch(url, { method: 'GET', mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.text();
      })
      .then(function (text) {
        var items = parseM3u(text);
        if (!items.length) throw new Error('La lista no contiene canales válidos.');
        setChannels(items, 'url:' + url, '✔ ' + items.length + ' elementos cargados.');
      })
      .catch(function (e) {
        showStatus('No se pudo descargar la lista: ' + e.message + ' (el servidor debe permitir CORS)', true);
      });
  }

  function onM3uFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var items = parseM3u(String(reader.result || ''));
      if (!items.length) { showStatus('El archivo no contiene canales válidos.', true); return; }
      setChannels(items, 'file:' + file.name, '✔ ' + items.length + ' elementos cargados desde ' + file.name + '.');
    };
    reader.onerror = function () { showStatus('Error al leer el archivo.', true); };
    reader.readAsText(file, 'UTF-8');
  }

  function pickLocalFiles() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mkv,.mp4,.m3u8,.m3u';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var files = Array.prototype.slice.call(input.files || []);
      document.body.removeChild(input);
      if (!files.length) { showStatus('No se seleccionaron archivos.', true); return; }
      state.localFiles = files.map(function (f) {
        return { name: f.name, url: URL.createObjectURL(f) };
      });
      state.channels = files.map(function (f, i) {
        return { name: f.name, group: 'Archivos locales', logo: '', id: 'local:' + i, url: 'local:' + i };
      });
      state.current = null; state.currentId = null;
      state.group = 'Todos'; state.search = '';
      state.lastSourceKey = 'local';
      $('search').value = '';
      renderGroups(); renderList();
      showStatus('✔ ' + files.length + ' archivos locales listos.', false);
      if (state.channels.length) play(state.channels[0]);
    });
    input.click();
  }

  function play(c) {
    state.current = c;
    state.currentId = c.id;
    renderList();
    $('nowTitle').textContent = c.name;
    $('nowGroup').textContent = c.group;
    if (/^local:/.test(c.url)) {
      var idx = parseInt(c.url.slice(6), 10);
      window.librePlayer.playLocalIndex(idx, state.localFiles);
    } else {
      window.librePlayer.playStream(c.url);
    }
  }

  function refresh() {
    if (state.lastSourceKey && state.lastSourceKey.indexOf('url:') === 0) {
      loadFromUrl(state.customUrl);
    } else if (state.lastSourceKey && state.lastSourceKey.indexOf('file:') === 0) {
      showStatus('Vuelve a seleccionar el archivo M3U para recargarlo.', false);
    } else {
      showStatus('Esta fuente no se puede recargar automáticamente.', false);
    }
  }

  /* ---------- cableado ---------- */

  function init() {
    window.librePlayer.attach();

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchMode(t.getAttribute('data-mode')); });
    });
    document.querySelectorAll('[data-pluto]').forEach(function (b) {
      b.addEventListener('click', function () { setPlutoPage(b.getAttribute('data-pluto')); });
    });

    $('btnLoadUrl').addEventListener('click', function () { loadFromUrl($('m3uUrl').value); });
    $('m3uUrl').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loadFromUrl($('m3uUrl').value);
    });
    $('m3uFile').addEventListener('change', function (e) { onM3uFile(e.target.files[0]); });
    $('btnPickLocal').addEventListener('click', pickLocalFiles);

    $('btnStop').addEventListener('click', function () {
      window.librePlayer.stop();
      state.current = null; state.currentId = null;
      renderList();
      $('nowTitle').textContent = 'Selecciona un canal o película';
      $('nowGroup').textContent = 'Elige un elemento de la lista para reproducir.';
    });
    $('btnFullscreen').addEventListener('click', function () { window.librePlayer.toggleFullscreen(); });
    $('btnRefresh').addEventListener('click', refresh);
    $('volume').addEventListener('input', function (e) {
      window.librePlayer.setVolume(parseFloat(e.target.value));
    });
    $('search').addEventListener('input', function (e) {
      state.search = e.target.value; renderList();
    });

    renderGroups();
    renderList();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
