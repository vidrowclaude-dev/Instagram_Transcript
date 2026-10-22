"""Instagram extractor: instaloader for listing + downloads, yt-dlp as a fallback for single posts."""
from __future__ import annotations

import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import instaloader
from instaloader import exceptions as ilx

from app.config import Settings
from app.extractors.base import (
    DownloadError,
    Extractor,
    ExtractorError,
    LoginRequiredError,
    NotAVideoError,
    NotFoundError,
    PrivateAccountError,
    RateLimitedError,
    Target,
    VideoMeta,
)
from app.extractors.cookies import load_cookie_dict
from app.extractors.ratelimit import RateLimiter, retry_network
from app.logging_setup import get_logger

log = get_logger(__name__)

HASHTAG_RE = re.compile(r"#(\w+)", re.UNICODE)
_CHUNK = 1 << 16


# ---- error mapping -----------------------------------------------------------------

def map_error(e: BaseException, what: str = "") -> ExtractorError:
    """Translate instaloader / yt-dlp / requests errors into our error types."""
    if isinstance(e, ExtractorError):
        return e
    msg = str(e)
    low = msg.lower()
    if isinstance(e, ilx.ProfileNotExistsException) or isinstance(e, ilx.QueryReturnedNotFoundException):
        return NotFoundError(f"{what} not found (deleted, renamed or never existed)".strip(), detail=msg)
    if isinstance(e, ilx.PrivateProfileNotFollowedException):
        return PrivateAccountError(f"{what} is private".strip(), detail=msg)
    if isinstance(e, ilx.TooManyRequestsException) or "429" in msg or "too many requests" in low \
            or "please wait a few minutes" in low or "rate-limit" in low or "rate limit" in low:
        return RateLimitedError(detail=msg)
    if isinstance(e, ilx.LoginRequiredException) or "login required" in low or "login_required" in low \
            or "redirected to login" in low:
        return LoginRequiredError(detail=msg)
    if "not found" in low or "404" in msg or "does not exist" in low or "unavailable" in low:
        return NotFoundError(f"{what} not found or removed".strip(), detail=msg)
    if "private" in low:
        return PrivateAccountError(f"{what} is private".strip(), detail=msg)
    return ExtractorError(msg or e.__class__.__name__, detail=msg)


class _VaultRateController(instaloader.RateController):
    """Route every instaloader query through our shared limiter, and surface 429s
    to the job runner (which shows "cooling down") instead of sleeping silently."""

    def __init__(self, context, limiter: RateLimiter):
        super().__init__(context)
        self._limiter = limiter

    def wait_before_query(self, query_type: str) -> None:  # noqa: D401
        self._limiter.wait()
        super().wait_before_query(query_type)

    def handle_429(self, query_type: str) -> None:
        raise RateLimitedError(detail=f"429 on {query_type}")


# ---- node helpers (read only what the listing already returned: no extra requests) ----

def _dig(node: dict, *path: str) -> Any:
    cur: Any = node
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def _first(*vals: Any) -> Any:
    for v in vals:
        if v is not None:
            return v
    return None


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def meta_from_node(node: dict, handle: str | None) -> VideoMeta:
    shortcode = node.get("shortcode") or node.get("code")
    caption = None
    edges = _dig(node, "edge_media_to_caption", "edges")
    if isinstance(edges, list) and edges:
        caption = _dig(edges[0], "node", "text")
    if caption is None:
        raw_caption = node.get("caption")
        caption = raw_caption.get("text") if isinstance(raw_caption, dict) else raw_caption
    ts = _first(node.get("taken_at_timestamp"), node.get("taken_at"), node.get("date"))
    posted = datetime.fromtimestamp(int(ts), tz=timezone.utc).replace(tzinfo=None) if ts else None
    music = node.get("clips_music_attribution_info") or _dig(node, "clips_metadata", "music_info", "music_asset_info") or {}
    audio_name = None
    if isinstance(music, dict):
        song = music.get("song_name") or music.get("title")
        artist = music.get("artist_name") or music.get("display_artist")
        if song and artist:
            audio_name = f"{song} - {artist}"
        else:
            audio_name = song or artist
    product_type = node.get("product_type")
    owner = _first(_dig(node, "owner", "username"), _dig(node, "user", "username"), handle) or ""
    return VideoMeta(
        shortcode=shortcode,
        handle=(owner or "").lower(),
        url=f"https://www.instagram.com/reel/{shortcode}/" if product_type == "clips"
        else f"https://www.instagram.com/p/{shortcode}/",
        posted_at=posted,
        caption=caption,
        hashtags=sorted(set(HASHTAG_RE.findall(caption or ""))),
        views=_int(_first(node.get("video_play_count"), node.get("play_count"), node.get("video_view_count"),
                          node.get("view_count"))),
        likes=_int(_first(_dig(node, "edge_media_preview_like", "count"), _dig(node, "edge_liked_by", "count"),
                          node.get("like_count"))),
        comments=_int(_first(_dig(node, "edge_media_to_comment", "count"),
                             _dig(node, "edge_media_to_parent_comment", "count"), node.get("comment_count"))),
        duration=_first(node.get("video_duration"), node.get("video_duration_seconds")),
        audio_name=audio_name,
        is_paid_partnership=node.get("is_paid_partnership"),
        is_reel=(product_type == "clips") if product_type else None,
        is_pinned=bool(node.get("pinned_for_users")) or bool(node.get("timeline_pinned_user_ids")),
        thumbnail_url=_first(node.get("display_url"), node.get("thumbnail_src"),
                             _dig(node, "image_versions2", "candidates", 0, "url")),
        video_url=node.get("video_url"),
    )


