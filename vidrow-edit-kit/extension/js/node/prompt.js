'use strict';
// System prompt + user content + the submit_edit_plan tool.
const fs = require('fs');
const path = require('path');
const { fmtLine } = require('./transcribe');

const SEG_REF = { type: 'string', description: 'Segment reference "SECTION.index", e.g. "H1.0" or "BODY.3" (0-based index into that section\'s segments).' };

const PLAN_TOOL = {
  name: 'submit_edit_plan',
  description: 'Submit the complete edit plan for all hooks and the body. Call this exactly once with the full plan.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['sections', 'overlays', 'callouts', 'editor_notes', 'music', 'faces', 'summary'],
    properties: {
      summary: { type: 'string', description: 'Two or three sentences for the editor: hooks chosen, takes, anything to check.' },
      sections: {
        type: 'array', description: 'H1, H2, H3 (as many hooks as the script has) and BODY, each an ordered list of segments.',
        items: {
          type: 'object', additionalProperties: false, required: ['name', 'segments'],
          properties: {
            name: { type: 'string', enum: ['H1', 'H2', 'H3', 'BODY'] },
            segments: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['clip', 'from_line', 'to_line'],
                properties: {
                  clip: { type: 'string', description: 'Footage id, e.g. "C3".' },
                  from_line: { type: 'integer', description: 'First transcript line number (the N in LN) of that clip.' },
                  to_line: { type: 'integer', description: 'Last transcript line number (inclusive).' },
                  start: { type: 'number', description: 'Optional: start time (s) inside from_line, to drop leading words. Snapped to a word boundary.' },
                  end: { type: 'number', description: 'Optional: end time (s) inside to_line, to drop trailing words. Snapped to a word boundary.' },
                  zoom: { type: 'number', description: 'Optional framing scale for this segment, 1.0 = default, 1.12 = punch-in.' },
                  keep_pauses: { type: 'boolean', description: 'true only if pauses carry on-screen action (reaction, demo, gag, comic beat).' },
                  script_line: { type: 'string', description: 'The script line this segment delivers (short).' },
                },
              },
            },
          },
        },
      },
      overlays: {
        type: 'array', description: 'Assets shown over the footage.',
        items: {
          type: 'object', additionalProperties: false, required: ['asset', 'segment', 'offset', 'duration'],
          properties: {
            asset: { type: 'string', description: 'Asset id, e.g. "A4".' },
            segment: SEG_REF,
            offset: { type: 'number', description: 'Seconds after that segment starts on the timeline (after gap removal). Use the word timing inside the segment to land on the spoken word.' },
            duration: { type: 'number', description: 'Seconds on screen (>= 1.5).' },
            layout: { type: 'string', enum: ['fullscreen', 'split', 'center_card', 'pip_top_right', 'phone'], description: 'For app screens the APP SCREENS mode overrides this.' },
            src_start: { type: 'number', description: 'For video assets: where to start inside the asset (s).' },
            asset_type: { type: 'string', enum: ['app_screen', 'graphic', 'product', 'broll', 'screenshot', 'end_card', 'logo'] },
            focus_y: { type: 'number', description: '0..1: centre of the band of a tall screen to show in split screen (0 = top, 1 = bottom).' },
          },
        },
      },
      callouts: {
        type: 'array', description: 'One per [CALLOUT: ...] in the script (and any text callout the format requires).',
        items: { type: 'object', additionalProperties: false, required: ['text', 'segment', 'offset', 'duration'],
          properties: { text: { type: 'string' }, segment: SEG_REF, offset: { type: 'number' }, duration: { type: 'number' } } },
      },
      links: {
        type: 'array', description: 'One per [LINK: url] in the script: the asset that shows it, or null if no matching screenshot exists.',
        items: { type: 'object', additionalProperties: false, required: ['url', 'segment'],
          properties: { url: { type: 'string' }, asset: { type: ['string', 'null'] }, segment: SEG_REF, offset: { type: 'number' } } },
      },
      editor_notes: {
        type: 'array', description: 'To-dos for the editor (SFX, risers, captions, roto, missing lines/screens). Become purple markers.',
        items: { type: 'object', additionalProperties: false, required: ['note'],
          properties: { note: { type: 'string' }, segment: SEG_REF, offset: { type: 'number' }, kind: { type: 'string', enum: ['sfx', 'riser', 'screenshot', 'caption', 'roto', 'missing', 'todo'] } } },
      },
      music: {
        type: 'object', additionalProperties: false,
        properties: {
          asset: { type: ['string', 'null'], description: 'Track 1 candidate id (M1..), or null for no music.' },
          volume_db: { type: 'number' },
          start: { type: 'number', description: 'Offset into the track (s) to start from.' },
          switch_asset: { type: ['string', 'null'], description: 'Track 2 candidate id.' },
          switch_segment: SEG_REF,
          switch_offset: { type: 'number', description: 'Where Track 2 should take over if nobody names the app/client.' },
        },
      },
      faces: {
        type: 'array', description: 'Fallback face estimate per clip from the thumbnails: vertical extent of all faces (incl. hair/chin) as 0..1 of the frame height.',
        items: { type: 'object', additionalProperties: false, required: ['clip', 'top', 'bottom'],
          properties: { clip: { type: 'string' }, top: { type: 'number' }, bottom: { type: 'number' } } },
      },
    },
  },
};

