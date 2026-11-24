'use strict';
// Reference ad: download (yt-dlp) or use a local/project file, scene-detect, key frames + cut rhythm.
const fs = require('fs');
const path = require('path');
const { run, cacheDir, hash, fileKey, readJSON, writeJSON, mkdirp } = require('./util');
const media = require('./media');

async function downloadWithYtDlp(url, settings, outputRoot, log) {
  const dir = cacheDir(outputRoot, 'reference', hash(url));
  const have = fs.readdirSync(dir).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
  if (have.length) return path.join(dir, have[0]);
  const bin = settings.ytdlpPath || 'yt-dlp';
  const args = ['--no-playlist', '-f', 'bv*[height<=1920]+ba/b', '--merge-output-format', 'mp4', '-o', path.join(dir, 'reference.%(ext)s')];
  if (settings.browserCookies && settings.browserCookies !== 'off') args.push('--cookies-from-browser', settings.browserCookies);
  if (settings.ffmpegPath) args.push('--ffmpeg-location', settings.ffmpegPath);
  args.push(url);
  log(`  yt-dlp: downloading reference ${url}`);
  const r = await run(bin, args, { timeoutMs: 10 * 60 * 1000 });
  const files = fs.readdirSync(dir).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f));
  if (r.code !== 0 || !files.length) {
    const tail = r.stderr.trim().split('\n').filter((l) => /ERROR|error/i.test(l)).slice(-2).join(' ') || r.stderr.trim().split('\n').slice(-1)[0];
    throw new Error(`yt-dlp could not download it: ${tail || 'unknown error'}${/login|cookies|private/i.test(tail) ? ' (turn on "Use logins from browser" in Settings)' : ''}`);
  }
  return path.join(dir, files[0]);
}

async function analyse(ref, settings, outputRoot, log) {
  // ref: {type:'link'|'file'|'project', url?, path?}
  try {
    let file = ref.path;
    if (ref.type === 'link') file = await downloadWithYtDlp(ref.url, settings, outputRoot, log);
    if (!file || !fs.existsSync(file)) throw new Error('reference file not found');
    const key = fileKey(file, 'ref-v1');
    const dir = cacheDir(outputRoot, 'reference-analysis', key);
    const cached = readJSON(path.join(dir, 'analysis.json'), null);
    if (cached && cached.frames.every((f) => fs.existsSync(f))) return cached;
    const info = await media.probe(file);
    const cuts = await media.detectScenes(file, 0.3);
    const bounds = [0, ...cuts, info.duration];
    const shots = [];
    for (let i = 0; i < bounds.length - 1; i++) if (bounds[i + 1] - bounds[i] > 0.04) shots.push([bounds[i], bounds[i + 1]]);
    // key frames: middle of each shot, max 10 spread across the ad
    const pick = shots.length <= 10 ? shots : Array.from({ length: 10 }, (_, k) => shots[Math.floor(k * shots.length / 10)]);
    const frames = [];
    for (let k = 0; k < pick.length; k++) {
      const t = (pick[k][0] + pick[k][1]) / 2;
      const p = path.join(dir, `k${k}.jpg`);
      await run(media.tools.ffmpeg, ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '4', p], { check: true });
      frames.push(p);
    }
    const res = { file, duration: info.duration, cuts, avgShot: info.duration / Math.max(1, shots.length), frames, width: info.width, height: info.height };
    writeJSON(path.join(dir, 'analysis.json'), res);
    log(`  reference: ${info.duration.toFixed(1)} s, ${cuts.length} cuts, avg shot ${res.avgShot.toFixed(2)} s`);
    return res;
  } catch (e) {
    log.warn(`Reference ad skipped: ${e.message}. Continuing with the format guidelines.`);
    return { error: e.message };
  }
}

module.exports = { analyse, downloadWithYtDlp };
