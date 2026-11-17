/* CotuStream — lógica de la interfaz (sin Blazor, solo JS del navegador).
   Fuente principal: Internet Archive (películas en español, dominio público/licencias abiertas). */
(function () {
  'use strict';

  var IA_SEARCH = 'https://archive.org/advancedsearch.php';
  var IA_METADATA = 'https://archive.org/metadata/';
  var IA_DOWNLOAD = 'https://archive.org/download/';
  var IA_IMAGE = 'https://archive.org/services/img/';
  var PAGE_SIZE = 120;
  var RECENT_DAYS = 365;

  /* Catálogo legal de respaldo: contenido libre (Creative Commons) y streams de prueba
     con CORS habilitado. Verificado reproduciendo con hls.js en navegador real. */
  var BUILTIN = [
    {
      name: 'Big Buck Bunny', group: 'Películas (CC)',
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      id: 'builtin-bbb'
    },
    {
      name: 'Tears of Steel', group: 'Películas (CC)',
      url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
      id: 'builtin-tos'
    },
    {
      name: 'Angel One', group: 'Películas (CC)',
      url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
      id: 'builtin-angel'
    },
    {
      name: 'Canal Demo 24/7 (HLS)', group: 'Canales en vivo (demo)',
      url: 'https://test-streams.mux.dev/pts_shift/master.m3u8',
      id: 'builtin-live'
    }
  ];

  var state = {
    mode: 'spanish',
    channels: [],
    localFiles: [],
    current: null,
    currentId: null,
    search: '',
    group: 'Todos',
    customUrl: '',
    lastSourceKey: 'spanish',
    iaQuery: '',
    iaPage: 1,
    iaTotal: 0,
    iaSort: 'downloads desc',
    iaLoading: false,
    iaResolveToken: 0
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- utilidades ---------- */

  function clean(s) {
    s = String(s || '').replace(/\[[^\]]*\]/g, '').trim();
    return s.length ? s : 'Película';
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

  function playerStatus(message) {
    window.cotuPlayer.setStatus(message);
  }

  function escapeIaWord(word) {
    return String(word || '')
      .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ-]+/g, ' ')
      .trim();
  }

  function iaSearchQuery(term) {
    var q = 'mediatype:movies AND language:spa AND collection:feature_films';
    var words = String(term || '').trim().split(/\s+/).map(escapeIaWord).filter(function (w) {
      return w.length > 1;
    });
    if (words.length) q += ' AND (' + words.join(' AND ') + ')';
    return q;
  }

  function formatCount(value) {
    var n = Number(value) || 0;
    var s;
    if (n >= 1000000) s = (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    else if (n >= 1000) s = (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    else s = n.toLocaleString('es-ES');
    return s.replace('.', ',');
  }

  function parseDate(value) {
    var s = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var t = Date.parse(s + 'T00:00:00Z');
    return isNaN(t) ? null : t;
  }

  function isRecentAddition(value) {
    var t = parseDate(value);
    if (!t) return false;
    var days = (Date.now() - t) / 86400000;
    return days >= 0 && days <= RECENT_DAYS;
  }

  function iaDocToItem(doc) {
    var id = doc.identifier;
    var year = Array.isArray(doc.year) ? doc.year[0] : doc.year;
    year = year ? String(year).slice(0, 4) : '';
    var added = doc.publicdate || doc.addeddate || doc.date || '';
    var downloads = Number(doc.downloads) || 0;

    return {
      name: clean(doc.title || id),
      group: 'Películas en español',
      logo: IA_IMAGE + encodeURIComponent(id),
      id: 'ia:' + id,
      url: 'ia:' + id,
      ia: true,
      identifier: id,
      year: year,
      downloads: downloads,
      addedDate: added,
      isRecent: isRecentAddition(added),
      license: doc.licenseurl || '',
      resolvedUrl: null
    };
  }

  function firstFile(files, test) {
    for (var i = 0; i < files.length; i++) {
      if (test(files[i])) return files[i];
    }
    return null;
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
      return (c.name + ' ' + c.group + ' ' + (c.year || '')).toLowerCase().indexOf(q) >= 0;
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

  function updateCount(items) {
    var count = $('itemCount');
    if (state.mode === 'spanish' && state.iaTotal) {
      count.textContent = items.length + ' de ' + state.iaTotal.toLocaleString('es-ES') + ' películas';
    } else {
      count.textContent = items.length + ' elementos';
    }
  }

  function emptyMessage() {
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.iaLoading
      ? (state.mode === 'spanish' ? 'Buscando carátulas y títulos…' : 'Cargando lista…')
      : 'No hay elementos. Prueba otra búsqueda o carga una fuente arriba.';
    return p;
  }

  function renderMovieList() {
    var host = $('channelList');
    var items = filtered();
    updateCount(items);
    host.innerHTML = '';

    if (!items.length) { host.appendChild(emptyMessage()); return; }

    var grid = document.createElement('div');
    grid.className = 'movie-grid';

    items.forEach(function (c) {
      var card = document.createElement('button');
      card.className = 'movie-card' + (state.currentId === c.id ? ' playing' : '');
      card.title = c.name + (c.year ? ' (' + c.year + ')' : '') +
        (c.downloads ? ' · ' + formatCount(c.downloads) + ' descargas' : '');

      var wrap = document.createElement('div');
      wrap.className = 'poster-wrap';

      if (c.logo) {
        var img = document.createElement('img');
        img.className = 'movie-poster';
        img.src = c.logo;
        img.alt = 'Carátula de ' + c.name;
        img.loading = 'lazy';
        img.onerror = function () { img.style.visibility = 'hidden'; };
        wrap.appendChild(img);
      } else {
        var ph = document.createElement('span');
        ph.className = 'poster-ph';
        ph.textContent = '▶';
        wrap.appendChild(ph);
      }

      if (c.isRecent) {
        var nb = document.createElement('span');
        nb.className = 'badge badge-new';
        nb.textContent = 'NUEVO';
        nb.title = 'Añadida recientemente al archivo (no es un estreno comercial)';
        wrap.appendChild(nb);
      }
      if (c.downloads > 0) {
        var pb = document.createElement('span');
        pb.className = 'badge badge-pop';
        pb.textContent = '★ ' + formatCount(c.downloads);
        pb.title = formatCount(c.downloads) + ' descargas en Internet Archive';
        wrap.appendChild(pb);
      }
      card.appendChild(wrap);

      var meta = document.createElement('div');
      meta.className = 'movie-meta';
      var title = document.createElement('div');
      title.className = 'movie-title';
      title.textContent = c.name;
      var sub = document.createElement('div');
      sub.className = 'movie-sub';
      var parts = [];
      if (c.year) parts.push(c.year);
      if (c.downloads) parts.push(formatCount(c.downloads) + ' desc.');
      else if (c.addedDate) parts.push('Añadida ' + String(c.addedDate).slice(0, 10));
      if (!parts.length) parts.push('Internet Archive');
      sub.textContent = parts.join(' · ');
      meta.appendChild(title);
      meta.appendChild(sub);
      card.appendChild(meta);

      card.addEventListener('click', function () { play(c); });
      grid.appendChild(card);
    });

    host.appendChild(grid);

    if (!state.iaLoading && !state.search.trim() && state.group === 'Todos' &&
        state.iaTotal > state.channels.length) {
      var more = document.createElement('button');
      more.className = 'btn primary load-more';
      var remaining = state.iaTotal - state.channels.length;
      more.textContent = 'Cargar más películas (' + remaining.toLocaleString('es-ES') + ')';
      more.addEventListener('click', function () {
        loadSpanish(state.iaQuery, state.iaPage + 1, true);
      });
      host.appendChild(more);
    }
  }

  function renderChannelList() {
    var host = $('channelList');
    var items = filtered();
    updateCount(items);
    host.innerHTML = '';

    if (!items.length) { host.appendChild(emptyMessage()); return; }

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
      var gr = document.createElement('span'); gr.className = 'chan-group';
      gr.textContent = c.year ? (c.group + ' · ' + c.year) : c.group;
      info.appendChild(nm); info.appendChild(gr);
      b.appendChild(info);
      b.addEventListener('click', function () { play(c); });
      host.appendChild(b);
    });
  }

  function renderList() {
    if (state.mode === 'spanish') renderMovieList();
    else renderChannelList();
  }

  /* ---------- Internet Archive ---------- */

  function loadSpanish(term, page, append) {
    if (state.iaLoading) return;

    term = term || '';
    page = page || 1;
    state.iaQuery = term;
    state.iaLoading = true;

    showStatus(page > 1
      ? 'Cargando más carátulas…'
      : (term ? 'Buscando «' + term + '» en Internet Archive…' : 'Cargando carátulas en español…'));

    var url = IA_SEARCH + '?q=' + encodeURIComponent(iaSearchQuery(term)) +
      '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=downloads&fl[]=publicdate' +
      '&fl[]=addeddate&fl[]=date&fl[]=licenseurl' +
      '&rows=' + PAGE_SIZE + '&page=' + page + '&output=json' +
      '&sort[]=' + encodeURIComponent(state.iaSort);

    fetch(url, { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.json();
      })
      .then(function (data) {
        var resp = data.response || {};
        var docs = resp.docs || [];
        var total = resp.numFound || 0;
        if (!docs.length && page === 1) {
          throw new Error('No se encontraron películas para esa búsqueda.');
        }

        var items = docs.map(iaDocToItem);
        state.iaTotal = total;
        state.iaPage = page;
        var key = 'spanish:' + term + ':' + state.iaSort + ':' + page;

        if (append) {
          var seen = {};
          state.channels.forEach(function (c) { seen[c.id] = 1; });
          var added = items.filter(function (c) {
            if (seen[c.id]) return false;
            seen[c.id] = 1;
            return true;
          });
          state.channels = state.channels.concat(added);
          state.lastSourceKey = key;
          renderGroups();
          showStatus('✔ ' + added.length + ' películas más (' + state.channels.length +
            ' de ' + state.iaTotal.toLocaleString('es-ES') + ').');
        } else {
          setChannels(items, key, '✔ ' + items.length + ' carátulas de ' +
            state.iaTotal.toLocaleString('es-ES') + ' películas disponibles.');
        }
      })
      .catch(function (e) {
        showStatus('No se pudo consultar Internet Archive: ' + e.message, true);
      })
      .then(function () {
        state.iaLoading = false;
        renderList();
      });
  }

  function resolveIa(item) {
    var token = ++state.iaResolveToken;
    showStatus('Preparando «' + item.name + '» desde Internet Archive…');
    playerStatus('Buscando archivo de video…');

    fetch(IA_METADATA + encodeURIComponent(item.identifier), { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
        return r.json();
      })
      .then(function (md) {
        if (token !== state.iaResolveToken) return;
        var files = md.files || [];
        var pick = firstFile(files, function (f) {
          return f.format === 'h.264' && /\.mp4$/i.test(f.name);
        }) || firstFile(files, function (f) {
          return f.source === 'derivative' && /\.mp4$/i.test(f.name);
        }) || firstFile(files, function (f) {
          return /\.mp4$/i.test(f.name);
        }) || firstFile(files, function (f) {
          return /\.m3u8$/i.test(f.name);
        }) || firstFile(files, function (f) {
          return /\.(webm|ogv|mkv)$/i.test(f.name);
        });

        if (!pick) throw new Error('Esta ficha no tiene un video reproducible.');

        var url = IA_DOWNLOAD + encodeURIComponent(item.identifier) + '/' +
          encodeURIComponent(pick.name);
        item.resolvedUrl = url;
        item.url = url;

        if (state.currentId === item.id) {
          $('nowGroup').textContent = item.group +
            (item.year ? ' · ' + item.year : '') + ' · Internet Archive';
        }

        showStatus('');
        window.cotuPlayer.playStream(url, { title: item.name, timeout: 35000 });
      })
      .catch(function (e) {
        if (token !== state.iaResolveToken) return;
        showStatus('No se pudo preparar la película: ' + e.message, true);
        playerStatus('Error: ' + e.message);
      });
  }

  /* ---------- acciones generales ---------- */

  function switchMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('mode-spanish', mode === 'spanish');
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-mode') === mode);
    });
    ['spanish', 'catalog', 'm3u', 'file', 'local'].forEach(function (m) {
      var panel = $('panel-' + m);
      if (panel) panel.style.display = (m === mode ? '' : 'none');
    });
    $('view-player').style.display = '';
    showStatus('');

    var legal = $('legalNote');
    if (legal) {
      if (mode === 'spanish') {
        legal.textContent = 'Películas en español del archivo público de Internet Archive ' +
          '(dominio público / licencias abiertas). CotuStream no distribuye contenido: ' +
          'solo reproduce fuentes públicas y tus propios archivos con licencia. ' +
          '«Recién añadidas» indica la fecha de incorporación al archivo, no un estreno comercial.';
      } else if (mode === 'catalog') {
        legal.textContent = 'Catálogo integrado: películas cortas y demos bajo licencias libres ' +
          '(Blender Foundation / Creative Commons) y un canal de prueba HLS. ' +
          'CotuStream no distribuye contenido; usa además tus propias listas o archivos con licencia.';
      } else {
        legal.textContent = 'CotuStream es un reproductor genérico y no distribuye contenido. ' +
          'Usa únicamente listas y archivos propios o con licencia.';
      }
    }

    if (mode === 'spanish') {
      loadSpanish(state.iaQuery, 1, false);
    } else if (mode === 'catalog') {
      setChannels(BUILTIN.slice(), 'catalog', '✔ ' + BUILTIN.length + ' elementos del catálogo listos.');
    } else {
      window.cotuPlayer.stop();
      renderList();
    }
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
    window.cotuPlayer.stop();
    $('nowTitle').textContent = 'Selecciona una película';
    $('nowGroup').textContent = 'Elige un título de la lista para empezar a ver.';
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
    $('nowGroup').textContent = c.year
      ? c.group + ' · ' + c.year
      : c.group;

    if (c.ia && !c.resolvedUrl) {
      resolveIa(c);
    } else if (/^local:/.test(c.url)) {
      var idx = parseInt(c.url.slice(6), 10);
      window.cotuPlayer.playLocalIndex(idx, state.localFiles);
    } else {
      window.cotuPlayer.playStream(c.url, { title: c.name });
    }
  }

  function refresh() {
    if (state.lastSourceKey.indexOf('spanish:') === 0) {
      loadSpanish(state.iaQuery, state.iaPage, false);
    } else if (state.lastSourceKey.indexOf('url:') === 0) {
      loadFromUrl(state.customUrl);
    } else if (state.lastSourceKey === 'catalog') {
      switchMode('catalog');
    } else if (state.lastSourceKey.indexOf('file:') === 0) {
      showStatus('Vuelve a seleccionar el archivo M3U para recargarlo.', false);
    } else {
      showStatus('Esta fuente no se puede recargar automáticamente.', false);
    }
  }

  /* ---------- cableado ---------- */

  function init() {
    window.cotuPlayer.attach();

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { switchMode(t.getAttribute('data-mode')); });
    });

    $('btnIaSearch').addEventListener('click', function () {
      loadSpanish($('iaSearch').value, 1, false);
    });
    $('iaSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loadSpanish($('iaSearch').value, 1, false);
    });
    $('btnIaReset').addEventListener('click', function () {
      $('iaSearch').value = '';
      state.iaSort = 'downloads desc';
      $('iaSort').value = 'downloads desc';
      loadSpanish('', 1, false);
    });
    $('iaSort').addEventListener('change', function (e) {
      state.iaSort = e.target.value;
      loadSpanish(state.iaQuery, 1, false);
    });

    $('btnLoadUrl').addEventListener('click', function () { loadFromUrl($('m3uUrl').value); });
    $('m3uUrl').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') loadFromUrl($('m3uUrl').value);
    });
    $('m3uFile').addEventListener('change', function (e) { onM3uFile(e.target.files[0]); });
    $('btnPickLocal').addEventListener('click', pickLocalFiles);

    $('btnStop').addEventListener('click', function () {
      state.iaResolveToken++;
      window.cotuPlayer.stop();
      state.current = null; state.currentId = null;
      renderList();
      $('nowTitle').textContent = 'Selecciona una película';
      $('nowGroup').textContent = 'Elige un título de la lista para empezar a ver.';
    });
    $('btnFullscreen').addEventListener('click', function () { window.cotuPlayer.toggleFullscreen(); });
    $('btnRefresh').addEventListener('click', refresh);
    $('volume').addEventListener('input', function (e) {
      window.cotuPlayer.setVolume(parseFloat(e.target.value));
    });
    $('search').addEventListener('input', function (e) {
      state.search = e.target.value; renderList();
    });

    loadSpanish('', 1, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
