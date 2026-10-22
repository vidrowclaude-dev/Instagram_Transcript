"""Output writers (.txt / .srt / .json) and the hook extractor."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

from app.transcription.base import Segment, TranscriptResult

_WS = re.compile(r"\s+")


def clean_text(text: str) -> str:
    return _WS.sub(" ", text or "").strip()


def to_txt(result: TranscriptResult) -> str:
    """One clean paragraph."""
    return clean_text(result.text) + "\n"


def _ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(result: TranscriptResult) -> str:
    lines: list[str] = []
    n = 0
    for seg in result.segments:
        text = clean_text(seg.text)
        if not text:
            continue
        n += 1
        end = seg.end if seg.end > seg.start else seg.start + 0.5
        lines += [str(n), f"{_ts(seg.start)} --> {_ts(end)}", text, ""]
    return "\n".join(lines)


def to_json(result: TranscriptResult, **meta) -> str:
    payload = {**meta, **result.to_dict()}
    return json.dumps(payload, ensure_ascii=False, indent=2)


def hook_text(segments: list[Segment], seconds: float = 3.0) -> str:
    """Words spoken in the first `seconds`. A segment that straddles the cut-off
    contributes the proportional share of its words (rounded up)."""
    if seconds <= 0:
        return ""
    words: list[str] = []
    for seg in segments:
        if seg.start >= seconds:
            break
        seg_words = clean_text(seg.text).split()
        if not seg_words:
            continue
        if seg.end <= seconds or seg.end <= seg.start:
            words += seg_words
        else:
            frac = (seconds - seg.start) / (seg.end - seg.start)
            words += seg_words[: max(1, math.ceil(len(seg_words) * frac))]
    return " ".join(words)


def write_outputs(result: TranscriptResult, base: Path, **meta) -> dict[str, Path]:
    """Write base.txt / base.srt / base.json atomically. Returns the paths."""
    base.parent.mkdir(parents=True, exist_ok=True)
    out = {}
    for ext, content in (("txt", to_txt(result)), ("srt", to_srt(result)), ("json", to_json(result, **meta))):
        p = base.with_suffix(f".{ext}")
        tmp = p.with_suffix(f".{ext}.part")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(p)
        out[ext] = p
    return out
