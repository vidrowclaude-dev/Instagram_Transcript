'use strict';
// Turn one plan segment (clip + transcript line range) into exact source cuts:
// snap to words → drop fillers/director talk → trim off-script edges → split at pauses → subtract measured
// silences → round to frames. Pure functions (unit-tested).
const { markFillers, scriptMatchRatio, norm } = require('./text');

const DEFAULTS = {
  pauseMin: 0.15,     // remove every pause >= 0.15 s inside a cut
  silencePad: 0.05,   // keep 0.05 s of each measured silence next to speech
  handle: 0.05,       // handle before first / after last syllable
  edgeMatch: 0.75,    // off-script edge trim only when take matches the script >= 75%
  edgeGap: 0.2,       // ...and a >= 0.2 s pause separates the off-script words
  minPiece: 0.1,
};

function wordRangeForSegment(lines, words, seg) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const a = byId.get(Number(seg.from_line));
  const b = byId.get(Number(seg.to_line != null ? seg.to_line : seg.from_line));
  if (!a || !b) return null;
  let i0 = Math.min(a.w0, b.w0), i1 = Math.max(a.w1, b.w1);
  // optional start/end inside the line range: snap to the nearest word boundary
  if (seg.start != null) {
    let best = i0, bd = Infinity;
    for (let i = i0; i <= i1; i++) { const d = Math.abs(words[i].s - seg.start); if (d < bd) { bd = d; best = i; } }
    i0 = best;
  }
  if (seg.end != null) {
    let best = i1, bd = Infinity;
    for (let i = i0; i <= i1; i++) { const d = Math.abs(words[i].e - seg.end); if (d < bd) { bd = d; best = i; } }
    i1 = best;
  }
  return [i0, i1];
}

// Subtract silences from [a,b]; returns list of ranges. internal=false only trims the ends.
function subtractSilences(range, silences, words, opts, internal) {
  let parts = [range.slice()];
  for (const [s0, s1] of silences) {
    const a = s0 + opts.silencePad, b = s1 - opts.silencePad;
    if (b - a <= 0 || (s1 - s0) < opts.pauseMin) continue;
    // never cut into a word Whisper heard clearly: skip a silence that covers the middle of a word
    const hitsWord = words.some((w) => {
      const m0 = w.s + (w.e - w.s) * 0.2, m1 = w.e - (w.e - w.s) * 0.2;
      return m1 > m0 && a < m1 && b > m0 && (Math.min(b, m1) - Math.max(a, m0)) > 0.6 * (m1 - m0);
    });
    if (hitsWord) continue;
    const next = [];
    for (const [p0, p1] of parts) {
      if (b <= p0 || a >= p1) { next.push([p0, p1]); continue; }
      const coversStart = a <= p0, coversEnd = b >= p1;
      if (coversStart && coversEnd) continue; // whole piece is silence
      if (coversStart) { next.push([b, p1]); continue; }
      if (coversEnd) { next.push([p0, a]); continue; }
      if (internal) { next.push([p0, a]); next.push([b, p1]); } else next.push([p0, p1]);
    }
    parts = next;
  }
  return parts;
}

function roundToFrames(t, fps) { return Math.round(t * fps) / fps; }

/**
 * @param ctx {words, lines, silences, scriptTokens, scriptText, fps, pauseMin, keepPausesDefault}
 * @param seg plan segment
 * @returns {pieces:[{srcIn,srcOut,words:[...]}], dropped:{filler:n,director:n,edge:n}, text, warnings}
 */
