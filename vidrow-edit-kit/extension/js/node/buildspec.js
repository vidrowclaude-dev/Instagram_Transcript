'use strict';
// Plan → build spec: exact cuts, timelines (one per hook: Hook N + Body), overlays, callouts, markers,
// music and exports. Everything that must be exact is resolved here so host.jsx only places things.
const fs = require('fs');
const path = require('path');
const { cutSegment } = require('./cuts');
const { tokens, norm, coverage, looseKey } = require('./text');
const framing = require('./framing');
const media = require('./media');
const { fileKey, hash, mkdirp, safeName } = require('./util');

const TICKS = 254016000000;
const SECTIONS = ['H1', 'H2', 'H3', 'BODY'];
const COLORS = { green: 0, red: 1, purple: 2, orange: 3, yellow: 4, white: 5, blue: 6, cyan: 7 };

function parseRef(ref) {
  const m = String(ref || '').match(/^(H[123]|BODY)\s*[.#:]\s*(\d+)$/i);
  return m ? { section: m[1].toUpperCase(), index: Number(m[2]) } : null;
}

// Validate + normalise Claude's plan against the job. Returns {plan, warnings}.
function validatePlan(plan, job) {
  const warnings = [];
  const clips = new Map(job.footage.map((f) => [f.id, f]));
  const out = { sections: {}, overlays: [], callouts: [], links: [], editor_notes: [], music: plan.music || {}, faces: plan.faces || [], summary: plan.summary || '' };
  for (const s of SECTIONS) out.sections[s] = [];
  for (const sec of plan.sections || []) {
    const name = String(sec.name || '').toUpperCase();
    if (!out.sections[name]) { warnings.push(`Unknown section "${sec.name}" ignored.`); continue; }
    (sec.segments || []).forEach((seg, i) => {
      const f = clips.get(seg.clip);
      if (!f) { warnings.push(`${name}.${i}: unknown clip ${seg.clip}, skipped.`); out.sections[name].push(null); return; }
      const ids = new Set(f.lines.map((l) => l.id));
      if (!ids.has(Number(seg.from_line)) || !ids.has(Number(seg.to_line))) {
        warnings.push(`${name}.${i}: lines L${seg.from_line}–L${seg.to_line} not in ${seg.clip}, skipped.`); out.sections[name].push(null); return;
      }
      out.sections[name].push(Object.assign({}, seg, { from_line: Number(seg.from_line), to_line: Number(seg.to_line) }));
    });
  }
  const assetIds = new Set(job.assets.map((a) => a.id));
  for (const o of plan.overlays || []) {
    if (!assetIds.has(o.asset)) { warnings.push(`Overlay asset ${o.asset} unknown, skipped.`); continue; }
    if (!parseRef(o.segment)) { warnings.push(`Overlay ${o.asset}: bad segment ref "${o.segment}", skipped.`); continue; }
    out.overlays.push(o);
  }
  for (const c of plan.callouts || []) if (c.text && parseRef(c.segment)) out.callouts.push(c);
  for (const l of plan.links || []) out.links.push(l);
  for (const n of plan.editor_notes || []) if (n.note) out.editor_notes.push(n);
  return { plan: out, warnings };
}

function scriptCoverageWarnings(job, sectionTexts) {
  const warns = [];
  for (const s of SECTIONS) {
    const lines = job.script.sections[s] || [];
    if (!lines.length) continue;
    const have = new Set(tokens(sectionTexts[s] || ''));
    for (const l of lines) {
      const cov = coverage(l.text, have);
      if (cov < 0.5) warns.push(`Script line not covered: ${s} #${l.idx + 1} "${l.text.slice(0, 70)}" (${Math.round(cov * 100)}% of its words found in the cut)`);
    }
  }
  return warns;
}

// Most common fps among video footage
function sequenceFps(footage) {
  const counts = {};
  for (const f of footage) if (f.info.fps) { const k = f.info.fps.toFixed(3); counts[k] = (counts[k] || 0) + 1; }
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return best ? Number(best) : 30;
}

function nameMatchers(clientName) {
  const toks = tokens(clientName).filter((t) => t.length >= 3);
  const keys = toks.map(looseKey).filter((k) => k.length >= 2);
  const appWords = new Set(['app', 'apps', 'application', 'ऐप', 'एप', 'ऍप', 'एप्प', 'ऐप्प']);
  return (w) => {
    const n = norm(w);
    if (!n) return false;
    if (appWords.has(n)) return true;
    const k = looseKey(n);
    return keys.some((key) => k === key || (key.length >= 4 && k.startsWith(key)));
  };
}

/**
 * @param job  {jobName, client, footage:[{id,path,info,words,lines,silences,faces}], assets:[{id,path,info,transparent,appScreen}],
 *              script, aspect, appScreens, calloutStyle, musicCfg, music:{list}, brief, format, jobDir}
 * @param rawPlan Claude's plan
 * @param env  {renderCallout(opts)→path, renderPhone(opts)→path, log}
 */
async function buildSpec(job, rawPlan, env) {
  const log = env.log;
  const { plan, warnings } = validatePlan(rawPlan, job);
  warnings.forEach((w) => log.warn(w));
  const frame = Object.assign({}, framing.aspectFrame(job.aspect));
  const fps = sequenceFps(job.footage);
  const tpf = Math.round(TICKS / fps);
  const F = (sec) => Math.round(sec * fps);              // seconds → frames
  const T = (frames) => String(frames * tpf);            // frames → ticks string
  const S = (frames) => frames / fps;                    // frames → seconds
  const fmt = job.format;
  const keepPausesDefault = fmt.pause_cut_seconds == null;
  const scriptText = ['H1', 'H2', 'H3', 'BODY'].map((s) => job.script.sections[s].map((l) => l.text).join(' ')).join(' ');
  const scriptTokens = new Set(tokens(scriptText));
  const scriptNorm = tokens(scriptText).join(' ');
  const clips = new Map(job.footage.map((f) => [f.id, f]));
  const assets = new Map(job.assets.map((a) => [a.id, a]));
  const rendersDir = mkdirp(path.join(job.jobDir, 'Renders'));
  const base = `${safeName(job.client.name, 'Client')}_${safeName(job.jobName, 'Ad')}`;

  // ---- 1. cut every segment
  const sectionPieces = {}; const sectionTexts = {};
  const dropTotals = { filler: 0, director: 0, edge: 0 };
  for (const s of SECTIONS) {
    sectionPieces[s] = []; const texts = [];
    plan.sections[s].forEach((seg, i) => {
      if (!seg) return;
      const f = clips.get(seg.clip);
      const r = cutSegment({ words: f.words, lines: f.lines, silences: f.silences, scriptTokens, scriptText: scriptNorm, fps, keepPausesDefault }, seg);
      r.warnings.forEach((w) => log.warn(`${s}.${i}: ${w}`));
      for (const k of Object.keys(dropTotals)) dropTotals[k] += r.dropped[k];
      texts.push(r.text);
      r.pieces.forEach((p, pi) => sectionPieces[s].push({ ref: `${s}.${i}`, first: pi === 0, seg, clip: f, srcIn: p.srcIn, srcOut: p.srcOut, words: p.words }));
    });
    sectionTexts[s] = texts.join(' ');
  }
  log(`Cuts: removed ${dropTotals.filler} filler words, ${dropTotals.director} director words, ${dropTotals.edge} off-script edge words.`);
  const coverWarn = scriptCoverageWarnings(job, sectionTexts);
  coverWarn.forEach((w) => log.warn(w));

  const hooks = ['H1', 'H2', 'H3'].filter((h) => sectionPieces[h].length);
  if (!sectionPieces.BODY.length) throw new Error('The plan has no usable BODY segments; nothing to build.');
  if (!hooks.length) log.warn('No hook sections in the plan; building a single Body timeline.');

  const mediaList = new Map(); // path → {id, path, kind}
  const addMedia = (p, kind, role) => {
    if (!mediaList.has(p)) mediaList.set(p, { id: 'm' + (mediaList.size + 1), path: p, kind, role });
    return mediaList.get(p).id;
  };
  const renderCache = new Map();
  const bandRect = framing.splitBand(frame);
  const phone = framing.phoneGeometry(frame);

  async function renderOverlay(o, durSec) {
    const a = assets.get(o.asset);
    const info = a.info;
    const isApp = !a.transparent && (a.appScreen || o.asset_type === 'app_screen');
    let mode;
    if (a.transparent) mode = 'graphic';
    else if (isApp) mode = job.appScreens; // full | phone | split
    else mode = ({ fullscreen: 'full', split: 'split', top_half: 'split', phone: 'phone', center_card: 'card', pip_top_right: 'pip' })[o.layout] || 'full';
    if (mode === 'split' && a.transparent) mode = 'graphic';
    const focusY = o.focus_y == null ? 0.5 : Math.max(0, Math.min(1, Number(o.focus_y)));
    const srcStart = info.kind === 'video' ? Math.max(0, Number(o.src_start) || 0) : 0;
    const key = hash(fileKey(a.path), mode, focusY.toFixed(2), frame, info.kind === 'video' ? [srcStart.toFixed(2), durSec.toFixed(2)] : '');
    if (renderCache.has(key)) return renderCache.get(key);
    const outBase = path.join(rendersDir, `${safeName(path.parse(a.path).name).slice(0, 40)}_${mode}_${key.slice(0, 8)}`);
    const vopts = info.kind === 'video' ? { srcStart, duration: durSec } : {};
    let r;
    const existing = ['.png', '.mp4', '.mov'].map((e) => outBase + e).find((p) => fs.existsSync(p));
    if (mode === 'graphic') {
      const ar = info.width / info.height, far = frame.w / frame.h;
      const full = Math.abs(ar - far) / far < 0.06;
      const rect = full ? { x: 0, y: 0, w: frame.w, h: frame.h } : framing.graphicRect(frame);
      const p = existing || (await media.renderOnCanvas(a.path, info, frame, rect, outBase, Object.assign({ alignTop: !full }, vopts))).path;
      r = { layers: [{ track: 'V3', path: p }], v1: null };
    } else if (mode === 'split') {
      const p = existing || await media.renderCover(a.path, info, bandRect.top.w, bandRect.top.h, focusY, outBase, vopts);
      r = { layers: [{ track: 'V2', path: p, cx: frame.w / 2, cy: bandRect.top.h / 2 }], v1: 'split' };
    } else if (mode === 'full') {
      const p = existing || await media.renderCover(a.path, info, frame.w, frame.h, focusY, outBase, vopts);
      r = { layers: [{ track: 'V2', path: p }], v1: null };
    } else if (mode === 'card' || mode === 'pip') {
      const rect = framing.layoutRect(mode === 'card' ? 'center_card' : 'pip_top_right', frame);
      const p = existing || (await media.renderOnCanvas(a.path, info, frame, rect, outBase, vopts)).path;
      r = { layers: [{ track: 'V2', path: p }], v1: null };
    } else { // phone
      if (info.kind === 'image') {
        const p = existing || await env.renderPhone({ screenshot: a.path, out: outBase + '.png', frame, geometry: phone, focusY });
        r = { layers: [{ track: 'V2', path: p }], v1: 'phone' };
      } else {
        const rec = existing || (await media.renderOnCanvas(a.path, info, frame, phone.hole, outBase, Object.assign({ cover: true, focusY }, vopts))).path;
        const framePng = path.join(rendersDir, `phone_frame_${frame.w}x${frame.h}.png`);
        if (!fs.existsSync(framePng)) await env.renderPhone({ screenshot: null, out: framePng, frame, geometry: phone });
        r = { layers: [{ track: 'V2', path: rec }, { track: 'V3', path: framePng }], v1: 'phone' };
      }
    }
    r.mode = mode; r.asset = a;
    renderCache.set(key, r);
    return r;
  }

  const calloutCache = new Map();
  async function renderCallout(text) {
    if (calloutCache.has(text)) return calloutCache.get(text);
    const out = path.join(rendersDir, `callout_${hash(text, job.calloutStyle, frame, job.client.brandColor || '')}.png`);
    if (!fs.existsSync(out)) await env.renderCallout({ text, style: job.calloutStyle, brandColor: job.client.brandColor, out, frame, topPct: 0.15 });
    calloutCache.set(text, out);
    return out;
  }

  const matchesName = nameMatchers(job.client.name || '');
  const musicById = new Map((job.music.list || []).map((m) => [m.id, m]));
  const timelines = [];
  const timelineDefs = hooks.length ? hooks.map((h) => ({ hook: h, name: `${base}_${h}`, sections: [h, 'BODY'] })) : [{ hook: null, name: `${base}_Body`, sections: ['BODY'] }];

  for (const def of timelineDefs) {
    const tl = { name: def.name, hook: def.hook, clips: [], audio: [], markers: [], frame, fps, ticksPerFrame: tpf };
    // ---- 2. lay out V1 pieces in frames
    let cursor = 0;
    const pieces = [];
    const segStart = {}; // ref → frame
    let bodyStartF = 0;
    let zoomIdx = 0; let prev = null;
    const scales = fmt.punch_ins.enabled ? fmt.punch_ins.scales : [1, 1];
    for (const s of def.sections) {
      if (s === 'BODY') bodyStartF = cursor;
      for (const p of sectionPieces[s]) {
        const inF = F(p.srcIn), outF = F(p.srcOut);
        const len = outF - inF;
        if (len <= 0) continue;
        // punch-in on jumps within the same take (abrupt cut), unless Claude set a zoom
        if (prev && prev.clip.id === p.clip.id && fmt.punch_ins.enabled) {
          const jump = Math.abs(inF - prev.outF) > 0;
          if (jump) zoomIdx = 1 - zoomIdx;
        } else if (prev && prev.clip.id !== p.clip.id) zoomIdx = 0;
        const zoom = p.seg.zoom ? Number(p.seg.zoom) : scales[zoomIdx];
        if (segStart[p.ref] == null) segStart[p.ref] = cursor;
        pieces.push(Object.assign({}, p, { startF: cursor, endF: cursor + len, inF, outF, zoom }));
        cursor += len; prev = pieces[pieces.length - 1];
      }
    }
    const endF = cursor;
    tl.durationTicks = T(endF); tl.duration = S(endF);
    tl.bodyStart = S(bodyStartF); tl.bodyStartTicks = T(bodyStartF);
    const refStart = (ref) => (segStart[ref] != null ? segStart[ref] : null);

    // ---- 3. overlays
    const v1Windows = []; // {startF,endF,mode}
    const overlaysHere = plan.overlays.concat(
      (plan.links || []).filter((l) => l.asset && assets.has(l.asset) && !plan.overlays.some((o) => o.asset === l.asset))
        .map((l) => ({ asset: l.asset, segment: l.segment, offset: l.offset || 0, duration: 2, asset_type: 'screenshot', layout: 'fullscreen' })));
    let firstAppScreenF = null;
    for (const o of overlaysHere) {
      const ref = parseRef(o.segment);
      if (!ref || !def.sections.includes(ref.section)) continue;
      const st = refStart(`${ref.section}.${ref.index}`);
      if (st == null) { log.warn(`${def.name}: overlay ${o.asset} refers to ${o.segment}, which has no cut; skipped.`); continue; }
      let s0 = st + F(Math.max(0, Number(o.offset) || 0));
      let dur = Math.max(F(1.5), F(Number(o.duration) || 2));
      if (s0 >= endF) s0 = Math.max(0, endF - dur);
      const e0 = Math.min(endF, s0 + dur);
      if (e0 - s0 < 2) continue;
      const r = await renderOverlay(o, S(e0 - s0));
      for (const L of r.layers) {
        const kind = media.kindOf(L.path) === 'image' ? 'image' : 'video';
        tl.clips.push({ track: L.track, media: addMedia(L.path, kind, 'overlay'), path: L.path, kind, startTicks: T(s0), endTicks: T(e0), inTicks: '0', outTicks: T(e0 - s0),
          start: S(s0), end: S(e0), scale: 100, cx: L.cx != null ? L.cx : frame.w / 2, cy: L.cy != null ? L.cy : frame.h / 2, label: `${o.asset} ${r.mode}` });
      }
      if (r.v1) v1Windows.push({ startF: s0, endF: e0, mode: r.v1 });
      if ((r.asset.appScreen || o.asset_type === 'app_screen') && (firstAppScreenF == null || s0 < firstAppScreenF)) firstAppScreenF = s0;
    }

    // ---- 4. V1 clips, split at overlay windows, framed per window
    for (const p of pieces) {
      const cuts = new Set([p.startF, p.endF]);
      for (const w of v1Windows) { if (w.startF > p.startF && w.startF < p.endF) cuts.add(w.startF); if (w.endF > p.startF && w.endF < p.endF) cuts.add(w.endF); }
      const pts = [...cuts].sort((a, b) => a - b);
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const mid = (a + b) / 2;
        const win = v1Windows.find((w) => mid >= w.startF && mid < w.endF);
        const mode = win ? win.mode : null;
        const visible = mode === 'split' ? bandRect.bottom : { x: 0, y: 0, w: frame.w, h: frame.h };
        const fr = framing.frameFootage({ w: p.clip.info.width, h: p.clip.info.height }, frame, visible, p.clip.faces, p.zoom);
        const inF = p.inF + (a - p.startF);
        tl.clips.push({ track: 'V1', media: addMedia(p.clip.path, 'video', 'footage'), path: p.clip.path, kind: 'video', linkedAudio: true,
          startTicks: T(a), endTicks: T(b), inTicks: T(inF), outTicks: T(inF + (b - a)), start: S(a), end: S(b), srcIn: S(inF), srcOut: S(inF + b - a),
          scale: fr.scale, cx: fr.cx, cy: fr.cy, blur: mode === 'phone' ? 60 : 0, cropTopPct: mode === 'split' ? fr.cropTopPct : 0,
          fit: fr.fit, label: `${p.clip.id} ${p.ref}` });
      }
    }

    // ---- 5. callouts (V4) + markers
    for (const c of plan.callouts) {
      const ref = parseRef(c.segment);
      if (!ref || !def.sections.includes(ref.section)) continue;
      const st = refStart(`${ref.section}.${ref.index}`); if (st == null) continue;
      const s0 = Math.min(Math.max(0, endF - F(1.5)), st + F(Math.max(0, Number(c.offset) || 0)));
      const e0 = Math.min(endF, s0 + Math.max(F(1.5), F(Number(c.duration) || 3)));
      const png = await renderCallout(c.text);
      tl.clips.push({ track: 'V4', media: addMedia(png, 'image', 'callout'), path: png, kind: 'image', startTicks: T(s0), endTicks: T(e0), inTicks: '0', outTicks: T(e0 - s0), start: S(s0), end: S(e0), scale: 100, cx: frame.w / 2, cy: frame.h / 2, label: 'callout' });
      tl.markers.push({ t: S(s0), ticks: T(s0), dur: S(e0 - s0), name: `CALLOUT: ${c.text}`, comment: c.text, color: 'orange' });
    }
    // green: script lines (one per segment)
    const seenRefs = new Set();
    for (const p of pieces) {
      if (seenRefs.has(p.ref)) continue; seenRefs.add(p.ref);
      const label = p.seg.script_line || p.words.map((w) => w.w).join(' ');
      tl.markers.push({ t: S(p.startF), ticks: T(p.startF), dur: 0, name: label.slice(0, 80), comment: `${p.ref} · ${p.clip.id} L${p.seg.from_line}–L${p.seg.to_line}`, color: 'green' });
    }
    if (def.hook) tl.markers.push({ t: S(bodyStartF), ticks: T(bodyStartF), dur: 0, name: 'BODY STARTS', comment: `${def.hook} ends here; Body starts`, color: 'red' });
    // purple: links without a screenshot
    for (const l of job.script.links) {
      if (!def.sections.includes(l.section)) continue;
      const claude = (plan.links || []).find((x) => x.url === l.url);
      if (claude && claude.asset && assets.has(claude.asset)) continue;
      const ref = claude && parseRef(claude.segment);
      let at = ref ? refStart(`${ref.section}.${ref.index}`) : null;
      if (at == null) at = l.section === 'BODY' ? bodyStartF : 0;
      tl.markers.push({ t: S(at), ticks: T(at), dur: 0, name: `SCREENSHOT NEEDED: ${l.url}`, comment: l.url, color: 'purple' });
    }
    // purple: editor notes
    for (const n of plan.editor_notes) {
      const ref = parseRef(n.segment);
      if (ref && !def.sections.includes(ref.section)) continue;
      let at = ref ? refStart(`${ref.section}.${ref.index}`) : 0;
      if (at == null) at = 0;
      at = Math.min(endF, at + F(Math.max(0, Number(n.offset) || 0)));
      tl.markers.push({ t: S(at), ticks: T(at), dur: 0, name: `${(n.kind || 'todo').toUpperCase()}: ${n.note}`.slice(0, 120), comment: n.note, color: 'purple' });
    }
    if (fmt.id === 'skit' && !job.script.callouts.length) tl.markers.push({ t: 0, ticks: '0', dur: 0, name: 'CALLOUT NEEDED: skits always have a callout (ask the Post Production Manager)', comment: '', color: 'purple' });

    // ---- 6. music (A2)
    const mcfg = job.musicCfg || {};
    const want1 = mcfg.track1 && mcfg.track1 !== 'None';
    const want2 = mcfg.track2 && mcfg.track2 !== 'None';
    const t1 = want1 && plan.music.asset && musicById.get(plan.music.asset) ? musicById.get(plan.music.asset) : (want1 ? (job.music.list || []).find((m) => m.genre === mcfg.track1) : null);
    let t2 = want2 && plan.music.switch_asset && musicById.get(plan.music.switch_asset) ? musicById.get(plan.music.switch_asset) : (want2 ? (job.music.list || []).find((m) => m.genre === mcfg.track2 && (!t1 || m.id !== t1.id)) : null);
    if (t1 && t2 && t1.id === t2.id) t2 = (job.music.list || []).find((m) => m.genre === mcfg.track2 && m.id !== t1.id) || null;
    tl.musicPlan = null;
    if (t1 || t2) {
      let startF = 0;
      if (mcfg.start === 'body') startF = bodyStartF;
      else if (mcfg.start === 'custom') startF = Math.min(endF, F(Number(mcfg.startSec) || 0));
      let switchF = null, why = '';
      if (t1 && t2) {
        // first spoken mention of the app/client name (or "app")
        for (const p of pieces) {
          const w = p.words.find((x) => matchesName(x.w) && x.s >= p.srcIn - 0.01);
          if (w) { switchF = p.startF + F(Math.max(0, w.s - p.srcIn)); why = `first mention "${w.w}"`; break; }
        }
        if (switchF != null) {
          // snap to the nearest cut within 0.8 s
          let best = null;
          for (const p of pieces) for (const c of [p.startF, p.endF]) { const d = Math.abs(c - switchF); if (d <= F(0.8) && (best == null || d < Math.abs(best - switchF))) best = c; }
          if (best != null) switchF = best;
        } else {
          const ref = parseRef(plan.music.switch_segment);
          const st = ref && def.sections.includes(ref.section) ? refStart(`${ref.section}.${ref.index}`) : null;
          if (st != null) { switchF = st + F(Math.max(0, Number(plan.music.switch_offset) || 0)); why = `Claude's switch point ${plan.music.switch_segment}`; }
          else if (firstAppScreenF != null) { switchF = firstAppScreenF; why = 'first app screen'; }
        }
        if (switchF != null && switchF <= Math.max(startF, F(0.5))) { switchF = startF; why += ' (app named immediately: Track 2 plays from the start)'; }
      }
      tl.musicPlan = { t1, t2, startF, switchF, why, level: Number(mcfg.level != null ? mcfg.level : (fmt.music.level_db || -20)), offset: Number(plan.music.start) || 0 };
      tl.musicSwitch = switchF != null ? S(switchF) : null;
      if (t1 && t2) log(`${def.name}: music switches to Track 2 at ${switchF != null ? S(switchF).toFixed(2) + ' s (' + why + ')' : 'never (no app mention, no switch point, no app screen) — Track 1 runs throughout'}.`);
      if (switchF != null) tl.markers.push({ t: S(switchF), ticks: T(switchF), dur: 0, name: 'MUSIC: Track 2', comment: why, color: 'purple' });
    }
    tl.pieces = pieces.map((p) => ({ ref: p.ref, clip: p.clip.id, start: S(p.startF), end: S(p.endF), srcIn: S(p.inF), srcOut: S(p.outF), zoom: p.zoom, text: p.words.map((w) => w.w).join(' ') }));
    timelines.push(tl);
  }

  return { base, frame, fps, tpf, timelines, mediaList, addMedia, plan, warnings: warnings.concat(coverWarn), F, T, S };
}

// Music needs local files + durations: resolve after Claude's picks.
async function addMusic(spec, fetchTrack, log) {
  const { T } = spec;
  const fetched = new Map();
  const get = async (m) => {
    if (!fetched.has(m.id)) {
      const p = await fetchTrack(m);
      const info = await media.probe(p);
      fetched.set(m.id, { path: p, duration: info.duration });
    }
    return fetched.get(m.id);
  };
  for (const tl of spec.timelines) {
    const mp = tl.musicPlan; if (!mp) continue;
    const endF = Math.round(tl.duration * spec.fps);
    const place = async (m, fromF, toF, offsetSec) => {
      if (!m || toF - fromF < 2) return;
      const f = await get(m);
      const id = spec.addMedia(f.path, 'audio', 'music');
      let cur = fromF; let off = Math.min(offsetSec || 0, Math.max(0, f.duration - 1));
      while (cur < toF) {
        const avail = Math.floor((f.duration - off) * spec.fps);
        if (avail < 2) break;
        const len = Math.min(avail, toF - cur);
        const inF = Math.round(off * spec.fps);
        tl.audio.push({ track: 'A2', media: id, path: f.path, kind: 'audio', startTicks: T(cur), endTicks: T(cur + len), inTicks: T(inF), outTicks: T(inF + len), start: cur / spec.fps, end: (cur + len) / spec.fps, levelDb: mp.level, label: m.relPath });
        cur += len; off = 0; // loop from the top if the track is shorter
      }
    };
    if (mp.t1 && mp.switchF != null && mp.t2) {
      await place(mp.t1, mp.startF, mp.switchF, mp.offset);
      await place(mp.t2, mp.switchF, endF, 0);
    } else if (mp.t1) await place(mp.t1, mp.startF, endF, mp.offset);
    else if (mp.t2) await place(mp.t2, mp.startF, endF, 0);
  }
}

function exportsFor(spec, deliver, exportsDir) {
  const suffix = spec.frame.suffix || '';
  const out = [];
  if (deliver === 'stitched') {
    for (const tl of spec.timelines) out.push({ timeline: tl.name, file: path.join(exportsDir, `${tl.name}${tl.hook ? '_Body' : ''}${suffix}.mp4`), mode: 'entire' });
  } else {
    for (const tl of spec.timelines) {
      if (tl.hook) out.push({ timeline: tl.name, file: path.join(exportsDir, `${tl.name}${suffix}.mp4`), mode: 'in_out', inTicks: '0', outTicks: tl.bodyStartTicks, in: 0, out: tl.bodyStart });
    }
    const first = spec.timelines[0];
    out.push({ timeline: first.name, file: path.join(exportsDir, `${spec.base}_Body${suffix}.mp4`), mode: first.hook ? 'in_out' : 'entire', inTicks: first.bodyStartTicks, outTicks: first.durationTicks, in: first.bodyStart, out: first.duration });
  }
  return out;
}

// Serialisable spec for host.jsx
function toHostSpec(spec, job, exportsList) {
  const mediaArr = [...spec.mediaList.values()];
  return {
    version: 1, job: job.jobName, base: spec.base, bin: `VEK · ${spec.base}`,
    frame: { w: spec.frame.w, h: spec.frame.h }, fps: spec.fps, ticksPerFrame: String(spec.tpf), ticksPerSecond: String(TICKS),
    colors: COLORS,
    media: mediaArr.map((m) => ({ id: m.id, path: m.path, kind: m.kind, role: m.role })),
    timelines: spec.timelines.map((tl) => ({
      name: tl.name, hook: tl.hook, duration: tl.duration, durationTicks: tl.durationTicks, bodyStart: tl.bodyStart, bodyStartTicks: tl.bodyStartTicks,
      clips: tl.clips.map(stripClip), audio: tl.audio.map(stripClip), markers: tl.markers,
    })),
    exports: exportsList || [],
    presetPath: job.presetPath || '',
  };
}
function stripClip(c) {
  const o = {};
  for (const k of ['track', 'media', 'kind', 'startTicks', 'endTicks', 'inTicks', 'outTicks', 'start', 'end', 'scale', 'cx', 'cy', 'blur', 'cropTopPct', 'levelDb', 'linkedAudio', 'label']) if (c[k] !== undefined) o[k] = c[k];
  return o;
}

function summary(spec) {
  return spec.timelines.map((tl) => {
    const v1 = tl.clips.filter((c) => c.track === 'V1').length;
    const ov = tl.clips.filter((c) => c.track === 'V2' || c.track === 'V3').length;
    const co = tl.clips.filter((c) => c.track === 'V4').length;
    return { name: tl.name, duration: tl.duration, bodyStart: tl.bodyStart, cuts: v1, overlays: ov, callouts: co, music: tl.audio.length ? (tl.musicSwitch != null ? `switch at ${tl.musicSwitch.toFixed(1)} s` : 'one track') : 'none', markers: tl.markers.length };
  });
}

module.exports = { buildSpec, addMusic, exportsFor, toHostSpec, summary, validatePlan, parseRef, sequenceFps, nameMatchers, TICKS };
