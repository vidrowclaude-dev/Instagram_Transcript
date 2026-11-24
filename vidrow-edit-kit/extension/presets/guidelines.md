# Vidrow general editing guidelines

<!-- Source: Google Doc "Vidrow Edit guidelines" (general section) plus the Edit Kit's enforced rules.
     This whole file is sent to Claude as part of the system prompt. Edit it freely, in plain English. -->

These apply to every video Vidrow delivers, in every format, unless the brief explicitly says otherwise. The chosen format's guidelines build on them. If a reference ad is given, follow the reference's pacing, music and graphics over the format guidelines.

## 1. Pacing: remove all gaps
- Cut out every pause, breath, hesitation and silence between lines, so each line starts immediately after the previous one ends. Viewers decide in the first second whether to keep watching; dead air is the most common reason they scroll.
- Exception: on-screen action. Keep a pause only when something meaningful happens in the frame during it (a reaction, a product demo, a visual gag, a comedic beat, a dramatic moment in a skit). Mark those segments `keep_pauses: true`.
- Never clip words: keep a few frames of handle before the first syllable and after the last.
- The finished timeline should show continuous waveforms with no flat stretches between lines.

## 2. Music: no corporate-style tracks, ever
- Never use corporate-style music: generic "inspirational"/"motivational" stock, upbeat ukulele, handclap-and-whistle tracks, soft corporate piano, anything that sounds like a company presentation or explainer template.
- Use music that feels native to the platform and matches the script's mood, or no music when the dialogue carries the video. Vidrow music library first.
- Music always sits under the dialogue (about -18 to -22 dB) and never competes with the voice.
- Track 1 starts with the hook. Track 2 (same feel, different track) takes over when the app/client is first named.

## 3. Deliverables: Hook 1, Hook 2, Hook 3 and Body
- Three genuinely different hooks (2-5 s each) and one shared Body (20-45 s), unless the brief says otherwise.
- Every hook must join the Body seamlessly: it ends on a clean cut leading into the Body's first line, never repeats the Body's opening line, and the Body must make sense after any hook.
- The first word of each hook lands on the first frame.
- CTA and end card only at the end of the Body, never at the end of a hook.
- Hooks must not end on a music fade or mid-word.

## 4. Avoid abrupt cuts
- When two consecutive shots come from the same camera angle, alternate framing with a punch-in/punch-out of about 10-15% so the jump reads as deliberate (if the format allows punch-ins).
- In skits and two-person podcasts, use reaction shots to bridge jumps.
- Keep the subject's face in the same area of the frame across cuts. Cut on action or on the start of a word.

## 5. Other standards
- Takes: use the best complete, fluent take of each script line. Remove stumbles, retakes, director talk and off-script chatter.
- Script order: keep the script's order and cover every line that exists in the footage; flag any missing lines in editor notes.
- Screens and assets appear exactly when the matching words are spoken (feature, price, offer, number, app name, CTA) and stay on screen at least 1.5 s.
- Safe zones (Reels/Shorts): keep text and key visuals out of the top ~15% and bottom ~20% of a 9:16 frame.
- Script hyperlinks (`[LINK: url]`): show a matching screenshot from the assets at the line where it is mentioned; if there is none, it becomes a purple "SCREENSHOT NEEDED" marker.
- Callouts (`[CALLOUT: text]`, yellow text under the script number): rendered as a rounded box in Helvetica Bold near the top of the frame.
- Captions clash with graphics and full-screen app UI; the editor adds captions afterwards (the tool does not make captions).
- Export: 1080x1920 H.264, Match Source high bitrate, each hook under 110 MB, no black first/last frames.

## 6. Rules the Edit Kit enforces in code (for Claude's awareness)
- One timeline per hook: `Client_Ad_H1/H2/H3`, each Hook N followed by the Body, with a red BODY STARTS marker at the join.
- Claude picks transcript line ranges (never free-typed times). The tool snaps to word boundaries, removes fillers and director words (umm, uh, hmm, stray okays, action, cut, rolling, one more, phir se, ek aur...), removes measured silences of 0.15 s or more and rounds to frames.
- Tracks: V1 speaker/scene cuts, V2 app screens, V3 transparent graphics, V4 callouts, A2 music.
- Markers: green = script lines, orange = callouts/text, purple = editor to-dos (SFX, risers, missing screenshots, roto, captions).
- Transparent assets are graphics on V3 (just below centre, about 90% width) and never go in a split screen.