# ---- extractor ---------------------------------------------------------------------

class InstagramExtractor(Extractor):
    name = "instagram"

    def __init__(self, settings: Settings, limiter: RateLimiter):
        self.settings = settings
        self.limiter = limiter
        self._local = threading.local()  # instaloader sessions aren't thread-safe

    # -- session --
    def _loader(self) -> instaloader.Instaloader:
        L = getattr(self._local, "loader", None)
        if L is None:
            L = instaloader.Instaloader(
                quiet=True,
                download_pictures=False,
                download_videos=False,
                download_video_thumbnails=False,
                download_geotags=False,
                download_comments=False,
                save_metadata=False,
                compress_json=False,
                max_connection_attempts=2,
                request_timeout=self.settings.request_timeout,
                rate_controller=lambda ctx: _VaultRateController(ctx, self.limiter),
            )
            cookies = load_cookie_dict(self.settings.cookies_path)
            if cookies and cookies.get("sessionid") and cookies.get("csrftoken"):
                L.load_session(cookies.get("ds_user_id") or "cookie-session", cookies)
                log.info("loaded browser session cookies", extra={"user_id": cookies.get("ds_user_id")})
            self._local.loader = L
        return L

    @property
    def logged_in(self) -> bool:
        return self._loader().context.is_logged_in

    def can_handle(self, target: Target) -> bool:
        return target.source == "instagram"

    # -- listing --
    def iter_videos(self, target: Target) -> Iterator[VideoMeta]:
        if target.kind == "post":
            yield self._single_post(target.shortcode or "")
            return
        yield from self._profile_videos(target.handle or "")

    def _profile_videos(self, handle: str) -> Iterator[VideoMeta]:
        L = self._loader()
        try:
            profile = instaloader.Profile.from_username(L.context, handle)
        except Exception as e:  # noqa: BLE001
            raise map_error(e, f"@{handle}") from e
        if profile.is_private and not (L.context.is_logged_in and profile.followed_by_viewer):
            raise PrivateAccountError(f"@{handle} is private")
        try:
            for post in profile.get_posts():
                node = post._node  # read-only: avoids one extra request per post
                if not node.get("is_video"):
                    continue
                yield meta_from_node(node, profile.username)
        except ExtractorError:
            raise
        except Exception as e:  # noqa: BLE001
            raise map_error(e, f"@{handle}") from e

    def _single_post(self, shortcode: str) -> VideoMeta:
        try:
            return self.refresh(shortcode)
        except (RateLimitedError, NotAVideoError, PrivateAccountError):
            raise
        except ExtractorError as e:
            # instaloader couldn't read it: try yt-dlp before giving up
            log.info("instaloader failed for post, trying yt-dlp", extra={"shortcode": shortcode, "err": str(e)})
            try:
                return ytdlp_meta(shortcode, self.settings)
            except ExtractorError:
                raise e from None

    def refresh(self, shortcode: str) -> VideoMeta:
        L = self._loader()
        try:
            post = instaloader.Post.from_shortcode(L.context, shortcode)
            if not post.is_video:
                raise NotAVideoError(f"Post {shortcode} is not a video")
            meta = meta_from_node(post._node, None)
            try:
                meta.video_url = post.video_url or meta.video_url  # best quality available
            except Exception:  # noqa: BLE001 - fall back to node url
                pass
            if not meta.handle:
                try:
                    meta.handle = post.owner_username.lower()
                except Exception:  # noqa: BLE001
                    meta.handle = "unknown"
            return meta
        except ExtractorError:
            raise
        except Exception as e:  # noqa: BLE001
            raise map_error(e, f"Post {shortcode}") from e

    # -- downloads --
    def _stream(self, url: str, dest: Path) -> None:
        session = self._loader().context._session  # same cookies/headers as the API calls
        tmp = dest.with_suffix(dest.suffix + ".part")
        dest.parent.mkdir(parents=True, exist_ok=True)

        def _get():
            self.limiter.wait()
            with session.get(url, stream=True, timeout=self.settings.request_timeout) as r:
                if r.status_code == 429:
                    raise RateLimitedError(detail="429 from CDN")
                if r.status_code in (401, 403, 404, 410):
                    raise DownloadError(f"CDN returned {r.status_code}", detail=url[:120])
                r.raise_for_status()
                with open(tmp, "wb") as fh:
                    for chunk in r.iter_content(_CHUNK):
                        if chunk:
                            fh.write(chunk)
            if tmp.stat().st_size == 0:
                raise DownloadError("Downloaded file is empty")
            tmp.replace(dest)

        import requests
        try:
            retry_network(_get, attempts=3, retry_on=(requests.ConnectionError, requests.Timeout, OSError))
        finally:
            if tmp.exists():
                tmp.unlink(missing_ok=True)

    def download_video(self, meta: VideoMeta, dest: Path) -> None:
        url = meta.video_url
        if not url:
            url = self.refresh(meta.shortcode).video_url
        try:
            self._stream(url, dest)  # type: ignore[arg-type]
        except DownloadError:
            # CDN links expire after a while: fetch a fresh one once, then try yt-dlp.
            fresh = self.refresh(meta.shortcode)
            try:
                self._stream(fresh.video_url, dest)  # type: ignore[arg-type]
            except DownloadError:
                ytdlp_download(meta.shortcode, dest, self.settings)

    def download_thumbnail(self, meta: VideoMeta, dest: Path) -> None:
        if not meta.thumbnail_url:
            return
        try:
            self._stream(meta.thumbnail_url, dest)
        except DownloadError:
            fresh = self.refresh(meta.shortcode)
            if fresh.thumbnail_url:
                self._stream(fresh.thumbnail_url, dest)


