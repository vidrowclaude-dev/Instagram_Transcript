"""Where files live.

All media goes into one shared library so the same reel is never downloaded twice,
even across jobs:

  data/library/<handle>/videos/<handle>_<YYYY-MM-DD>_<shortcode>.mp4
  data/library/<handle>/thumbnails/...jpg
  data/library/<handle>/captions/...txt
  data/library/<handle>/transcripts/...{txt,srt,json}

Paths stored in the DB are relative to data_dir, so the data folder can be moved.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from app.config import get_settings

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def safe(s: str) -> str:
    return _SAFE.sub("_", s or "unknown")[:80] or "unknown"


def stem(handle: str, posted_at: datetime | None, shortcode: str) -> str:
    day = posted_at.strftime("%Y-%m-%d") if posted_at else "undated"
    return f"{safe(handle)}_{day}_{safe(shortcode)}"


def media_paths(handle: str, posted_at: datetime | None, shortcode: str) -> dict[str, Path]:
    root = get_settings().library_dir / safe(handle)
    s = stem(handle, posted_at, shortcode)
    return {
        "video": root / "videos" / f"{s}.mp4",
        "thumbnail": root / "thumbnails" / f"{s}.jpg",
        "caption": root / "captions" / f"{s}.txt",
        "transcript_base": root / "transcripts" / s,
        "audio": get_settings().cache_dir / "audio" / f"{s}.wav",
    }


def rel(p: Path | None) -> str | None:
    if p is None:
        return None
    try:
        return str(p.resolve().relative_to(get_settings().data_dir.resolve()))
    except ValueError:
        return str(p)


def absolute(p: str | None) -> Path | None:
    if not p:
        return None
    path = Path(p)
    return path if path.is_absolute() else get_settings().data_dir / path


def exists_nonempty(p: Path | None) -> bool:
    return bool(p) and p.exists() and p.stat().st_size > 0  # type: ignore[union-attr]
