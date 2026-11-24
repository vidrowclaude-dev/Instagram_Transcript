'use strict';
// Sample media made with ffmpeg (cached in tests/.fixtures). Speech is simulated with tone bursts so
// silencedetect has real gaps to find; transcripts are mocked to line up with the bursts.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '.fixtures');
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);

// speech intervals for take 1 (seconds) and the words spoken in each
const TAKE1 = [
  { s: 0.5, e: 2.3, words: ['Umm,', 'Kya', 'aap', 'bhi', 'EMI', 'se', 'pareshan', 'ho?'] },
  { s: 2.9, e: 4.3, words: ['Maine', '30', 'din', 'mein', 'paise', 'bachaye.'] },
  { s: 5.2, e: 5.6, words: ['Action!'] },
  { s: 6.0, e: 7.4, words: ['Bachatt', 'app', 'pe', 'zero', 'percent', 'EMI'] },
  { s: 7.7, e: 9.2, words: ['milta', 'hai,', 'uh,', 'sach', 'mein.'] },
  { s: 10.0, e: 11.4, words: ['Aaj', 'hi', 'download', 'karo.'] },
  { s: 11.8, e: 12.3, words: ['Cut.'] },
];
const TAKE2 = [
  { s: 0.4, e: 2.0, words: ['Kya', 'aap', 'bhi', 'EMI', 'se', 'pareshan', 'ho?'] },
  { s: 2.6, e: 4.4, words: ['Maine', 'tees', 'din', 'mein', 'paise', 'bachaye', 'yaar.'] },
];

function words(intervals) {
  const out = [];
  for (const iv of intervals) {
    const n = iv.words.length, d = (iv.e - iv.s) / n;
    iv.words.forEach((w, i) => out.push({ w, s: +(iv.s + i * d + 0.02).toFixed(3), e: +(iv.s + (i + 1) * d - 0.02).toFixed(3) }));
  }
  return out;
}

function toneExpr(intervals) {
  return 'sin(2*PI*220*t)*0.6*(' + intervals.map((iv) => `between(t,${iv.s},${iv.e})`).join('+') + ')';
}

function make() {
  fs.mkdirSync(DIR, { recursive: true });
  const f = (n) => path.join(DIR, n);
  const marker = f('.v3');
  if (fs.existsSync(marker)) return paths();
  // take 1: portrait 1080x1920, 30 fps, 13 s
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=13', '-f', 'lavfi', '-i', `aevalsrc='${toneExpr(TAKE1)}':s=48000:d=13`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('take1.mp4')]);
  // take 2: landscape 1920x1080, 30 fps, 5 s
  ff(['-f', 'lavfi', '-i', 'testsrc=s=1920x1080:r=30:d=5', '-f', 'lavfi', '-i', `aevalsrc='${toneExpr(TAKE2)}':s=48000:d=5`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('take2.mov')]);
  fs.mkdirSync(f('assets'), { recursive: true });
  // opaque portrait app screenshot
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1170x2532:d=1', '-frames:v', '1', f('assets/app_home.png')]);
  // transparent sticker (alpha background)
  ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=800x300,format=rgba', '-vf', 'drawbox=x=50:y=50:w=700:h=200:c=yellow@1:t=fill', '-frames:v', '1', f('assets/sticker.png')]);
  // RGBA PNG that is fully opaque (must NOT count as transparent)
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=1000x600,format=rgba', '-frames:v', '1', f('assets/opaque_rgba_banner.png')]);
  // portrait screen recording
  ff(['-f', 'lavfi', '-i', 'testsrc=s=886x1920:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('assets/app_recording.mp4')]);
  // ProRes 4444 logo with alpha
  ff(['-f', 'lavfi', '-i', 'color=c=blue@0.0:s=640x360:r=30:d=2,format=rgba', '-vf', 'drawbox=x=120:y=80:w=400:h=200:c=white@1:t=fill',
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', f('assets/logo_anim.mov')]);
  // music library
  for (const [rel, freq] of [['Curious/Quirky Pizzicato Walk.mp3', 330], ['Curious/Corporate Curious Bed.mp3', 400], ['Happy/Sunny Day Groove.mp3', 523], ['Upbeat Corporate/Inspire Success.mp3', 600], ['Mystery/Night Detective.mp3', 262]]) {
    fs.mkdirSync(path.dirname(f('music/' + rel)), { recursive: true });
    ff(['-f', 'lavfi', '-i', `sine=f=${freq}:d=8`, '-c:a', 'libmp3lame', '-b:a', '64k', f('music/' + rel)]);
  }
  // reference ad with 4 hard cuts
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=540x960:r=30:d=1.5', '-f', 'lavfi', '-i', 'color=c=green:s=540x960:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:r=30:d=1',
    '-f', 'lavfi', '-i', 'color=c=white:s=540x960:r=30:d=2.5', '-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f('reference.mp4')]);
  fs.writeFileSync(marker, 'ok');
  return paths();
}

function paths() {
  const f = (n) => path.join(DIR, n);
  return {
    dir: DIR, take1: f('take1.mp4'), take2: f('take2.mov'),
    appHome: f('assets/app_home.png'), sticker: f('assets/sticker.png'), opaqueRgba: f('assets/opaque_rgba_banner.png'),
    recording: f('assets/app_recording.mp4'), logo4444: f('assets/logo_anim.mov'), musicDir: f('music'), reference: f('reference.mp4'),
  };
}

const SCRIPT = `Hook 1
Kya aap bhi EMI se pareshan ho?
Hook 2
Maine 30 din mein paise bachaye.
Hook 3
Body
[CALLOUT: 0% EMI on everything]
Bachatt app pe zero percent EMI milta hai, sach mein.
Aaj hi download karo [LINK: https://bachatt.example/offer]`;

module.exports = { make, paths, words, TAKE1, TAKE2, SCRIPT, DIR };