# ---- yt-dlp fallback -----------------------------------------------------------------

def _ytdlp_opts(settings: Settings, **extra) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": settings.request_timeout,
        "retries": 2,
    }
    if settings.cookies_path.exists():
        opts["cookiefile"] = str(settings.cookies_path)
    opts.update(extra)
    return opts


def ytdlp_meta(shortcode: str, settings: Settings) -> VideoMeta:
    import yt_dlp

    url = f"https://www.instagram.com/p/{shortcode}/"
    try:
        with yt_dlp.YoutubeDL(_ytdlp_opts(settings)) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:  # noqa: BLE001
        raise map_error(e, f"Post {shortcode}") from e
    if info.get("_type") == "playlist":
        entries = [x for x in (info.get("entries") or []) if x and x.get("vcodec") != "none"]
        if not entries:
            raise NotAVideoError(f"Post {shortcode} is not a video")
        info = entries[0]
    ts = info.get("timestamp")
    caption = info.get("description")
    return VideoMeta(
        shortcode=shortcode,
        handle=(info.get("channel") or info.get("uploader_id") or info.get("uploader") or "unknown").lower(),
        url=info.get("webpage_url") or url,
        posted_at=datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None) if ts else None,
        caption=caption,
        hashtags=sorted(set(HASHTAG_RE.findall(caption or ""))),
        views=_int(info.get("view_count")),
        likes=_int(info.get("like_count")),
        comments=_int(info.get("comment_count")),
        duration=info.get("duration"),
        audio_name=info.get("track"),
        thumbnail_url=info.get("thumbnail"),
        video_url=None,
    )


def ytdlp_download(shortcode: str, dest: Path, settings: Settings) -> None:
    import yt_dlp

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmpl = str(dest.with_suffix("")) + ".ytdlp.%(ext)s"
    opts = _ytdlp_opts(settings, outtmpl=tmpl, format="bv*+ba/b", merge_output_format="mp4")
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([f"https://www.instagram.com/p/{shortcode}/"])
    except Exception as e:  # noqa: BLE001
        raise map_error(e, f"Post {shortcode}") from e
    produced = sorted(dest.parent.glob(dest.stem + ".ytdlp.*"))
    mp4 = [p for p in produced if p.suffix == ".mp4"] or produced
    if not mp4:
        raise DownloadError("yt-dlp produced no file")
    mp4[0].replace(dest)
    for p in produced:
        if p.exists() and p != dest:
            p.unlink(missing_ok=True)
