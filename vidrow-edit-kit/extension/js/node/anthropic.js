'use strict';
// Claude Messages API over our own HTTPS client (CEP's Node has no fetch).
// Streaming SSE so 30-minute high-effort turns don't sit on an idle socket.
const http = require('./http');
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, cacheDir } = require('./util');

const API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', in: 4, out: 20, fallbacks: true },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', in: 8, out: 40, fallbacks: true },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', in: 2, out: 10, fallbacks: true },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', in: 0.1, out: 0.5, fallbacks: false },
];
const EFFORTS = [
  { id: 'low', hint: 'Fastest and cheapest. Fine for simple talking-head cuts.' },
  { id: 'medium', hint: 'Quicker, a little less careful with take choice.' },
  { id: 'high', hint: 'Recommended. Careful take choice and timing (a few minutes).' },
  { id: 'xhigh', hint: 'Extra careful on long or messy footage; slower, costs more.' },
  { id: 'max', hint: 'Slowest and most expensive. Only when nothing else gets it right.' },
];
const OUT_TOKENS_BY_EFFORT = { low: 6000, medium: 12000, high: 20000, xhigh: 35000, max: 55000 };

// Rough cost per edit: ~60k input tokens (script, transcripts, thumbnails) + effort-dependent output.
function estimateCost(modelId, effort) {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) return null;
  const inTok = 60000, outTok = OUT_TOKENS_BY_EFFORT[effort] || 20000;
  const c = (inTok * m.in + outTok * m.out) / 1e6;
  return { low: c * 0.5, high: c * 1.8, mid: c };
}
function costLabel(modelId, effort) {
  const e = estimateCost(modelId, effort);
  if (!e) return 'cost depends on model pricing';
  const f = (x) => '$' + (x < 0.1 ? x.toFixed(3) : x.toFixed(2));
  return `≈ ${f(e.low)}–${f(e.high)} per edit at ${effort} effort (depends on effort and footage length)`;
}

function headers(apiKey, betas) {
  const h = { 'x-api-key': apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json', accept: 'text/event-stream' };
  if (betas && betas.length) h['anthropic-beta'] = betas.join(',');
  return h;
}

// Parse SSE into a final message (content blocks rebuilt exactly, including thinking signatures).
function sseCollector(onEvent) {
  let buf = '';
  const msg = { content: [], stop_reason: null, usage: {} };
  const partial = {};
  let streamError = null;
  const handle = (ev, data) => {
    let j; try { j = JSON.parse(data); } catch (e) { return; }
    if (onEvent) onEvent(ev || j.type, j);
    switch (j.type) {
      case 'message_start': Object.assign(msg, j.message, { content: [] }); break;
      case 'content_block_start': msg.content[j.index] = JSON.parse(JSON.stringify(j.content_block)); if (j.content_block.type === 'tool_use') partial[j.index] = ''; break;
      case 'content_block_delta': {
        const b = msg.content[j.index]; const d = j.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') b.text = (b.text || '') + d.text;
        else if (d.type === 'input_json_delta') partial[j.index] += d.partial_json;
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
        else if (d.type === 'citations_delta') { b.citations = b.citations || []; b.citations.push(d.citation); }
        break;
      }
      case 'content_block_stop': {
        const b = msg.content[j.index];
        if (b && b.type === 'tool_use') {
          const raw = partial[j.index];
          try { b.input = raw ? JSON.parse(raw) : (b.input || {}); } catch (e) { b.input = null; b._invalidJson = raw; }
        }
        break;
      }
      case 'message_delta':
        if (j.delta) { if (j.delta.stop_reason) msg.stop_reason = j.delta.stop_reason; if (j.delta.stop_details) msg.stop_details = j.delta.stop_details; }
        if (j.usage) Object.assign(msg.usage, j.usage);
        break;
      case 'error': streamError = j.error || j; break;
      default: break;
    }
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = null; const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) handle(ev, data.join('\n'));
      }
    },
    result() { msg.content = msg.content.filter(Boolean); return { msg, streamError }; },
  };
}

async function streamOnce(body, opts) {
  const betas = [];
  if (body.fallbacks) betas.push(FALLBACK_BETA);
  const payload = Buffer.from(JSON.stringify(Object.assign({}, body, { stream: true })));
  const col = sseCollector(opts.onEvent);
  let aborted = false;
  if (opts.signal) opts.signal.onabort = () => { aborted = true; };
  await http.request((opts.baseUrl || API) + '/v1/messages', {
    method: 'POST', body: payload, headers: headers(opts.apiKey, betas), service: 'Anthropic API',
    timeoutMs: opts.timeoutMs || 30 * 60 * 1000, log: opts.log, retries: 2,
    onResponse: (res, done) => {
      res.setEncoding('utf8');
      res.on('data', (d) => { if (aborted) { res.destroy(); return; } col.feed(d); });
      res.on('end', () => done(null, { status: res.statusCode }));
    },
  });
  const { msg, streamError } = col.result();
  if (streamError) {
    const e = new http.HttpError(`Anthropic API stream error: ${streamError.message || streamError.type || JSON.stringify(streamError)}`, { status: streamError.type === 'overloaded_error' ? 529 : 500, streamType: streamError.type });
    throw e;
  }
  return msg;
}

