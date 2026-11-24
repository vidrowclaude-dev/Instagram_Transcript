'use strict';
// Test harness: node tests/run.js [filter]
// Transcription and Claude are mocked; media is generated with ffmpeg; host.jsx runs on a mock Premiere DOM.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const N = (m) => require(path.join(__dirname, '..', 'extension', 'js', 'node', m));
const util = N('util');
const text = N('text');
const cuts = N('cuts');
const framing = N('framing');
const media = N('media');
const music = N('music');
const anthropic = N('anthropic');
const httpc = N('http');
const transcribe = N('transcribe');
const pipeline = N('pipeline');
const bs = N('buildspec');
const fx = require('./fixtures');
const mock = require('./mock-premiere');
const renderers = require('./mock-renderers');

const PRESETS = path.join(__dirname, '..', 'extension', 'presets');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const quietLog = () => { const l = util.makeLogger(process.env.VERBOSE ? (x) => console.log('    ' + x.level.padEnd(5), x.msg) : null); return l; };
const tmp = (n) => util.mkdirp(path.join(os.tmpdir(), 'vek-test', n + '-' + process.pid));

// ------------------------------------------------------------------ script + text
test('script parsing: sections, callouts, links', () => {
  const s = text.parseScript(fx.SCRIPT);
  assert.strictEqual(s.sections.H1.length, 1);
  assert.strictEqual(s.sections.H2.length, 1);
  assert.strictEqual(s.sections.H3.length, 0);
  assert.strictEqual(s.sections.BODY.length, 2);
  assert.deepStrictEqual(s.callouts, [{ section: 'BODY', line: 0, text: '0% EMI on everything' }]);
  assert.strictEqual(s.links[0].url, 'https://bachatt.example/offer');
  assert.strictEqual(s.sections.BODY[1].text, 'Aaj hi download karo');
});

test('fillers and director talk marked; Hindi आ/aa not fillers; script "okay" kept', () => {
  const w = (arr) => arr.map((x, i) => ({ w: x, s: i, e: i + 0.5 }));
  const st = new Set(text.tokens('haan okay toh chalo'));
  const r = text.markFillers(w(['Umm,', 'uh', 'hmm', 'okay', 'Action!', 'one', 'more', 'phir', 'se', 'आ', 'aa', 'ek', 'aur', 'chalo', 'Cut.']), st, text.tokens('haan okay toh chalo').join(' '));
  assert.deepStrictEqual(r.drop, [true, true, true, false, true, true, true, true, true, false, false, true, true, false, true]);
  const r2 = text.markFillers(w(['okay']), new Set(), '');
  assert.deepStrictEqual(r2.drop, [true], 'stray okay dropped when script lacks it');
});

// ------------------------------------------------------------------ cuts
function ctxFor(words, silences, script, extra) {
  const st = new Set(text.tokens(script));
  return Object.assign({ words, lines: transcribe.groupLines(words), silences: silences || [], scriptTokens: st, scriptText: text.tokens(script).join(' '), fps: 30 }, extra || {});
}

