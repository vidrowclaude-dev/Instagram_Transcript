'use strict';
// Generate edit: footage → transcripts/silences → assets/links → music → reference → Claude → build spec.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const media = require('./media');
const transcribe = require('./transcribe');
const links = require('./links');
const music = require('./music');
const reference = require('./reference');
const prompt = require('./prompt');
const anthropic = require('./anthropic');
const framing = require('./framing');
const bs = require('./buildspec');
const { parseScript } = require('./text');

function loadFormats(presetsDir) {
  return JSON.parse(fs.readFileSync(path.join(presetsDir, 'formats.json'), 'utf8')).formats;
}

function expandPaths(list) {
  const out = [];
  for (const p of list || []) {
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) out.push(...links.walkFiles(p).filter((f) => media.kindOf(f) !== 'other'));
      else out.push(p);
    } catch (e) { /* missing file: reported later */ out.push(p); }
  }
  return [...new Set(out)];
}

async function facesFor(clip, outputRoot, env, log) {
  if (!env.detectFaces) return null;
  const key = util.fileKey(clip.path, 'faces-v2');
  const cpath = path.join(util.cacheDir(outputRoot, 'faces'), key + '.json');
  let cached = util.readJSON(cpath, null);
  if (!cached) {
    const frames = await media.sampleFrames(clip.path, path.join(util.cacheDir(outputRoot, 'frames'), key), 5, clip.info);
    let detections = [];
    try { detections = await env.detectFaces(frames.map((f) => f.path)); } catch (e) { log.warn(`  face detection failed on ${clip.name}: ${e.message}`); detections = null; }
    cached = { detections: detections || [] , failed: !detections };
    util.writeJSON(cpath, cached);
  }
  const sel = framing.selectFaces(cached.detections || []);
  return sel;
}

