"""Read a Netscape-format cookies.txt exported from the user's own browser.

We only keep instagram.com cookies, never ask for a password, and store the
file with 0600 permissions inside data/secrets/.
"""
from __future__ import annotations

import http.cookiejar
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

REQUIRED = ("sessionid", "csrftoken")


@dataclass
class CookieInfo:
    present: bool
    valid: bool
    message: str
    user_id: str | None = None
    expires: datetime | None = None
    uploaded_at: datetime | None = None

    def to_dict(self) -> dict:
        return {
            "present": self.present,
            "valid": self.valid,
            "message": self.message,
            "user_id": self.user_id,
            "expires": self.expires.isoformat() if self.expires else None,
            "uploaded_at": self.uploaded_at.isoformat() if self.uploaded_at else None,
        }


def parse_cookies_text(text: str) -> dict[str, str]:
    """Return {name: value} for instagram.com cookies from Netscape cookies.txt text."""
    cookies: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_"):]
        elif not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _flag, _path, _secure, _expiry, name, value = parts[:7]
        if "instagram.com" not in domain.lower():
            continue
        cookies[name] = value
    return cookies


def load_cookie_dict(path: Path) -> dict[str, str] | None:
    if not path.exists():
        return None
    return parse_cookies_text(path.read_text(encoding="utf-8", errors="ignore")) or None


def inspect_cookies(path: Path) -> CookieInfo:
    if not path.exists():
        return CookieInfo(False, False, "No cookies uploaded. Public profiles still work; Instagram may "
                                        "limit how far back you can scroll without a session.")
    text = path.read_text(encoding="utf-8", errors="ignore")
    cookies = parse_cookies_text(text)
    uploaded = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    missing = [c for c in REQUIRED if not cookies.get(c)]
    if missing:
        return CookieInfo(True, False, f"cookies.txt is missing: {', '.join(missing)}. Export it while "
                                       "logged in to instagram.com.", uploaded_at=uploaded)
    expires = None
    jar = http.cookiejar.MozillaCookieJar()
    try:
        jar.load(str(path), ignore_discard=True, ignore_expires=True)
        for c in jar:
            if c.name == "sessionid" and "instagram.com" in c.domain and c.expires:
                expires = datetime.fromtimestamp(c.expires, tz=timezone.utc)
    except (http.cookiejar.LoadError, OSError):
        pass
    if expires and expires < datetime.now(timezone.utc):
        return CookieInfo(True, False, "The Instagram session in cookies.txt has expired. Export a fresh one.",
                          user_id=cookies.get("ds_user_id"), expires=expires, uploaded_at=uploaded)
    return CookieInfo(True, True, "Session cookies loaded.", user_id=cookies.get("ds_user_id"),
                      expires=expires, uploaded_at=uploaded)


def save_cookies(path: Path, text: str) -> CookieInfo:
    cookies = parse_cookies_text(text)
    if not cookies:
        raise ValueError("That file has no instagram.com cookies. Export cookies.txt (Netscape format) "
                         "from a browser tab where you're logged in to instagram.com.")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Keep only Instagram lines so nothing else from the browser is stored.
    kept = ["# Netscape HTTP Cookie File"]
    for line in text.splitlines():
        probe = line[len("#HttpOnly_"):] if line.startswith("#HttpOnly_") else line
        if probe and not probe.startswith("#") and "instagram.com" in probe.split("\t")[0].lower():
            kept.append(line)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(kept) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)
    return inspect_cookies(path)