test('gap removal: pauses >= 0.15 s split, < 0.15 kept, measured silences removed', () => {
  const words = [{ w: 'Bachatt', s: 1.0, e: 1.4 }, { w: 'app', s: 1.5, e: 1.8 }, { w: 'pe', s: 1.9, e: 2.1 }, { w: 'zero', s: 2.4, e: 2.7 }];
  // gap 1.4→1.5 (0.1, kept), 2.1→2.4 (0.3, removed)
  const ctx = ctxFor(words, [[2.12, 2.38]], 'Bachatt app pe zero', { lines: [{ id: 1, w0: 0, w1: 3, s: 1, e: 2.7, text: '' }] });
  const r = cuts.cutSegment(ctx, { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r.pieces.length, 2, JSON.stringify(r.pieces));
  assert.ok(r.pieces[0].srcOut <= 2.2 && r.pieces[1].srcIn >= 2.3, 'pause removed');
  for (const p of r.pieces) { assert.ok(Math.abs(p.srcIn * 30 - Math.round(p.srcIn * 30)) < 1e-6, 'frame aligned'); }
  const kept = cuts.cutSegment(ctx, { clip: 'C1', from_line: 1, to_line: 1, keep_pauses: true });
  assert.strictEqual(kept.pieces.length, 1, 'keep_pauses keeps the pause');
});

test('dead air at the start/end of a cut is trimmed from measured silence', () => {
  const words = [{ w: 'Aaj', s: 1.0, e: 1.6 }, { w: 'hi', s: 1.6, e: 2.0 }];
  // Whisper says "Aaj" starts at 1.0 but audio is silent until 1.3
  const ctx = ctxFor(words, [[0, 1.3], [2.0, 3.0]], 'Aaj hi', { lines: [{ id: 1, w0: 0, w1: 1, s: 1, e: 2, text: '' }] });
  const r = cuts.cutSegment(ctx, { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r.pieces.length, 1);
  assert.ok(Math.abs(r.pieces[0].srcIn - 1.25) < 0.04, 'starts at silence end minus pad: ' + r.pieces[0].srcIn);
});

test('filler removal splits the cut around "uh"', () => {
  const words = [{ w: 'milta', s: 0, e: 0.3 }, { w: 'hai,', s: 0.32, e: 0.6 }, { w: 'uh,', s: 0.62, e: 0.9 }, { w: 'sach', s: 0.92, e: 1.2 }, { w: 'mein', s: 1.22, e: 1.5 }];
  const ctx = ctxFor(words, [], 'milta hai sach mein');
  const r = cuts.cutSegment(ctx, { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r.pieces.length, 2);
  assert.ok(r.pieces[0].srcOut <= 0.63 && r.pieces[1].srcIn >= 0.89, JSON.stringify(r.pieces.map((p) => [p.srcIn, p.srcOut])));
  assert.strictEqual(r.dropped.filler, 1);
});

test('off-script edge words trimmed only with >=75% match and >=0.2 s pause', () => {
  const words = [{ w: 'chalo', s: 0, e: 0.3 }, { w: 'Kya', s: 0.6, e: 0.8 }, { w: 'aap', s: 0.8, e: 1.0 }, { w: 'bhi', s: 1.0, e: 1.2 }, { w: 'pareshan', s: 1.2, e: 1.6 }, { w: 'ho', s: 1.6, e: 1.8 }];
  const lines = [{ id: 1, w0: 0, w1: 5, s: 0, e: 1.8, text: '' }];
  const r = cuts.cutSegment(ctxFor(words, [], 'Kya aap bhi pareshan ho', { lines }), { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r.dropped.edge, 1);
  assert.ok(r.pieces[0].srcIn >= 0.5);
  // no pause before the script words → real word never clipped
  const w2 = words.map((w, i) => (i === 0 ? { w: 'chalo', s: 0.45, e: 0.59 } : w));
  const r2 = cuts.cutSegment(ctxFor(w2, [], 'Kya aap bhi pareshan ho', { lines, opts: { pauseMin: 99 } }), { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r2.dropped.edge, 0);
  // low script match (<75%) → no edge trimming
  const r3 = cuts.cutSegment(ctxFor(words, [], 'Kya aap', { lines }), { clip: 'C1', from_line: 1, to_line: 1 });
  assert.strictEqual(r3.dropped.edge, 0);
});

// ------------------------------------------------------------------ faces + framing
test('face selection: >=2 frames, >=45% of biggest, grown and merged', () => {
  const big = { x: 0.4, y: 0.3, w: 0.2, h: 0.12 };
  const small = { x: 0.1, y: 0.8, w: 0.03, h: 0.03 };   // tiny background face
  const once = { x: 0.7, y: 0.3, w: 0.2, h: 0.12 };     // only in one frame (false positive)
  const sel = framing.selectFaces([[big, small], [big, small], [big, once], [big], []]);
  assert.strictEqual(sel.count, 1);
  assert.ok(Math.abs(sel.union.y0 - (0.3 - 0.45 * 0.12)) < 1e-9 && Math.abs(sel.union.y1 - (0.42 + 0.15 * 0.12)) < 1e-9);
  assert.strictEqual(framing.selectFaces([[big]]), null, 'single frame is not enough');
});

test('split screen framing: faces never cut or covered (portrait + landscape)', () => {
  const frame = { w: 1080, h: 1920 };
  const band = framing.splitBand(frame);
  assert.deepStrictEqual(band.top, { x: 0, y: 0, w: 1080, h: 768 });
  for (const [src, faces] of [
    [{ w: 1080, h: 1920 }, { union: { x0: 0.3, x1: 0.7, y0: 0.08, y1: 0.35 }, biggest: { x0: 0.3, x1: 0.7, y0: 0.08, y1: 0.35 } }],
    [{ w: 1080, h: 1920 }, { union: { x0: 0.3, x1: 0.7, y0: 0.55, y1: 0.85 }, biggest: { x0: 0.3, x1: 0.7, y0: 0.55, y1: 0.85 } }],
    [{ w: 1920, h: 1080 }, { union: { x0: 0.75, x1: 0.9, y0: 0.1, y1: 0.6 }, biggest: { x0: 0.75, x1: 0.9, y0: 0.1, y1: 0.6 } }],
  ]) {
    const r = framing.frameFootage(src, frame, band.bottom, faces, 1);
    const s = r.scale / 100, W = src.w * s, H = src.h * s, top = r.cy - H / 2, left = r.cx - W / 2;
    const fy0 = top + faces.union.y0 * H, fy1 = top + faces.union.y1 * H, fx0 = left + faces.union.x0 * W, fx1 = left + faces.union.x1 * W;
    assert.ok(fy0 >= 768 - 0.5, `head below the screen band (${fy0.toFixed(1)})`);
    assert.ok(fy1 <= 1920.5, `chin inside frame (${fy1.toFixed(1)})`);
    assert.ok(fx0 >= -0.5 && fx1 <= 1080.5, `face inside horizontally (${fx0.toFixed(0)}–${fx1.toFixed(0)})`);
    assert.strictEqual(r.fit, 'faces');
  }
  // group too tall to fit → frames the biggest face
  const tall = { union: { x0: 0.1, x1: 0.9, y0: 0.0, y1: 0.95 }, biggest: { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 } };
  assert.strictEqual(framing.frameFootage({ w: 1080, h: 1920 }, frame, band.bottom, tall, 1).fit, 'biggest');
});

test('phone geometry ~94% of frame height, centred', () => {
  const g = framing.phoneGeometry({ w: 1080, h: 1920 });
  assert.ok(Math.abs(g.body.h / 1920 - 0.94) < 0.005);
  assert.ok(Math.abs(g.body.x + g.body.w / 2 - 540) <= 1);
  assert.ok(g.hole.x > g.body.x && g.hole.y > g.body.y && g.hole.w < g.body.w);
});

// ------------------------------------------------------------------ media
test('media: probe, real-alpha detection (PNG, opaque RGBA, ProRes 4444), silences', async () => {
  const P = fx.make();
  const t1 = await media.probe(P.take1);
  assert.strictEqual(t1.width, 1080); assert.strictEqual(t1.height, 1920); assert.ok(Math.abs(t1.fps - 30) < 0.01);
  assert.strictEqual(await media.hasRealAlpha(P.sticker), true, 'sticker is transparent');
  assert.strictEqual(await media.hasRealAlpha(P.opaqueRgba), false, 'opaque RGBA is not transparent');
  assert.strictEqual(await media.hasRealAlpha(P.appHome), false);
  assert.strictEqual(await media.hasRealAlpha(P.logo4444), true, 'ProRes 4444 with alpha');
  const sil = await media.detectSilences(P.take1, tmp('sil'));
  assert.ok(sil.threshold <= -28 && sil.threshold >= -55);
  // the gap 2.3→2.9 must be found
  assert.ok(sil.silences.some(([a, b]) => a <= 2.4 && b >= 2.8), JSON.stringify(sil.silences));
});

test('split-screen screen render is exactly 1080x768; focus_y picks the band', async () => {
  const P = fx.make();
  const info = await media.probe(P.appHome);
  const out = await media.renderCover(P.appHome, info, 1080, 768, 0.2, path.join(tmp('crop'), 'top'));
  const pr = await media.probe(out);
  assert.strictEqual(pr.width, 1080); assert.strictEqual(pr.height, 768);
  const c0 = media.coverFilter(1170, 2532, 1080, 768, 0, 0.5), c1 = media.coverFilter(1170, 2532, 1080, 768, 1, 0.5);
  assert.strictEqual(c0.y, 0); assert.strictEqual(c1.y, c1.sh - 768);
});

// ------------------------------------------------------------------ music
test('music matching: genre synonyms, never corporate, up to 3', async () => {
  const P = fx.make();
  const files = await music.listLibrary(P.musicDir, {}, tmp('music'), quietLog());
  const cur = music.matchCandidates(files, 'Curious', 'x');
  const names = cur.map((f) => f.relPath);
  assert.ok(names.includes('Curious/Quirky Pizzicato Walk.mp3'));
  assert.ok(names.includes('Mystery/Night Detective.mp3'), 'mystery counts as curious');
  assert.ok(!names.some((n) => /corporate/i.test(n)), 'no corporate tracks');
  assert.ok(cur.length <= 3);
  assert.ok(!music.matchCandidates(files, 'Happy', 'x').some((f) => /corporate/i.test(f.relPath)));
});

// ------------------------------------------------------------------ network
function server(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

test('network: upload cut off twice (ECONNRESET) is retried and succeeds', async () => {
  let n = 0;
  const s = await server((req, res) => {
    n++;
    if (n <= 2) { req.socket.destroy(); return; }
    let len = 0; req.on('data', (d) => (len += d.length)); req.on('end', () => { res.end(JSON.stringify({ ok: true, len })); });
  });
  const body = Buffer.alloc(2 * 1024 * 1024, 1);
  const log = quietLog();
  const j = await httpc.json(`http://127.0.0.1:${s.address().port}/up`, { method: 'POST', body, service: 'Test upload', log });
  assert.strictEqual(j.len, body.length); assert.strictEqual(n, 3);
  assert.ok(log.lines.some((l) => /retrying \(1\/2\)/.test(l.msg)));
  s.close();
});

test('network: server reply before close is shown (no bare EPIPE)', async () => {
  const s = await server((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    req.socket.destroy();
  });
  await assert.rejects(httpc.json(`http://127.0.0.1:${s.address().port}/x`, { method: 'POST', body: Buffer.alloc(3 * 1024 * 1024), service: 'OpenAI Whisper' }),
    (e) => /OpenAI Whisper returned HTTP 401: Incorrect API key/.test(e.message) && !/EPIPE/.test(e.message));
  s.close();
});

test('network: persistent failure names the service and MB', async () => {
  const s = await server((req) => req.socket.destroy());
  await assert.rejects(httpc.json(`http://127.0.0.1:${s.address().port}/x`, { method: 'POST', body: Buffer.alloc(5 * 1024 * 1024), service: 'OpenAI Whisper', retries: 1 }),
    (e) => /OpenAI Whisper lost the connection while uploading 5\.0 MB after 2 tries/.test(e.message));
  s.close();
});

// mock Anthropic streaming server
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function toolEvents(input, withThinking) {
  const ev = [{ type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 100 } } }];
  let i = 0;
  if (withThinking) {
    ev.push({ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } });
    ev.push({ type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig123' } });
    ev.push({ type: 'content_block_stop', index: i }); i++;
  }
  ev.push({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'tu1', name: 'submit_edit_plan', input: {} } });
  const s = JSON.stringify(input);
  ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: s.slice(0, 10) } });
  ev.push({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: s.slice(10) } });
  ev.push({ type: 'content_block_stop', index: i });
  ev.push({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } });
  ev.push({ type: 'message_stop' });
  return ev;
}
function readBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(JSON.parse(Buffer.concat(c).toString()))); }); }

