/*
 * Vidrow Edit Kit — host.jsx (Premiere Pro ExtendScript).
 * ES3 ONLY: no let/const, arrow functions, forEach/map/indexOf/trim, template strings or built-in JSON.
 * Check after every change:  npx acorn --ecma3 --silent extension/jsx/host.jsx
 * Data comes in as an escaped JSON string (non-ASCII as \uXXXX) and results go back as JSON strings.
 */
var VEK = (typeof VEK !== 'undefined' && VEK) ? VEK : {};

(function () {
  var TICKS = 254016000000;
  var ITEM_BIN = 2, ITEM_ROOT = 3;
  var LOG = [];

  function log(msg) { LOG.push(String(msg)); }

  // ------------------------------------------------------------------ tiny JSON
  function q(s) {
    var out = '"', i, c, code, hex;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i); code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32 || code > 126) {
        hex = code.toString(16);
        while (hex.length < 4) hex = '0' + hex;
        out += '\\u' + hex;
      } else out += c;
    }
    return out + '"';
  }
  function stringify(v) {
    var i, parts, k;
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return q(v);
    if (v instanceof Array) {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (typeof v === 'object') {
      parts = [];
      for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== 'function') parts.push(q(k) + ':' + stringify(v[k]));
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }
  function parse(s) {
    if (typeof s !== 'string') return s;
    // input is produced by our own panel with JSON.stringify; eval of a JSON literal is safe here
    return eval('(' + s + ')');
  }
  VEK.json = { parse: parse, stringify: stringify };

  function result(obj) { obj.log = LOG; LOG = []; return stringify(obj); }
  function fail(e) { return result({ ok: false, error: (e && e.message) ? e.message + (e.line ? ' (line ' + e.line + ')' : '') : String(e) }); }

  // ------------------------------------------------------------------ helpers
  function num(x) { return parseFloat(x); }
  function makeTime(ticks) { var t = new Time(); t.ticks = String(Math.round(num(ticks))); return t; }
  function secs(ticks) { return num(ticks) / TICKS; }
  function contains(arr, v) { var i; for (i = 0; i < arr.length; i++) if (arr[i] === v) return true; return false; }
  function normPath(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }

  function walk(item, binPath, fn) {
    var i, c, n;
    if (!item || !item.children) return;
    n = item.children.numItems;
    for (i = 0; i < n; i++) {
      c = item.children[i];
      if (!c) continue;
      if (c.type === ITEM_BIN) { fn(c, binPath, true); walk(c, binPath ? binPath + ' / ' + c.name : c.name, fn); }
      else fn(c, binPath, false);
    }
  }
  function mediaPathOf(item) { try { return item.getMediaPath ? item.getMediaPath() : ''; } catch (e) { return ''; } }

  function projectMap() {
    var map = {};
    walk(app.project.rootItem, '', function (it, bin, isBin) {
      if (isBin) return;
      var p = mediaPathOf(it);
      if (p) map[normPath(p)] = it;
    });
    return map;
  }

  function findBin(name) {
    var root = app.project.rootItem, i, c;
    for (i = 0; i < root.children.numItems; i++) {
      c = root.children[i];
      if (c && c.type === ITEM_BIN && c.name === name) return c;
    }
    return null;
  }
  function getBin(name) {
    var b = findBin(name);
    if (b) return b;
    b = app.project.rootItem.createBin(name);
    return b || findBin(name);
  }

  function findSequence(name) {
    var i, s;
    for (i = 0; i < app.project.sequences.numSequences; i++) {
      s = app.project.sequences[i];
      if (s && s.name === name) return s;
    }
    return null;
  }

  // ------------------------------------------------------------------ public: status / project browser
  VEK.ping = function () {
    try {
      return result({ ok: true, app: app.name || 'Premiere Pro', version: app.version, project: app.project ? app.project.name : '', projectPath: app.project ? app.project.path : '' });
    } catch (e) { return fail(e); }
  };

  VEK.listProject = function () {
    try {
      var items = [];
      walk(app.project.rootItem, '', function (it, bin, isBin) {
        if (isBin) return;
        var p = mediaPathOf(it);
        if (!p) return;
        items.push({ name: it.name, bin: bin || '(root)', path: p, nodeId: it.nodeId });
      });
      return result({ ok: true, items: items });
    } catch (e) { return fail(e); }
  };

  VEK.getSelection = function () {
    try {
      var sel = app.getCurrentProjectViewSelection ? app.getCurrentProjectViewSelection() : null;
      var out = [], i;
      if (!sel) return result({ ok: true, items: [], note: 'Nothing selected in the Project panel.' });
      for (i = 0; i < sel.length; i++) {
        if (sel[i].type === ITEM_BIN) {
          walk(sel[i], sel[i].name, function (it, bin, isBin) { if (!isBin && mediaPathOf(it)) out.push({ name: it.name, bin: bin, path: mediaPathOf(it) }); });
        } else if (mediaPathOf(sel[i])) out.push({ name: sel[i].name, bin: '', path: mediaPathOf(sel[i]) });
      }
      return result({ ok: true, items: out });
    } catch (e) { return fail(e); }
  };

  // ------------------------------------------------------------------ in/out units (ticks vs seconds differ across versions)
  var UNITS = null;
  function detectUnits(item) {
    if (UNITS) return UNITS;
    try {
      item.setInPoint(2, 4);
      var got = num(item.getInPoint().seconds);
      UNITS = (Math.abs(got - 2) < 0.01) ? 'seconds' : 'ticks';
      try { item.clearInPoint(); } catch (e1) { }
    } catch (e) { UNITS = 'ticks'; }
    log('In/out units: ' + UNITS);
    return UNITS;
  }
  function unitArg(ticks) { return UNITS === 'seconds' ? secs(ticks) : String(Math.round(num(ticks))); }

  function setItemInOut(item, inTicks, outTicks, isStill) {
    try {
      item.setInPoint(unitArg(inTicks), 4);
      item.setOutPoint(unitArg(outTicks), 4);
    } catch (e) { if (!isStill) log('Could not set in/out on ' + item.name + ': ' + e.message); }
  }
  function clearItemInOut(item) { try { item.clearInPoint(); item.clearOutPoint(); } catch (e) { } }

  // ------------------------------------------------------------------ sequence setup
  function clearSequence(seq) {
    var t, j, tr;
    for (t = 0; t < seq.videoTracks.numTracks; t++) { tr = seq.videoTracks[t]; for (j = tr.clips.numItems - 1; j >= 0; j--) tr.clips[j].remove(false, false); }
    for (t = 0; t < seq.audioTracks.numTracks; t++) { tr = seq.audioTracks[t]; for (j = tr.clips.numItems - 1; j >= 0; j--) tr.clips[j].remove(false, false); }
  }

  function qeSeq(seq) {
    try {
      app.enableQE();
      if (app.project.openSequence) app.project.openSequence(seq.sequenceID);
      return qe.project.getActiveSequence();
    } catch (e) { return null; }
  }

  function ensureTracks(seq, nVideo, nAudio) {
    var needV = nVideo - seq.videoTracks.numTracks, needA = nAudio - seq.audioTracks.numTracks, qs;
    if (needV <= 0 && needA <= 0) return true;
    qs = qeSeq(seq);
    try {
      if (qs) qs.addTracks(Math.max(0, needV), seq.videoTracks.numTracks, Math.max(0, needA), 1, seq.audioTracks.numTracks, 0, 0, 0);
    } catch (e) { log('Could not add tracks automatically (' + e.message + ').'); }
    if (seq.videoTracks.numTracks < nVideo || seq.audioTracks.numTracks < nAudio) {
      log('Sequence has V' + seq.videoTracks.numTracks + '/A' + seq.audioTracks.numTracks + '; wanted V' + nVideo + '/A' + nAudio + '. Extra layers go on the highest track.');
      return false;
    }
    return true;
  }

  function makeSequence(name, firstItem, bin, frame) {
    var old = findSequence(name), seq, st, d = new Date();
    if (old) {
      old.name = name + ' (prev ' + d.getHours() + '.' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes() + ')';
      log('Renamed the existing ' + name + ' to "' + old.name + '".');
    }
    seq = app.project.createNewSequenceFromClips(name, [firstItem], bin);
    if (!seq) seq = findSequence(name);
    if (!seq) throw new Error('Premiere could not create sequence ' + name);
    clearSequence(seq);
    try {
      st = seq.getSettings();
      st.videoFrameWidth = frame.w;
      st.videoFrameHeight = frame.h;
      seq.setSettings(st);
    } catch (e) { log('Could not set ' + frame.w + 'x' + frame.h + ' on ' + name + ': ' + e.message); }
    return seq;
  }

  // ------------------------------------------------------------------ components
  function findComponent(tc, names) {
    var i, c;
    if (!tc.components) return null;
    for (i = 0; i < tc.components.numItems; i++) {
      c = tc.components[i];
      if (contains(names, c.displayName) || contains(names, c.matchName)) return c;
    }
    return null;
  }
  function findProp(comp, names, idx) {
    var i, p;
    for (i = 0; i < comp.properties.numItems; i++) { p = comp.properties[i]; if (contains(names, p.displayName) || contains(names, p.matchName)) return p; }
    return (idx !== undefined && comp.properties.numItems > idx) ? comp.properties[idx] : null;
  }

  function setMotion(tc, c, frame) {
    var m = findComponent(tc, ['Motion', 'AE.ADBE Motion']), pos, sc, cur, normalized;
    if (!m) { log('No Motion on ' + tc.name); return; }
    pos = findProp(m, ['Position', 'ADBE Position'], 0);
    sc = findProp(m, ['Scale', 'ADBE Scale'], 1);
    if (pos && c.cx !== undefined) {
      cur = pos.getValue();
      normalized = cur && cur.length > 1 && cur[0] <= 1.5 && cur[1] <= 1.5;
      pos.setValue(normalized ? [c.cx / frame.w, c.cy / frame.h] : [c.cx, c.cy], true);
    }
    if (sc && c.scale !== undefined) sc.setValue(c.scale, true);
  }

  function setVolume(tc, db) {
    var v = findComponent(tc, ['Volume', 'audioVolume', 'ADBE Volume']), lvl;
    if (!v) return;
    lvl = findProp(v, ['Level', 'ADBE Volume Level'], 1);
    if (lvl) lvl.setValue(Math.pow(10, (db - 15) / 20), true);
  }

  // QE effects (unofficial, may fail silently: nothing exact depends on them)
  function qeAddEffect(seq, trackIdx, startTicks, effectName, tpf) {
    try {
      var qs = qeSeq(seq), tr, i, it, eff;
      if (!qs) return false;
      tr = qs.getVideoTrackAt(trackIdx);
      eff = qe.project.getVideoEffectByName(effectName);
      if (!tr || !eff) return false;
      for (i = 0; i < tr.numItems; i++) {
        it = tr.getItemAt(i);
        if (!it || it.type === 'Empty') continue;
        if (Math.abs(num(it.start.ticks) - num(startTicks)) <= tpf / 2) { it.addVideoEffect(eff); return true; }
      }
    } catch (e) { }
    return false;
  }
  function applyBlur(seq, tc, c, tpf) {
    if (!qeAddEffect(seq, 0, c.startTicks, 'Gaussian Blur', tpf)) return false;
    var comp = findComponent(tc, ['Gaussian Blur', 'AE.ADBE Gaussian Blur 2']), p;
    if (!comp) return false;
    p = findProp(comp, ['Blurriness'], 0); if (p) p.setValue(c.blur, true);
    p = findProp(comp, ['Repeat Edge Pixels'], 2); if (p) { try { p.setValue(true, true); } catch (e) { p.setValue(1, true); } }
    return true;
  }
  function applyCropTop(seq, tc, c, tpf) {
    if (!c.cropTopPct || c.cropTopPct < 0.5) return true;
    if (!qeAddEffect(seq, 0, c.startTicks, 'Crop', tpf)) return false;
    var comp = findComponent(tc, ['Crop', 'AE.ADBE AECrop']), p;
    if (!comp) return false;
    p = findProp(comp, ['Top'], 1); if (p) p.setValue(c.cropTopPct, true);
    return true;
  }

  // ------------------------------------------------------------------ placing + verifying cuts
  function clipAt(track, startTicks, tpf) {
    var j, tc;
    for (j = 0; j < track.clips.numItems; j++) {
      tc = track.clips[j];
      if (Math.abs(num(tc.start.ticks) - num(startTicks)) <= tpf / 2) return tc;
    }
    return null;
  }

  function verifyClip(tc, c, tpf, isStill) {
    var eS = num(c.startTicks), eDur = num(c.outTicks) - num(c.inTicks), eIn = num(c.inTicks);
    var aS = num(tc.start.ticks), aE = num(tc.end.ticks), aIn = num(tc.inPoint.ticks);
    var okStart = Math.abs(aS - eS) <= tpf / 2;
    var okDur = Math.abs((aE - aS) - eDur) <= tpf / 2;
    var okIn = isStill || Math.abs(aIn - eIn) <= tpf / 2;
    return okStart && okDur && okIn;
  }

  function correctClip(tc, c, isStill) {
    var eS = num(c.startTicks), eDur = num(c.outTicks) - num(c.inTicks);
    try {
      if (!isStill) tc.inPoint = makeTime(c.inTicks);
      tc.end = makeTime(eS + eDur);
      if (!isStill) tc.outPoint = makeTime(num(c.inTicks) + eDur);
    } catch (e) { log('Correction failed on ' + tc.name + ': ' + e.message); }
  }

  function placeClip(seq, track, item, c, tpf, stats, isStill) {
    setItemInOut(item, c.inTicks, c.outTicks, isStill);
    track.overwriteClip(item, secs(c.startTicks));
    var tc = clipAt(track, c.startTicks, tpf);
    if (!tc) { stats.failed++; log('Cut check: could not find ' + (c.label || item.name) + ' at ' + secs(c.startTicks).toFixed(2) + ' s'); return null; }
    if (verifyClip(tc, c, tpf, isStill)) stats.exact++;
    else {
      correctClip(tc, c, isStill);
      if (verifyClip(tc, c, tpf, isStill)) stats.corrected++;
      else {
        stats.failed++;
        log('Cut check: ' + (c.label || item.name) + ' expected ' + (eDurSec(c)).toFixed(3) + ' s, got ' + ((num(tc.end.ticks) - num(tc.start.ticks)) / TICKS).toFixed(3) + ' s');
      }
    }
    return tc;
  }
  function eDurSec(c) { return (num(c.outTicks) - num(c.inTicks)) / TICKS; }

  function trackIndex(name) { var n = parseInt(String(name).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n - 1; }

  function addMarker(seq, mk, colors) {
    try {
      var m = seq.markers.createMarker(num(mk.t));
      m.name = mk.name || '';
      m.comments = mk.comment || '';
      if (mk.dur && mk.dur > 0) m.end = num(mk.t) + num(mk.dur);
      var idx = colors[mk.color];
      if (idx !== undefined) { try { m.setColorByIndex(idx); } catch (e1) { try { m.setColorByIndex(idx, 0); } catch (e2) { } } }
    } catch (e) { log('Marker failed: ' + e.message); }
  }

  // ------------------------------------------------------------------ public: build timelines
  VEK.build = function (specJson) {
    try {
      var spec = parse(specJson), tpf = num(spec.ticksPerFrame), frame = spec.frame;
      if (!app.project) throw new Error('Open a Premiere project first.');
      var bin = getBin(spec.bin);
      // import (reuse anything already in the project, refresh files we re-rendered)
      var map = projectMap(), toImport = [], i, m;
      for (i = 0; i < spec.media.length; i++) {
        m = spec.media[i];
        if (map[normPath(m.path)]) { if (m.role !== 'footage') { try { map[normPath(m.path)].refreshMedia(); } catch (e0) { } } }
        else toImport.push(m.path);
      }
      if (toImport.length) {
        log('Importing ' + toImport.length + ' file(s) into bin "' + spec.bin + '"');
        app.project.importFiles(toImport, true, bin, false);
        map = projectMap();
      }
      var items = {}, missing = [];
      for (i = 0; i < spec.media.length; i++) {
        m = spec.media[i];
        items[m.id] = map[normPath(m.path)];
        if (!items[m.id]) missing.push(m.path);
      }
      if (missing.length) throw new Error('Premiere did not import: ' + missing.join(', '));

      var built = [], t, tl, seq, stats, c, track, tc, firstV1, k, fx = { blurOk: 0, blurFail: 0, cropOk: 0, cropFail: 0 };
      for (t = 0; t < spec.timelines.length; t++) {
        tl = spec.timelines[t];
        firstV1 = null;
        for (k = 0; k < tl.clips.length; k++) if (tl.clips[k].track === 'V1') { firstV1 = items[tl.clips[k].media]; break; }
        if (!firstV1) throw new Error(tl.name + ' has no speaker cuts');
        detectUnits(firstV1);
        seq = makeSequence(tl.name, firstV1, bin, frame);
        ensureTracks(seq, 4, 2);
        stats = { exact: 0, corrected: 0, failed: 0 };
        // V1 first (in timeline order), then V2..V4 so overlays sit above
        var order = ['V1', 'V2', 'V3', 'V4'], o;
        for (o = 0; o < order.length; o++) {
          for (k = 0; k < tl.clips.length; k++) {
            c = tl.clips[k];
            if (c.track !== order[o]) continue;
            var ti = Math.min(trackIndex(c.track), seq.videoTracks.numTracks - 1);
            track = seq.videoTracks[ti];
            tc = placeClip(seq, track, items[c.media], c, tpf, stats, c.kind === 'image');
            if (!tc) continue;
            setMotion(tc, c, frame);
            if (c.blur) { if (applyBlur(seq, tc, c, tpf)) fx.blurOk++; else fx.blurFail++; }
            if (c.cropTopPct) { if (applyCropTop(seq, tc, c, tpf)) fx.cropOk++; else fx.cropFail++; }
          }
        }
        for (k = 0; k < tl.audio.length; k++) {
          c = tl.audio[k];
          var ai = Math.min(trackIndex(c.track), seq.audioTracks.numTracks - 1);
          tc = placeClip(seq, seq.audioTracks[ai], items[c.media], c, tpf, stats, false);
          if (tc && c.levelDb !== undefined) setVolume(tc, c.levelDb);
        }
        for (k = 0; k < spec.media.length; k++) clearItemInOut(items[spec.media[k].id]);
        for (k = 0; k < tl.markers.length; k++) addMarker(seq, tl.markers[k], spec.colors);
        log(tl.name + ': Cut check: ' + stats.exact + ' exact' + (stats.corrected ? ', ' + stats.corrected + ' corrected' : '') + (stats.failed ? ', ' + stats.failed + ' FAILED' : ''));
        built.push({ name: tl.name, exact: stats.exact, corrected: stats.corrected, failed: stats.failed });
      }
      if (fx.blurFail || fx.cropFail) log('QE effects: ' + fx.blurOk + ' blur and ' + fx.cropOk + ' crop applied; ' + (fx.blurFail + fx.cropFail) + ' could not be applied (add Gaussian Blur / Crop by hand where needed; framing is unaffected).');
      return result({ ok: true, timelines: built, units: UNITS });
    } catch (e) { return fail(e); }
  };

  // ------------------------------------------------------------------ public: exports via Adobe Media Encoder
  function findPreset() {
    var apps = Folder('/Applications').getFiles(), i, j, f, sys, sub, files, candidates = [];
    for (i = 0; i < apps.length; i++) {
      if (!(apps[i] instanceof Folder) || !/Adobe (Media Encoder|Premiere Pro)/.test(apps[i].name)) continue;
      sub = apps[i].getFiles();
      for (j = 0; j < sub.length; j++) {
        if (!/\.app$/.test(sub[j].name)) continue;
        sys = Folder(sub[j].fsName + '/Contents/MediaIO/systempresets/4E49434B_48323634');
        if (!sys.exists) continue;
        files = sys.getFiles('*.epr');
        for (f = 0; f < files.length; f++) {
          if (/Match Source.*High bitrate/i.test(decodeURI(files[f].name))) candidates.unshift(files[f].fsName);
          else if (/Match Source/i.test(decodeURI(files[f].name))) candidates.push(files[f].fsName);
        }
      }
    }
    return candidates.length ? candidates[0] : '';
  }

  var SEQ_UNITS = null;
  function setSeqInOut(seq, inTicks, outTicks) {
    if (!SEQ_UNITS) {
      try { seq.setInPoint(2); SEQ_UNITS = Math.abs(num(seq.getInPoint()) - 2) < 0.01 ? 'seconds' : 'ticks'; } catch (e) { SEQ_UNITS = 'ticks'; }
    }
    if (SEQ_UNITS === 'seconds') { seq.setInPoint(secs(inTicks)); seq.setOutPoint(secs(outTicks)); }
    else { seq.setInPoint(String(Math.round(num(inTicks)))); seq.setOutPoint(String(Math.round(num(outTicks)))); }
  }

  VEK.exportAll = function (specJson) {
    try {
      var spec = parse(specJson), preset = spec.presetPath || findPreset(), i, e, seq, wa, queued = [];
      if (!preset) throw new Error('Could not find the H.264 "Match Source - High bitrate" preset. Set its .epr path in Settings → Export preset.');
      app.encoder.launchEncoder();
      var IN_OUT = (app.encoder.ENCODE_IN_TO_OUT !== undefined) ? app.encoder.ENCODE_IN_TO_OUT : 1;
      var ENTIRE = (app.encoder.ENCODE_ENTIRE !== undefined) ? app.encoder.ENCODE_ENTIRE : 0;
      for (i = 0; i < spec.exports.length; i++) {
        e = spec.exports[i];
        seq = findSequence(e.timeline);
        if (!seq) { log('Export skipped, no sequence ' + e.timeline); continue; }
        if (e.mode === 'in_out') { setSeqInOut(seq, e.inTicks, e.outTicks); wa = IN_OUT; } else wa = ENTIRE;
        var id = app.encoder.encodeSequence(seq, e.file, preset, wa, 1);
        queued.push({ file: e.file, job: String(id) });
        log('Queued ' + e.file.replace(/^.*[\/\\]/, ''));
      }
      if (spec.autoStartQueue) app.encoder.startBatch();
      return result({ ok: true, queued: queued, preset: preset });
    } catch (err) { return fail(err); }
  };
})();
