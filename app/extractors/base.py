"""Source-agnostic extractor interface.

Adding a new source (YouTube, TikTok, ...) means writing one class that
implements `Extractor` and registering it in `app/extractors/__init__.py`.
Nothing else in the app needs to change.
"""
from __future__ import annotations

import abc
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterator


@dataclass
class Target:
    """One thing the user asked for: a whole profile or a single post."""
    kind: str               # "profile" | "post"
    raw: str                # what the user typed
    handle: str | None = None
    shortcode: str | None = None
    source: str = "instagram"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Target":
        return cls(**{k: d.get(k) for k in ("kind", "raw", "handle", "shortcode", "source") if k in d})

    @property
    def label(self) -> str:
        if self.kind == "profile":
            return f"@{self.handle}"
        return f"post {self.shortcode}"


@dataclass
class VideoMeta:
    shortcode: str
    handle: str
    url: str
    posted_at: datetime | None = None
    caption: str | None = None
    hashtags: list[str] = field(default_factory=list)
    views: int | None = None
    likes: int | None = None
    comments: int | None = None
    duration: float | None = None
    audio_name: str | None = None
    is_paid_partnership: bool | None = None
    is_reel: bool | None = None
    is_pinned: bool = False
    thumbnail_url: str | None = None
    video_url: str | None = None  # CDN url; expires, so never persisted


# ---- Errors -----------------------------------------------------------------
# Every error carries a short machine `reason` that ends up in the UI / CSV.

class ExtractorError(Exception):
    reason = "error"

    def __init__(self, message: str = "", *, detail: str | None = None):
        super().__init__(message or self.__class__.__doc__ or self.reason)
        self.detail = detail


class InvalidInputError(ExtractorError):
    """That doesn't look like an Instagram profile or post link."""
    reason = "invalid_input"


class NotFoundError(ExtractorError):
    """Profile or post not found (deleted, renamed, or never existed)."""
    reason = "not_found"


class PrivateAccountError(ExtractorError):
    """This account is private. Only accounts your own session follows can be read."""
    reason = "private"


class LoginRequiredError(ExtractorError):
    """Instagram is asking for a login. Upload a cookies.txt from your own browser session in Settings."""
    reason = "login_required"


class RateLimitedError(ExtractorError):
    """Instagram is rate-limiting requests (HTTP 429). Cooling down before retrying."""
    reason = "rate_limited"


class NotAVideoError(ExtractorError):
    """This post has no video."""
    reason = "not_a_video"


class DownloadError(ExtractorError):
    """The video file could not be downloaded."""
    reason = "download_failed"


# ---- Interface ----------------------------------------------------------------

class Extractor(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    def can_handle(self, target: Target) -> bool:
        ...

    @abc.abstractmethod
    def iter_videos(self, target: Target) -> Iterator[VideoMeta]:
        """Yield videos for a target, newest first where possible.

        Must raise NotFoundError / PrivateAccountError / LoginRequiredError /
        RateLimitedError as appropriate. Filtering is done by the caller.
        """

    @abc.abstractmethod
    def refresh(self, shortcode: str) -> VideoMeta:
        """Re-fetch one video's metadata (fresh, non-expired video_url)."""

    @abc.abstractmethod
    def download_video(self, meta: VideoMeta, dest: Path) -> None:
        """Download the video file to `dest` (write atomically)."""

    def download_thumbnail(self, meta: VideoMeta, dest: Path) -> None:
        """Download the thumbnail to `dest`. Optional; default does nothing."""
        return None
