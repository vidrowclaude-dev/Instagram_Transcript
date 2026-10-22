# Reel Vault

Paste an Instagram profile (or Reel links), pick the videos you want, and get back MP4s, thumbnails, captions, timestamped transcripts and a metadata sheet. Built as an internal research tool for studying reference ads and creator content.

- **Preview first:** every video is listed with its thumbnail, date, views, likes and duration before anything downloads.
- **Three modes:** download only, download + transcribe, or transcribe only (the video is deleted after).
- **Transcripts that suit Indian content:** Hindi, English and Hinglish, written in Devanagari or romanised Hinglish. You get .txt, .srt and .json files, plus a 3-second "hook" column.
- **Safe to stop and restart:** if the worker dies midway, the job resumes and skips everything already done. The same Reel is never downloaded twice, even across jobs.
- **Polite to Instagram:** random delays, at most 2 downloads at a time, and automatic cooldowns on rate limits.

---

## Quick start (Docker)

```bash
cp .env.example .env          # defaults are fine to start
docker compose up --build
```

Open **http://localhost:8000**. Files land in `./data`.

The first transcription downloads the Whisper model (~3 GB for `large-v3`) into `./data/models`. On a laptop CPU, set `WHISPER_MODEL=small` in `.env` for speed; `large-v3` is noticeably better on Hinglish but slow without a GPU.

### Try it without touching Instagram

```bash
echo "DEMO_MODE=true" >> .env && docker compose up --build
```

Then paste `@demo_brand`, `@demo_private` or `@demo_missing`. Demo mode generates real MP4s with ffmpeg and a fake transcript, so you can click through the whole flow offline.

## Running without Docker

Needs Python 3.11+ and ffmpeg (`brew install ffmpeg` / `apt install ffmpeg`).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.api.main:app --port 8000
```

Without Redis, jobs run inside the web process (`QUEUE_BACKEND=auto` picks this). That's fine for one person. For a team, run Redis and a separate worker:

```bash
redis-server &
QUEUE_BACKEND=rq uvicorn app.api.main:app --port 8000 &
QUEUE_BACKEND=rq python -m app.worker
```

## Command line

Same engine, no browser needed. Handy for proving things work end to end.

```bash
python -m app.cli preview @brandname --latest 20
python -m app.cli download @brandname --latest 20 --transcribe --language hinglish --script roman --zip
python -m app.cli download https://www.instagram.com/reel/XXXX/ --transcribe-only
python -m app.cli download @brandname --from 2026-09-01 --to 2026-10-01 --min-views 50000 --sort most_viewed
python -m app.cli transcribe ./any_video.mp4 --model small
python -m app.cli jobs
python -m app.cli resume <job_id>
```

## Instagram session (cookies.txt)

Public profiles work without logging in, but Instagram limits anonymous browsing quickly. Uploading a session from your own browser raises those limits and lets the tool see what your account can see. **Reel Vault never asks for or stores a password.**

1. Log in to instagram.com in Chrome. A secondary account is safer than your main one.
2. Install a cookies.txt exporter extension, such as **Get cookies.txt LOCALLY**.
3. On an instagram.com tab, open the extension and export cookies for this site.
4. In Reel Vault, go to **Settings → Choose cookies.txt**.

Only `instagram.com` cookies are kept, in `data/secrets/cookies.txt` with `0600` permissions. Settings shows when the session expires. Sessions usually last a few months, or until you log out in that browser.

## Rate limits: how to not get blocked

Instagram throttles automated access, and when it does you'll see **Cooling down** with a countdown. The job waits (60s, then 2 min, 4 min… up to 15 min), retries and carries on. After 6 cooldowns in a row it stops so it doesn't make things worse. Use **Retry failed** an hour later.

Guidelines:

- Keep the defaults: a 4–9s random gap between requests and 2 parallel downloads. Lowering them is the fastest way to get your IP or account flagged.
- Run one big profile at a time. Several jobs share the same pacing, so they don't speed things up anyway.
- Use filters. *Latest 30* or a date range stops reading early, while *Most viewed* reads the whole profile (capped at 600 posts).
- Don't use the Instagram app on the same account while a big job runs.
- Expect roughly 6–10 videos a minute on a healthy session.

## Transcription engines

| Engine | Cost | Setup | Notes |
|---|---|---|---|
| `faster_whisper` (default) | Free, local | none | `large-v3` best quality; `small` ~5× faster on CPU |
| `openai` | Paid API | `OPENAI_API_KEY` | `whisper-1`, quick, no GPU needed |
| `deepgram` | Paid API | `DEEPGRAM_API_KEY` | `nova-3`; the Hinglish option uses Deepgram's code-switching mode |
| `assemblyai` | Paid API | `ASSEMBLYAI_API_KEY` | Sentence-level timestamps |

Language options are **Detect automatically**, **Hinglish**, **Hindi** and **English**. Hinglish nudges Whisper to keep mixed speech as spoken rather than translating it.

**Hindi written as** controls the output script. *Hinglish* turns Devanagari into casual romanised text ("aaj hum baat karenge", not "āj ham bāt kareṅge"). The conversion runs offline and follows Hindi's dropped-vowel rules. *देवनागरी* keeps the original. The .json file always stores the original script too, so you can switch later without re-transcribing.

## What you get

```
reelvault_<name>_<job>.zip
├── videos/       <handle>_<YYYY-MM-DD>_<shortcode>.mp4
├── thumbnails/   …jpg
├── captions/     …txt
├── transcripts/  …txt  …srt  …json
├── metadata.csv      every field: views, likes, comments, duration, hashtags, audio, paid partnership, paths…
├── metadata.json
└── transcripts.csv   handle, shortcode, url, date, views, likes, duration, caption, transcript, hook
```

The CSVs include a byte-order mark so Excel and Google Sheets show Devanagari and emoji correctly. Import them with **File → Import** in Sheets.

## How it's built

```
app/
  extractors/    source plugins: instagram.py (instaloader + yt-dlp fallback), demo.py
                 urls.py (link parsing), filters.py, ratelimit.py, cookies.py
  transcription/ engines.py (4 engines, one interface), audio.py (ffmpeg),
                 formats.py (txt/srt/json/hook), romanize.py (Devanagari → Hinglish)
  jobs/          pipeline.py (preview + run, per-video error isolation, cooldowns, heartbeat)
                 queue.py (RQ or in-process, stale-job resume)
  storage/       paths.py (shared library layout), export.py (CSV/JSON/ZIP, disk cleanup)
  api/main.py    FastAPI: JSON API, live progress over Server-Sent Events, media with seeking
  web/           the dashboard (plain HTML/CSS/JS, served by the API, no build step)
  cli.py         command line
  worker.py      RQ worker entrypoint
