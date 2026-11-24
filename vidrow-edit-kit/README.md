# Vidrow Edit Kit

A Premiere Pro panel that turns **a script + raw takes** into finished ad timelines. You paste the script, add the footage, pick a format and press **Generate edit**. Claude chooses the takes and builds one timeline per hook (`Client_Ad_H1`, `_H2`, `_H3`, each Hook followed by the Body), with app screens, graphics, callouts, music and markers already placed. It can also queue the exports.

---

## 1. Install (once per Mac)

1. Unzip `Vidrow_Edit_Kit.zip`.
2. Double-click **Install Vidrow Edit Kit.command**.
   - If macOS says it *"can't be opened because Apple cannot check it"* or *"doesn't identify the source"*: **right-click the file → Open → Open**. If that doesn't work, open Terminal and run `xattr -dr com.apple.quarantine ~/Downloads/Vidrow_Edit_Kit` (use the path to the unzipped folder), then double-click again.
   - The installer copies the panel into `~/Library/Application Support/Adobe/CEP/extensions/`, allows unsigned panels (PlayerDebugMode for CSXS 9–12), downloads the Vidrow logo and offers to `brew install ffmpeg yt-dlp`. **ffmpeg is required.** yt-dlp is only needed for reference-ad links.
3. Quit and reopen Premiere Pro.
4. **Premiere → Settings → Media → Default Media Scaling = None.** The panel sets scale and position itself, so leaving "Scale to frame size" on makes framing wrong.
5. **Window → Extensions → Vidrow Edit Kit.** The dot next to "Premiere" turns green when the panel can talk to Premiere.

## 2. Keys (⚙ Settings)

Keys are stored only on your Mac (`~/Library/Application Support/Vidrow Edit Kit/settings.json`, readable only by you).