test('Claude: effort rejected → steps down to high; output_config rejected → dropped; tool_choice auto', async () => {
  const seen = [];
  const s = await server(async (req, res) => {
    const b = await readBody(req); seen.push(b);
    if (seen.length === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config.effort: "max" is not supported for this model' } })); }
    if (seen.length === 2) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } })); }
    sse(res, toolEvents({ sections: [], summary: 'ok' }));
  });
  const log = quietLog();
  const r = await anthropic.requestPlan({ apiKey: 'k', model: 'claude-haiku-5-5', effort: 'max', system: 'sys', content: [{ type: 'text', text: 'hi' }], tool: { name: 'submit_edit_plan', input_schema: { type: 'object' } }, log, baseUrl: `http://127.0.0.1:${s.address().port}` });
  assert.strictEqual(seen[0].output_config.effort, 'max');
  assert.strictEqual(seen[0].max_tokens, 64000, 'max effort → 64000 max_tokens');
  assert.deepStrictEqual(seen[0].tool_choice, { type: 'auto' });
  assert.strictEqual(seen[1].output_config.effort, 'high');
  assert.strictEqual(seen[2].output_config, undefined);
  assert.strictEqual(r.plan.summary, 'ok');
  assert.ok(log.lines.some((l) => /stepping down to high/.test(l.msg)) && log.lines.some((l) => /sending without it/.test(l.msg)));
  s.close();
});