function buildSystem(presetsDir, format, brief) {
  const guidelines = fs.readFileSync(path.join(presetsDir, 'guidelines.md'), 'utf8');
  const f = format;
  const fmt = [
    `# Format: ${f.name} — ${f.tagline}`,
    `Pace: ${f.pace}. Screens: ${f.screens}. Main layout: ${f.main_layout}. Allowed layouts: ${f.allowed_layouts.join(', ')}.`,
    `Screen coverage of Body: ${f.screen_coverage}.`,
    `Pause cutting: ${f.pause_cut_seconds == null ? 'Off (keep performance timing; set keep_pauses on segments with comic/dramatic beats — the tool keeps pauses by default for this format)' : 'pauses longer than ' + f.pause_cut_seconds + ' s are never acceptable; the tool removes every measured pause >= 0.15 s unless keep_pauses'}.`,
    `Punch-ins: ${f.punch_ins.enabled ? 'on, alternate ' + f.punch_ins.scales.join(' / ') : 'off'}${f.punch_ins.notes ? ' (' + f.punch_ins.notes + ')' : ''}.`,
    `Hook length: ${brief.maxHook ? 'max ' + brief.maxHook : f.hook_range.join('–')} s. Body length: ${brief.maxBody ? 'max ' + brief.maxBody : f.body_range.join('–')} s.`,
    `Music: ${f.music.notes}`,
    '',
    f.guidance,
  ].join('\n');
  const how = `# How to answer
You are the senior editor at Vidrow, a performance-marketing video agency in Bengaluru. You receive a script, word-timed transcripts of every raw take (numbered lines per clip), the client's assets, music candidates, an optional reference ad and the brief. Decide the edit; the Edit Kit then builds it in Premiere Pro.

- Follow the script strictly and in order. For each script line pick the best complete, fluent take and reference it by clip id and transcript line numbers (from_line..to_line). Never invent times outside those lines; use start/end only to trim words inside the first/last line.
- One segment per contiguous stretch of a single take. Split a line across segments only when you switch takes.
- Hooks: build H1, H2, H3 from the script's Hook 1/2/3 (only those that exist). Each must lead naturally into BODY.0 and must not repeat it. BODY contains everything from the first line after the hook to the CTA.
- The tool removes fillers, director talk and pauses automatically. Mark keep_pauses only where a pause carries on-screen action.
- Overlays: place each screen exactly when its words are spoken (feature, price, offer, number, app name, CTA), >= 1.5 s on screen. Offsets are seconds from the start of the referenced segment on the final timeline; because gaps are removed, estimate from word timings minus removed pauses. Transparent assets are graphics (V3), never split screen. Mark app screens asset_type "app_screen" (portrait screenshots/recordings, or landscape recordings of the app). For split screen set focus_y to the band of the screen that matters (offer, feature, button).
- Callouts: one entry per [CALLOUT: ...] at the line it belongs to.
- Links: one entry per [LINK: url]; give the matching screenshot asset id if one exists, else null.
- Music: pick Track 1 and Track 2 only from the music candidates (ids M1..), matching the genres asked for; never anything corporate. Give switch_segment/offset as a fallback for where Track 2 should start if nobody names the app.
- faces: for every clip, the vertical extent of all faces (with hair and chin) as fractions of the frame height, judged from the thumbnails.
- editor_notes: SFX, risers, captions, roto, missing script lines or screens. Be brief.
- If a reference ad is given, follow its pacing, cut rhythm and style over the format guidelines.
- Respond by calling submit_edit_plan once with the complete plan. Do not reply in plain text.`;
  return [how, guidelines, fmt].join('\n\n---\n\n');
}

