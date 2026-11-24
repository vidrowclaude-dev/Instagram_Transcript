# Vidrow Edit Kit — notes for Claude

Internal Premiere Pro CEP panel for Vidrow (Bengaluru performance-marketing agency). Script + raw takes + format + assets + music + brief → Claude edit plan (`submit_edit_plan` tool) → exact build spec → ExtendScript builds timelines in the open project → Media Encoder exports.

## Layout
```
extension/                     the CEP extension (installed as co.vidrow.editkit)
  CSXS/manifest.xml            --enable-nodejs --mixed-context; ScriptPath jsx/host.jsx
  index.html, css/panel.css    panel UI (dark; lime #F5FA5E, purple #715BE4)
  js/panel/                    browser side: app.js (UI, drafts, flow), cep.js (CSInterface subset), bridge.js (evalScript JSON),
                               paste.js (Google Docs rich paste → [LINK:]/[CALLOUT:]), renderers.js (canvas callouts + phone frame),
                               faces.js (face-api loader: Node globals hidden, weights via tf.io.decodeWeights)
  js/node/                     pipeline (CommonJS, runs in CEP's Node):
    pipeline.js                generate()/rebuild(): orchestrates everything, writes job.json, claude_plan.json, build_spec.json
    http.js                    own HTTPS client (no fetch in CEP): retries EPIPE/ECONNRESET/timeouts ×2, surfaces server replies
    anthropic.js               streaming Messages API, tool_choice auto + one nudge, effort fallback, models list, cost estimate
    transcribe.js              whisper-1 verbose_json word timestamps (chunks <25 MB) or whisper.cpp; groupLines (0.25 s / 10 words)
    media.js                   ffprobe/ffmpeg: probe, real alpha check (alphaextract), adaptive silencedetect, thumbnails, exact renders
    text.js                    script parsing, fillers/director words, coverage
    cuts.js                    segment → frame-exact source cuts (word snap, fillers, edge trim, pauses, measured silences)
    framing.js                 face selection, footage framing into a window, split band / phone / graphic geometry
    buildspec.js               plan → timelines (Hook N + Body), overlays, callouts, markers, music switch, exports, host spec
    links.js, music.js, reference.js, prompt.js, settings.js, util.js
  jsx/host.jsx                 ExtendScript (ES3!) — import, sequences, place + verify cuts, motion, effects, markers, exports
  presets/formats.json         six formats (from the Google Doc "Vidrow Edit guidelines"); guidelines.md general rules
  lib/faceapi/                 @vladmandic/face-api browser bundle + SSD MobileNet + Tiny Face Detector weights
tests/                         run.js (unit + E2E + host.jsx on mock DOM), screenshot.js (Playwright UI check), fixtures (ffmpeg)
Install Vidrow Edit Kit.command, scripts/package.sh → dist/Vidrow_Edit_Kit.zip
```

## Checks (run after every change)
```
npm install                 # acorn (dev only)
npm run check:jsx           # host.jsx must be ES3: acorn --ecma3 + banned ES5 methods
npm test                    # check:jsx + node tests/run.js  (VERBOSE=1 to print pipeline logs; arg filters by name)
node tests/screenshot.js    # Playwright: screenshots in tests/screenshots, paste/renderers/face-api in Chromium
npm run package             # dist/Vidrow_Edit_Kit.zip
```
Tests need ffmpeg. Transcription and Claude are mocked (env.transcribe / env.callClaude); the panel renderers are mocked by tests/mock-renderers.js.

## Rules the code enforces (don't regress)
- One timeline per hook `Client_Ad_H1..3` = Hook N + Body; red BODY STARTS marker at the join. Never separate hook/body sequences.
- Claude references transcript line ranges (`clip`, `from_line`, `to_line`, optional start/end snapped to words) — never free times.
- Gaps: measured silences (silencedetect, threshold = mean −16 dB clamped −55…−28, d=0.12) removed at cut ends and inside cuts when ≥0.15 s (pad 0.05) unless `keep_pauses`. Formats with `pause_cut_seconds: null` (Skit) default to keep_pauses.
- Fillers/director talk removed; off-script edge words trimmed only if take matches script ≥75% and a ≥0.2 s pause separates them; आ/अ/aa are not fillers. Boundaries next to removed words round inward to frames.
- Punch-in alternation on same-take jumps if the format allows.
- Music: never corporate (music.js CORPORATE regex); tab music always added even if the format says no music; Track 1 from first frame; Track 2 at first app/client/"app" mention snapped to a cut within 0.8 s → else Claude's switch point → else first app screen; immediate mention → Track 2 from start.
- Transparent assets → V3, top at 52% height, 90% width, fitted (full-frame ones as designed); never split screen.
- App screens = opaque & aspect 0.4–0.62, or `asset_type: app_screen`. Modes: full / phone (canvas frame ~94% height, recording in the transparent hole, V1 Gaussian blur 60) / split (screen strictly top 40% = 1080×768 at 9:16, pre-cropped by ffmpeg with focus_y; V1 framed so faces sit in the bottom 60%).
- Everything exact is pre-rendered to frame size (or the exact band) and placed at Scale 100, centred. QE DOM (blur, crop, addTracks) is best-effort only.
- Callouts: canvas PNG, chosen style, V4, ~15% down. `[LINK:]` with no matching asset → purple `SCREENSHOT NEEDED: url` marker.
- Markers: green script lines, orange callouts/text, purple editor to-dos.

## Pitfalls (these bit us before)
- **host.jsx is ES3**: no let/const/arrows/template strings/forEach/map/indexOf/trim/JSON. Uses its own JSON helper; data comes in via `VEKBridge.toArg` (JSON string literal, non-ASCII → \uXXXX).
- Ticks = 254016000000/s. ProjectItem.setInPoint units differ by version → `detectUnits()`; every cut is verified on the timeline after placing and corrected (log "Cut check: N exact").
- Opus 5.5 rejects `tool_choice` any/tool → use auto + instruction + one nudge turn that replays the assistant content (thinking blocks unchanged).
- Effort goes in `output_config.effort`; rejected level → step down to high; rejected field → drop and log. max_tokens 32000 (64000 for xhigh/max). 30-min timeout; streaming SSE.
- `fallbacks: "default"` (beta server-side-fallback-2026-07-01) is sent for Opus/Fable/Sonnet; dropped automatically if rejected.
- CEP Node has no fetch; GUI PATH lacks Homebrew (util.js adds /opt/homebrew/bin, /usr/local/bin).
- face-api must be evaluated with require/module/exports/process/define hidden or it picks the Node build.
- Default Media Scaling must be None (README tells editors).
- Cache: transcripts, silences, faces, downloads, Drive listings, renders under `<output>/.cache` and `<job>/Renders`.