test('Claude: answers without the tool → one nudge turn that keeps thinking blocks', async () => {
  const seen = [];
  const s = await server(async (req, res) => {
    const b = await readBody(req); seen.push(b);
    if (seen.length === 1) {
      return sse(res, [
        { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5-5', usage: {} } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan…' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Here is the plan in words.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' }]);
    }
    sse(res, toolEvents({ sections: [{ name: 'BODY', segments: [] }], summary: 'nudged' }, true));
  });
  const r = await anthropic.requestPlan({ apiKey: 'k', model: 'claude-opus-5-5', effort: 'high', system: 's', content: [{ type: 'text', text: 'x' }], tool: { name: 'submit_edit_plan', input_schema: { type: 'object' } }, log: quietLog(), baseUrl: `http://127.0.0.1:${s.address().port}` });
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].fallbacks, 'default', 'refusal fallbacks requested on Opus 5.5');
  const asst = seen[1].messages[1];
  assert.strictEqual(asst.role, 'assistant');
  assert.deepStrictEqual(asst.content[0], { type: 'thinking', thinking: 'plan…', signature: 'SIG' }, 'thinking block replayed unchanged');
  assert.ok(/submit_edit_plan/.test(seen[1].messages[2].content[0].text));
  assert.strictEqual(r.plan.summary, 'nudged');
  s.close();
});

test('cost labels exist for every built-in model', () => {
  for (const m of anthropic.MODELS) assert.ok(/per edit/.test(anthropic.costLabel(m.id, 'high')));
  assert.ok(anthropic.estimateCost('claude-fable-5-2', 'high').mid > anthropic.estimateCost('claude-haiku-5-5', 'high').mid);
});

// ------------------------------------------------------------------ end to end
function mockPlan(overrides) {
  // take1 lines (grouped by gaps): L1 umm..ho  L2 Maine..bachaye  L3 Action  L4 Bachatt..EMI  L5 milta..mein  L6 Aaj..karo  L7 Cut
  return Object.assign({
    summary: 'H1 pain question, H2 result claim; body from take 1.',
    sections: [
      { name: 'H1', segments: [{ clip: 'C1', from_line: 1, to_line: 1, script_line: 'Kya aap bhi EMI se pareshan ho?' }] },
      { name: 'H2', segments: [{ clip: 'C2', from_line: 2, to_line: 2, script_line: 'Maine 30 din mein paise bachaye.' }] },
      { name: 'BODY', segments: [
        { clip: 'C1', from_line: 4, to_line: 5, script_line: 'Bachatt app pe zero percent EMI milta hai, sach mein.' },
        { clip: 'C1', from_line: 6, to_line: 6, script_line: 'Aaj hi download karo' }] },
    ],
    overlays: [
      { asset: 'A1', segment: 'BODY.0', offset: 0.2, duration: 1.8, layout: 'split', asset_type: 'app_screen', focus_y: 0.3 },
      { asset: 'A2', segment: 'BODY.1', offset: 0, duration: 1.5, layout: 'fullscreen', asset_type: 'graphic' },
    ],
    callouts: [{ text: '0% EMI on everything', segment: 'BODY.0', offset: 0, duration: 2 }],
    links: [{ url: 'https://bachatt.example/offer', asset: null, segment: 'BODY.1', offset: 0 }],
    editor_notes: [{ note: 'Riser into the hook', segment: 'H1.0', offset: 0, kind: 'riser' }],
    music: { asset: 'M1', volume_db: -20, start: 0, switch_asset: 'M2', switch_segment: 'BODY.1', switch_offset: 0 },
    faces: [{ clip: 'C1', top: 0.1, bottom: 0.4 }, { clip: 'C2', top: 0.15, bottom: 0.6 }],
  }, overrides || {});
}

function mockWords(file) {
  return /take1/.test(file) ? fx.words(fx.TAKE1) : fx.words(fx.TAKE2);
}

async function runPipeline(appScreens, extra) {
  const P = fx.make();
  const out = tmp('out-' + appScreens);
  const log = quietLog();
  const settings = Object.assign({}, require(path.join(__dirname, '..', 'extension', 'js', 'node', 'settings')).DEFAULTS, { outputFolder: out, anthropicKey: 'x' });
  const input = Object.assign({
    jobName: 'EMI Ad', scriptText: fx.SCRIPT, footage: [P.take1, P.take2], format: 'talking_head', aspect: '9:16', appScreens,
    reference: { type: 'file', path: P.reference },
    client: { name: 'Bachatt', assets: [P.appHome, P.sticker, P.opaqueRgba, P.recording], links: [], calloutStyle: 'white', brandNotes: '' },
    music: { library: P.musicDir, track1: 'Curious', track2: 'Happy', start: 'first', level: -20 },
    brief: { text: 'Punchy.', deliver: 'separate', autoExport: true }, model: 'claude-opus-5-5', effort: 'high',
  }, extra && extra.input);
  let request = null;
  const env = {
    log, presetsDir: PRESETS,
    transcribe: async (p) => ({ words: mockWords(p), engine: 'mock' }),
    detectFaces: async (frames) => frames.map(() => [{ x: 0.35, y: 0.12, w: 0.3, h: 0.15, score: 0.9 }]),
    callClaude: async (req) => { request = req; return { plan: (extra && extra.plan) || mockPlan(), usage: [] }; },
    renderCallout: renderers.renderCallout, renderPhone: renderers.renderPhone,
  };
  const res = await pipeline.generate(input, settings, env);
  return { res, log, request, P, out, settings, env };
}

test('E2E split mode: timelines, gaps, fillers, overlays, callouts, markers, music switch, exports', async () => {
  const { res, log, request } = await runPipeline('split');
  const spec = res.hostSpec;
  // Claude request content
  const textAll = request.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  assert.ok(/L1 \[0\.\d\d–2\.\d\d\] Umm, Kya aap/.test(textAll), 'numbered transcript lines sent');
  assert.ok(/TRANSPARENT graphic/.test(textAll) && /APP SCREENS mode: split/.test(textAll) && /M1 \[Curious\]/.test(textAll) && /Reference ad/.test(textAll));
  assert.ok(request.content.some((b) => b.type === 'image'), 'thumbnails sent as images');
  assert.ok(/Talking Head/.test(request.system) && /no corporate-style tracks/i.test(request.system));
  // one timeline per hook, Hook N + Body, no separate hook/body sequences
  assert.deepStrictEqual(spec.timelines.map((t) => t.name), ['Bachatt_EMI_Ad_H1', 'Bachatt_EMI_Ad_H2']);
  for (const tl of spec.timelines) {
    const v1 = tl.clips.filter((c) => c.track === 'V1').sort((a, b) => a.start - b.start);
    // contiguous: no gaps between V1 cuts
    for (let i = 1; i < v1.length; i++) assert.strictEqual(v1[i].startTicks, v1[i - 1].endTicks, `${tl.name}: gap at cut ${i}`);
    assert.strictEqual(v1[v1.length - 1].endTicks, tl.durationTicks);
    // red BODY STARTS marker at the join
    const bm = tl.markers.find((m) => m.name === 'BODY STARTS');
    assert.ok(bm && bm.color === 'red' && bm.ticks === tl.bodyStartTicks);
    // filler "Umm" (0.5–0.7) never inside a V1 cut; director "Action"/"Cut" never included
    for (const c of v1.filter((x) => x.label.startsWith('C1'))) {
      assert.ok(!(c.srcIn < 0.68 && c.srcOut > 0.55), `Umm included in ${tl.name}`);
      assert.ok(!(c.srcIn < 5.55 && c.srcOut > 5.25), 'Action included');
      assert.ok(!(c.srcIn < 12.25 && c.srcOut > 11.85), 'Cut included');
      // 'uh,' sits at about 8.3–8.58
      assert.ok(!(c.srcIn < 8.5 && c.srcOut > 8.4), 'uh included');
    }
    // green script markers, orange callout, purple link + to-do
    assert.ok(tl.markers.some((m) => m.color === 'green'));
    assert.ok(tl.markers.some((m) => m.color === 'orange' && /0% EMI/.test(m.name)));
    assert.ok(tl.markers.some((m) => m.color === 'purple' && /SCREENSHOT NEEDED: https:\/\/bachatt\.example\/offer/.test(m.name)));
    // tracks
    const v2 = tl.clips.filter((c) => c.track === 'V2'), v3 = tl.clips.filter((c) => c.track === 'V3'), v4 = tl.clips.filter((c) => c.track === 'V4');
    assert.strictEqual(v2.length, 1, 'app screen on V2'); assert.strictEqual(v3.length, 1, 'transparent sticker on V3'); assert.strictEqual(v4.length, 1, 'callout on V4');
    assert.strictEqual(v2[0].cy, 384, 'split screen centred in top 40% band');
    // V1 under the split screen framed into the bottom 60%
    const under = v1.filter((c) => c.start >= v2[0].start - 1e-6 && c.end <= v2[0].end + 1e-6);
    assert.ok(under.length >= 1 && under.every((c) => c.cropTopPct > 0));
    // music: A2, track 1 from frame 0, switch at the first "Bachatt"/"app" mention snapped to a cut
    const a2 = tl.audio.filter((a) => a.track === 'A2');
    assert.ok(a2.length >= 2 && a2[0].startTicks === '0' && a2[0].levelDb === -20);
    assert.strictEqual(a2[1].startTicks, tl.bodyStartTicks, 'Track 2 at first app mention (the Body join)');
  }
  // rendered files
  const media2 = (id) => spec.media.find((m) => m.id === id);
  const v2c = spec.timelines[0].clips.find((c) => c.track === 'V2');
  const pr = await media.probe(media2(v2c.media).path);
  assert.deepStrictEqual([pr.width, pr.height], [1080, 768]);
  const v3c = spec.timelines[0].clips.find((c) => c.track === 'V3');
  const pr3 = await media.probe(media2(v3c.media).path);
  assert.deepStrictEqual([pr3.width, pr3.height], [1080, 1920]);
  assert.ok(await media.hasRealAlpha(media2(v3c.media).path), 'graphic keeps transparency');
  // exports
  assert.deepStrictEqual(spec.exports.map((e) => path.basename(e.file)), ['Bachatt_EMI_Ad_H1.mp4', 'Bachatt_EMI_Ad_H2.mp4', 'Bachatt_EMI_Ad_Body.mp4']);
  assert.strictEqual(spec.exports[2].timeline, 'Bachatt_EMI_Ad_H1'); assert.strictEqual(spec.exports[2].inTicks, spec.timelines[0].bodyStartTicks);
  // files written
  assert.ok(fs.existsSync(path.join(res.jobDir, 'claude_plan.json')) && fs.existsSync(path.join(res.jobDir, 'build_spec.json')));
  // coverage warning? all script lines are covered except Hook 3 (none in script)
  assert.ok(!log.lines.some((l) => /Script line not covered/.test(l.msg)), log.lines.filter((l) => /not covered/.test(l.msg)).map((l) => l.msg).join('\n'));
  assert.ok(log.lines.some((l) => /music switches to Track 2 at/.test(l.msg)));
});

test('E2E: uncovered script lines are warned', async () => {
  const plan = mockPlan();
  plan.sections[2].segments = [plan.sections[2].segments[0]]; // drop "Aaj hi download karo"
  const { log } = await runPipeline('split', { plan });
  assert.ok(log.lines.some((l) => /Script line not covered: BODY #2 "Aaj hi download karo"/.test(l.msg)));
});

test('E2E phone mode: screenshot inside phone on V2, recording in the hole + frame on V3, V1 blurred', async () => {
  const plan = mockPlan({ overlays: [
    { asset: 'A1', segment: 'BODY.0', offset: 0, duration: 1.6, asset_type: 'app_screen' },
    { asset: 'A4', segment: 'BODY.1', offset: 0, duration: 1.5, asset_type: 'app_screen' }] });
  const { res } = await runPipeline('phone', { plan });
  const tl = res.hostSpec.timelines[0];
  const v2 = tl.clips.filter((c) => c.track === 'V2'), v3 = tl.clips.filter((c) => c.track === 'V3');
  assert.strictEqual(v2.length, 2); assert.strictEqual(v3.length, 1, 'phone frame over the recording');
  const rec = res.hostSpec.media.find((m) => m.id === v2[1].media).path;
  assert.ok(/\.mov$/.test(rec) && await media.hasRealAlpha(rec), 'recording rendered into the hole with transparency around it');
  const blurred = tl.clips.filter((c) => c.track === 'V1' && c.blur === 60);
  assert.ok(blurred.length >= 2, 'footage keeps playing behind, blurred');
  assert.ok(tl.clips.filter((c) => c.track === 'V1' && !c.blur).length >= 1);
});

test('E2E full mode: app screen covers the frame (1080x1920)', async () => {
  const plan = mockPlan({ overlays: [{ asset: 'A1', segment: 'BODY.0', offset: 0, duration: 1.6, asset_type: 'app_screen', focus_y: 0.1 }] });
  const { res } = await runPipeline('full', { plan });
  const v2 = res.hostSpec.timelines[0].clips.find((c) => c.track === 'V2');
  const pr = await media.probe(res.hostSpec.media.find((m) => m.id === v2.media).path);
  assert.deepStrictEqual([pr.width, pr.height], [1080, 1920]);
  assert.ok(!res.hostSpec.timelines[0].clips.some((c) => c.cropTopPct > 0), 'no split framing in full mode');
});

test('E2E: no app mention → music switches at Claude\'s point; stitched delivery names', async () => {
  const plan = mockPlan();
  const P = fx.make();
  const { res, log } = await runPipeline('split', { plan, input: { client: { name: 'Zorblax', assets: [P.appHome], links: [] }, brief: { deliver: 'stitched' } } });
  // "app" is still spoken in take 1 ("Bachatt app pe") → switch at "app"; check log mentions it
  assert.ok(log.lines.some((l) => /first mention "app"/.test(l.msg)));
  assert.deepStrictEqual(res.hostSpec.exports.map((e) => path.basename(e.file)), ['Zorblax_EMI_Ad_H1_Body.mp4', 'Zorblax_EMI_Ad_H2_Body.mp4']);
});

test('E2E rebuild from saved plan (no Claude call)', async () => {
  const { res, settings, env } = await runPipeline('split');
  env.callClaude = () => { throw new Error('should not be called'); };
  const rb = await pipeline.rebuild(res.jobDir, settings, env);
  assert.deepStrictEqual(rb.hostSpec.timelines.map((t) => t.durationTicks), res.hostSpec.timelines.map((t) => t.durationTicks));
});

test('E2E aspect override 1:1 → _square exports', async () => {
  const { res } = await runPipeline('split', { input: { aspect: '1:1' } });
  assert.deepStrictEqual(res.hostSpec.frame, { w: 1080, h: 1080 });
  assert.ok(res.hostSpec.exports.every((e) => /_square\.mp4$/.test(e.file)));
});

// ------------------------------------------------------------------ host.jsx on the mock Premiere DOM
async function hostRun(mockOpts) {
  const { res } = await runPipeline('split');
  const env = mock.makeEnv(mockOpts);
  env.addProjectFile(fx.paths().take1, 'Footage'); // already in project → reused, not re-imported
  const spec = Object.assign({}, res.hostSpec, { presetPath: '/fake/Match Source - High bitrate.epr' });
  const out = env.call('build', spec);
  return { out, env, spec };
}

test('host.jsx: builds timelines, cut check exact, tracks/markers/motion/volume set (units = seconds)', async () => {
  const { out, env, spec } = await hostRun({ units: 'seconds' });
  assert.ok(out.ok, out.error + '\n' + (out.log || []).join('\n'));
  assert.strictEqual(out.units, 'seconds');
  for (const t of out.timelines) assert.strictEqual(t.failed + t.corrected, 0, JSON.stringify(out));
  assert.ok(out.log.some((l) => /Cut check: \d+ exact/.test(l)));
  assert.strictEqual(env.sequences.length, 2);
  const seq = env.sequences[0];
  assert.deepStrictEqual([seq._settings.videoFrameWidth, seq._settings.videoFrameHeight], [1080, 1920]);
  assert.ok(seq._video.length >= 4 && seq._audio.length >= 2, 'V4 / A2 added');
  const tl = spec.timelines[0];
  assert.strictEqual(seq._video[0]._clips.length, tl.clips.filter((c) => c.track === 'V1').length);
  assert.strictEqual(seq._video[1]._clips.length, 1); assert.strictEqual(seq._video[3]._clips.length, 1);
  // motion: V2 split screen position normalised (0.5, 0.2)
  const mo = seq._video[1]._clips[0]._comps.find((c) => c.displayName === 'Motion');
  assert.strictEqual(JSON.stringify(mo.properties[0]._v), '[0.5,0.2]');
  // V1 under split: crop applied via QE
  assert.ok(env.calls.effects.includes('Crop'));
  // markers with colours
  const colors = new Set(seq._markers.map((m) => m.color));
  assert.ok(colors.has(0) && colors.has(1) && colors.has(2) && colors.has(3));
  // music volume -20 dB encoded
  const music1 = seq._audio[1]._clips[0]._comps.find((c) => c.displayName === 'Volume');
  assert.ok(Math.abs(music1.properties[1]._v - Math.pow(10, (-20 - 15) / 20)) < 1e-9);
  // footage already in the project was not imported again
  assert.ok(!env.calls.imports.includes(fx.paths().take1));
  // exports
  const ex = env.call('exportAll', Object.assign({}, spec, { autoStartQueue: true }));
  assert.ok(ex.ok, ex.error);
  assert.strictEqual(env.calls.encode.length, 3);
  const [h1, , body] = env.calls.encode;
  assert.strictEqual(h1.wa, 1); assert.ok(Math.abs(h1.in) < 1e-6 && Math.abs(h1.out - tl.bodyStart) < 1e-6, 'H1 = hook only');
  assert.ok(Math.abs(body.in - tl.bodyStart) < 1e-6 && Math.abs(body.out - tl.duration) < 1e-6 && body.seq === tl.name, 'Body cut from H1 with In/Out');
  assert.strictEqual(env.calls.startBatch, 1);
});

test('host.jsx: in/out in ticks + overwriteClip ignoring out point → corrected, verified', async () => {
  const { out } = await hostRun({ units: 'ticks', ignoreOutPoint: true });
  assert.ok(out.ok, out.error);
  assert.strictEqual(out.units, 'ticks');
  const tot = out.timelines.reduce((a, t) => ({ c: a.c + t.corrected, f: a.f + t.failed }), { c: 0, f: 0 });
  assert.strictEqual(tot.f, 0, out.log.join('\n'));
  assert.ok(tot.c > 0, 'cuts were corrected');
});

test('host.jsx: QE DOM failing silently does not break the build', async () => {
  const { out } = await hostRun({ qeWorks: false, startTracks: { v: 4, a: 2 } });
  assert.ok(out.ok, out.error);
  assert.ok(out.log.some((l) => /could not be applied/.test(l)));
});

test('host.jsx: project browser + selection + non-ASCII round trip', async () => {
  const env = mock.makeEnv();
  env.addProjectFile('/media/टेक 1.mp4', 'Shoot Day 1');
  const lp = env.call('listProject');
  assert.ok(lp.ok && lp.items[0].bin === 'Shoot Day 1' && lp.items[0].path === '/media/टेक 1.mp4');
  const sel = env.call('getSelection');
  assert.ok(sel.ok);
  assert.ok(env.call('ping').ok);
});

// ------------------------------------------------------------------ runner
(async () => {
  const filter = process.argv[2];
  let pass = 0, fail = 0;
  const t0 = Date.now();
  for (const t of tests) {
    if (filter && !t.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const s = Date.now();
    try { await t.fn(); pass++; console.log(`  ✓ ${t.name} (${Date.now() - s} ms)`); }
    catch (e) { fail++; console.log(`  ✗ ${t.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 6).join('\n      ')}`); }
  }
  console.log(`\n${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fail ? 1 : 0);
})();
