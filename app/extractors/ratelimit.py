"""A shared, thread-safe rate limiter with randomised spacing and cooldowns.

Every Instagram request in a process goes through `RateLimiter.wait()`, so
parallel download threads still respect one global request rhythm. When a
429 arrives, `cooldown()` pauses *all* threads, not just the one that hit it.
"""
from __future__ import annotations

import random
import threading
import time
from typing import Callable, TypeVar

T = TypeVar("T")


class RateLimiter:
    def __init__(self, min_delay: float, max_delay: float, *, sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        if max_delay < min_delay:
            max_delay = min_delay
        self.min_delay = min_delay
        self.max_delay = max_delay
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.Lock()
        self._next_allowed = 0.0
        self._cooldown_until = 0.0

    def wait(self) -> float:
        """Block until the next request may go out. Returns seconds waited."""
        with self._lock:
            now = self._clock()
            start = max(now, self._next_allowed, self._cooldown_until)
            gap = random.uniform(self.min_delay, self.max_delay)
            self._next_allowed = start + gap
        waited = max(0.0, start - now)
        if waited:
            self._sleep(waited)
        return waited

    def cooldown(self, seconds: float) -> None:
        """Pause all requests for `seconds` from now."""
        with self._lock:
            self._cooldown_until = max(self._cooldown_until, self._clock() + seconds)

    @property
    def cooling_down_for(self) -> float:
        return max(0.0, self._cooldown_until - self._clock())


def backoff_seconds(attempt: int, base: float, cap: float) -> float:
    """Exponential backoff with +/-20% jitter. attempt starts at 1."""
    raw = min(cap, base * (2 ** max(0, attempt - 1)))
    return max(1.0, raw * random.uniform(0.8, 1.2))


def retry_network(fn: Callable[[], T], *, attempts: int = 3, base: float = 2.0,
                  retry_on: tuple[type[BaseException], ...] = (OSError,),
                  sleep: Callable[[float], None] = time.sleep) -> T:
    """Retry a flaky network call with exponential backoff (for non-429 errors)."""
    last: BaseException | None = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except retry_on as e:  # type: ignore[misc]
            last = e
            if i == attempts:
                break
            sleep(backoff_seconds(i, base, 30.0))
    assert last is not None
    raise last
