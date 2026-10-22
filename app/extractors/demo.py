"""Offline demo extractor: generates fake profiles and real (synthetic) MP4s with ffmpeg.

Enabled with DEMO_MODE=true. Only handles that start with "demo" use it, e.g. @demo_brand.
Useful for trying the UI and for the end-to-end test, with zero Instagram traffic.
"""
from __future__ import annotations

import hashlib
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator

from app.extractors.base import (
    DownloadError,
    Extractor,
    NotFoundError,
    PrivateAccountError,
    Target,
    VideoMeta,
)

DEMO_CAPTIONS = [
    "Paisa bachana hai? Ye 3 galtiyan mat karna #finance #savings",
    "POV: you finally found a skincare routine that works #skincare #routine",
    "Office mein sabse bada time-waste? Meetings. #productivity #worklife",
    "We tested 5 budget earphones so you don't have to #tech #review",
    "Monday motivation, but make it honest #motivation",
    "Ghar pe 10 minute ki chai recipe #chai #recipe",
    "3 hooks that doubled our CTR this month #marketing #ads",
    "Unboxing our new summer drop #fashion #newdrop",
]


def is_demo_handle(handle: str | None) -> bool:
    return bool(handle) and handle.lower().startswith("demo")


class DemoExtractor(Extractor):
    name = "demo"

    def __init__(self, count: int = 8, generate_media: bool = True):
        self.count = count
        self.generate_media = generate_media
        self.download_calls: list[str] = []

    def can_handle(self, target: Target) -> bool:
        if target.kind == "profile":
            return is_demo_handle(target.handle)
        return bool(target.shortcode) and target.shortcode.lower().startswith("demo")

    def _meta(self, handle: str, i: int) -> VideoMeta:
        sc = f"DEMO{hashlib.md5(f'{handle}{i}'.encode()).hexdigest()[:7].upper()}"
        caption = DEMO_CAPTIONS[i % len(DEMO_CAPTIONS)]
        posted = datetime(2026, 10, 20, 12, 0) - timedelta(days=3 * i)
        return VideoMeta(
            shortcode=sc,
            handle=handle,
            url=f"https://www.instagram.com/reel/{sc}/",
            posted_at=posted,
            caption=caption,
            hashtags=sorted({w[1:] for w in caption.split() if w.startswith("#")}),
            views=int(5000 * (1 + (i * 37) % 23)),
            likes=int(300 * (1 + (i * 11) % 13)),
            comments=int(10 * (1 + (i * 7) % 9)),
            duration=4.0 + (i % 3),
            audio_name="Original audio" if i % 2 else None,
            is_paid_partnership=(i % 4 == 0),
            is_reel=(i % 5 != 4),
            thumbnail_url=None,
            video_url=f"demo://{sc}",
        )

    def iter_videos(self, target: Target) -> Iterator[VideoMeta]:
        if target.kind == "post":
            yield self.refresh(target.shortcode or "")
            return
        h = (target.handle or "").lower()
        if "private" in h:
            raise PrivateAccountError(f"@{h} is private")
        if "missing" in h:
            raise NotFoundError(f"@{h} not found (deleted, renamed or never existed)")
        for i in range(self.count):
            yield self._meta(h, i)

    def refresh(self, shortcode: str) -> VideoMeta:
        for i in range(self.count):
            m = self._meta("demo_post", i)
            if m.shortcode == shortcode:
                return m
        m = self._meta("demo_post", 0)
        m.shortcode = shortcode
        return m

    def download_video(self, meta: VideoMeta, dest: Path) -> None:
        from app.extractors import get_limiter
        get_limiter().wait()  # same pacing as real Instagram downloads
        self.download_calls.append(meta.shortcode)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part.mp4")
        if not self.generate_media:
            tmp.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"0" * 64)
            tmp.replace(dest)
            return
        dur = str(meta.duration or 4)
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc2=size=360x640:rate=24:duration={dur}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(tmp),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise DownloadError("ffmpeg failed to make demo video", detail=r.stderr[-300:])
        tmp.replace(dest)

    def download_thumbnail(self, meta: VideoMeta, dest: Path) -> None:
        if not self.generate_media:
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
               "-i", "testsrc2=size=360x640:rate=1:duration=1", "-frames:v", "1", str(dest)]
        subprocess.run(cmd, capture_output=True)
