'use strict';
// Face selection, footage framing, and layout geometry. Pure functions (unit-tested).

// detections: [[{x,y,w,h,score}], ...] per sampled frame, normalised 0..1 to the source frame.
// Keep a face only if seen in >= 2 frames and >= 45% the height of the biggest face.
// Grow each box up ~45% (hair) and down ~15% (chin), then merge into one union box.
function selectFaces(detections, opts) {
  opts = Object.assign({ minFrames: 2, minRel: 0.45, growUp: 0.45, growDown: 0.15 }, opts || {});
  const clusters = [];
  detections.forEach((frame, fi) => {
    for (const d of frame || []) {
      const cx = d.x + d.w / 2, cy = d.y + d.h / 2;
      let best = null, bd = Infinity;
      for (const c of clusters) {
        const dist = Math.hypot(c.cx - cx, c.cy - cy);
        if (dist < Math.max(c.h, d.h) * 0.8 && dist < bd) { bd = dist; best = c; }
      }
      if (!best) { best = { boxes: [], frames: new Set(), cx, cy, h: d.h }; clusters.push(best); }
      best.boxes.push(d); best.frames.add(fi);
      const n = best.boxes.length;
      best.cx = best.boxes.reduce((s, b) => s + b.x + b.w / 2, 0) / n;
      best.cy = best.boxes.reduce((s, b) => s + b.y + b.h / 2, 0) / n;
      best.h = best.boxes.reduce((s, b) => s + b.h, 0) / n;
    }
  });
  let kept = clusters.filter((c) => c.frames.size >= opts.minFrames);
  if (!kept.length) return null;
  const maxH = Math.max(...kept.map((c) => c.h));
  kept = kept.filter((c) => c.h >= opts.minRel * maxH);
  const grown = kept.map((c) => {
    const x0 = Math.min(...c.boxes.map((b) => b.x)), x1 = Math.max(...c.boxes.map((b) => b.x + b.w));
    const y0 = Math.min(...c.boxes.map((b) => b.y)), y1 = Math.max(...c.boxes.map((b) => b.y + b.h));
    const h = y1 - y0;
    return { x0: clamp01(x0), x1: clamp01(x1), y0: clamp01(y0 - opts.growUp * h), y1: clamp01(y1 + opts.growDown * h), h: c.h, frames: c.frames.size };
  });
  const union = grown.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), x1: Math.max(u.x1, b.x1), y0: Math.min(u.y0, b.y0), y1: Math.max(u.y1, b.y1) }),
    { x0: 1, x1: 0, y0: 1, y1: 0 });
  const biggest = grown.reduce((a, b) => (b.h > a.h ? b : a));
  return { union, biggest: { x0: biggest.x0, x1: biggest.x1, y0: biggest.y0, y1: biggest.y1 }, count: grown.length };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * Position footage so faces sit inside a visible window.
 * src {w,h}; frame {w,h}; win {x,y,w,h} (frame px); faces = selectFaces() result or null; zoom multiplier.
 * Returns {scale (percent), cx, cy (clip centre in frame px), fit:'faces'|'biggest'|'none', gapTop}.
 */
