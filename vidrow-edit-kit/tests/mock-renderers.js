'use strict';
// Node stand-ins for the panel's canvas renderers (callout box, phone frame). The real ones draw on a
// <canvas> in the panel; these draw equivalent geometry with ffmpeg so the pipeline can be tested headless.
const { execFileSync } = require('child_process');

function renderCallout({ text, style, out, frame, topPct }) {
  const w = Math.round(frame.w * 0.7), h = 140, x = Math.round((frame.w - w) / 2), y = Math.round(frame.h * topPct);
  const fill = style === 'black' ? 'black' : style === 'brand' ? '0x715BE4' : 'white';
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${frame.w}x${frame.h},format=rgba`,
    '-vf', `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:c=${fill}@1:t=fill`, '-frames:v', '1', out]);
  renderCallout.calls.push(text);
  return out;
}
renderCallout.calls = [];

function renderPhone({ screenshot, out, frame, geometry }) {
  const b = geometry.body, hole = geometry.hole;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${frame.w}x${frame.h},format=rgba`];
  let fc = `[0]drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:c=black@1:t=fill[p]`;
  if (screenshot) {
    args.push('-i', screenshot);
    fc += `;[1]scale=${hole.w}:${hole.h},format=rgba[s];[p][s]overlay=${hole.x}:${hole.y}`;
  } else {
    // punch a transparent hole: draw the hole with alpha 0 via geq would be slow; use drawbox with replace
    fc += `;[p]drawbox=x=${hole.x}:y=${hole.y}:w=${hole.w}:h=${hole.h}:c=black@0.0:t=fill:replace=1`;
  }
  execFileSync('ffmpeg', [...args, '-filter_complex', fc, '-frames:v', '1', out]);
  renderPhone.calls.push(screenshot || 'frame');
  return out;
}
renderPhone.calls = [];

module.exports = { renderCallout, renderPhone };
