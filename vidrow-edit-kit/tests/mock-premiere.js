'use strict';
// A small mock of Premiere Pro's ExtendScript DOM so host.jsx can run in Node via vm.
// Modes let tests reproduce real-world quirks: in/out units in seconds vs ticks, and
// overwriteClip ignoring the out point (so the cut check has to correct it).
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const TICKS = 254016000000;

function makeEnv(opts) {
  opts = Object.assign({ units: 'seconds', ignoreOutPoint: false, startTracks: { v: 3, a: 2 }, qeWorks: true, positionsNormalized: true }, opts || {});
  let nodeId = 1;
  const calls = { encode: [], startBatch: 0, imports: [], effects: [] };

  class Time {
    constructor() { this._ticks = '0'; }
    get ticks() { return this._ticks; }
    set ticks(v) { this._ticks = String(Math.round(Number(v))); }
    get seconds() { return Number(this._ticks) / TICKS; }
    set seconds(v) { this._ticks = String(Math.round(Number(v) * TICKS)); }
  }
  const T = (ticks) => { const t = new Time(); t.ticks = ticks; return t; };

  function collection(arr, countName) {
    const c = { _a: arr };
    Object.defineProperty(c, countName, { get: () => arr.length });
    return new Proxy(c, { get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) return arr[Number(k)]; return t[k]; } });
  }

  function makeProp(displayName, value) {
    return { displayName, matchName: displayName, _v: value, getValue() { return this._v; }, setValue(v) { this._v = v; } };
  }
  function makeComponent(displayName, props) {
    return { displayName, matchName: displayName, properties: collection(props, 'numItems') };
  }

  class ProjectItem {
    constructor(name, type, mediaPath, kind) {
      this.name = name; this.type = type; this.nodeId = String(nodeId++); this._path = mediaPath; this.kind = kind;
      this._children = []; this.children = collection(this._children, 'numItems');
      this._in = null; this._out = null; this.refreshed = 0;
      this._dur = kind === 'image' ? 5 * TICKS : 60 * TICKS;
      this.hasAudio = kind === 'video' && /take/.test(name);
    }
    getMediaPath() { return this._path || ''; }
    createBin(name) { const b = new ProjectItem(name, 2); this._children.push(b); return b; }
    _toTicks(v) { return opts.units === 'seconds' ? Math.round(Number(v) * TICKS) : Math.round(Number(v)); }
    setInPoint(v, mt) { if (this.kind === 'image' && opts.stillThrows) throw new Error('still'); this._in = this._toTicks(v); }
    setOutPoint(v, mt) { this._out = this._toTicks(v); }
    getInPoint() { return T(this._in || 0); }
    getOutPoint() { return T(this._out != null ? this._out : this._dur); }
    clearInPoint() { this._in = null; }
    clearOutPoint() { this._out = null; }
    refreshMedia() { this.refreshed++; }
  }

  class TrackItem {
    constructor(item, startTicks, inTicks, durTicks, track) {
      this.projectItem = item; this.name = item.name; this.track = track;
      this.start = T(startTicks); this.end = T(startTicks + durTicks); this.inPoint = T(inTicks); this.outPoint = T(inTicks + durTicks);
      const comps = [];
      if (track.isVideo) {
        comps.push(makeComponent('Opacity', [makeProp('Opacity', 100)]));
        comps.push(makeComponent('Motion', [makeProp('Position', opts.positionsNormalized ? [0.5, 0.5] : [540, 960]), makeProp('Scale', 100), makeProp('Scale Width', 100), makeProp('Uniform Scale', true), makeProp('Rotation', 0)]));
      } else comps.push(makeComponent('Volume', [makeProp('Bypass', false), makeProp('Level', 0.1778)]));
      this._comps = comps; this.components = collection(comps, 'numItems');
    }
    remove() { const a = this.track._clips; const i = a.indexOf(this); if (i >= 0) a.splice(i, 1); }
  }

  class Track {
    constructor(isVideo, idx, seq) { this.isVideo = isVideo; this.idx = idx; this.seq = seq; this._clips = []; this.clips = collection(this._clips, 'numItems'); }
    overwriteClip(item, timeSec) {
      const start = Math.round(Number(timeSec) * TICKS);
      const inT = item._in || 0;
      let dur = (item._out != null ? item._out : item._dur) - inT;
      if (opts.ignoreOutPoint && item.kind !== 'image') dur = item._dur - inT; // quirk: whole rest of clip
      this._overwrite(start, start + dur);
      const tc = new TrackItem(item, start, inT, dur, this);
      this._clips.push(tc); this._clips.sort((a, b) => Number(a.start.ticks) - Number(b.start.ticks));
      if (this.isVideo && item.hasAudio) {
        const at = this.seq._audio[this.idx] || this.seq._audio[0];
        at._overwrite(start, start + dur);
        at._clips.push(new TrackItem(item, start, inT, dur, at));
        at._clips.sort((a, b) => Number(a.start.ticks) - Number(b.start.ticks));
      }
      return true;
    }
    _overwrite(s, e) {
      for (const c of this._clips.slice()) {
        const cs = Number(c.start.ticks), ce = Number(c.end.ticks);
        if (ce <= s || cs >= e) continue;
        if (cs >= s && ce <= e) { c.remove(); continue; }
        if (cs < s) { c.end = T(s); c.outPoint = T(Number(c.inPoint.ticks) + (s - cs)); }
        else { const cut = e - cs; c.start = T(e); c.inPoint = T(Number(c.inPoint.ticks) + cut); }
      }
    }
  }

  class Sequence {
    constructor(name) {
      this.name = name; this.sequenceID = 'seq-' + (nodeId++);
      this._video = []; this._audio = [];
      for (let i = 0; i < opts.startTracks.v; i++) this._video.push(new Track(true, i, this));
      for (let i = 0; i < opts.startTracks.a; i++) this._audio.push(new Track(false, i, this));
      this.videoTracks = collection(this._video, 'numTracks'); this.audioTracks = collection(this._audio, 'numTracks');
      this._markers = [];
      this.markers = { createMarker: (t) => { const m = { start: Number(t), name: '', comments: '', end: Number(t), color: null, setColorByIndex(i) { this.color = i; } }; this._markers.push(m); return m; } };
      this._markers = this._markers; // keep reference
      const self = this;
      this.markers.createMarker = (t) => { const m = { start: Number(t), name: '', comments: '', end: Number(t), color: null, setColorByIndex(i) { this.color = i; } }; self._markers.push(m); return m; };
      this._settings = { videoFrameWidth: 1920, videoFrameHeight: 1080 };
      this._in = 0; this._out = 0;
    }
    getSettings() { return Object.assign({}, this._settings); }
    setSettings(s) { this._settings = Object.assign({}, s); }
    setInPoint(v) { this._in = typeof v === 'string' ? Number(v) / TICKS : Number(v); }
    setOutPoint(v) { this._out = typeof v === 'string' ? Number(v) / TICKS : Number(v); }
    getInPoint() { return String(this._in); }
    getOutPoint() { return String(this._out); }
  }

  const root = new ProjectItem('root', 3);
  const sequences = [];
  const project = {
    name: 'Mock.prproj', path: '/tmp/Mock.prproj', rootItem: root,
    sequences: collection(sequences, 'numSequences'),
    activeSequence: null,
    importFiles(paths, suppress, bin) {
      for (const p of paths) {
        const ext = path.extname(p).toLowerCase();
        const kind = ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : ['.mp3', '.wav', '.m4a'].includes(ext) ? 'audio' : 'video';
        if (!fs.existsSync(p)) continue;
        bin._children.push(new ProjectItem(path.basename(p), 1, p, kind));
        calls.imports.push(p);
      }
      return true;
    },
    createNewSequenceFromClips(name, items, bin) {
      const s = new Sequence(name);
      s._video[0].overwriteClip(items[0], 0);
      sequences.push(s);
      bin._children.push(Object.assign(new ProjectItem(name, 1), { isSequence: true }));
      return s;
    },
    openSequence(id) { project.activeSequence = sequences.find((s) => s.sequenceID === id); return true; },
  };

  const encoder = {
    ENCODE_ENTIRE: 0, ENCODE_IN_TO_OUT: 1,
    launchEncoder() { return true; },
    encodeSequence(seq, file, preset, wa, rm) { calls.encode.push({ seq: seq.name, file, preset, wa, in: seq._in, out: seq._out }); return 'job' + calls.encode.length; },
    startBatch() { calls.startBatch++; },
  };

  const app = {
    name: 'Premiere Pro (mock)', version: '25.0', project, encoder,
    getCurrentProjectViewSelection() { return root._children.filter((c) => c.type !== 2).slice(0, 2); },
    enableQE() { return true; },
  };

  const qe = {
    project: {
      getActiveSequence() {
        const s = project.activeSequence;
        if (!s) return null;
        return {
          addTracks(nv, vAfter, na) { if (!opts.qeWorks) throw new Error('QE broken'); for (let i = 0; i < nv; i++) s._video.push(new Track(true, s._video.length, s)); for (let i = 0; i < na; i++) s._audio.push(new Track(false, s._audio.length, s)); },
          getVideoTrackAt(i) {
            const tr = s._video[i];
            return { numItems: tr._clips.length, getItemAt(k) { const tc = tr._clips[k]; return { type: 'Clip', start: { ticks: tc.start.ticks }, addVideoEffect(e) {
              if (!opts.qeWorks) return; // silently does nothing, like the real QE DOM sometimes
              const props = e.name === 'Gaussian Blur' ? [makeProp('Blurriness', 0), makeProp('Blur Dimensions', 1), makeProp('Repeat Edge Pixels', false)] : [makeProp('Left', 0), makeProp('Top', 0), makeProp('Right', 0), makeProp('Bottom', 0)];
              tc._comps.push(makeComponent(e.name, props)); calls.effects.push(e.name);
            } }; } };
          },
        };
      },
      getVideoEffectByName(n) { return { name: n }; },
    },
  };

  function Folder() { return { exists: false, getFiles() { return []; } }; }

  const context = vm.createContext({ app, qe, Time, Folder, File: function () { return { exists: false }; }, $: { writeln() {} } });
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'jsx', 'host.jsx'), 'utf8');
  vm.runInContext(src, context, { filename: 'host.jsx' });

  return {
    app, qe, calls, project, root, sequences, TICKS,
    call(fnName, arg) {
      // mimic CSInterface.evalScript: the panel passes a JSON string literal
      const bridge = require('../extension/js/panel/bridge');
      const code = arg === undefined ? `VEK.${fnName}()` : `VEK.${fnName}(${bridge.toArg(arg)})`;
      return JSON.parse(vm.runInContext(code, context));
    },
    addProjectFile(p, binName) {
      let bin = root;
      if (binName) { bin = root._children.find((c) => c.name === binName) || root.createBin(binName); }
      const ext = path.extname(p).toLowerCase();
      bin._children.push(new ProjectItem(path.basename(p), 1, p, ['.png', '.jpg'].includes(ext) ? 'image' : 'video'));
    },
  };
}

module.exports = { makeEnv, TICKS };