function frameFootage(src, frame, win, faces, zoom) {
  zoom = zoom || 1;
  const s = Math.max(win.w / src.w, win.h / src.h) * zoom;
  const W = src.w * s, H = src.h * s;
  // default: centred on the window
  let left = win.x + (win.w - W) / 2;
  let top = win.y + (win.h - H) / 2;
  let fit = 'none';
  if (faces) {
    const margin = 0.04 * win.h;
    const tryBox = (b) => {
      const fy0 = b.y0 * H, fy1 = b.y1 * H, fx0 = b.x0 * W, fx1 = b.x1 * W;
      if (fy1 - fy0 > win.h - margin || fx1 - fx0 > win.w) return null;
      let t = top, l = left;
      // vertical: keep the whole head (with headroom) inside the window
      if (t + fy0 < win.y + margin) t = win.y + margin - fy0;
      if (t + fy1 > win.y + win.h) t = win.y + win.h - fy1;
      // horizontal (landscape footage etc.)
      if (l + fx0 < win.x) l = win.x - fx0;
      if (l + fx1 > win.x + win.w) l = win.x + win.w - fx1;
      // keep the window covered where that doesn't push a face out
      const tMin = win.y + win.h - H, tMax = win.y; // t in [tMin,tMax] covers the window
      const tFaceMin = win.y + win.h - fy1, tFaceMax = win.y + margin - fy0;
      const lo = Math.max(tMin, tFaceMin), hi = Math.min(tMax, tFaceMax);
      if (lo <= hi) t = Math.min(hi, Math.max(lo, t));
      const lMin = win.x + win.w - W, lMax = win.x;
      const lFaceMin = win.x + win.w - fx1, lFaceMax = win.x - fx0;
      const llo = Math.max(lMin, lFaceMin), lhi = Math.min(lMax, lFaceMax);
      if (llo <= lhi) l = Math.min(lhi, Math.max(llo, l));
      return { t, l };
    };
    let r = tryBox(faces.union);
    if (r) fit = 'faces';
    else { r = tryBox(faces.biggest); if (r) fit = 'biggest'; }
    if (r) { top = r.t; left = r.l; }
  }
  return {
    scale: Math.round(s * 100000) / 1000,
    cx: Math.round((left + W / 2) * 100) / 100,
    cy: Math.round((top + H / 2) * 100) / 100,
    fit,
    gapTop: Math.max(0, top - win.y),
    cropTopPct: Math.max(0, Math.min(100, (win.y - top) / H * 100)), // portion of the clip above the window
  };
}

// Frame geometry helpers
function splitBand(frame) {
  const bandH = Math.round(frame.h * 0.4 / 2) * 2; // 768 for 1920
  return { top: { x: 0, y: 0, w: frame.w, h: bandH }, bottom: { x: 0, y: bandH, w: frame.w, h: frame.h - bandH } };
}

// Phone frame ~94% of the frame height, centred. Screen hole inside the bezel.
function phoneGeometry(frame) {
  const H = Math.round(frame.h * 0.94);
  let W = Math.round(H * 0.485);
  if (W > frame.w * 0.92) { W = Math.round(frame.w * 0.92); }
  const x = Math.round((frame.w - W) / 2), y = Math.round((frame.h - H) / 2);
  const bezel = Math.max(6, Math.round(W * 0.035));
  const radius = Math.round(W * 0.14);
  const hole = { x: x + bezel, y: y + bezel, w: W - 2 * bezel, h: H - 2 * bezel, r: Math.max(4, radius - bezel) };
  hole.w -= hole.w % 2; hole.h -= hole.h % 2;
  const island = { w: Math.round(W * 0.3), h: Math.round(W * 0.085), x: Math.round(frame.w / 2 - W * 0.15), y: hole.y + Math.round(W * 0.03) };
  return { body: { x, y, w: W, h: H, r: radius }, bezel, hole, island, shadow: Math.round(W * 0.06) };
}

// Transparent graphic placement: top edge ~52% of frame height, ~90% width, fitted.
function graphicRect(frame) {
  const y = Math.round(frame.h * 0.52);
  return { x: Math.round(frame.w * 0.05), y, w: Math.round(frame.w * 0.9), h: Math.round(frame.h * 0.94) - y };
}

function layoutRect(layout, frame) {
  switch (layout) {
    case 'center_card': return { x: Math.round(frame.w * 0.1), y: Math.round(frame.h * 0.22), w: Math.round(frame.w * 0.8), h: Math.round(frame.h * 0.45) };
    case 'pip_top_right': return { x: Math.round(frame.w * 0.58), y: Math.round(frame.h * 0.16), w: Math.round(frame.w * 0.37), h: Math.round(frame.h * 0.3) };
    default: return { x: 0, y: 0, w: frame.w, h: frame.h };
  }
}

function aspectFrame(aspect) {
  switch (aspect) {
    case '4:5': return { w: 1080, h: 1350, suffix: '_portrait' };
    case '1:1': return { w: 1080, h: 1080, suffix: '_square' };
    case '16:9': return { w: 1920, h: 1080, suffix: '_landscape' };
    default: return { w: 1080, h: 1920, suffix: '' };
  }
}

module.exports = { selectFaces, frameFootage, splitBand, phoneGeometry, graphicRect, layoutRect, aspectFrame };
