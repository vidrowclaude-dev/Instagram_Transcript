'use strict';
// Remote sources: Google Drive (public folders without a key, or with an API key), Figma, Dropbox,
// direct file links and zips. All downloads cached.
const fs = require('fs');
const path = require('path');
const { cacheDir, hash, readJSON, writeJSON, mkdirp, run, safeName } = require('./util');
const http = require('./http');

function parseDrive(url) {
  const s = String(url);
  let m = s.match(/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?)?folders\/([\w-]{10,})/);
  if (m) return { type: 'folder', id: m[1] };
  m = s.match(/drive\.google\.com\/file\/d\/([\w-]{10,})/) || s.match(/[?&]id=([\w-]{10,})/);
  if (m && /google\.com/.test(s)) return { type: 'file', id: m[1] };
  m = s.match(/docs\.google\.com\/(?:document|presentation|spreadsheets)\/d\/([\w-]{10,})/);
  if (m) return { type: 'doc', id: m[1] };
  return null;
}

function parseFigma(url) {
  const m = String(url).match(/figma\.com\/(?:file|design|proto|board)\/([\w]+)(?:\/[^?]*)?(?:\?(.*))?/);
  if (!m) return null;
  const q = new URLSearchParams(m[2] || '');
  const node = q.get('node-id');
  return { key: m[1], nodeId: node ? node.replace(/-/g, ':') : null };
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// One level of a Drive folder → [{id, name, isFolder}]
async function listDriveLevel(folderId, opts) {
  if (opts.apiKey) {
    const out = [];
    let token = '';
    do {
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}` +
        `&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,size)')}&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&key=${opts.apiKey}` +
        (token ? `&pageToken=${token}` : '');
      const j = await http.json(url, { service: 'Google Drive API', log: opts.log });
      for (const f of j.files || []) out.push({ id: f.id, name: f.name, isFolder: f.mimeType === 'application/vnd.google-apps.folder', size: Number(f.size || 0) });
      token = j.nextPageToken || '';
    } while (token);
    return out;
  }
  // No key: the public embedded folder view (works for "Anyone with the link" folders)
  const res = await http.request(`https://drive.google.com/embeddedfolderview?id=${folderId}`, { service: 'Google Drive', allowErrorStatus: true });
  const html = res.body.toString('utf8');
  if (res.status >= 400 || /ServiceLogin|accounts\.google\.com/.test(html) && !/flip-entry/.test(html)) {
    throw new Error(`Google Drive folder ${folderId} is not shared as "Anyone with the link" (HTTP ${res.status}). Share it that way or add a Google API key in Settings.`);
  }
  const out = [];
  const re = /<div class="flip-entry" id="entry-([\w-]+)"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    out.push({ id: m[1], name: decodeHtml(m[3].trim()), isFolder: /\/folders\//.test(m[2]) });
  }
  return out;
}

// Recursive listing with caching (1 hour). Returns files [{id, name, relPath}]
async function listDriveFolder(folderId, opts) {
  opts = opts || {};
  const cpath = path.join(cacheDir(opts.outputRoot, 'drive-lists'), hash(folderId, opts.apiKey ? 'k' : 'nk') + '.json');
  const cached = readJSON(cpath, null);
  if (cached && Date.now() - cached.at < 3600 * 1000) return cached.files;
  const files = [];
  const walk = async (id, rel, depth) => {
    if (depth > 6) return;
    const items = await listDriveLevel(id, opts);
    for (const it of items) {
      const relPath = rel ? rel + '/' + it.name : it.name;
      if (it.isFolder) await walk(it.id, relPath, depth + 1);
      else files.push({ id: it.id, name: it.name, relPath, size: it.size || 0 });
    }
  };
  await walk(folderId, '', 0);
  writeJSON(cpath, { at: Date.now(), files });
  return files;
}

// Download a Drive file by id (cached by id). Handles the large-file virus-scan confirmation page.
async function downloadDriveFile(id, name, opts) {
  opts = opts || {};
  const dir = cacheDir(opts.outputRoot, 'drive-files', id);
  const existing = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (existing.length) return path.join(dir, existing[0]);
  const dest = path.join(dir, safeFile(name || id));
  const url = opts.apiKey
    ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true&key=${opts.apiKey}`
    : `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  let r = await http.download(url, dest, { service: 'Google Drive', log: opts.log });
  const ct = String(r.headers['content-type'] || '');
  if (/text\/html/.test(ct)) {
    const html = r.body.toString('utf8');
    const action = (html.match(/<form[^>]+action="([^"]+)"/) || [])[1];
    if (!action) { fs.unlinkSync(dest); throw new Error(`Google Drive would not hand over "${name || id}" (not shared publicly?).`); }
    const params = [];
    const re = /<input type="hidden" name="([^"]+)" value="([^"]*)"/g; let m;
    while ((m = re.exec(html))) params.push(`${encodeURIComponent(m[1])}=${encodeURIComponent(decodeHtml(m[2]))}`);
    r = await http.download(decodeHtml(action) + '?' + params.join('&'), dest, { service: 'Google Drive', log: opts.log });
  }
  if (!name) {
    const cd = String(r.headers['content-disposition'] || '');
    const fm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (fm) { const named = path.join(dir, safeFile(decodeURIComponent(fm[1]))); fs.renameSync(dest, named); return named; }
  }
  return dest;
}

