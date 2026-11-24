/* Vidrow Edit Kit — panel UI. Pipeline lives in js/node/* (Node, via CEP mixed context). */
(function () {
  'use strict';
  // Show any startup/runtime error in the panel instead of failing silently.
  function showFatal(msg) {
    var el = document.getElementById('status');
    if (el) { el.className = 'status err'; el.textContent = 'Panel error: ' + msg + ' (see Log)'; }
    var lg = document.getElementById('log');
    if (lg) { var d = document.createElement('div'); d.className = 'error'; d.textContent = 'Panel error: ' + msg; lg.appendChild(d); }
  }
  window.addEventListener('error', function (e) { showFatal(e.message + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')); });
  window.addEventListener('unhandledrejection', function (e) { showFatal(String(e.reason && e.reason.message || e.reason)); });
  var missing = ['VEKHost', 'VEKBridge', 'VEKPaste', 'VEKRenderers', 'VEKFaces'].filter(function (k) { return !window[k]; });
  if (missing.length) { showFatal('scripts not loaded: ' + missing.join(', ')); }
  var H = window.VEKHost;
  var req = H.node;
  var EXT = H.extensionPath();
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  // Node modules (only inside Premiere)
  var N = {};
  if (req && EXT) {
    try {
      ['pipeline', 'settings', 'anthropic', 'text', 'util', 'media'].forEach(function (m) { N[m] = req(EXT + '/js/node/' + m + '.js'); });
    } catch (e) { console.error(e); }
  }
  var cs = { evalScript: H.evalScript };

  var GENRES = ['None', 'Curious', 'Happy', 'Wholesome', 'Sad'];
  var FALLBACK_MODELS = [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }];
  var EFFORT_HINTS = {
    low: 'Fastest and cheapest. Fine for simple talking-head cuts.',
    medium: 'Quicker, a little less careful with take choice.',
    high: 'Recommended. Careful take choice and timing (a few minutes).',
    xhigh: 'Extra careful on long or messy footage; slower, costs more.',
    max: 'Slowest and most expensive. Only when nothing else gets it right.',
  };
  var APP_HINTS = {
    split: 'App screen strictly in the top 40%; footage in the bottom 60% with faces kept fully in view.',
    full: 'The app screen covers the whole frame.',
    phone: 'Screens shown inside a phone frame (~94% of the height) over the footage, which keeps playing blurred behind it.',
  };

  var state = {
    footage: [], assets: [], links: [], format: 'talking_head', refType: 'none', refFile: '', refProject: '',
    callout: 'white', deliver: 'separate', lastJobDir: '', lastEdit: null,
  };
  var settings = N.settings ? N.settings.load() : loadLocal('vek.settings', {});
  var formats = [];
  var busy = false;

  // ---------------------------------------------------------------- helpers
  function loadLocal(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function saveLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function basename(p) { return String(p).split(/[\\/]/).pop(); }
  function kindOf(p) {
    if (N.media) return N.media.kindOf(p);
    var e = (String(p).split('.').pop() || '').toLowerCase();
    if (/^(png|jpe?g|webp|gif|psd|tiff?|heic|svg)$/.test(e)) return 'image';
    if (/^(mp3|wav|aac|m4a|aiff?|flac)$/.test(e)) return 'audio';
    return 'video';
  }
  function isDir(p) { try { return req && req('fs').statSync(p).isDirectory(); } catch (e) { return false; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtSec(s) { return (Math.round(s * 10) / 10).toFixed(1) + ' s'; }

  // ---------------------------------------------------------------- log + status
  var logEl = $('log'), logCount = 0;
  function appendLog(line) {
    var d = document.createElement('div');
    d.className = line.level;
    d.innerHTML = '<span class="t">' + esc(line.t) + '</span>' + esc(line.msg);
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    $('logCount').textContent = '(' + (++logCount) + ')';
    if (line.level === 'step') status(line.msg.replace(/^\d\/\d\s*/, ''), '');
  }
  function makeLog() {
    if (N.util) return N.util.makeLogger(appendLog);
    var f = function (m, l) { appendLog({ t: new Date().toTimeString().slice(0, 8), level: l || 'info', msg: m }); };
    f.warn = function (m) { f(m, 'warn'); }; f.error = function (m) { f(m, 'error'); }; f.step = function (m) { f(m, 'step'); }; f.lines = [];
    return f;
  }
  function status(msg, cls, html) {
    var el = $('status');
    el.className = 'status ' + (cls || '');
    if (html) el.innerHTML = html; else el.textContent = msg;
  }
  $('logCopy').addEventListener('click', function (e) {
    e.preventDefault();
    var t = qsa('#log > div').map(function (d) { return d.textContent; }).join('\n');
    try { navigator.clipboard.writeText(t); } catch (er) { /* ignore */ }
  });

  // ---------------------------------------------------------------- tabs
  function openTab(name) {
    qsa('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    qsa('.pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + name); });
    saveLocal('vek.tab', name);
  }
  qsa('.tab').forEach(function (t) { t.addEventListener('click', function () { openTab(t.dataset.tab); }); });

  // ---------------------------------------------------------------- drafts
  var draftTimer = null;
  function collectDraft() {
    var d = { fields: {}, state: state };
    qsa('[data-draft]').forEach(function (el) { d.fields[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
    return d;
  }
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      var d = collectDraft();
      saveLocal('vek.draft', d);
      if (req) {
        try {
          var dir = req('path').dirname(N.settings.FILE);
          req('fs').mkdirSync(dir, { recursive: true });
          req('fs').writeFileSync(req('path').join(dir, 'draft.json'), JSON.stringify(d));
        } catch (e) { /* ignore */ }
      }
    }, 300);
  }
  function loadDraft() {
    var d = null;
    if (req && N.settings) {
      try { d = JSON.parse(req('fs').readFileSync(req('path').join(req('path').dirname(N.settings.FILE), 'draft.json'), 'utf8')); } catch (e) { d = null; }
    }
    d = d || loadLocal('vek.draft', null);
    if (!d) return;
    Object.keys(d.fields || {}).forEach(function (id) {
      var el = $(id); if (!el) return;
      if (el.type === 'checkbox') el.checked = !!d.fields[id]; else el.value = d.fields[id];
    });
    if (d.state) Object.keys(state).forEach(function (k) { if (d.state[k] !== undefined) state[k] = d.state[k]; });
  }
  document.addEventListener('input', function (e) { if (e.target.closest('[data-draft]') || e.target.name) saveDraft(); });
  document.addEventListener('change', saveDraft);

  // ---------------------------------------------------------------- script
  window.VEKPaste.attach($('script'), function () { updateScriptStats(); saveDraft(); });
  function updateScriptStats() {
    var txt = $('script').value;
    var el = $('scriptStats');
    if (!txt.trim()) { el.innerHTML = ''; return; }
    var s;
    if (N.text) s = N.text.parseScript(txt);
    else s = { sections: { H1: [], H2: [], H3: [], BODY: [] }, callouts: (txt.match(/\[CALLOUT:/g) || []), links: (txt.match(/\[LINK:/g) || []) };
    var tags = ['H1', 'H2', 'H3', 'BODY'].map(function (k) {
      var n = s.sections[k].length;
      return '<span class="tag' + (k === 'BODY' && !n && N.text ? ' warn' : '') + '">' + (k === 'BODY' ? 'Body' : 'Hook ' + k[1]) + ': ' + n + ' line' + (n === 1 ? '' : 's') + '</span>';
    });
    tags.push('<span class="tag">' + s.callouts.length + ' callout' + (s.callouts.length === 1 ? '' : 's') + '</span>');
    tags.push('<span class="tag">' + s.links.length + ' link' + (s.links.length === 1 ? '' : 's') + '</span>');
    el.innerHTML = tags.join('');
  }
  $('script').addEventListener('input', updateScriptStats);

  // ---------------------------------------------------------------- file lists
  function renderList(listId, arr, countId) {
    var ul = $(listId);
    ul.innerHTML = '';
    arr.forEach(function (f, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="kind ' + f.kind + '">' + f.kind + '</span><span class="nm" title="' + esc(f.path) + '">' + esc(f.name) +
        (f.bin ? ' <span class="sub">· ' + esc(f.bin) + '</span>' : '') + '</span><button class="x" title="Remove">✕</button>';
      li.querySelector('.x').addEventListener('click', function () { arr.splice(i, 1); renderList(listId, arr, countId); saveDraft(); });
      ul.appendChild(li);
    });
    if (countId) $(countId).textContent = arr.length ? arr.length : '';
  }
  function addPaths(arr, paths, opts) {
    opts = opts || {};
    (paths || []).forEach(function (p) {
      if (!p || arr.some(function (f) { return f.path === p; })) return;
      var dir = isDir(p);
      arr.push({ path: p, name: basename(p) + (dir ? '/' : ''), kind: dir ? 'folder' : kindOf(p), bin: opts.bin || '' });
    });
  }
  function pickInto(arr, listId, countId, folder, inputId) {
    var r = H.pick({ multiple: !folder, folder: folder, title: folder ? 'Choose a folder' : 'Choose files' });
    if (r === null) { $(inputId).click(); return; }
    addPaths(arr, r); renderList(listId, arr, countId); saveDraft();
  }
  function browserFiles(inputId, arr, listId, countId) {
    $(inputId).addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      addPaths(arr, files.map(function (f) { return f.path || f.name; }));
      renderList(listId, arr, countId); saveDraft(); e.target.value = '';
    });
  }
  $('fAddFiles').onclick = function () { pickInto(state.footage, 'listFootage', 'cntFootage', false, 'fileInputFootage'); };
  $('fAddFolder').onclick = function () { pickInto(state.footage, 'listFootage', 'cntFootage', true, 'fileInputFootage'); };
  $('fClear').onclick = function () { state.footage.length = 0; renderList('listFootage', state.footage, 'cntFootage'); saveDraft(); };
  $('aAddFiles').onclick = function () { pickInto(state.assets, 'listAssets', null, false, 'fileInputAssets'); };
  $('aAddFolder').onclick = function () { pickInto(state.assets, 'listAssets', null, true, 'fileInputAssets'); };
  browserFiles('fileInputFootage', state.footage, 'listFootage', 'cntFootage');
  browserFiles('fileInputAssets', state.assets, 'listAssets', null);

  $('fUseSel').onclick = function () {
    window.VEKBridge.call(cs, 'getSelection').then(function (r) {
      if (!r.ok) throw new Error(r.error);
      if (!r.items.length) { status('Nothing is selected in the Project panel.', 'err'); return; }
      r.items.forEach(function (it) { addPaths(state.footage, [it.path], { bin: it.bin }); });
      renderList('listFootage', state.footage, 'cntFootage'); saveDraft();
      status('Added ' + r.items.length + ' clip(s) from the selection.', 'ok');
    }).catch(function (e) { status(e.message, 'err'); });
  };

  // ---------------------------------------------------------------- project browser
  var projTarget = null;
  function openProject(target, single) {
    projTarget = { target: target, single: single };
    $('projTitle').textContent = single ? 'Pick a reference clip' : 'Project panel';
    $('projList').innerHTML = '<p class="muted">Loading…</p>';
    $('projModal').hidden = false;
    window.VEKBridge.call(cs, 'listProject').then(function (r) {
      if (!r.ok) throw new Error(r.error);
      renderProject(r.items);
    }).catch(function (e) { $('projList').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }
  function renderProject(items) {
    var bins = {};
    items.forEach(function (it) { (bins[it.bin] = bins[it.bin] || []).push(it); });
    var html = Object.keys(bins).sort().map(function (b) {
      var rows = bins[b].map(function (it) {
        return '<label class="proj-item" data-name="' + esc((it.name + ' ' + it.path).toLowerCase()) + '"><input type="' + (projTarget.single ? 'radio' : 'checkbox') + '" name="pi" value="' + esc(it.path) + '" data-bin="' + esc(b) + '">' +
          '<span><div>' + esc(it.name) + '</div><div class="p">' + esc(it.path) + '</div></span></label>';
      }).join('');
      return '<div class="proj-bin"><div class="bin-head">' + (projTarget.single ? '' : '<input type="checkbox" class="binall">') + '📁 ' + esc(b) + ' <span>(' + bins[b].length + ')</span></div>' + rows + '</div>';
    }).join('') || '<p class="muted">No clips with media in this project.</p>';
    $('projList').innerHTML = html;
    qsa('.binall', $('projList')).forEach(function (cb) {
      cb.addEventListener('change', function () { qsa('input[name=pi]', cb.closest('.proj-bin')).forEach(function (x) { if (!x.closest('.proj-item').hidden) x.checked = cb.checked; }); countProj(); });
    });
    qsa('input[name=pi]', $('projList')).forEach(function (x) { x.addEventListener('change', countProj); });
    countProj();
  }
  function countProj() { $('projCount').textContent = qsa('input[name=pi]:checked', $('projList')).length + ' selected'; }
  $('projFilter').addEventListener('input', function () {
    var q = this.value.toLowerCase();
    qsa('.proj-item', $('projList')).forEach(function (el) { el.hidden = q && el.dataset.name.indexOf(q) < 0; });
  });
  $('projAdd').onclick = function () {
    var sel = qsa('input[name=pi]:checked', $('projList'));
    if (projTarget.single) {
      if (sel[0]) { state.refProject = sel[0].value; $('refProjectName').textContent = basename(sel[0].value); }
    } else {
      var arr = projTarget.target === 'assets' ? state.assets : state.footage;
      sel.forEach(function (x) { addPaths(arr, [x.value], { bin: x.dataset.bin }); });
      renderList('listFootage', state.footage, 'cntFootage'); renderList('listAssets', state.assets, null);
    }
    $('projModal').hidden = true; saveDraft();
  };
  $('fFromProject').onclick = function () { openProject('footage', false); };
  $('aFromProject').onclick = function () { openProject('assets', false); };
  qsa('[data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('.modal').hidden = true; }); });

  // ---------------------------------------------------------------- formats
  function loadFormats() {
    if (req && EXT) {
      try { return Promise.resolve(JSON.parse(req('fs').readFileSync(EXT + '/presets/formats.json', 'utf8')).formats); } catch (e) { /* fall back below */ }
    }
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open('GET', 'presets/formats.json');
      x.onload = function () { try { resolve(JSON.parse(x.responseText).formats); } catch (e) { resolve([]); } };
      x.onerror = function () { resolve([]); };
      x.send();
    }).then(function (f) {
      if (!f.length) status('Could not read presets/formats.json — reinstall the panel.', 'err');
      return f;
    });
  }
  function renderFormats() {
    $('formatList').innerHTML = formats.map(function (f) {
      return '<button class="fmt' + (f.id === state.format ? ' on' : '') + '" data-id="' + f.id + '"><b>' + esc(f.name) + '</b><span>' + esc(f.tagline) + '</span></button>';
    }).join('');
    qsa('.fmt').forEach(function (b) { b.onclick = function () { state.format = b.dataset.id; renderFormats(); saveDraft(); }; });
    var f = formats.find(function (x) { return x.id === state.format; }) || formats[0];
    if (!f) return;
    var rows = [
      ['Pace', f.pace], ['Main layout', f.main_layout], ['Layouts allowed', f.allowed_layouts.join(', ')], ['Screen coverage', f.screen_coverage],
      ['Pauses', f.pause_cut_seconds == null ? 'Off (keep performance timing)' : 'none longer than ' + f.pause_cut_seconds + ' s (tool removes ≥ 0.15 s)'],
      ['Punch-ins', f.punch_ins.enabled ? 'On, ' + f.punch_ins.scales.join(' / ') : 'Off'],
      ['Music', f.music.notes], ['Hook', f.hook_range.join('–') + ' s'], ['Body', f.body_range.join('–') + ' s'],
    ];
    $('formatDetail').innerHTML = '<div class="tagline">' + esc(f.name) + ' — ' + esc(f.tagline) + '</div><table>' +
      rows.map(function (r) { return '<tr><td>' + r[0] + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join('') + '</table>';
    $('maxHook').placeholder = 'default ' + f.hook_range[1];
    $('maxBody').placeholder = 'default ' + f.body_range[1];
  }
  $('appScreens').addEventListener('change', function () { $('appScreensHint').textContent = APP_HINTS[this.value]; });

  // reference
  function renderRef() {
    qsa('#refType button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === state.refType); });
    qsa('.ref-body').forEach(function (d) { d.classList.toggle('on', d.dataset.ref === state.refType); });
    $('refFileName').textContent = state.refFile ? basename(state.refFile) : '';
    $('refProjectName').textContent = state.refProject ? basename(state.refProject) : '';
  }
  qsa('#refType button').forEach(function (b) { b.onclick = function () { state.refType = b.dataset.v; renderRef(); saveDraft(); }; });
  $('refPickFile').onclick = function () {
    var r = H.pick({ multiple: false, title: 'Reference video' });
    if (r && r[0]) { state.refFile = r[0]; renderRef(); saveDraft(); }
  };
  $('refPickProject').onclick = function () { openProject('reference', true); };

  // ---------------------------------------------------------------- client: links, callout style
  function renderLinks() {
    $('linkRows').innerHTML = '';
    state.links.forEach(function (l, i) {
      var row = document.createElement('div');
      row.className = 'linkrow';
      row.innerHTML = '<select><option value="figma">Figma</option><option value="drive">Google Drive</option><option value="other">Other</option></select>' +
        '<input type="url" placeholder="https://…"><button class="x" title="Remove">✕</button>';
      var sel = row.querySelector('select'), inp = row.querySelector('input');
      sel.value = l.type; inp.value = l.url;
      sel.onchange = function () { l.type = sel.value; saveDraft(); };
      inp.oninput = function () {
        l.url = inp.value;
        if (/figma\.com/.test(l.url)) sel.value = l.type = 'figma'; else if (/drive\.google\.com/.test(l.url)) sel.value = l.type = 'drive';
        saveDraft();
      };
      row.querySelector('.x').onclick = function () { state.links.splice(i, 1); renderLinks(); saveDraft(); };
      $('linkRows').appendChild(row);
    });
  }
  $('addLink').onclick = function () { state.links.push({ type: 'drive', url: '' }); renderLinks(); saveDraft(); };
  qsa('input[name=callout]').forEach(function (r) { r.addEventListener('change', function () { state.callout = r.value; saveDraft(); }); });
  $('brandColor').addEventListener('input', function () { $('swBrand').style.background = this.value; });
  qsa('input[name=deliver]').forEach(function (r) { r.addEventListener('change', function () { state.deliver = r.value; saveDraft(); }); });

  // ---------------------------------------------------------------- music
  ['track1', 'track2'].forEach(function (id) {
    $(id).innerHTML = GENRES.map(function (g) { return '<option>' + g + '</option>'; }).join('');
  });
  $('track1').value = 'Curious'; $('track2').value = 'Happy';
  $('musicStart').addEventListener('change', function () { $('musicStartSecWrap').hidden = this.value !== 'custom'; });
  $('musicLevel').addEventListener('input', function () { $('musicLevelVal').textContent = '−' + Math.abs(this.value) + ' dB'; });

  // ---------------------------------------------------------------- models + effort
  function fillModels(list) {
    var sel = $('model'), cur = sel.value || settings.defaultModel || 'claude-opus-5-5';
    sel.innerHTML = list.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('');
    sel.value = list.some(function (m) { return m.id === cur; }) ? cur : list[0].id;
    $('sModel').innerHTML = sel.innerHTML; $('sModel').value = settings.defaultModel || sel.value;
    updateHint();
  }
  function updateHint() {
    var e = $('effort').value, m = $('model').value;
    var cost = N.anthropic ? N.anthropic.costLabel(m, e) : '';
    $('modelHint').textContent = EFFORT_HINTS[e] + (cost ? ' ' + cost + '.' : '');
    saveLocal('vek.modelEffort', { model: m, effort: e });
  }
  $('model').addEventListener('change', updateHint);
  $('effort').addEventListener('change', updateHint);
  function refreshModels(force) {
    if (!N.anthropic) { fillModels(FALLBACK_MODELS); return; }
    fillModels(N.anthropic.MODELS);
    N.anthropic.listModels(settings.anthropicKey, settings.outputFolder, { refresh: !!force }).then(fillModels).catch(function () { /* keep built-ins */ });
  }

  // ---------------------------------------------------------------- settings
  var SET_MAP = { sAnthropic: 'anthropicKey', sModel: 'defaultModel', sTranscriber: 'transcriber', sOpenAI: 'openaiKey', sWhisperBin: 'whisperCppBin', sWhisperModel: 'whisperCppModel',
    sLanguage: 'language', sFigma: 'figmaToken', sGoogle: 'googleKey', sYtdlp: 'ytdlpPath', sCookies: 'browserCookies', sOutput: 'outputFolder', sPreset: 'presetPath', sAutoStart: 'autoStartQueue' };
  function openSettings() {
    Object.keys(SET_MAP).forEach(function (id) { var el = $(id), v = settings[SET_MAP[id]]; if (el.type === 'checkbox') el.checked = v !== false; else el.value = v == null ? '' : v; });
    trVisibility(); $('setSaved').textContent = ''; $('setModal').hidden = false;
  }
  function trVisibility() { qsa('[data-tr]').forEach(function (l) { l.hidden = l.dataset.tr !== $('sTranscriber').value; }); }
  $('sTranscriber').addEventListener('change', trVisibility);
  $('btnSettings').onclick = openSettings;
  $('setSave').onclick = function () {
    Object.keys(SET_MAP).forEach(function (id) { var el = $(id); settings[SET_MAP[id]] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    if (settings.whisperCppModel && req) settings.whisperCppModel = settings.whisperCppModel.replace(/^~/, req('os').homedir());
    if (N.settings) N.settings.save(settings); else saveLocal('vek.settings', settings);
    $('setSaved').textContent = 'Saved.';
    refreshModels(true);
    setTimeout(function () { $('setModal').hidden = true; }, 400);
  };

  // ---------------------------------------------------------------- connection
  function ping() {
    window.VEKBridge.call(cs, 'ping').then(function (r) {
      $('conn').className = 'conn ' + (r.ok ? 'ok' : 'bad');
      $('conn').title = r.ok ? 'Connected to ' + r.app + ' ' + r.version + (r.project ? ' · ' + r.project : ' · no project open') : r.error;
      $('connText').textContent = r.ok ? (r.project ? r.project.replace(/\.prproj$/, '') : 'Premiere') : 'Premiere';
    }).catch(function () {
      $('conn').className = 'conn bad';
      $('conn').title = H.inCEP ? 'Premiere is not answering (host.jsx not loaded?)' : 'Preview mode: open this panel inside Premiere Pro (Window → Extensions → Vidrow Edit Kit)';
    });
  }

  // ---------------------------------------------------------------- generate
  function collectInput() {
    var ref = null;
    if (state.refType === 'link' && $('refUrl').value.trim()) ref = { type: 'link', url: $('refUrl').value.trim() };
    if (state.refType === 'file' && state.refFile) ref = { type: 'file', path: state.refFile };
    if (state.refType === 'project' && state.refProject) ref = { type: 'project', path: state.refProject };
    return {
      jobName: $('jobName').value.trim(), scriptText: $('script').value,
      footage: state.footage.map(function (f) { return f.path; }),
      format: state.format, aspect: $('aspect').value, appScreens: $('appScreens').value, reference: ref,
      client: {
        name: $('clientName').value.trim(), assets: state.assets.map(function (f) { return f.path; }),
        links: state.links.filter(function (l) { return l.url; }), calloutStyle: state.callout, brandColor: $('brandColor').value, brandNotes: $('brandNotes').value,
      },
      music: { library: $('musicLib').value.trim(), track1: $('track1').value, track2: $('track2').value, start: $('musicStart').value, startSec: Number($('musicStartSec').value) || 0, level: Number($('musicLevel').value) },
      brief: { text: $('brief').value, maxHook: Number($('maxHook').value) || null, maxBody: Number($('maxBody').value) || null, deliver: state.deliver, autoExport: $('autoExport').checked },
      model: $('model').value, effort: $('effort').value,
    };
  }

  function makeEnv(log) {
    var r = window.VEKRenderers.makeRenderers(req);
    return {
      log: log, presetsDir: EXT + '/presets',
      renderCallout: r.renderCallout, renderPhone: r.renderPhone,
      detectFaces: function (frames) {
        return window.VEKFaces.load(EXT, req).then(function (fa) { return window.VEKFaces.detectFrames(fa, frames); });
      },
    };
  }

  function setBusy(b) {
    busy = b;
    var g = $('btnGenerate');
    g.disabled = b; g.classList.toggle('busy', b);
    g.querySelector('.label').textContent = b ? 'Working…' : 'Generate edit';
    ['btnRebuild', 'btnExport', 'btnOpenJob'].forEach(function (id) { $(id).disabled = b || !state.lastJobDir; });
  }

  function premiere(fn, spec, log) {
    return window.VEKBridge.call(cs, fn, spec).then(function (r) {
      (r.log || []).forEach(function (l) { log((/FAILED|failed|could not/i.test(l) ? '⚠ ' : '') + 'Premiere: ' + l, /FAILED/.test(l) ? 'warn' : 'info'); });
      if (!r.ok) throw new Error('Premiere: ' + r.error);
      return r;
    });
  }

  function showLastEdit(info, flash) {
    state.lastEdit = info;
    var body = $('lastEditBody');
    if (!info) { body.innerHTML = 'No edit yet.'; body.className = 'muted'; return; }
    body.className = '';
    var rows = (info.summary || []).map(function (t) {
      var cut = info.cutCheck && info.cutCheck[t.name];
      return '<div class="tl-row"><b>' + esc(t.name) + '</b> · ' + fmtSec(t.duration) + '<div class="meta">Body starts ' + fmtSec(t.bodyStart) + ' · ' + t.cuts + ' cuts · ' + t.overlays + ' screens/graphics · ' +
        t.callouts + ' callouts · music: ' + esc(t.music) + ' · ' + t.markers + ' markers' + (cut ? ' · cut check: ' + cut : '') + '</div></div>';
    }).join('');
    var warns = (info.warnings || []).slice(0, 8).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    body.innerHTML = (info.planSummary ? '<p>' + esc(info.planSummary) + '</p>' : '') + rows + (warns ? '<ul class="warns">' + warns + '</ul>' : '') +
      '<div class="muted">' + esc(info.jobDir || '') + '</div>';
    ['btnRebuild', 'btnExport', 'btnOpenJob'].forEach(function (id) { $(id).disabled = busy || !state.lastJobDir; });
    if (flash) { $('lastEdit').classList.remove('flash'); void $('lastEdit').offsetWidth; $('lastEdit').classList.add('flash'); }
  }

  function readyStatus() {
    status('', 'ok', 'Edit ready. Rebuild / Export are in the <a id="toBrief">Brief tab</a>');
    $('toBrief').onclick = function () { openTab('brief'); $('lastEdit').scrollIntoView({ behavior: 'smooth' }); showLastEdit(state.lastEdit, true); };
  }

  function afterBuild(res, built, log) {
    var cut = {};
    (built.timelines || []).forEach(function (t) { cut[t.name] = t.exact + ' exact' + (t.corrected ? ', ' + t.corrected + ' corrected' : '') + (t.failed ? ', ' + t.failed + ' FAILED' : ''); });
    state.lastJobDir = res.jobDir;
    showLastEdit({ summary: res.summary, planSummary: res.planSummary, warnings: res.warnings, jobDir: res.jobDir, cutCheck: cut });
    saveDraft();
    readyStatus();
  }

  function guard() {
    if (busy) return false;
    if (!req || !N.pipeline) { status('Open this panel inside Premiere Pro (Window → Extensions → Vidrow Edit Kit).', 'err'); return false; }
    return true;
  }

  $('btnGenerate').onclick = function () {
    if (!guard()) return;
    var input = collectInput();
    if (!input.scriptText.trim()) { status('Paste the script first (Script tab).', 'err'); openTab('script'); return; }
    if (!input.footage.length) { status('Add footage first (Footage tab).', 'err'); openTab('footage'); return; }
    if (!settings.anthropicKey) { status('Add your Anthropic API key in ⚙ Settings.', 'err'); openSettings(); return; }
    if (settings.transcriber !== 'whispercpp' && !settings.openaiKey) { status('Add an OpenAI key (speech-to-text) or set up whisper.cpp in ⚙ Settings.', 'err'); openSettings(); return; }
    var log = makeLog();
    $('logBox').open = true;
    setBusy(true);
    status('Starting…');
    log.step('Generate edit: ' + (input.jobName || 'untitled job'));
    var res;
    N.pipeline.generate(input, settings, makeEnv(log)).then(function (r) {
      res = r;
      log.step('Building timelines in Premiere');
      return premiere('build', r.hostSpec, log);
    }).then(function (built) {
      afterBuild(res, built, log);
      if (input.brief.autoExport) { log.step('Queueing exports in Media Encoder'); return premiere('exportAll', res.hostSpec, log).then(function () { readyStatus(); }); }
    }).catch(function (e) {
      log.error(e.message);
      status(e.message, 'err');
    }).then(function () { setBusy(false); });
  };

  $('btnRebuild').onclick = function () {
    if (!guard() || !state.lastJobDir) return;
    var log = makeLog(); $('logBox').open = true; setBusy(true);
    var res;
    N.pipeline.rebuild(state.lastJobDir, settings, makeEnv(log)).then(function (r) { res = r; return premiere('build', r.hostSpec, log); })
      .then(function (built) { afterBuild(res, built, log); })
      .catch(function (e) { log.error(e.message); status(e.message, 'err'); })
      .then(function () { setBusy(false); });
  };
  $('btnExport').onclick = function () {
    if (!guard() || !state.lastJobDir) return;
    var log = makeLog(); $('logBox').open = true; setBusy(true);
    var spec;
    try { spec = JSON.parse(req('fs').readFileSync(req('path').join(state.lastJobDir, 'build_spec.json'), 'utf8')); }
    catch (e) { setBusy(false); status('No build spec in the job folder; rebuild first.', 'err'); return; }
    spec.autoStartQueue = settings.autoStartQueue !== false;
    premiere('exportAll', spec, log).then(function (r) { status('Queued ' + r.queued.length + ' export(s) in Media Encoder → ' + basename(state.lastJobDir) + '/Exports', 'ok'); })
      .catch(function (e) { log.error(e.message); status(e.message, 'err'); })
      .then(function () { setBusy(false); });
  };
  $('btnOpenJob').onclick = function () {
    if (req && state.lastJobDir) req('child_process').spawn('open', [state.lastJobDir], { detached: true });
  };

  // ---------------------------------------------------------------- init
  $('logo').addEventListener('error', function () { this.replaceWith(document.createTextNode('vidrow')); });
  loadDraft();
  if (state.callout) qsa('input[name=callout]').forEach(function (r) { r.checked = r.value === state.callout; });
  if (state.deliver) qsa('input[name=deliver]').forEach(function (r) { r.checked = r.value === state.deliver; });
  $('swBrand').style.background = $('brandColor').value;
  $('musicStartSecWrap').hidden = $('musicStart').value !== 'custom';
  $('musicLevelVal').textContent = '−' + Math.abs($('musicLevel').value) + ' dB';
  $('appScreensHint').textContent = APP_HINTS[$('appScreens').value];
  var me = loadLocal('vek.modelEffort', null);
  if (me && me.effort) $('effort').value = me.effort;
  else if (settings.defaultEffort) $('effort').value = settings.defaultEffort;
  refreshModels(false);
  if (me && me.model) { $('model').value = me.model; updateHint(); }
  renderList('listFootage', state.footage, 'cntFootage');
  renderList('listAssets', state.assets, null);
  renderLinks(); renderRef(); updateScriptStats();
  if (state.lastEdit) showLastEdit(state.lastEdit);
  loadFormats().then(function (f) { formats = f; renderFormats(); });
  openTab(loadLocal('vek.tab', 'script'));
  ping(); setInterval(ping, 5000);
  // reload host.jsx on panel reload (so a panel refresh picks up host changes during development)
  if (H.inCEP && EXT) H.evalScript('$.evalFile("' + EXT.replace(/\\/g, '/').replace(/"/g, '\\"') + '/jsx/host.jsx")');
  window.VEKApp = {
    state: state, openTab: openTab, showLastEdit: showLastEdit, readyStatus: readyStatus, renderFormats: renderFormats,
    refresh: function () { renderList('listFootage', state.footage, 'cntFootage'); renderList('listAssets', state.assets, null); renderLinks(); renderRef(); saveDraft(); },
  };
})();