```

- **Adding a source:** to add YouTube or TikTok, write a class implementing `Extractor` in `app/extractors/base.py` and register it in `app/extractors/__init__.py`. Nothing else changes.
- **Resuming:** running jobs write a heartbeat every 15s. Workers re-queue any job whose heartbeat has been quiet for 60s, and an atomic claim stops two workers running the same job. Each video checks the disk before downloading or transcribing, so re-runs only do the missing work.
- **Storage:** media lives once in `data/library/<handle>/`, shared by every job that includes it. Deleting a job removes only files no other job uses. Settings has buttons to clear the cache and old jobs.
- **Database:** SQLite by default. Set `DATABASE_URL=postgresql+psycopg://…` and `pip install "psycopg[binary]"` to use Postgres.

### API

Interactive docs at `/docs`. The main endpoints:

| | |
|---|---|
| `POST /api/jobs/preview` | `{inputs, filters}` → `{job_id}`; lists videos in the background |
| `POST /api/jobs/{id}/start` | `{shortcodes, mode, engine, model, language, script, hook_seconds}` |
| `GET /api/jobs/{id}/events` | live progress (SSE) |
| `GET /api/jobs/{id}/zip` · `metadata.csv` · `transcripts.csv` | exports |
| `POST /api/jobs/{id}/rerun` · `cancel` · `refresh-preview`, `DELETE /api/jobs/{id}` | job control |
| `GET /api/videos/{id}` · `/file` · `/thumb` · `/transcript.{txt,srt,json}` | one video |
| `GET /api/search?q=` | keyword search across all transcripts and captions |
| `GET /api/storage`, `POST /api/storage/clear-cache`, `POST /api/storage/clear-old` | disk |
| `POST/DELETE /api/settings/cookies` | session upload |

Logs are JSON lines on stdout (`docker compose logs -f api worker`). Every failed video records a reason (`private`, `not_found`, `rate_limited`, `login_required`, `no_audio`, `download_failed`…) that shows in the UI and in `metadata.csv`.

## Tests

```bash
pytest
```

69 tests, no network needed. They cover link parsing, filters, rate limiting, cookies, output formats, romanisation, engine response parsing, ffmpeg audio extraction, and end-to-end API runs on the demo extractor, including: kill the worker midway → resume without re-downloading; a 429 → cooldown → finish; private/missing/invalid inputs → clear errors; transcribe-only cleanup; dedupe across jobs; cancel and re-run.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Instagram is asking for a login" | Upload cookies.txt in Settings, then use **Look up again** on the job. |
| Stuck on Cooling down for a long time | Instagram is throttling this IP or account. Let it run, or cancel and retry in an hour. Avoid running several jobs at once. |
| Preview finds fewer videos than the profile shows | Anonymous browsing is cut off after a few pages. Add cookies. Also check the **Reels only** filter. |
| `CDN returned 403` failures | Video links expire. The tool refetches automatically; if a few still fail, use **Retry failed**. |
| Transcription is very slow | Use `WHISPER_MODEL=small`, a GPU (see `docker-compose.yml`), or an API engine. |
| Hindi comes out translated to English | Set Language to **Hinglish** or **Hindi** instead of auto-detect. |
| `faster-whisper is not installed` | `pip install faster-whisper` (already included in Docker). |
| A job shows Running but nothing moves | The worker is down. Restart it; the job resumes within a minute. |

## Guardrails

- **Public content only:** public profiles, plus whatever your own logged-in session can already see. The tool doesn't get around private accounts, CAPTCHAs or login walls.
- **Conservative rate limits:** defaults are deliberately slow, and the UI warns about the risk of blocks.
- **Research use only:** downloaded content is for internal reference and isn't to be republished. Instagram's terms restrict automated collection, so use your own judgement on volume and keep it to research.