// Send with automatic downgrades: effort → high → dropped; fallbacks/thinking dropped if rejected.
async function send(body, opts) {
  const log = opts.log || (() => {});
  body = JSON.parse(JSON.stringify(body));
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return { msg: await streamOnce(body, opts), body };
    } catch (e) {
      const text = String(e.bodyText || e.message || '');
      if (e.status === 400) {
        if (/effort/i.test(text) && body.output_config && body.output_config.effort && body.output_config.effort !== 'high' && !/output_config.*(extra|not permitted|unknown|unexpected)/i.test(text)) {
          log.warn(`Model ${body.model} rejected effort "${body.output_config.effort}"; stepping down to high.`);
          body.output_config.effort = 'high'; continue;
        }
        if (/output_config|effort/i.test(text) && body.output_config) {
          log.warn(`Model ${body.model} does not accept the effort setting; sending without it. (${text.slice(0, 160)})`);
          delete body.output_config; continue;
        }
        if (/fallback/i.test(text) && body.fallbacks) {
          log.warn('Server-side refusal fallbacks not available for this account/model; continuing without them.');
          delete body.fallbacks; continue;
        }
        if (/thinking/i.test(text) && body.thinking) {
          log.warn(`Model ${body.model} rejected adaptive thinking; sending without it.`);
          delete body.thinking; continue;
        }
        if (/tool_choice/i.test(text) && body.tool_choice && body.tool_choice.type !== 'auto') { body.tool_choice = { type: 'auto' }; continue; }
      }
      if ((e.status === 529 || e.streamType === 'overloaded_error') && attempt < 3) {
        log.warn('Anthropic API is overloaded; retrying in 20 s…');
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Anthropic API: gave up after repeated request adjustments.');
}

/**
 * Ask Claude for the plan via the submit_edit_plan tool. tool_choice auto (Opus 5.5 rejects forced tools);
 * if Claude answers without the tool, one nudge turn that keeps its thinking blocks.
 */
async function requestPlan({ apiKey, model, effort, system, content, tool, log, onEvent, baseUrl, timeoutMs }) {
  const m = MODELS.find((x) => x.id === model);
  const maxTokens = (effort === 'xhigh' || effort === 'max') ? 64000 : 32000;
  const body = {
    model, max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    tools: [tool],
    tool_choice: { type: 'auto' },
    thinking: { type: 'adaptive' },
    output_config: { effort: effort || 'high' },
  };
  if (!m || m.fallbacks) body.fallbacks = 'default';
  const opts = { apiKey, log, onEvent, baseUrl, timeoutMs };
  let { msg, body: sent } = await send(body, opts);
  const usage = [msg.usage];
  const findTool = (mm) => (mm.content || []).find((b) => b.type === 'tool_use' && b.name === tool.name);
  checkStop(msg);
  let call = findTool(msg);
  if (!call || !call.input) {
    log.warn(call ? 'Claude sent an incomplete plan; asking it to resend.' : 'Claude answered without calling submit_edit_plan; nudging it once.');
    const textSoFar = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (textSoFar) log(`Claude said: ${textSoFar.slice(0, 400)}`);
    const assistantContent = (msg.content || []).map((b) => {
      const c = Object.assign({}, b); delete c._invalidJson;
      if (c.type === 'tool_use' && !c.input) c.input = {};
      return c;
    });
    const next = Object.assign({}, sent, {
      messages: sent.messages.concat([
        { role: 'assistant', content: assistantContent },
        { role: 'user', content: call
          ? [{ type: 'tool_result', tool_use_id: call.id, is_error: true, content: 'The plan JSON was incomplete or invalid. Call submit_edit_plan again with the complete plan.' }]
          : [{ type: 'text', text: 'Please call the submit_edit_plan tool now with the complete edit plan. Do not reply in text.' }] },
      ]),
    });
    ({ msg } = await send(next, opts));
    usage.push(msg.usage);
    checkStop(msg);
    call = findTool(msg);
    if (!call || !call.input) throw new Error('Claude did not return an edit plan (no submit_edit_plan call). Try again, or try another model / higher effort.');
  }
  return { plan: call.input, usage, model: msg.model || model, stopReason: msg.stop_reason };
}

function checkStop(msg) {
  if (msg.stop_reason === 'refusal') {
    const d = msg.stop_details || {};
    throw new Error(`Claude declined this request${d.category ? ` (${d.category})` : ''}${d.explanation ? ': ' + d.explanation : ''}.`);
  }
  if (msg.stop_reason === 'max_tokens' && !(msg.content || []).some((b) => b.type === 'tool_use' && b.input)) {
    throw new Error('Claude ran out of output space before finishing the plan. Lower the effort or shorten the footage list, then try again.');
  }
}

// Models the account can use (cached 24 h); merged with the built-in list.
async function listModels(apiKey, outputRoot, opts) {
  opts = opts || {};
  const cpath = path.join(cacheDir(outputRoot), 'models.json');
  const cached = readJSON(cpath, null);
  if (cached && !opts.refresh && Date.now() - cached.at < 24 * 3600 * 1000) return merge(cached.data);
  if (!apiKey) return merge([]);
  try {
    const out = [];
    let after = '';
    for (let i = 0; i < 5; i++) {
      const j = await http.json(`${opts.baseUrl || API}/v1/models?limit=100${after ? '&after_id=' + after : ''}`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION }, service: 'Anthropic Models API', retries: 1, timeoutMs: 20000,
      });
      for (const m of j.data || []) out.push({ id: m.id, name: m.display_name || m.id });
      if (!j.has_more) break;
      after = j.last_id;
    }
    writeJSON(cpath, { at: Date.now(), data: out });
    return merge(out);
  } catch (e) {
    return merge(cached ? cached.data : []);
  }
  function merge(remote) {
    const list = MODELS.map((m) => ({ id: m.id, name: m.name, builtin: true }));
    for (const r of remote) if (!list.find((x) => x.id === r.id)) list.push({ id: r.id, name: r.name });
    return list;
  }
}

module.exports = { MODELS, EFFORTS, requestPlan, send, sseCollector, listModels, estimateCost, costLabel, FALLBACK_BETA };
