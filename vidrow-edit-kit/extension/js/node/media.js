'use strict';
// ffmpeg / ffprobe wrappers. Everything that must be pixel-exact is rendered here, not in Premiere's QE DOM.
const fs = require('fs');
const path = require('path');
const { run, cacheDir, fileKey, readJSON, writeJSON, mkdirp } = require('./util');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.psd', '.svg']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.aif', '.aiff', '.flac', '.ogg', '.opus']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.mxf', '.webm', '.mts', '.m2ts', '.3gp', '.braw', '.r3d']);

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };
function setToolPaths(p) { Object.assign(tools, p || {}); }

const ALPHA_PIX = /^(rgba|bgra|argb|abgr|ya8|ya16|yuva|gbrap|rgba64|bgra64|pal8)/;

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

// Probe: size, fps, duration, pixel format, alpha flag (from pix_fmt), codec, rotation-corrected size.
async function probe(file) {
  const res = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { check: true });
  const j = JSON.parse(res.stdout.toString());
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic && kindOf(file) !== 'image'));
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  const out = {
    path: file, kind: kindOf(file),
    duration: Number(fmt.duration || (v && v.duration) || (a && a.duration) || 0),
    size: Number(fmt.size || 0),
    hasAudio: !!a, hasVideo: !!v,
  };
  if (v) {
    let w = v.width, h = v.height;
    let rot = 0;
    if (v.tags && v.tags.rotate) rot = Number(v.tags.rotate);
    const sd = (v.side_data_list || []).find((d) => d.rotation != null);
    if (sd) rot = Number(sd.rotation);
    if (Math.abs(rot) % 180 === 90) { const t = w; w = h; h = t; }
    out.width = w; out.height = h; out.rotation = rot;
    out.fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 0;
    if (out.kind === 'image') out.fps = 0;
    out.pixFmt = v.pix_fmt || '';
    out.codec = v.codec_name || '';
    out.profile = v.profile || '';
    out.alphaPixFmt = ALPHA_PIX.test(out.pixFmt) || /4444/.test(out.profile || '') || (v.tags && /alpha/i.test(JSON.stringify(v.tags)));
    if (out.kind === 'other') out.kind = out.duration > 0.5 && v.nb_frames !== '1' ? 'video' : 'image';
  } else if (a && out.kind === 'other') out.kind = 'audio';
  return out;
}

// Real transparency check: extract the alpha plane and look for any non-opaque pixel.
// Many opaque PNGs/ProRes files carry an alpha channel that is fully 255; those are NOT graphics.
async function hasRealAlpha(file, info) {
  info = info || await probe(file);
  if (!info.alphaPixFmt) return false;
  const seek = info.kind === 'video' && info.duration > 1 ? ['-ss', String(Math.min(1, info.duration / 2))] : [];
  const args = ['-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', 'format=rgba,alphaextract,signalstats,metadata=print:file=-', '-f', 'null', '-'];
  const res = await run(tools.ffmpeg, args);
  const txt = res.stdout.toString() + res.stderr;
  const m = txt.match(/lavfi\.signalstats\.YMIN=(\d+)/);
  if (!m) return false;
  return Number(m[1]) < 250;
}