| Key | What it's for | Where to get it |
|---|---|---|
| **Anthropic API key** | Claude makes the edit plan | [console.anthropic.com](https://console.anthropic.com) → API Keys. API usage is **billed separately from a Claude.ai subscription**: add credit under Billing. |
| **OpenAI API key** | Speech-to-text only (Whisper, about $0.006 per minute of footage) | [platform.openai.com](https://platform.openai.com/api-keys) |
| or **whisper.cpp** | Free, offline speech-to-text | Say yes in the installer (`brew install whisper-cpp` + a ~1.6 GB model), then put the binary path (`/opt/homebrew/bin/whisper-cli`) and the model path in Settings. Slower than OpenAI. |
| Figma token | Figma links in the Client tab | Figma → Settings → Security → Personal access tokens |
| Google API key (optional) | Drive folders that aren't public | Only needed if "Anyone with the link" sharing isn't possible |

Also in Settings: spoken language (Hindi/Hinglish, English, auto), the yt-dlp path, **Use logins from browser** (lets yt-dlp use your Instagram/Facebook login from Chrome/Safari for references), the output folder (default `~/Movies/Vidrow Edit Kit/`) and the export preset.

**Rough cost per edit** (Claude only, shown under the model picker; it rises with effort and footage length):

| Model | low effort | high effort | max effort |
|---|---|---|---|
| Claude Opus 5.5 (default) | $0.18–0.65 | $0.32–1.15 | $0.67–2.41 |
| Claude Fable 5.2 | $0.36–1.30 | $0.64–2.30 | $1.34–4.82 |
| Claude Sonnet 5.5 | $0.09–0.32 | $0.16–0.58 | $0.34–1.21 |
| Claude Haiku 5.5 | under $0.01 | $0.01–0.03 | $0.02–0.06 |

## 3. What goes in each tab

**Job:** a name for this edit (e.g. `EMI Ad`). Files go to `~/Movies/Vidrow Edit Kit/<Job>/`.

1. **Script.** Paste the whole script from Google Docs with the labels `Hook 1`, `Hook 2`, `Hook 3`, `Body`. Hyperlinks become `[LINK: url]` and **yellow** (highlighted) text becomes `[CALLOUT: text]` automatically. The line under the box counts lines, callouts and links per section.
2. **Footage.** Every raw take: *Add files*, *Add folder*, *From Project panel…* (pick clips from the open project, grouped by bin) or *Use selection* (whatever is selected in the Project panel). Leave in the slates, retakes and "action/cut": the tool removes them.
3. **Format.** One of the six formats (Podcast, Gyan Pelo, Skit, Talking Head, Street Interview, Vox Pop); its settings are shown underneath. Optional aspect override (9:16 default, 4:5, 1:1, 16:9). **App screens:**
   - *Split screen* (default): the screen fills the top 40%, the speaker plays in the bottom 60% with faces kept fully in view.
   - *Full screen*: the screen covers the frame.
   - *Full screen phone UI*: the screen sits inside a drawn phone (~94% of the height) over the footage, which keeps playing blurred behind it.
   - **Reference ad** (optional): a link (Instagram, YouTube, Facebook, TikTok, X), a file, or a clip from the project. Claude then follows the reference's pacing and style over the format rules.
4. **Client.** Client name (used in file names and to find the music switch point), assets (files, folder or from the project), asset links (Figma / Google Drive / Other = direct file or .zip, Dropbox works), callout style (white box, black box, or brand colour), brand notes.
5. **Music.** The library link is prefilled with the Vidrow Music Library; any shared Drive folder, Dropbox link or Mac folder works. Choose Track 1 and Track 2 genres (Curious, Happy, Wholesome, Sad, or None), when Track 1 starts (default: first frame, with the hook) and the level (default −20 dB). Corporate-sounding tracks are never picked.
6. **Brief.** Anything extra, optional max hook/body length (defaults come from the format), *Deliver as* (separate Hook 1/2/3 + Body, or stitched Hook + Body) and *Auto-export*. The **Last edit** box at the bottom shows what was built per timeline and has **Rebuild timelines** (re-runs from the saved plan without calling Claude again), **Export** and **Open job folder**.

Footer: **Edit with** (model), **Effort** (low → max, with a hint), **Generate edit**, and the **Log** (click to expand; *copy* puts it on the clipboard). When an edit is done, the line under the button links to the Brief tab.

Every field is saved as you type, so nothing is lost if the panel reloads.

## 4. What the tool does to the edit

- **One timeline per hook:** `Client_Ad_H1`, `_H2`, `_H3`, each Hook N followed by the Body, with a red **BODY STARTS** marker at the join. If a timeline with that name already exists it is renamed `… (prev hh.mm)`, never overwritten.
- **Follows the script:** the best take of each line, in order. Script lines that aren't in any cut are listed in the log and the Last edit box.
- **No gaps:** dead air at the start and end of every cut, and every pause of 0.15 s or more, is removed using the measured audio silence. Pauses are kept only where Claude marks on-screen action (in Skits, performance timing is kept by default).
- **No fillers or director talk:** umm, uh, hmm, stray okays, "action", "cut", "rolling", "one more", "phir se", "ek aur"…
- **Punch-ins** (100% ↔ 112%) hide jump cuts within the same take, when the format allows them.
- **Tracks:** V1 speaker cuts · V2 app screens · V3 transparent graphics (stickers, logos, lower thirds, placed just below the centre) · V4 callouts (near the top) · A2 music.
- **Music:** Track 1 from the first frame. Track 2 takes over when the app or client is first named (snapped to the nearest cut). If nobody names it, Track 2 starts at Claude's chosen point or the first app screen. The log says where it switched.
- **Markers:** 🟢 green = script lines · 🟠 orange = callouts/text · 🟣 purple = editor to-dos (SFX, risers, `SCREENSHOT NEEDED: url`, captions, roto).
- **Cut check:** after placing every cut, the panel verifies its length on the timeline and fixes it if needed. The log shows e.g. `Cut check: 14 exact`.

## 5. Drive sharing rules

- **Asset folders and the music library** must be shared as **"Anyone with the link – Viewer"**. Then no key is needed. Sub-folders are included.
- Single files: the same rule applies.
- If a folder can't be public, add a Google API key in Settings (the folder still has to be visible to that key's project, i.e. link-shared or public).
- Downloads are cached in `~/Movies/Vidrow Edit Kit/.cache/`, so the second run is fast. Delete that folder to force fresh downloads.

## 6. Exports

Exports go through Adobe Media Encoder (H.264, **Match Source – High bitrate**) into `<Job>/Exports/`:

| Deliver as | Files |
|---|---|
| Separate (default) | `Client_Ad_H1.mp4`, `Client_Ad_H2.mp4`, `Client_Ad_H3.mp4` (hook only) and `Client_Ad_Body.mp4` (cut from the H1 timeline with In/Out points) |
| Stitched | `Client_Ad_H1_Body.mp4`, `Client_Ad_H2_Body.mp4`, `Client_Ad_H3_Body.mp4` |

Non-9:16 versions get a suffix: `_portrait` (4:5), `_square` (1:1), `_landscape` (16:9). If the preset isn't found automatically, put the path to an `.epr` file in Settings → Export preset.

## 7. Updating the guidelines

The rules Claude follows are plain files inside the panel folder (`~/Library/Application Support/Adobe/CEP/extensions/co.vidrow.editkit/presets/`):

- `guidelines.md`: the general Vidrow editing guidelines, in plain English. Edit freely.
- `formats.json`: the six formats: tagline, layouts, screen coverage, music, pause cutting (`pause_cut_seconds`, `null` = off), punch-ins, hook/body ranges, and the guidance text Claude reads. Keep the keys and change the values.

Both were transcribed from the Google Doc "Vidrow Edit guidelines". After editing, close and reopen the panel. To ship the change to everyone, edit the copies in this repo (`extension/presets/`) and re-run the installer.

## 8. Known limits

- No captions, SFX, risers or roto. Where they're needed you get **purple markers**.
- Face framing uses an on-device detector on 5 frames per clip. With unusual footage (masks, extreme angles) it falls back to Claude's estimate, so check split-screen framing.
- The Gaussian Blur (phone mode) and the Crop on the speaker (split mode) use Premiere's unofficial QE API. If Premiere refuses, the log says so and you add them by hand. Framing and sizes never depend on them.
- Claude's overlay timing is usually within a word or two. Nudge screens on V2 if a feature lands slightly early or late.
- The first run on new footage takes longest (transcription, silence detection, faces). Re-runs use the cache.

## Troubleshooting

- **Panel not in Window → Extensions:** re-run the installer, then fully quit and reopen Premiere.
- **Red dot:** open a project; if it stays red, close and reopen the panel.
- **"ffmpeg is not installed":** run `brew install ffmpeg` in Terminal.
- **Reference link fails:** turn on *Use logins from browser* (be logged in to Instagram in that browser), update yt-dlp (`brew upgrade yt-dlp`), or download the reel and use *File*.
- **Upload errors:** the log names the service and the upload size. Keys and credit are the usual cause.
