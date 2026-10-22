"""Pre-download filters: content type, date range, latest N, min views, sort."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from typing import Iterable, Iterator

from app.extractors.base import VideoMeta


@dataclass
class Filters:
    content_type: str = "reels"        # "reels" | "all_videos"
    date_from: date | None = None
    date_to: date | None = None
    latest_n: int | None = None
    min_views: int | None = None
    sort: str = "newest"               # "newest" | "most_viewed"

    @classmethod
    def from_dict(cls, d: dict | None) -> "Filters":
        d = d or {}

        def _date(v):
            if not v:
                return None
            if isinstance(v, date):
                return v
            return date.fromisoformat(str(v)[:10])

        def _int(v):
            if v in (None, "", 0, "0"):
                return None
            return max(0, int(v))

        f = cls(
            content_type=d.get("content_type") or "reels",
            date_from=_date(d.get("date_from")),
            date_to=_date(d.get("date_to")),
            latest_n=_int(d.get("latest_n")),
            min_views=_int(d.get("min_views")),
            sort=d.get("sort") or "newest",
        )
        if f.content_type not in ("reels", "all_videos"):
            raise ValueError("content_type must be 'reels' or 'all_videos'")
        if f.sort not in ("newest", "most_viewed"):
            raise ValueError("sort must be 'newest' or 'most_viewed'")
        if f.date_from and f.date_to and f.date_from > f.date_to:
            raise ValueError("date_from is after date_to")
        return f

    def to_dict(self) -> dict:
        return {
            "content_type": self.content_type,
            "date_from": self.date_from.isoformat() if self.date_from else None,
            "date_to": self.date_to.isoformat() if self.date_to else None,
            "latest_n": self.latest_n,
            "min_views": self.min_views,
            "sort": self.sort,
        }

    # ---- per-item checks -------------------------------------------------------
    def type_ok(self, v: VideoMeta) -> bool:
        if self.content_type == "reels":
            # When Instagram doesn't tell us the product type, keep the video.
            return v.is_reel is not False
        return True

    def date_ok(self, v: VideoMeta) -> bool:
        if v.posted_at is None:
            return self.date_from is None and self.date_to is None
        if self.date_from and v.posted_at < datetime.combine(self.date_from, time.min):
            return False
        if self.date_to and v.posted_at > datetime.combine(self.date_to, time.max):
            return False
        return True

    def views_ok(self, v: VideoMeta) -> bool:
        if not self.min_views:
            return True
        return (v.views or 0) >= self.min_views

    def matches(self, v: VideoMeta) -> bool:
        return self.type_ok(v) and self.date_ok(v) and self.views_ok(v)

    def is_older_than_range(self, v: VideoMeta) -> bool:
        return bool(self.date_from and v.posted_at and v.posted_at < datetime.combine(self.date_from, time.min))

    @property
    def needs_full_scan(self) -> bool:
        """Sorting by views means we can't stop early after N matches."""
        return self.sort == "most_viewed"


def apply_filters(
    stream: Iterable[VideoMeta],
    f: Filters,
    *,
    max_scan: int = 600,
    stop_after_old: int = 6,
) -> tuple[list[VideoMeta], dict]:
    """Consume a newest-first stream and return the matching videos.

    Stops early when possible so big profiles stay fast:
      * latest_n reached (and no view sort)
      * `stop_after_old` consecutive non-pinned posts older than date_from
      * max_scan posts read
    Returns (videos, stats).
    """
    out: list[VideoMeta] = []
    scanned = 0
    old_streak = 0
    stopped = "end"
    seen: set[str] = set()

    for v in stream:
        scanned += 1
        if v.shortcode in seen:
            continue
        seen.add(v.shortcode)

        if f.is_older_than_range(v) and not v.is_pinned:
            old_streak += 1
            if old_streak >= stop_after_old:
                stopped = "date_range"
                break
        else:
            old_streak = 0

        if f.matches(v):
            out.append(v)
            if f.latest_n and not f.needs_full_scan and len(out) >= f.latest_n:
                stopped = "latest_n"
                break

        if scanned >= max_scan:
            stopped = "max_scan"
            break

    out = sort_videos(out, f.sort)
    if f.latest_n:
        out = out[: f.latest_n]
    return out, {"scanned": scanned, "matched": len(out), "stopped": stopped}


def sort_videos(videos: list[VideoMeta], how: str) -> list[VideoMeta]:
    if how == "most_viewed":
        return sorted(videos, key=lambda v: (v.views or 0), reverse=True)
    return sorted(videos, key=lambda v: v.posted_at or datetime.min, reverse=True)


def iter_take(it: Iterable, n: int) -> Iterator:
    for i, x in enumerate(it):
        if i >= n:
            return
        yield x