// Adaptive silencedetect: threshold = mean volume - 16 dB, clamped to [-55, -28] dB, d = 0.12 s.
async function detectSilences(file, outputRoot, log) {
  const key = fileKey(file, 'sil-v2');
  const cpath = path.join(cacheDir(outputRoot, 'silences'), key + '.json');
  const cached = readJSON(cpath, null);
  if (cached) return cached;
  const vd = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const mm = vd.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const mean = mm ? Number(mm[1]) : -30;
  const thr = Math.max(-55, Math.min(-28, mean - 16));
  const sd = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `silencedetect=noise=${thr.toFixed(1)}dB:d=0.12`, '-f', 'null', '-']);
  const silences = [];
  let start = null;
  for (const line of sd.stderr.split('\n')) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { start = Math.max(0, Number(m[1])); continue; }
    m = line.match(/silence_end:\s*([\d.]+)/);
    if (m && start != null) { silences.push([round3(start), round3(Number(m[1]))]); start = null; }
  }
  if (start != null) {
    const dur = (await probe(file)).duration;
    silences.push([round3(start), round3(dur)]);
  }
  const result = { mean, threshold: thr, silences };
  writeJSON(cpath, result);
  if (log) log(`  silences: ${path.basename(file)} mean ${mean.toFixed(1)} dB → threshold ${thr.toFixed(1)} dB, ${silences.length} gaps`);
  return result;
}
function round3(x) { return Math.round(x * 1000) / 1000; }

// Extract mono 16 kHz audio for transcription. mp3 @ 48 kbps keeps uploads small (~0.36 MB/min).
async function extractAudio(file, outPath, opts) {
  opts = opts || {};
  const args = ['-y', '-v', 'error'];
  if (opts.start != null) args.push('-ss', String(opts.start));
  args.push('-i', file);
  if (opts.duration != null) args.push('-t', String(opts.duration));
  args.push('-vn', '-ac', '1', '-ar', '16000');
  if (opts.wav) args.push('-c:a', 'pcm_s16le', outPath);
  else args.push('-c:a', 'libmp3lame', '-b:a', '48k', outPath);
  await run(tools.ffmpeg, args, { check: true });
  return outPath;
}

