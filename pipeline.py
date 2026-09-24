"""
Instagram → character-dialogue transcript pipeline.

Steps
  1. download_audio()      yt-dlp pulls the audio track from an Instagram reel/post (or use a local file)
  2. transcribe()          AssemblyAI (transcript + speaker diarization) or local faster-whisper (transcript only)
  3. name_characters()     Claude turns "Speaker A/B" into named characters ("Mom", "Delivery Guy", "VO")
                           and, if there was no diarization, splits the dialogue by character from context
  4. to_script()/to_srt()  export

Every step is a plain function so you can swap engines later.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Optional

INSTAGRAM_RE = re.compile(r"(https?://)?(www\.)?instagram\.com/(reel|reels|p|tv)/([A-Za-z0-9_-]+)")

Progress = Callable[[str], None]


def _noop(_: str) -> None:
    pass


# ----------------------------------------------------------------------------
# Data
# ----------------------------------------------------------------------------

@dataclass
class Line:
    speaker: str          # raw label from the engine: "A", "B" … or "" if unknown
    character: str        # human name after Claude pass; falls back to "Speaker A"
    start: float          # seconds
    end: float
    text: str


@dataclass
class Transcript:
    source: str
    title: str
    caption: str
    duration: float
    language: str
    engine: str
    diarized: bool
    lines: list[Line]

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


# ----------------------------------------------------------------------------
# 1. Download
# ----------------------------------------------------------------------------

def validate_instagram_url(url: str) -> str:
    """Return a clean canonical URL or raise ValueError."""
    url = url.strip()
    m = INSTAGRAM_RE.search(url)
    if not m:
        raise ValueError("That doesn't look like an Instagram reel/post link (expected instagram.com/reel/… or /p/…).")
    kind, code = m.group(3), m.group(4)
    kind = "reel" if kind == "reels" else kind
    return f"https://www.instagram.com/{kind}/{code}/"


def download_audio(url: str, out_dir: Path, cookies_file: Optional[str] = None,
                   progress: Progress = _noop) -> tuple[Path, dict]:
    """Download the audio track as MP3. Returns (path, yt-dlp info dict)."""
    import yt_dlp  # imported lazily so the module loads without it

    out_dir.mkdir(parents=True, exist_ok=True)
    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(id)s.%(ext)s"),
        "postprocessors": [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": "128",
        }],
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
    }
    if cookies_file:
        ydl_opts["cookiefile"] = cookies_file

    progress("Downloading audio from Instagram…")
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    path = out_dir / f"{info['id']}.mp3"
    if not path.exists():
        # postprocessor may have kept another extension in odd cases
        candidates = sorted(out_dir.glob(f"{info['id']}.*"))
        if not candidates:
            raise RuntimeError("Download finished but no audio file was produced. Is ffmpeg installed?")
        path = candidates[0]
    return path, info


def extract_audio_from_file(video_path: Path, out_dir: Path, progress: Progress = _noop) -> Path:
    """For a locally uploaded video: strip audio to MP3 with ffmpeg."""
    import subprocess

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (video_path.stem + ".mp3")
    progress("Extracting audio…")
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-acodec", "libmp3lame", "-b:a", "128k", str(out)],
        check=True, capture_output=True,
    )
    return out


# ----------------------------------------------------------------------------
# 2. Transcribe
# ----------------------------------------------------------------------------

def transcribe_assemblyai(audio_path: Path, api_key: str, language: Optional[str] = None,
                          progress: Progress = _noop) -> tuple[list[Line], str, bool]:
    """Transcript + speaker labels via AssemblyAI. Returns (lines, detected_language, diarized)."""
    import assemblyai as aai

    aai.settings.api_key = api_key
    transcriber = aai.Transcriber()

    def _run(with_speakers: bool):
        kwargs = {"speaker_labels": with_speakers}
        if language:
            kwargs["language_code"] = language
        else:
            kwargs["language_detection"] = True
        cfg = aai.TranscriptionConfig(**kwargs)
        return transcriber.transcribe(str(audio_path), cfg)

    progress("Transcribing with AssemblyAI (with speaker diarization)…")
    t = _run(True)
    diarized = True
    if t.status == aai.TranscriptStatus.error:
        # Speaker labels aren't supported for every language; retry without them.
        progress(f"Diarization failed ({t.error}); retrying without speaker labels…")
        t = _run(False)
        diarized = False
        if t.status == aai.TranscriptStatus.error:
            raise RuntimeError(f"AssemblyAI error: {t.error}")

    detected = (getattr(t, "json_response", {}) or {}).get("language_code") or language or "auto"

    lines: list[Line] = []
    if diarized and t.utterances:
        for u in t.utterances:
            lines.append(Line(speaker=u.speaker, character=f"Speaker {u.speaker}",
                              start=u.start / 1000, end=u.end / 1000, text=u.text.strip()))
    else:
        # fall back to sentence-ish chunks with timestamps
        for s in t.get_sentences():
            lines.append(Line(speaker="", character="", start=s.start / 1000, end=s.end / 1000, text=s.text.strip()))
    return lines, detected, diarized


def transcribe_whisper(audio_path: Path, model_size: str = "small", language: Optional[str] = None,
                       progress: Progress = _noop) -> tuple[list[Line], str, bool]:
    """Local transcript via faster-whisper. No diarization (Claude splits by context afterwards)."""
    from faster_whisper import WhisperModel

    progress(f"Loading Whisper model '{model_size}' (first run downloads it)…")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    progress("Transcribing locally with Whisper…")
    segments, info = model.transcribe(str(audio_path), language=language, vad_filter=True, beam_size=5)
    lines = [Line(speaker="", character="", start=s.start, end=s.end, text=s.text.strip())
             for s in segments if s.text.strip()]
    return lines, info.language, False


# ----------------------------------------------------------------------------
# 3. Character naming with Claude
# ----------------------------------------------------------------------------

_NAMING_PROMPT = """You are converting a raw transcript of a short Instagram video (usually an ad or skit) into a script broken down by character.