function safeFile(n) { return String(n).replace(/[\/\\:*?"<>|]+/g, '_').slice(0, 180); }

async function figmaExport(url, token, opts) {
  opts = opts || {};
  const f = parseFigma(url);
  if (!f) throw new Error(`Not a Figma file link: ${url}`);
  if (!token) throw new Error('Figma links need a personal access token (Settings → Figma token).');
  const headers = { 'X-Figma-Token': token };
  let ids = f.nodeId ? [f.nodeId] : [];
  const names = {};
  if (!ids.length || opts.expandChildren) {
    const file = await http.json(`https://api.figma.com/v1/files/${f.key}${f.nodeId ? `/nodes?ids=${encodeURIComponent(f.nodeId)}&depth=2` : '?depth=2'}`, { headers, service: 'Figma' });
    const pages = f.nodeId ? [file.nodes[f.nodeId].document] : (file.document.children || []).slice(0, 1);
    ids = [];
    for (const pg of pages) for (const ch of (pg.children || [])) {
      if (/FRAME|COMPONENT|GROUP|SECTION|INSTANCE/.test(ch.type)) { ids.push(ch.id); names[ch.id] = ch.name; }
    }
    ids = ids.slice(0, 40);
    if (!ids.length && f.nodeId) ids = [f.nodeId];
  }
  const dir = cacheDir(opts.outputRoot, 'figma', f.key);
  const out = [];
  const missing = ids.filter((id) => !fs.existsSync(path.join(dir, safeFile(id) + '.png')));
  if (missing.length) {
    const img = await http.json(`https://api.figma.com/v1/images/${f.key}?ids=${encodeURIComponent(missing.join(','))}&format=png&scale=2`, { headers, service: 'Figma' });
    if (img.err) throw new Error(`Figma: ${img.err}`);
    for (const id of missing) {
      const u = img.images && img.images[id];
      if (u) await http.download(u, path.join(dir, safeFile(id) + '.png'), { service: 'Figma images' });
    }
  }
  for (const id of ids) {
    const p = path.join(dir, safeFile(id) + '.png');
    if (fs.existsSync(p)) {
      const nice = path.join(dir, safeName(names[id] || id) + '__' + safeFile(id) + '.png');
      if (!fs.existsSync(nice)) fs.copyFileSync(p, nice);
      out.push(nice);
    }
  }
  return out;
}

async function extractZip(zipPath, outputRoot) {
  const dir = cacheDir(outputRoot, 'unzipped', hash(zipPath, String(fs.statSync(zipPath).size)));
  if (!fs.readdirSync(dir).length) {
    const r = await run('unzip', ['-o', '-q', zipPath, '-d', dir]);
    if (r.code !== 0) await run('ditto', ['-x', '-k', zipPath, dir], { check: true });
  }
  return walkFiles(dir);
}

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n.startsWith('.') || n === '__MACOSX') continue;
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

// Direct link / Dropbox. Returns local files (zips extracted).
async function downloadOther(url, opts) {
  opts = opts || {};
  let u = String(url).trim();
  if (/dropbox\.com/.test(u)) u = u.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=1/.test(u) ? '' : (u.includes('?') ? '&dl=1' : '?dl=1'));
  const dir = cacheDir(opts.outputRoot, 'links', hash(u));
  let files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  let local;
  if (files.length) local = path.join(dir, files[0]);
  else {
    const guess = safeFile(decodeURIComponent((new URL(u).pathname.split('/').pop() || 'download'))) || 'download';
    const r = await http.download(u, path.join(dir, guess), { service: new URL(u).hostname, log: opts.log });
    local = r.path;
    const cd = String(r.headers['content-disposition'] || '');
    const fm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
    if (fm) { const named = path.join(dir, safeFile(decodeURIComponent(fm[1]))); if (named !== local) { fs.renameSync(local, named); local = named; } }
    else if (!path.extname(local)) {
      const ct = String(r.headers['content-type'] || '');
      const ext = /zip/.test(ct) ? '.zip' : /png/.test(ct) ? '.png' : /jpe?g/.test(ct) ? '.jpg' : /mp4/.test(ct) ? '.mp4' : /quicktime/.test(ct) ? '.mov' : /mpeg/.test(ct) ? '.mp3' : '';
      if (ext) { fs.renameSync(local, local + ext); local = local + ext; }
    }
  }
  const head = fs.readFileSync(local).subarray(0, 4);
  if (/\.zip$/i.test(local) || (head[0] === 0x50 && head[1] === 0x4b)) return extractZip(local, opts.outputRoot);
  return [local];
}

// Resolve one asset-link row {type:'figma'|'drive'|'other', url} to local files.
async function resolveLink(row, settings, outputRoot, log) {
  const type = row.type || (parseFigma(row.url) ? 'figma' : parseDrive(row.url) ? 'drive' : 'other');
  if (type === 'figma') return figmaExport(row.url, settings.figmaToken, { outputRoot });
  if (type === 'drive') {
    const d = parseDrive(row.url);
    if (!d) throw new Error(`Not a Google Drive link: ${row.url}`);
    if (d.type === 'folder') {
      const list = await listDriveFolder(d.id, { apiKey: settings.googleKey, outputRoot, log });
      log(`  Drive folder: ${list.length} files`);
      const out = [];
      for (const f of list) {
        const p = await downloadDriveFile(f.id, f.name, { apiKey: settings.googleKey, outputRoot, log });
        if (/\.zip$/i.test(p)) out.push(...await extractZip(p, outputRoot)); else out.push(p);
      }
      return out;
    }
    if (d.type === 'doc') throw new Error('Google Docs/Slides/Sheets links are not media; export the images instead.');
    const p = await downloadDriveFile(d.id, null, { apiKey: settings.googleKey, outputRoot, log });
    return /\.zip$/i.test(p) ? extractZip(p, outputRoot) : [p];
  }
  return downloadOther(row.url, { outputRoot, log });
}

module.exports = { parseDrive, parseFigma, listDriveLevel, listDriveFolder, downloadDriveFile, figmaExport, extractZip, walkFiles, downloadOther, resolveLink };
