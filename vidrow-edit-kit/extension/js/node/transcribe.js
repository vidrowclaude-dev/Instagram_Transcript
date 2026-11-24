'use strict';
// Word-level transcription: OpenAI whisper-1 (verbose_json, word timestamps) or whisper.cpp offline.
// Cached per file. Long audio is split into chunks under the 25 MB upload limit.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, cacheDir, fileKey, readJSON, writeJSON, mkdirp, mb } = require('./util');
const media = require('./media');
const http = require('./http');

// Disfluent prompt so fillers and director talk come back verbatim (and can then be removed).
const DISFLUENT_PROMPT = 'Umm, uh... hmm. Okay, okay. Umm, toh, aaa, matlab... Action! Cut. One more. Uh, haan.';
const MAX_UPLOAD = 24 * 1024 * 1024; // keep under OpenAI's 25 MB
const CHUNK_SECONDS = 20 * 60;

function langCode(lang) {
  if (!lang || lang === 'auto') return null;
  if (/hi/i.test(lang)) return 'hi';
  if (/en/i.test(lang)) return 'en';
  return lang;
}

async function transcribeOpenAI(audioPath, offset, settings, log) {
  const data = fs.readFileSync(audioPath);
  const fields = [
    { name: 'model', value: 'whisper-1' },
    { name: 'response_format', value: 'verbose_json' },
    { name: 'timestamp_granularities[]', value: 'word' },
    { name: 'timestamp_granularities[]', value: 'segment' },
    { name: 'prompt', value: DISFLUENT_PROMPT },
    { name: 'temperature', value: '0' },
  ];
  const lc = langCode(settings.language);
  if (lc) fields.push({ name: 'language', value: lc });
  fields.push({ name: 'file', filename: path.basename(audioPath), contentType: 'audio/mpeg', data });
  const mp = http.multipart(fields);
  const res = await http.json('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', body: mp.body, service: 'OpenAI Whisper', log, timeoutMs: 15 * 60 * 1000,
    headers: { authorization: `Bearer ${settings.openaiKey}`, 'content-type': mp.contentType },
  });
  return (res.words || []).map((w) => ({ w: String(w.word).trim(), s: w.start + offset, e: w.end + offset })).filter((w) => w.w);
}

async function transcribeWhisperCpp(audioWav, offset, settings) {
  const bin = settings.whisperCppBin || 'whisper-cli';
  const model = settings.whisperCppModel;
  if (!model) throw new Error('whisper.cpp needs a model file (Settings → whisper.cpp model path).');
  const outBase = audioWav.replace(/\.wav$/, '');
  const args = ['-m', model, '-f', audioWav, '-oj', '-of', outBase, '-ml', '1', '-sow', '--prompt', DISFLUENT_PROMPT];
  const lc = langCode(settings.language);
  args.push('-l', lc || 'auto');
  await run(bin, args, { check: true, timeoutMs: 60 * 60 * 1000 });
  const j = JSON.parse(fs.readFileSync(outBase + '.json', 'utf8'));
  const words = [];
  for (const seg of j.transcription || []) {
    const t = String(seg.text || '').trim();
    if (!t || /^\[.*\]$/.test(t)) continue;
    const s = (seg.offsets ? seg.offsets.from : 0) / 1000 + offset;
    const e = (seg.offsets ? seg.offsets.to : 0) / 1000 + offset;
    // -ml 1 -sow gives one word per segment; split defensively if not
    const parts = t.split(/\s+/);
    parts.forEach((p, i) => {
      const ps = s + (e - s) * i / parts.length, pe = s + (e - s) * (i + 1) / parts.length;
      words.push({ w: p, s: ps, e: pe });
    });
  }
  return words;
}

// Transcribe one media file → {words:[{w,s,e}], engine}
async function transcribeFile(file, info, settings, outputRoot, log) {
  const engine = settings.transcriber === 'whispercpp' ? 'whispercpp' : 'openai';
  const key = fileKey(file, engine, settings.language || 'auto', 'v3');
  const cpath = path.join(cacheDir(outputRoot, 'transcripts'), key + '.json');
  const cached = readJSON(cpath, null);
  if (cached) { log(`  transcript (cached): ${path.basename(file)} — ${cached.words.length} words`); return cached; }
  if (!info.hasAudio) return { words: [], engine, noAudio: true };
  if (engine === 'openai' && !settings.openaiKey) throw new Error('No OpenAI key set. Add one in Settings, or switch the transcriber to whisper.cpp.');

  const tmp = mkdirp(path.join(os.tmpdir(), 'vek-audio', key));
  const dur = info.duration || 0;
  const nChunks = Math.max(1, Math.ceil(dur / CHUNK_SECONDS));
  let words = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * CHUNK_SECONDS;
    const len = Math.min(CHUNK_SECONDS, dur - start);
    if (engine === 'openai') {
      let p = path.join(tmp, `c${i}.mp3`);
      await media.extractAudio(file, p, { start, duration: len });
      // if the chunk is still too large (very long take), split it further
      if (fs.statSync(p).size > MAX_UPLOAD) {
        const sub = Math.ceil(fs.statSync(p).size / MAX_UPLOAD) + 1;
        for (let k = 0; k < sub; k++) {
          const ss = start + k * len / sub;
          const sp = path.join(tmp, `c${i}_${k}.mp3`);
          await media.extractAudio(file, sp, { start: ss, duration: len / sub });
          log(`  uploading ${path.basename(file)} part ${i + 1}.${k + 1} (${mb(fs.statSync(sp).size)} MB) to Whisper…`);
          words = words.concat(await transcribeOpenAI(sp, ss, settings, log));
        }
        continue;
      }
      log(`  uploading ${path.basename(file)}${nChunks > 1 ? ` part ${i + 1}/${nChunks}` : ''} (${mb(fs.statSync(p).size)} MB) to Whisper…`);
      words = words.concat(await transcribeOpenAI(p, start, settings, log));
    } else {
      const p = path.join(tmp, `c${i}.wav`);
      await media.extractAudio(file, p, { start, duration: len, wav: true });
      log(`  whisper.cpp: ${path.basename(file)}${nChunks > 1 ? ` part ${i + 1}/${nChunks}` : ''}…`);
      words = words.concat(await transcribeWhisperCpp(p, start, settings));
    }
  }
  words.sort((a, b) => a.s - b.s);
  const result = { words, engine };
  writeJSON(cpath, result);
  log(`  transcript: ${path.basename(file)} — ${words.length} words`);
  return result;
}

// Group words into short numbered lines: break at gaps > 0.25 s or after 10 words.
function groupLines(words, opts) {
  opts = opts || {};
  const maxGap = opts.maxGap || 0.25, maxWords = opts.maxWords || 10;
  const lines = [];
  let cur = null;
  words.forEach((w, i) => {
    if (cur && (w.s - words[i - 1].e > maxGap || cur.w1 - cur.w0 + 1 >= maxWords)) { lines.push(cur); cur = null; }
    if (!cur) cur = { id: lines.length + 1, w0: i, w1: i, s: w.s, e: w.e };
    cur.w1 = i; cur.e = w.e;
  });
  if (cur) lines.push(cur);
  for (const l of lines) l.text = words.slice(l.w0, l.w1 + 1).map((w) => w.w).join(' ');
  return lines;
}

function fmtLine(l) { return `L${l.id} [${l.s.toFixed(2)}–${l.e.toFixed(2)}] ${l.text}`; }

module.exports = { transcribeFile, groupLines, fmtLine, DISFLUENT_PROMPT, transcribeOpenAI, transcribeWhisperCpp };