function imageBlock(file) {
  const data = fs.readFileSync(file).toString('base64');
  const ext = path.extname(file).toLowerCase();
  return { type: 'image', source: { type: 'base64', media_type: ext === '.png' ? 'image/png' : 'image/jpeg', data } };
}

// Build user content blocks
function buildUserContent(job) {
  const c = [];
  const t = (s) => c.push({ type: 'text', text: s });
  t(`# Job: ${job.jobName}\nClient: ${job.client.name || '(not given)'}\nAspect: ${job.aspect}\nAPP SCREENS mode: ${job.appScreens} (full = screen covers frame; phone = inside a phone frame over blurred footage; split = screen in the top 40%, speaker in the bottom 60%).\nDeliver: ${job.brief.deliver === 'stitched' ? 'stitched Hook+Body files' : 'separate Hook 1/2/3 + Body files'}.`);
  t(`# Script (as pasted)\n${job.scriptText}\n\n# Script parsed\n` + ['H1', 'H2', 'H3', 'BODY'].map((s) =>
    job.script.sections[s].length ? `${s}:\n` + job.script.sections[s].map((l) => `  ${s}#${l.idx}: ${l.text}`).join('\n') : `${s}: (none)`).join('\n') +
    (job.script.callouts.length ? `\nCallouts:\n` + job.script.callouts.map((x) => `  ${x.section}#${x.line}: ${x.text}`).join('\n') : '') +
    (job.script.links.length ? `\nLinks:\n` + job.script.links.map((x) => `  ${x.section}#${x.line}: ${x.url}`).join('\n') : ''));
  t('# Footage (transcripts, numbered lines per clip)');
  for (const f of job.footage) {
    const head = `## ${f.id} — ${f.name} (${f.info.width}x${f.info.height}, ${(f.info.fps || 0).toFixed(2)} fps, ${f.info.duration.toFixed(1)} s)`;
    const body = f.lines.length ? f.lines.map(fmtLine).join('\n') : '(no speech detected)';
    t(`${head}\n${body}`);
    if (f.thumb) { c.push(imageBlock(f.thumb)); }
  }
  if (job.assets.length) {
    t('# Client assets');
    for (const a of job.assets) {
      const tags = [a.info.kind, `${a.info.width}x${a.info.height}`];
      if (a.info.kind === 'video') tags.push(`${a.info.duration.toFixed(1)} s`);
      if (a.transparent) tags.push('TRANSPARENT graphic (goes on V3, never split)');
      if (a.appScreen) tags.push('app screen (portrait, opaque)');
      t(`${a.id} — ${a.name} [${tags.join(', ')}]`);
      if (a.thumb) c.push(imageBlock(a.thumb));
    }
  } else t('# Client assets\n(none)');
  if (job.music.list.length) {
    t(`# Music candidates (genres asked: Track 1 = ${job.musicCfg.track1}, Track 2 = ${job.musicCfg.track2})\n` + job.music.list.map((m) => `${m.id} [${m.genre}] ${m.relPath}`).join('\n'));
  } else t(`# Music\n${[job.musicCfg.track1, job.musicCfg.track2].some((g) => g && g !== 'None') ? 'No matching tracks were found; set music.asset to null.' : 'No music requested; set music.asset to null.'}`);
  if (job.reference) {
    const r = job.reference;
    if (r.error) t(`# Reference ad\nCould not be analysed: ${r.error}. Follow the format guidelines.`);
    else {
      t(`# Reference ad (follow its pacing and style over the format guidelines)\nDuration ${r.duration.toFixed(1)} s, ${r.cuts.length} cuts, average shot ${r.avgShot.toFixed(2)} s.\nCut times: ${r.cuts.map((x) => x.toFixed(2)).join(', ')}\nKey frames follow in order.`);
      for (const k of r.frames) c.push(imageBlock(k));
    }
  }
  t(`# Brief\n${job.brief.text || '(none)'}\nClient brand notes: ${job.client.brandNotes || '(none)'}\nMax hook: ${job.brief.maxHook || 'format default'} s; max body: ${job.brief.maxBody || 'format default'} s.\n\nNow call submit_edit_plan.`);
  return c;
}

module.exports = { PLAN_TOOL, buildSystem, buildUserContent };