function cutSegment(ctx, seg) {
  const opts = Object.assign({}, DEFAULTS, ctx.opts || {});
  const words = ctx.words;
  const res = { pieces: [], dropped: { filler: 0, director: 0, edge: 0 }, text: '', warnings: [] };
  const range = wordRangeForSegment(ctx.lines, words, seg);
  if (!range) { res.warnings.push(`lines L${seg.from_line}–L${seg.to_line} not found in ${seg.clip}`); return res; }
  const keepPauses = seg.keep_pauses != null ? !!seg.keep_pauses : !!ctx.keepPausesDefault;
  let idx = [];
  for (let i = range[0]; i <= range[1]; i++) idx.push(i);
  const slice = idx.map((i) => words[i]);

  // 1. fillers + director talk
  const { drop, reason } = markFillers(slice, ctx.scriptTokens, ctx.scriptText);
  drop.forEach((d, k) => { if (d) res.dropped[reason[k] === 'director' ? 'director' : 'filler']++; });

  // 2. off-script words at the very start/end of the take (only when the take clearly matches the script)
  const keptK = [];
  for (let k = 0; k < slice.length; k++) if (!drop[k]) keptK.push(k);
  const keptWords = keptK.map((k) => slice[k]);
  if (keptWords.length >= 3 && scriptMatchRatio(keptWords, ctx.scriptTokens) >= opts.edgeMatch) {
    const inScript = (k) => ctx.scriptTokens.has(norm(slice[k].w));
    // leading
    let j = 0;
    while (j < keptK.length && !inScript(keptK[j])) j++;
    if (j > 0 && j < keptK.length) {
      const gap = slice[keptK[j]].s - slice[keptK[j - 1]].e;
      if (gap >= opts.edgeGap) { for (let q = 0; q < j; q++) { drop[keptK[q]] = true; res.dropped.edge++; } }
    }
    // trailing
    let t = keptK.length - 1;
    while (t >= 0 && !inScript(keptK[t])) t--;
    if (t < keptK.length - 1 && t >= 0) {
      const gap = slice[keptK[t + 1]].s - slice[keptK[t]].e;
      if (gap >= opts.edgeGap) { for (let q = t + 1; q < keptK.length; q++) { drop[keptK[q]] = true; res.dropped.edge++; } }
    }
  }

  // 3. runs of kept words; split at dropped words, and at pauses >= pauseMin unless keep_pauses
  const runs = [];
  let cur = null;
  for (let k = 0; k < slice.length; k++) {
    if (drop[k]) { if (cur) { runs.push(cur); cur = null; } continue; }
    const w = slice[k];
    if (cur && !keepPauses && (w.s - cur.last.e) >= opts.pauseMin) { runs.push(cur); cur = null; }
    if (!cur) cur = { first: w, last: w, words: [], k0: k };
    cur.last = w; cur.words.push(w); cur.k1 = k;
  }
  if (cur) runs.push(cur);

  // 4. ranges with handles, clamped so dropped words never leak in
  for (const r of runs) {
    const prevDropped = r.k0 > 0 ? slice[r.k0 - 1] : (range[0] > 0 ? words[range[0] - 1] : null);
    const nextDropped = r.k1 < slice.length - 1 ? slice[r.k1 + 1] : (range[1] < words.length - 1 ? words[range[1] + 1] : null);
    let a = r.first.s - opts.handle, b = r.last.e + opts.handle;
    let clampA = false, clampB = false; // bounded by a removed word: round inward so none of it leaks in
    if (prevDropped && prevDropped.e > a) { a = Math.min(prevDropped.e, r.first.s); clampA = true; }
    if (nextDropped && nextDropped.s < b) { b = Math.max(nextDropped.s, r.last.e); clampB = true; }
    a = Math.max(0, a);
    // 5. measured silences: dead air at the ends always; inside the cut unless keep_pauses
    const parts = subtractSilences([a, b], ctx.silences || [], r.words, opts, !keepPauses);
    for (const [p0, p1] of parts) {
      const srcIn = (clampA && p0 === a) ? Math.ceil(p0 * ctx.fps - 1e-6) / ctx.fps : roundToFrames(p0, ctx.fps);
      const srcOut = (clampB && p1 === b) ? Math.floor(p1 * ctx.fps + 1e-6) / ctx.fps : roundToFrames(p1, ctx.fps);
      if (srcOut - srcIn < opts.minPiece) continue;
      const pw = r.words.filter((w) => w.e > srcIn && w.s < srcOut);
      if (!pw.length) continue;
      res.pieces.push({ srcIn, srcOut, words: pw });
    }
  }
  // merge pieces that touch after rounding
  const merged = [];
  for (const p of res.pieces) {
    const last = merged[merged.length - 1];
    if (last && p.srcIn - last.srcOut < 0.5 / ctx.fps) { last.srcOut = p.srcOut; last.words = last.words.concat(p.words); }
    else merged.push(p);
  }
  res.pieces = merged;
  res.text = merged.map((p) => p.words.map((w) => w.w).join(' ')).join(' ');
  return res;
}

module.exports = { cutSegment, wordRangeForSegment, subtractSilences, roundToFrames, DEFAULTS };
