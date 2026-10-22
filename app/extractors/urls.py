"""Parse whatever the user pastes into a list of Targets.

Accepted:
  https://www.instagram.com/handle/            (also /handle/reels/, /handle/tagged/ etc.)
  instagram.com/handle?igsh=...                 (no scheme, tracking params)
  @handle  /  handle
  https://www.instagram.com/reel/SHORTCODE/     (also /reels/, /p/, /tv/, /handle/reel/SHORTCODE/)
  instagr.am/p/SHORTCODE
Multiple items may be separated by newlines, commas or spaces.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlparse

from app.extractors.base import Target

HANDLE_RE = re.compile(r"^(?!.*\.\.)(?!\.)[A-Za-z0-9._]{1,30}(?<!\.)$")
SHORTCODE_RE = re.compile(r"^[A-Za-z0-9_-]{5,64}$")
POST_PREFIXES = {"p", "reel", "reels", "tv"}
IG_HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com", "instagr.am", "www.instagr.am"}

# First path segments that are Instagram pages, not usernames.
RESERVED = {
    "explore", "accounts", "direct", "stories", "about", "developer", "legal", "web", "emails",
    "challenge", "graphql", "api", "static", "privacy", "terms", "session", "login", "signup",
    "reels", "p", "reel", "tv", "audio", "locations", "directory", "nametag", "your_activity",
}


@dataclass
class ParseError:
    raw: str
    message: str

    def to_dict(self) -> dict:
        return {"raw": self.raw, "message": self.message, "reason": "invalid_input"}


def _clearly_one_item(tok: str) -> bool:
    t = tok.lower()
    return t.startswith("@") or "instagram.com" in t or "instagr.am" in t or t.startswith("http")


def split_inputs(text: str) -> list[str]:
    """One item per line (or comma). A line is split on spaces only when every piece is
    clearly a link or an @handle, so typed sentences aren't misread as handles."""
    out: list[str] = []
    for chunk in re.split(r"[\n,]+", text or ""):
        chunk = chunk.strip()
        if not chunk:
            continue
        toks = chunk.split()
        if len(toks) > 1 and all(_clearly_one_item(t) for t in toks):
            out += toks
        else:
            out.append(chunk)
    return out


def parse_one(raw: str) -> Target:
    """Parse a single input. Raises ValueError with a human message on failure."""
    s = raw.strip().strip("<>\"'")
    if not s:
        raise ValueError("Empty input")

    # @handle or bare handle
    if s.startswith("@"):
        handle = s[1:]
        if not HANDLE_RE.match(handle):
            raise ValueError(f"'{raw}' is not a valid Instagram handle")
        return Target(kind="profile", raw=raw, handle=handle.lower())

    looks_like_url = "/" in s or "." in s and any(h in s.lower() for h in ("instagram", "instagr.am"))
    if not looks_like_url:
        if HANDLE_RE.match(s):
            return Target(kind="profile", raw=raw, handle=s.lower())
        raise ValueError(f"'{raw}' is not a valid Instagram handle or link")

    url = s if re.match(r"^https?://", s, re.I) else "https://" + s
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in IG_HOSTS:
        raise ValueError(f"'{raw}' is not an Instagram link")

    segs = [seg for seg in parsed.path.split("/") if seg]
    if not segs:
        raise ValueError(f"'{raw}' has no profile or post in it")

    first = segs[0].lower()

    # /p/<sc>, /reel/<sc>, /reels/<sc>, /tv/<sc>
    if first in POST_PREFIXES:
        if len(segs) < 2:
            raise ValueError(f"'{raw}' is missing the post code")
        sc = segs[1]
        if not SHORTCODE_RE.match(sc):
            raise ValueError(f"'{raw}' has an invalid post code")
        return Target(kind="post", raw=raw, shortcode=sc)

    if first == "stories":
        raise ValueError(f"'{raw}' is a Story link; Stories aren't supported, only posts and Reels")

    if first in RESERVED:
        raise ValueError(f"'{raw}' is not a profile or post link")

    handle = segs[0]
    if not HANDLE_RE.match(handle):
        raise ValueError(f"'{raw}' has an invalid handle")

    # /handle/reel/<sc> or /handle/p/<sc>
    if len(segs) >= 3 and segs[1].lower() in POST_PREFIXES and SHORTCODE_RE.match(segs[2]):
        return Target(kind="post", raw=raw, handle=handle.lower(), shortcode=segs[2])

    return Target(kind="profile", raw=raw, handle=handle.lower())


def parse_inputs(text: str) -> tuple[list[Target], list[ParseError]]:
    """Parse a pasted blob. Deduplicates targets, keeps order."""
    targets: list[Target] = []
    errors: list[ParseError] = []
    seen: set[tuple] = set()
    for raw in split_inputs(text):
        try:
            t = parse_one(raw)
        except ValueError as e:
            errors.append(ParseError(raw=raw, message=str(e)))
            continue
        key = (t.kind, t.shortcode if t.kind == "post" else t.handle)
        if key in seen:
            continue
        seen.add(key)
        targets.append(t)
    return targets, errors
