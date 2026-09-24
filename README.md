# Instagram Transcript Generator

Paste an Instagram reel/post link → get the dialogue as a script, broken down by character:

```
[00:00] MOM: Beta, yeh phone kab liya?
[00:03] SON: Mummy, EMI pe liya hai — zero interest.
[00:06] VO: Bachatt pe 0% EMI, aaj hi download karo.
```

Exports as `.txt` script, `.srt` subtitles, or `.json`.

## How it works

| Step | Tool | Needs |
|---|---|---|
| Download audio from the link | `yt-dlp` + `ffmpeg` | ffmpeg installed |
| Transcribe + split speakers | **AssemblyAI** (cloud, diarization built in) | `ASSEMBLYAI_API_KEY` |
| …or transcribe locally | **faster-whisper** (no diarization) | nothing, runs on CPU |
| Name the characters, format the script | **Claude** | `ANTHROPIC_API_KEY` |

Without any keys it still works: Whisper transcribes locally and you get a plain timestamped transcript. With AssemblyAI you get real speaker separation. With Claude the speakers become "Mom / Son / VO" and, for Whisper-only runs, Claude splits the dialogue into characters from context.

## Setup (once)

```bash
# 1. ffmpeg
brew install ffmpeg            # mac
# sudo apt install ffmpeg      # ubuntu
# winget install ffmpeg        # windows

# 2. python deps
cd Instagram_Transcript
python -m venv .venv && source .venv/bin/activate     # windows: .venv\Scripts\activate
pip install -r requirements.txt

# 3. keys
cp .env.example .env           # then paste your keys in
```

## Run

```bash
streamlit run app.py
```

Opens at http://localhost:8501. Paste a link, hit **Generate transcript**.

### Command line

Same pipeline without the UI:

```bash
python cli.py https://www.instagram.com/reel/XXXXXXXXX/              # prints the script
python cli.py https://www.instagram.com/reel/XXXXXXXXX/ --out output/  # also saves .txt / .srt / .json
python cli.py --file clip.mp4 --engine whisper --language hi
python cli.py --help                                                  # all options
```

## If Instagram blocks the download

Instagram sometimes returns "login required" or rate-limits anonymous downloads. Two fixes:

1. **Cookies** — install a browser extension like *Get cookies.txt LOCALLY*, open instagram.com while logged in, export `cookies.txt`, and put its path in the sidebar (or `INSTAGRAM_COOKIES` in `.env`).
2. **Upload tab** — download the reel with any reel-saver and drop the file into the *Upload video* tab. Everything after the download step is identical.

Also keep yt-dlp current — Instagram changes things often: `pip install -U yt-dlp`.

## Hinglish notes

- AssemblyAI auto-detects language; Hindi-heavy audio comes back in Devanagari. The **"Write Hinglish in Roman script"** option has Claude re-render it as `"Mummy, yeh kya hai?"` without changing the words.
- For very code-mixed audio, force the language to `hi` or `en` in the sidebar if auto-detect picks wrong.
- Whisper `small` is a good speed/accuracy balance on a laptop; `medium` is noticeably better for Hindi but ~3× slower.

## Swapping engines

Everything lives in `pipeline.py` as plain functions (`download_audio`, `transcribe_assemblyai`, `transcribe_whisper`, `name_characters`, `to_script`, `to_srt`). To add another STT provider (Sarvam, Deepgram, etc.), write a function that returns `list[Line]` and plug it into `run()`.
