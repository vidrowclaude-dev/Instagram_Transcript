"""Extractor registry. Add new sources here."""
from __future__ import annotations

import threading

from app.config import Settings, get_settings
from app.extractors.base import Extractor, InvalidInputError, Target
from app.extractors.ratelimit import RateLimiter

_lock = threading.RLock()
_limiter: RateLimiter | None = None
_extractors: list[Extractor] | None = None
_override: list[Extractor] | None = None


def get_limiter(settings: Settings | None = None) -> RateLimiter:
    global _limiter
    s = settings or get_settings()
    with _lock:
        if _limiter is None:
            _limiter = RateLimiter(s.min_delay, s.max_delay)
        return _limiter


def get_extractors() -> list[Extractor]:
    global _extractors
    if _override is not None:
        return _override
    with _lock:
        if _extractors is None:
            s = get_settings()
            exs: list[Extractor] = []
            if s.demo_mode:
                from app.extractors.demo import DemoExtractor
                exs.append(DemoExtractor())
            from app.extractors.instagram import InstagramExtractor
            exs.append(InstagramExtractor(s, get_limiter(s)))
            _extractors = exs
        return _extractors


def extractor_for(target: Target) -> Extractor:
    for ex in get_extractors():
        if ex.can_handle(target):
            return ex
    raise InvalidInputError(f"No extractor can handle {target.raw}")


def extractor_by_name(name: str) -> Extractor:
    for ex in get_extractors():
        if ex.name == name:
            return ex
    raise InvalidInputError(f"Extractor '{name}' is not available (is DEMO_MODE off?)")


def set_extractors_for_tests(extractors: list[Extractor] | None) -> None:
    """Swap in fake extractors (tests)."""
    global _override, _extractors, _limiter
    _override = extractors
    _extractors = None
    _limiter = None


def reset_extractors() -> None:
    """Drop cached sessions (e.g. after new cookies are uploaded)."""
    global _extractors
    with _lock:
        _extractors = None