// Thumbnail (JPEG, max 512 px) for Claude. Images keep alpha shown over a checkerboard-ish grey.
async function thumbnail(file, outPath, info, atSec) {
  info = info || await probe(file);
  const seek = info.kind === 'video' ? ['-ss', String(atSec != null ? atSec : Math.min(1, (info.duration || 0) / 3))] : [];
  const vf = "scale='if(gt(iw,ih),min(512,iw),-2)':'if(gt(iw,ih),-2,min(512,ih))',format=rgba,split[a][b];[a]drawbox=c=0x808080:t=fill[bg];[bg][b]overlay,format=yuvj420p";
  await run(tools.ffmpeg, ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-filter_complex', vf, '-q:v', '4', outPath], { check: true });
  return outPath;
}

// N evenly spaced frames (for face detection).
async function sampleFrames(file, dir, n, info) {
  info = info || await probe(file);
  mkdirp(dir);
  const out = [];
  const dur = info.duration || 1;
  for (let i = 0; i < n; i++) {
    const t = info.kind === 'image' ? 0 : dur * (i + 0.5) / n;
    const p = path.join(dir, `f${i}.jpg`);
    if (!fs.existsSync(p)) {
      const seek = info.kind === 'image' ? [] : ['-ss', t.toFixed(3)];
      await run(tools.ffmpeg, ['-y', '-v', 'error', ...seek, '-i', file, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", '-q:v', '3', p], { check: true });
    }
    out.push({ path: p, t });
  }
  return out;
}

// Cover-scale + crop to an exact WxH box. focusY (0..1) picks which vertical band of a tall source shows.
function coverFilter(srcW, srcH, W, H, focusY, focusX) {
  const s = Math.max(W / srcW, H / srcH);
  const sw = Math.max(W, Math.round(srcW * s / 2) * 2);
  const sh = Math.max(H, Math.round(srcH * s / 2) * 2);
  const fy = focusY == null ? 0.5 : Math.max(0, Math.min(1, focusY));
  const fx = focusX == null ? 0.5 : Math.max(0, Math.min(1, focusX));
  const x = Math.round((sw - W) * fx);
  // focusY is the centre of the band we want, as a fraction of the source height
  const y = Math.round(Math.max(0, Math.min(sh - H, fy * sh - H / 2)));
  return { filter: `scale=${sw}:${sh}:flags=lanczos,crop=${W}:${H}:${x}:${y},setsar=1`, x, y, sw, sh };
}

// Render an asset into an exact box (opaque). Images → PNG, videos → H.264 CRF 16.
async function renderCover(file, info, W, H, focusY, outBase, opts) {
  opts = opts || {};
  const { filter } = coverFilter(info.width, info.height, W, H, focusY, opts.focusX);
  if (info.kind === 'image') {
    const out = outBase + '.png';
    await run(tools.ffmpeg, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', filter, out], { check: true });
    return out;
  }
  const out = outBase + '.mp4';
  const args = ['-y', '-v', 'error'];
  if (opts.srcStart) args.push('-ss', String(opts.srcStart));
  args.push('-i', file);
  if (opts.duration) args.push('-t', String(opts.duration + 0.5));
  args.push('-vf', filter + ',format=yuv420p', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-an', '-movflags', '+faststart', out);
  await run(tools.ffmpeg, args, { check: true });
  return out;
}

// Place an asset (fit or cover) at a rectangle on a transparent full-frame canvas.
// Images → PNG with alpha. Videos → ProRes 4444 .mov with alpha. Placed in Premiere at Scale 100, centred:
// exact whether or not "Set to frame size" is on, because the file already is the frame size.
async function renderOnCanvas(file, info, frame, rect, outBase, opts) {
  opts = opts || {};
  const W = frame.w, H = frame.h;
  let fit;
  if (opts.cover) {
    const c = coverFilter(info.width, info.height, rect.w, rect.h, opts.focusY, opts.focusX);
    fit = { filter: c.filter, w: rect.w, h: rect.h };
  } else {
    const s = Math.min(rect.w / info.width, rect.h / info.height);
    const w = Math.max(2, Math.round(info.width * s / 2) * 2), h = Math.max(2, Math.round(info.height * s / 2) * 2);
    fit = { filter: `scale=${w}:${h}:flags=lanczos,setsar=1`, w, h };
  }
  const x = Math.round(rect.x + (rect.w - fit.w) / 2);
  const y = Math.round(rect.y + (opts.alignTop ? 0 : (rect.h - fit.h) / 2));
  const canvas = `color=c=black@0.0:s=${W}x${H}:r=${info.fps || 30},format=rgba`;
  if (info.kind === 'image') {
    const out = outBase + '.png';
    await run(tools.ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', canvas, '-i', file,
      '-filter_complex', `[1:v]format=rgba,${fit.filter}[fg];[0:v][fg]overlay=${x}:${y}:format=auto,format=rgba`,
      '-frames:v', '1', out], { check: true });
    return { path: out, x, y, w: fit.w, h: fit.h };
  }
  const out = outBase + '.mov';
  const dur = opts.duration ? opts.duration + 0.5 : info.duration;
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-t', String(dur), '-i', canvas];
  if (opts.srcStart) args.push('-ss', String(opts.srcStart));
  args.push('-i', file, '-filter_complex', `[1:v]format=rgba,${fit.filter}[fg];[0:v][fg]overlay=${x}:${y}:shortest=1:format=auto,format=yuva444p10le`,
    '-t', String(dur), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-an', out);
  await run(tools.ffmpeg, args, { check: true });
  return { path: out, x, y, w: fit.w, h: fit.h };
}

// Scene detection for reference ads: returns cut times.
async function detectScenes(file, threshold) {
  const res = await run(tools.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vf', `select='gt(scene,${threshold || 0.3})',showinfo`, '-an', '-f', 'null', '-']);
  const cuts = [];
  for (const line of res.stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) cuts.push(Number(m[1]));
  }
  return cuts;
}

module.exports = { kindOf, probe, hasRealAlpha, detectSilences, extractAudio, thumbnail, sampleFrames, coverFilter, renderCover, renderOnCanvas, detectScenes, setToolPaths, tools, IMAGE_EXT, VIDEO_EXT, AUDIO_EXT };
