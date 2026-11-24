'use strict';
// Music library: list (Drive / Dropbox / Mac folder), match tracks to genres by folder + file names,
// never anything corporate, up to 3 candidates per genre, download only the picked tracks.
const fs = require('fs');
const path = require('path');
const links = require('./links');
const media = require('./media');

const GENRES = {
  Curious: ['curious', 'curiosity', 'suspense', 'suspenseful', 'mystery', 'mysterious', 'quirky', 'playful', 'pizzicato', 'sneaky', 'tension', 'investigat', 'thinking', 'intrigue', 'detective', 'tiptoe'],
  Happy: ['happy', 'upbeat', 'fun', 'cheerful', 'joy', 'bright', 'positive', 'groovy', 'party', 'energetic', 'bouncy', 'feel good', 'feelgood', 'summer', 'comedy', 'comedic', 'funny'],
  Wholesome: ['wholesome', 'warm', 'heartwarming', 'family', 'emotional', 'tender', 'soft', 'indian', 'desi', 'gentle', 'acoustic', 'hopeful', 'love', 'nostalg', 'sweet'],
  Sad: ['sad', 'melancholy', 'melancholic', 'emotional', 'strings', 'somber', 'sombre', 'heartbreak', 'lonely', 'cry', 'tragic', 'dramatic', 'piano sad', 'grief'],
};
const CORPORATE = /corporate|business|inspiring[\s_-]*corporate|upbeat[\s_-]*corporate|motivational|inspirational|presentation|explainer|commercial|advertis|ukulele|whistle|hand\s*clap|technology[\s_-]*corporate|startup/i;
const AUDIO = /\.(mp3|wav|aac|m4a|aif|aiff|flac|ogg)$/i;

function scoreTrack(relPath, genre) {
  const p = relPath.toLowerCase();
  if (CORPORATE.test(p)) return -1;
  let score = 0;
  const parts = p.split('/');
  const file = parts.pop();
  const folders = parts.join('/');
  for (const kw of GENRES[genre] || []) {
    if (folders.includes(kw)) score += 3;
    if (file.includes(kw)) score += 2;
  }
  if (folders.includes(genre.toLowerCase())) score += 3;
  return score;
}

// Stable pseudo-random order so candidates vary per job but are reproducible
function seeded(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; }; }

function matchCandidates(files, genre, seedStr, max) {
  max = max || 3;
  const rnd = seeded(seedStr + genre);
  return files
    .filter((f) => AUDIO.test(f.relPath))
    .map((f) => ({ f, s: scoreTrack(f.relPath, genre), r: rnd() }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.r - b.r)
    .slice(0, max)
    .map((x) => x.f);
}

// List a library source → [{relPath, name, source:'drive'|'local', id?, path?}]
async function listLibrary(link, settings, outputRoot, log) {
  const s = String(link || '').trim();
  if (!s) return [];
  if (s.startsWith('/') || s.startsWith('~')) {
    const dir = s.replace(/^~/, require('os').homedir());
    if (!fs.existsSync(dir)) throw new Error(`Music folder not found: ${dir}`);
    return links.walkFiles(dir).map((p) => ({ relPath: path.relative(dir, p), name: path.basename(p), source: 'local', path: p }));
  }
  const d = links.parseDrive(s);
  if (d && d.type === 'folder') {
    const list = await links.listDriveFolder(d.id, { apiKey: settings.googleKey, outputRoot, log });
    return list.map((f) => ({ relPath: f.relPath, name: f.name, source: 'drive', id: f.id }));
  }
  // Dropbox / zip link: download and extract
  const files = await links.downloadOther(s, { outputRoot, log });
  const root = commonDir(files);
  return files.map((p) => ({ relPath: path.relative(root, p), name: path.basename(p), source: 'local', path: p }));
}
function commonDir(files) {
  if (!files.length) return '/';
  let d = path.dirname(files[0]);
  while (!files.every((f) => f.startsWith(d + path.sep))) d = path.dirname(d);
  return d;
}

async function fetchTrack(track, settings, outputRoot, log) {
  if (track.source === 'local') return track.path;
  log(`  downloading music: ${track.relPath}`);
  return links.downloadDriveFile(track.id, track.name, { apiKey: settings.googleKey, outputRoot, log });
}

// Build candidate list for the job: M1.. per genre
async function candidates(musicCfg, settings, outputRoot, log, seedStr) {
  const genres = [musicCfg.track1, musicCfg.track2].filter((g) => g && g !== 'None');
  if (!genres.length) return { list: [], genres };
  const files = await listLibrary(musicCfg.library, settings, outputRoot, log);
  log(`  music library: ${files.length} files`);
  const list = [];
  const seen = new Set();
  for (const g of [...new Set(genres)]) {
    const c = matchCandidates(files, g, seedStr || '', 3);
    if (!c.length) log.warn(`  no ${g} tracks found in the library (folder/file names); Claude will be told.`);
    for (const t of c) {
      if (seen.has(t.relPath)) continue;
      seen.add(t.relPath);
      list.push(Object.assign({ id: 'M' + (list.length + 1), genre: g }, t));
    }
  }
  return { list, genres };
}

module.exports = { GENRES, CORPORATE, scoreTrack, matchCandidates, listLibrary, fetchTrack, candidates };