async function prepare(input, settings, env) {
  const log = env.log;
  const outputRoot = settings.outputFolder || util.DEFAULT_OUTPUT;
  const jobName = (input.jobName || '').trim() || `Edit ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const jobDir = util.mkdirp(path.join(outputRoot, util.safeName(jobName, 'Job')));
  util.mkdirp(path.join(jobDir, 'Exports'));
  if (settings.ffmpegPath) media.setToolPaths({ ffmpeg: path.join(settings.ffmpegPath, 'ffmpeg'), ffprobe: path.join(settings.ffmpegPath, 'ffprobe') });
  const formats = loadFormats(env.presetsDir);
  const format = formats.find((f) => f.id === input.format) || formats.find((f) => f.id === 'talking_head');
  const script = parseScript(input.scriptText);
  const nLines = ['H1', 'H2', 'H3', 'BODY'].reduce((n, s) => n + script.sections[s].length, 0);
  if (!nLines) throw new Error('The script is empty. Paste it in the Script tab (with Hook 1 / Hook 2 / Hook 3 / Body labels).');
  log(`Script: ${['H1', 'H2', 'H3', 'BODY'].map((s) => `${s} ${script.sections[s].length}`).join(', ')} lines; ${script.callouts.length} callouts, ${script.links.length} links.`);

  // ---- footage
  log.step('1/6 Footage: probing, transcribing, measuring silences');
  const footPaths = expandPaths(input.footage).filter((p) => ['video', 'audio'].includes(media.kindOf(p)) || media.kindOf(p) === 'other');
  if (!footPaths.length) throw new Error('No footage added. Use the Footage tab.');
  const footage = [];
  for (const p of footPaths) {
    if (!fs.existsSync(p)) { log.warn(`  missing file, skipped: ${p}`); continue; }
    let info;
    try { info = await media.probe(p); } catch (e) { log.warn(`  could not read ${path.basename(p)}: ${e.message}`); continue; }
    if (!info.hasVideo && !info.hasAudio) continue;
    const id = 'C' + (footage.length + 1);
    log(`  ${id} ${path.basename(p)} — ${info.width || '?'}x${info.height || '?'} ${info.fps ? info.fps.toFixed(2) + ' fps' : ''} ${info.duration.toFixed(1)} s ${info.codec || ''}${info.alphaPixFmt ? ' (alpha)' : ''}`);
    const tr = await (env.transcribe ? env.transcribe(p, info) : transcribe.transcribeFile(p, info, settings, outputRoot, log));
    const lines = transcribe.groupLines(tr.words);
    const sil = await media.detectSilences(p, outputRoot, log);
    footage.push({ id, path: p, name: path.basename(p), info, words: tr.words, lines, silences: sil.silences, faces: null });
  }
  if (!footage.length) throw new Error('None of the footage files could be read.');
  for (const f of footage) {
    if (!f.info.hasVideo) continue;
    try { f.thumb = await media.thumbnail(f.path, path.join(util.cacheDir(outputRoot, 'thumbs'), util.fileKey(f.path, 'th') + '.jpg'), f.info, f.info.duration / 2); } catch (e) { /* no thumb */ }
  }
  // faces (split screen framing)
  for (const f of footage) {
    if (!f.info.hasVideo) continue;
    f.faces = await facesFor(f, outputRoot, env, log);
    log(`  faces: ${f.id} ${f.faces ? `${f.faces.count} face(s), head box ${(f.faces.union.y0 * 100).toFixed(0)}–${(f.faces.union.y1 * 100).toFixed(0)}% of height` : 'none detected (will use Claude\'s estimate)'}`);
  }

  // ---- assets
  log.step('2/6 Client assets and links');
  let assetPaths = expandPaths(input.client.assets);
  for (const row of input.client.links || []) {
    if (!row.url) continue;
    try {
      log(`  downloading ${row.type || 'link'}: ${row.url}`);
      const got = await links.resolveLink(row, settings, outputRoot, log);
      log(`  → ${got.length} file(s)`);
      assetPaths = assetPaths.concat(got);
    } catch (e) { log.warn(`  ${row.url}: ${e.message}`); }
  }
  assetPaths = [...new Set(assetPaths)].filter((p) => ['image', 'video'].includes(media.kindOf(p)));
  const assets = [];
  for (const p of assetPaths) {
    let info;
    try { info = await media.probe(p); } catch (e) { log.warn(`  could not read asset ${path.basename(p)}: ${e.message}`); continue; }
    if (!info.width) continue;
    const transparent = await media.hasRealAlpha(p, info).catch(() => false);
    const ar = info.width / info.height;
    const appScreen = !transparent && ar >= 0.4 && ar <= 0.62;
    const id = 'A' + (assets.length + 1);
    let thumb = null;
    try { thumb = await media.thumbnail(p, path.join(util.cacheDir(outputRoot, 'thumbs'), util.fileKey(p, 'th') + '.jpg'), info); } catch (e) { /* ignore */ }
    assets.push({ id, path: p, name: path.basename(p), info, transparent, appScreen, thumb });
    log(`  ${id} ${path.basename(p)} — ${info.kind} ${info.width}x${info.height}${transparent ? ' · transparent graphic' : ''}${appScreen ? ' · app screen' : ''}`);
  }

  // ---- music
  log.step('3/6 Music library');
  const musicCfg = Object.assign({ library: '', track1: 'None', track2: 'None', start: 'first', level: -20 }, input.music || {});
  let musicC = { list: [], genres: [] };
  try { musicC = await music.candidates(musicCfg, settings, outputRoot, log, jobName); }
  catch (e) { log.warn(`  music library: ${e.message}`); }
  musicC.list.forEach((m) => log(`  ${m.id} [${m.genre}] ${m.relPath}`));

  // ---- reference
  let ref = null;
  if (input.reference && (input.reference.url || input.reference.path)) {
    log.step('4/6 Reference ad');
    ref = await reference.analyse(input.reference, settings, outputRoot, log);
  } else log.step('4/6 Reference ad: none');

  return {
    jobName, jobDir, outputRoot, format, script, scriptText: input.scriptText, footage, assets,
    client: Object.assign({ name: '', calloutStyle: 'white', brandColor: '', brandNotes: '' }, input.client, { assets: undefined, links: undefined }),
    calloutStyle: (input.client && input.client.calloutStyle) || 'white',
    aspect: input.aspect || format.aspect || '9:16', appScreens: input.appScreens || 'split',
    musicCfg, music: musicC, reference: ref, brief: Object.assign({ deliver: 'separate', autoExport: false }, input.brief || {}),
    presetPath: settings.presetPath || '',
  };
}

function applyClaudeFaces(job, plan, log) {
  for (const f of job.footage) {
    if (f.faces || !f.info.hasVideo) continue;
    const est = (plan.faces || []).find((x) => x.clip === f.id);
    if (est && est.bottom > est.top) {
      f.faces = { union: { x0: 0.3, x1: 0.7, y0: Math.max(0, est.top), y1: Math.min(1, est.bottom) }, biggest: { x0: 0.3, x1: 0.7, y0: Math.max(0, est.top), y1: Math.min(1, est.bottom) }, count: 1, fromClaude: true };
      log(`  faces: ${f.id} using Claude's estimate ${(est.top * 100).toFixed(0)}–${(est.bottom * 100).toFixed(0)}%`);
    }
  }
}