Video caption / context:
<caption>
{caption}
</caption>

Raw transcript (JSON list; `speaker` is a diarization label like "A"/"B", or empty when the engine couldn't separate speakers):
<transcript>
{lines}
</transcript>

Rules:
- Give each distinct speaker a short, descriptive CHARACTER name based on what they say and the caption — e.g. "Mom", "Daughter", "Delivery Guy", "Customer", "Founder", "VO" for voice-over/narration. Use a real name only if it is said in the dialogue.
- If `speaker` labels exist, keep them consistent: one label → one character. Merge consecutive lines from the same speaker only if they are clearly one continuous line.
- If `speaker` labels are EMPTY, split the dialogue into character turns yourself using context (questions/answers, tone, who is being addressed). If it is clearly a single person talking to camera, use one character (e.g. "Creator" or "VO").
- Do NOT translate, paraphrase or fix the wording. Keep the spoken text exactly as transcribed{roman_rule}.
- Keep the `start`/`end` timestamps from the source line each piece came from.
- Add a one-line `synopsis` of the video.

Return ONLY valid JSON, no prose, in this shape:
{{
  "synopsis": "…",
  "characters": {{"A": "Mom", "B": "Son"}},
  "lines": [
    {{"character": "Mom", "start": 0.0, "end": 2.4, "text": "…"}}
  ]
}}"""


def name_characters(lines: list[Line], caption: str, api_key: str, model: str,
                    romanize_hinglish: bool = False, progress: Progress = _noop) -> tuple[list[Line], dict, str]:
    """Ask Claude to name characters and (if needed) split by speaker. Returns (lines, char_map, synopsis)."""
    import anthropic

    progress("Naming characters with Claude…")
    client = anthropic.Anthropic(api_key=api_key)
    raw = [{"speaker": l.speaker, "start": round(l.start, 2), "end": round(l.end, 2), "text": l.text} for l in lines]
    roman_rule = (" — except: if the speech is Hindi/Hinglish, write it in Roman (Latin) script the way Indian ad scripts "
                  "are written, e.g. 'Mummy, yeh kya hai?'; do not change the words") if romanize_hinglish else ""
    prompt = _NAMING_PROMPT.format(caption=caption or "(none)", lines=json.dumps(raw, ensure_ascii=False, indent=1),
                                   roman_rule=roman_rule)

    msg = client.messages.create(model=model, max_tokens=4000, messages=[{"role": "user", "content": prompt}])
    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise RuntimeError("Claude did not return valid JSON; keeping raw speaker labels.")
        data = json.loads(m.group(0))

    char_map = data.get("characters", {}) or {}
    out: list[Line] = []
    for item in data.get("lines", []):
        out.append(Line(
            speaker=next((k for k, v in char_map.items() if v == item.get("character")), ""),
            character=item.get("character", "Speaker"),
            start=float(item.get("start", 0)), end=float(item.get("end", 0)),
            text=str(item.get("text", "")).strip(),
        ))
    if not out:
        raise RuntimeError("Claude returned no lines; keeping raw speaker labels.")
    return out, char_map, data.get("synopsis", "")


# ----------------------------------------------------------------------------
# 4. Export
# ----------------------------------------------------------------------------

def _ts(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m:02d}:{s:02d}"


def _srt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_script(t: Transcript, synopsis: str = "", timestamps: bool = True) -> str:
    head = [
        f"SOURCE:   {t.source}",
        f"TITLE:    {t.title}" if t.title else None,
        f"DURATION: {_ts(t.duration)}" if t.duration else None,
        f"LANGUAGE: {t.language}   ENGINE: {t.engine}{' + diarization' if t.diarized else ''}",
        f"SYNOPSIS: {synopsis}" if synopsis else None,
        "",
    ]
    body = []
    for l in t.lines:
        who = (l.character or "SPEAKER").upper()
        stamp = f"[{_ts(l.start)}] " if timestamps else ""
        body.append(f"{stamp}{who}: {l.text}")
    return "\n".join(x for x in head if x is not None) + "\n" + "\n".join(body) + "\n"


def to_srt(t: Transcript) -> str:
    out = []
    for i, l in enumerate(t.lines, 1):
        out.append(f"{i}\n{_srt_ts(l.start)} --> {_srt_ts(l.end)}\n{l.character.upper()}: {l.text}\n")
    return "\n".join(out)


# ----------------------------------------------------------------------------
# Orchestrator
# ----------------------------------------------------------------------------

def run(
    *,
    url: Optional[str] = None,
    local_video: Optional[Path] = None,
    work_dir: Path,
    engine: str = "auto",                     # "auto" | "assemblyai" | "whisper"
    whisper_model: str = "small",
    language: Optional[str] = None,           # None = auto-detect
    name_with_claude: bool = True,
    romanize_hinglish: bool = False,
    cookies_file: Optional[str] = None,
    progress: Progress = _noop,
) -> tuple[Transcript, str]:
    """End-to-end. Returns (Transcript, synopsis)."""
    aai_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    claude_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    claude_model = os.getenv("CLAUDE_MODEL", "claude-sonnet-5").strip()

    if engine == "auto":
        engine = "assemblyai" if aai_key else "whisper"
    if engine == "assemblyai" and not aai_key:
        raise RuntimeError("ASSEMBLYAI_API_KEY is not set (put it in .env).")

    # 1. audio
    title, caption, duration, source = "", "", 0.0, ""
    if url:
        source = validate_instagram_url(url)
        audio, info = download_audio(source, work_dir, cookies_file, progress)
        title = info.get("title") or ""
        caption = info.get("description") or ""
        duration = float(info.get("duration") or 0)
    elif local_video:
        source = local_video.name
        audio = extract_audio_from_file(local_video, work_dir, progress)
    else:
        raise ValueError("Provide either an Instagram URL or a local video file.")

    # 2. transcript
    if engine == "assemblyai":
        lines, lang, diarized = transcribe_assemblyai(audio, aai_key, language, progress)
    else:
        lines, lang, diarized = transcribe_whisper(audio, whisper_model, language, progress)

    if not lines:
        raise RuntimeError("No speech was detected in this video.")

    if not duration:
        duration = max(l.end for l in lines)

    # 3. characters
    synopsis = ""
    if name_with_claude and claude_key:
        try:
            lines, _, synopsis = name_characters(lines, f"{title}\n{caption}".strip(), claude_key,
                                                claude_model, romanize_hinglish, progress)
        except Exception as e:  # keep the raw transcript rather than fail the whole run
            progress(f"Character naming skipped: {e}")
    for l in lines:
        if not l.character:
            l.character = f"Speaker {l.speaker}" if l.speaker else "Speaker"

    t = Transcript(source=source, title=title, caption=caption, duration=duration, language=lang,
                   engine=engine, diarized=diarized, lines=lines)
    progress("Done.")
    return t, synopsis
