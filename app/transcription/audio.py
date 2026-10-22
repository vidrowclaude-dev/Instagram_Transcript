"""ffmpeg helpers: probe for audio, extract 16 kHz mono WAV."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from app.transcription.base import NoAudioError, TranscriptionError


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def probe(path: Path) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise TranscriptionError(f"ffprobe could not read the file: {r.stderr.strip()[-200:]}")
    return json.loads(r.stdout or "{}")


def has_audio(path: Path) -> bool:
    info = probe(path)
    return any(s.get("codec_type") == "audio" for s in info.get("streams", []))


def duration_of(path: Path) -> float | None:
    try:
        return float(probe(path).get("format", {}).get("duration"))
    except (TypeError, ValueError, TranscriptionError):
        return None


def extract_audio(video: Path, wav: Path) -> Path:
    """Write a 16 kHz mono PCM WAV next to nothing else; raises NoAudioError if silent-by-design."""
    if not has_audio(video):
        raise NoAudioError("The video has no audio track")
    wav.parent.mkdir(parents=True, exist_ok=True)
    tmp = wav.with_suffix(".part.wav")
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-f", "wav", str(tmp)],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size < 1024:
        tmp.unlink(missing_ok=True)
        raise TranscriptionError(f"ffmpeg audio extraction failed: {r.stderr.strip()[-200:]}")
    tmp.replace(wav)
    return wav