async function build(job, plan, settings, env) {
  const log = env.log;
  log.step('6/6 Building timelines spec');
  applyClaudeFaces(job, plan, log);
  const spec = await bs.buildSpec(job, plan, env);
  await bs.addMusic(spec, (m) => music.fetchTrack(m, settings, job.outputRoot, log), log);
  const exportsList = bs.exportsFor(spec, job.brief.deliver, path.join(job.jobDir, 'Exports'));
  const hostSpec = bs.toHostSpec(spec, job, exportsList);
  hostSpec.autoExport = !!job.brief.autoExport;
  hostSpec.autoStartQueue = settings.autoStartQueue !== false;
  const specPath = util.writeJSON(path.join(job.jobDir, 'build_spec.json'), hostSpec);
  const summary = bs.summary(spec);
  util.writeJSON(path.join(job.jobDir, 'last_edit.json'), { at: new Date().toISOString(), summary, planSummary: spec.plan.summary, warnings: spec.warnings, specPath });
  log(`Wrote ${path.basename(specPath)} (${hostSpec.timelines.length} timelines, ${hostSpec.media.length} media files).`);
  return { hostSpec, specPath, summary, planSummary: spec.plan.summary, warnings: spec.warnings };
}

function saveJob(job) {
  const slim = Object.assign({}, job);
  util.writeJSON(path.join(job.jobDir, 'job.json'), slim);
}

async function generate(input, settings, env) {
  const log = env.log;
  const job = await prepare(input, settings, env);
  saveJob(job);
  log.step(`5/6 Claude (${input.model || settings.defaultModel}, ${input.effort || 'high'} effort) — this can take several minutes`);
  const system = prompt.buildSystem(env.presetsDir, job.format, job.brief);
  const content = prompt.buildUserContent(job);
  util.writeJSON(path.join(job.jobDir, 'claude_request_preview.json'), { system, content: content.map((b) => (b.type === 'image' ? { type: 'image', omitted: true } : b)) });
  let res;
  if (env.callClaude) res = await env.callClaude({ system, content, tool: prompt.PLAN_TOOL, job });
  else {
    if (!settings.anthropicKey) throw new Error('No Anthropic API key. Add it in ⚙ Settings.');
    let chars = 0; const t0 = Date.now();
    res = await anthropic.requestPlan({
      apiKey: settings.anthropicKey, model: input.model || settings.defaultModel, effort: input.effort || 'high',
      system, content, tool: prompt.PLAN_TOOL, log,
      onEvent: (type, j) => {
        if (type === 'content_block_start' && j.content_block && j.content_block.type === 'tool_use') log('  Claude is writing the edit plan…');
        if (type === 'content_block_delta' && j.delta && j.delta.partial_json) { chars += j.delta.partial_json.length; }
        if (type === 'message_stop') log(`  Claude finished in ${Math.round((Date.now() - t0) / 1000)} s.`);
      },
    });
    const u = res.usage.reduce((a, x) => ({ in: a.in + (x.input_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation_input_tokens || 0), out: a.out + (x.output_tokens || 0) }), { in: 0, out: 0 });
    log(`  tokens: ${u.in} in, ${u.out} out`);
  }
  util.writeJSON(path.join(job.jobDir, 'claude_plan.json'), res.plan);
  if (res.plan.summary) log(`Claude: ${res.plan.summary}`);
  const out = await build(job, res.plan, settings, env);
  return Object.assign({ jobDir: job.jobDir, job }, out);
}

// Rebuild from the last saved plan, without calling Claude.
async function rebuild(jobDir, settings, env) {
  const job = util.readJSON(path.join(jobDir, 'job.json'), null);
  const plan = util.readJSON(path.join(jobDir, 'claude_plan.json'), null);
  if (!job || !plan) throw new Error(`No saved plan in ${jobDir}. Run Generate edit first.`);
  env.log(`Rebuilding ${path.basename(jobDir)} from the saved plan (no Claude call).`);
  if (settings.ffmpegPath) media.setToolPaths({ ffmpeg: path.join(settings.ffmpegPath, 'ffmpeg'), ffprobe: path.join(settings.ffmpegPath, 'ffprobe') });
  job.outputRoot = job.outputRoot || settings.outputFolder || util.DEFAULT_OUTPUT;
  // footage faces may have been computed after; recompute from cache
  for (const f of job.footage) if (f.info.hasVideo && !f.faces) f.faces = await facesFor(f, job.outputRoot, env, env.log);
  const out = await build(job, plan, settings, env);
  return Object.assign({ jobDir, job }, out);
}

module.exports = { generate, rebuild, prepare, build, loadFormats, expandPaths };
