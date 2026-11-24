'use strict';
// Minimal HTTPS client for CEP's Node (no global fetch there).
// - JSON, multipart and streaming (SSE) requests
// - retries uploads cut off by EPIPE / ECONNRESET / timeouts (2 retries, back-off)
// - if the server answered before closing (bad key, no credit, file too large) that answer is surfaced
// - otherwise the error says which service failed and how many MB were being sent
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const { sleep, mb } = require('./util');

const RETRYABLE = new Set(['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'EHOSTUNREACH', 'ENETUNREACH']);

class HttpError extends Error {
  constructor(message, props) { super(message); Object.assign(this, props); this.name = 'HttpError'; }
}

function describeServerError(service, status, bodyText) {
  let detail = (bodyText || '').trim();
  try {
    const j = JSON.parse(detail);
    detail = (j.error && (j.error.message || j.error.type)) || j.message || j.error_description || detail;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch (e) { /* not JSON */ }
  if (detail.length > 600) detail = detail.slice(0, 600) + '…';
  return `${service} returned HTTP ${status}${detail ? ': ' + detail : ''}`;
}

// One attempt. Resolves {status, headers, body(Buffer)} or rejects with a code-carrying error.
function once(url, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const body = opts.body || null;
    const headers = Object.assign({}, opts.headers || {});
    if (body && headers['content-length'] == null) headers['content-length'] = Buffer.byteLength(body);
    const req = lib.request({
      method: opts.method || (body ? 'POST' : 'GET'),
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers,
    });
    let settled = false;
    let gotResponse = null; // response may arrive even if our upload is cut short
    const chunks = [];
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      const e = new Error('timed out'); e.code = 'ETIMEDOUT'; req.destroy(e);
    }, opts.timeoutMs || 120000);

    req.on('response', (res) => {
      gotResponse = res;
      if (opts.onResponse && res.statusCode < 400) {
        // streaming consumer handles data
        opts.onResponse(res, (err, val) => err ? finish(reject, err) : finish(resolve, val));
        res.on('error', (e) => finish(reject, e));
        return;
      }
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', (e) => {
        if (chunks.length) finish(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        else finish(reject, e);
      });
    });
    req.on('error', (e) => {
      // Server replied (e.g. 413/401) and then closed while we were still uploading: give the reply.
      if (gotResponse && gotResponse.statusCode >= 400) {
        setTimeout(() => finish(resolve, { status: gotResponse.statusCode, headers: gotResponse.headers, body: Buffer.concat(chunks) }), 50);
        return;
      }
      finish(reject, e);
    });
    if (body) {
      // write in pieces so a big upload doesn't sit in one buffer write
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      let off = 0; const CH = 256 * 1024;
      const pump = () => {
        while (off < buf.length) {
          const slice = buf.subarray(off, Math.min(off + CH, buf.length));
          off += slice.length;
          if (!req.write(slice)) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    } else req.end();
  });
}

// request with retries and friendly errors
async function request(url, opts) {
  opts = opts || {};
  const service = opts.service || new URL(url).hostname;
  const size = opts.body ? Buffer.byteLength(opts.body) : 0;
  const retries = opts.retries == null ? 2 : opts.retries;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await once(url, opts);
      if (res && res.status >= 400 && !opts.allowErrorStatus) {
        const text = res.body ? res.body.toString('utf8') : '';
        // 429/5xx: transient, retry
        if ((res.status === 429 || res.status >= 500) && attempt < retries && res.status !== 501) {
          const ra = Number(res.headers && res.headers['retry-after']);
          await sleep(Math.min(60000, (ra > 0 ? ra * 1000 : 2000 * Math.pow(2, attempt))));
          lastErr = new HttpError(describeServerError(service, res.status, text), { status: res.status, bodyText: text });
          continue;
        }
        throw new HttpError(describeServerError(service, res.status, text), { status: res.status, bodyText: text, headers: res.headers });
      }
      return res;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e;
      if (RETRYABLE.has(e.code) && attempt < retries) {
        if (opts.log) opts.log.warn(`${service}: connection ${e.code === 'ETIMEDOUT' ? 'timed out' : 'dropped'}${size ? ` while sending ${mb(size)} MB` : ''}, retrying (${attempt + 1}/${retries})…`);
        await sleep(1500 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }
  if (lastErr instanceof HttpError) throw lastErr;
  const what = lastErr && lastErr.code === 'ETIMEDOUT' ? 'timed out' : 'lost the connection';
  const sizeTxt = size ? ` while uploading ${mb(size)} MB` : '';
  const hint = size > 20 * 1024 * 1024 ? ' The upload may be too large for this service or your connection.' : ' Check your internet connection.';
  throw new HttpError(`${service} ${what}${sizeTxt} after ${retries + 1} tries.${hint}`, { code: lastErr && lastErr.code, cause: lastErr });
}

async function json(url, opts) {
  opts = Object.assign({}, opts);
  opts.headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
  if (opts.json !== undefined) {
    opts.body = Buffer.from(JSON.stringify(opts.json));
    opts.headers['content-type'] = 'application/json';
  }
  const res = await request(url, opts);
  const text = res.body.toString('utf8');
  try { return JSON.parse(text); } catch (e) {
    throw new HttpError(`${opts.service || 'Server'} sent an unreadable reply: ${text.slice(0, 200)}`, { status: res.status });
  }
}

// Build a multipart/form-data body. fields: [{name, value}] or [{name, filename, contentType, data(Buffer)}]
function multipart(fields) {
  const boundary = '----VEK' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const f of fields) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"`;
    if (f.filename) head += `; filename="${f.filename}"\r\nContent-Type: ${f.contentType || 'application/octet-stream'}`;
    head += '\r\n\r\n';
    parts.push(Buffer.from(head, 'utf8'));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.value), 'utf8'));
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Download to a file, following redirects. Returns {path, headers, finalUrl}.
async function download(url, dest, opts) {
  opts = opts || {};
  const fs = require('fs');
  let cur = url;
  for (let hop = 0; hop < 8; hop++) {
    const res = await request(cur, Object.assign({}, opts, { allowErrorStatus: true, timeoutMs: opts.timeoutMs || 600000 }));
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      cur = new URL(res.headers.location, cur).toString();
      continue;
    }
    if (res.status >= 400) throw new HttpError(describeServerError(opts.service || new URL(cur).hostname, res.status, res.body.toString('utf8').slice(0, 300)), { status: res.status });
    fs.writeFileSync(dest, res.body);
    return { path: dest, headers: res.headers, finalUrl: cur, body: res.body };
  }
  throw new HttpError(`Too many redirects downloading ${url}`);
}

module.exports = { request, json, multipart, download, HttpError, describeServerError, RETRYABLE };
