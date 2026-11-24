'use strict';
// Shared helpers: paths, process spawning, caching, logging.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// CEP panels start with the GUI PATH (no Homebrew). Add the usual tool locations.
(function fixPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), 'bin')];
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  for (const p of extra) if (!cur.includes(p)) cur.push(p);
  process.env.PATH = cur.join(':');
})();

const HOME = os.homedir();
const DEFAULT_OUTPUT = path.join(HOME, 'Movies', 'Vidrow Edit Kit');

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function cacheDir(outputRoot, ...sub) {
  return mkdirp(path.join(outputRoot || DEFAULT_OUTPUT, '.cache', ...sub));
}

function hash(...parts) {
  const h = crypto.createHash('sha1');
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p));
  return h.digest('hex').slice(0, 16);
}

// Cache key for a local file: path + size + mtime (cheap, survives renames poorly but that's fine).
function fileKey(file, ...extra) {
  const st = fs.statSync(file);
  return hash(path.resolve(file), String(st.size), String(st.mtimeMs), ...extra);
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(p, obj) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function safeName(s, fallback) {
  const out = String(s || '').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
  return out || fallback || 'Untitled';
}

// Run a command; resolves {code, stdout, stderr}. Never throws on non-zero exit unless opts.check.
function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    } catch (e) { return reject(e); }
    const out = []; const err = [];
    let errLen = 0;
    child.stdout.on('data', (d) => { out.push(d); if (opts.onStdout) opts.onStdout(d.toString()); });
    child.stderr.on('data', (d) => {
      if (errLen < 8 * 1024 * 1024) { err.push(d); errLen += d.length; }
      if (opts.onStderr) opts.onStderr(d.toString());
    });
    let timer = null;
    if (opts.timeoutMs) timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      if (e.code === 'ENOENT') e.message = `${cmd} is not installed or not on the PATH (${e.message})`;
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const res = { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() };
      if (opts.check && code !== 0) {
        const tail = res.stderr.trim().split('\n').slice(-6).join('\n');
        const e = new Error(`${path.basename(cmd)} failed (exit ${code}): ${tail}`);
        e.result = res; return reject(e);
      }
      resolve(res);
    });
  });
}

// Logger: collects lines and forwards to a sink (panel log, console in tests).
function makeLogger(sink) {
  const lines = [];
  const log = (msg, level) => {
    const line = { t: new Date().toISOString().slice(11, 19), level: level || 'info', msg: String(msg) };
    lines.push(line);
    if (sink) sink(line);
  };
  log.warn = (m) => log(m, 'warn');
  log.error = (m) => log(m, 'error');
  log.step = (m) => log(m, 'step');
  log.lines = lines;
  return log;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mb(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }

module.exports = { HOME, DEFAULT_OUTPUT, mkdirp, cacheDir, hash, fileKey, readJSON, writeJSON, safeName, run, makeLogger, sleep, mb };
