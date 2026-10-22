"""The two background tasks: preview (list + filter) and run (download + transcribe).

Design rules:
  * One bad video never kills the job: every per-video error is caught and recorded.
  * A 429 pauses every thread (shared limiter) and flips the job to "cooling_down".
  * Re-running is always safe: finished files are detected on disk and skipped.
  * A heartbeat lets a restarted worker pick up jobs that were running when it died.
"""
from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import or_, select, update

from app.config import get_settings
from app.db import Job, JobStatus, Mode, Video, VideoStatus, session_scope, utcnow
from app.extractors import extractor_by_name, extractor_for, get_limiter
from app.extractors.base import ExtractorError, RateLimitedError, Target, VideoMeta
from app.extractors.filters import Filters, apply_filters
from app.extractors.ratelimit import backoff_seconds
from app.logging_setup import get_logger
from app.storage.paths import absolute, exists_nonempty, media_paths, rel
from app.transcription.audio import extract_audio
from app.transcription.base import Segment, Transcriber, TranscriptionError, TranscriptResult
from app.transcription.engines import get_transcriber
from app.transcription.formats import hook_text, write_outputs
from app.transcription.romanize import has_devanagari, romanize

log = get_logger(__name__)


class JobCancelled(Exception):
    pass


class GiveUp(Exception):
    """Too many consecutive rate-limit cooldowns."""


# ---- small DB helpers ---------------------------------------------------------------

def _set_job(job_id: str, **fields) -> None:
    with session_scope() as s:
        s.execute(update(Job).where(Job.id == job_id).values(**fields, updated_at=utcnow()))


def _set_video(video_id: int, **fields) -> None:
    with session_scope() as s:
        s.execute(update(Video).where(Video.id == video_id).values(**fields))


def _cancel_requested(job_id: str) -> bool:
    with session_scope() as s:
        j = s.get(Job, job_id)
        return bool(j is None or j.cancel_requested)


class Heartbeat:
    """Touches job.heartbeat_at every few seconds while the job runs."""

    def __init__(self, job_id: str):
        self.job_id = job_id
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True, name=f"hb-{job_id}")

    def _run(self):
        every = get_settings().heartbeat_seconds
        while not self._stop.wait(every):
            try:
                _set_job(self.job_id, heartbeat_at=utcnow())
            except Exception:  # noqa: BLE001
                log.warning("heartbeat failed", extra={"job_id": self.job_id})

    def __enter__(self):
        _set_job(self.job_id, heartbeat_at=utcnow())
        self._t.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        self._t.join(timeout=2)


@dataclass
class Cooldowns:
    """Shared across a job's threads: consecutive 429 counter + the job-level status flip."""
    job_id: str
    count: int = 0
    ends_at: float = 0.0  # monotonic time the current cooldown ends
    lock: threading.Lock = field(default_factory=threading.Lock)

    def hit(self, detail: str | None) -> float:
        s = get_settings()
        with self.lock:
            self.count += 1
            if self.count > s.max_cooldowns:
                raise GiveUp(f"Instagram kept rate-limiting after {s.max_cooldowns} cooldowns")
            secs = backoff_seconds(self.count, s.backoff_base, s.backoff_max)
            get_limiter().cooldown(secs)
            self.ends_at = time.monotonic() + secs
            until = utcnow() + timedelta(seconds=secs)
            _set_job(self.job_id, status=JobStatus.COOLING_DOWN, cooldown_until=until,
                     message=f"Instagram is rate-limiting. Cooling down for {int(secs)}s "
                             f"(attempt {self.count}/{s.max_cooldowns}).")
            log.warning("rate limited, cooling down",
                        extra={"job_id": self.job_id, "seconds": round(secs), "attempt": self.count, "detail": detail})
            return secs

    def ok(self) -> None:
        """A request succeeded. Only a success *after* the cooldown ends clears it: with parallel
        downloads, another thread can finish a request that started before the 429 arrived."""
        with self.lock:
            if self.count and time.monotonic() >= self.ends_at:
                self.count = 0
                _set_job(self.job_id, status=JobStatus.RUNNING, cooldown_until=None, message=None)


def _with_cooldown(cd: Cooldowns, job_id: str, fn):
    """Run fn; on RateLimitedError wait out a cooldown and try again."""
    while True:
        if _cancel_requested(job_id):
            raise JobCancelled()
        try:
            out = fn()
            cd.ok()
            return out
        except RateLimitedError as e:
            secs = cd.hit(e.detail)
            # Sleep in small steps so cancel stays responsive.
            end = time.monotonic() + secs
            while (left := end - time.monotonic()) > 0:
                if _cancel_requested(job_id):
                    raise JobCancelled()
                time.sleep(min(2.0, left))


# ---- preview ----------------------------------------------------------------------------

def _meta_to_row(m: VideoMeta, job_id: str, pos: int, source: str) -> Video:
    return Video(
        job_id=job_id, position=pos, source=source, shortcode=m.shortcode, handle=m.handle or "unknown",
        url=m.url, posted_at=m.posted_at, caption=m.caption, hashtags=m.hashtags, views=m.views, likes=m.likes,
        comments=m.comments, duration=m.duration, audio_name=m.audio_name,
        is_paid_partnership=m.is_paid_partnership, is_reel=m.is_reel, thumbnail_url=m.thumbnail_url,
    )


def run_preview(job_id: str) -> None:
    s = get_settings()
    with session_scope() as sess:
        job = sess.get(Job, job_id)
        if job is None:
            return
        targets = [Target.from_dict(t) for t in job.targets]
        filters = Filters.from_dict(job.filters)
        errors = list(job.input_errors or [])
    cd = Cooldowns(job_id)
    found: list[tuple[VideoMeta, str]] = []
    stats: list[dict] = []

    with Heartbeat(job_id):
        _set_job(job_id, status=JobStatus.PREVIEWING, message="Looking up videos…")
        for t in targets:
            _set_job(job_id, message=f"Reading {t.label}…")
            try:
                ex = extractor_for(t)
                if t.kind == "profile":
                    vids, st = _with_cooldown(
                        cd, job_id, lambda: apply_filters(ex.iter_videos(t), filters, max_scan=s.max_scan))
                    stats.append({"target": t.label, **st})
                    if not vids and st["scanned"] == 0:
                        errors.append({"raw": t.raw, "reason": "no_videos",
                                       "message": f"{t.label} has no video posts"})
                else:
                    vids = _with_cooldown(cd, job_id, lambda: list(ex.iter_videos(t)))
                found += [(v, ex.name) for v in vids]
            except JobCancelled:
                _set_job(job_id, status=JobStatus.CANCELLED, message="Cancelled", finished_at=utcnow())
                return
            except GiveUp as e:
                errors.append({"raw": t.raw, "reason": "rate_limited", "message": str(e)})
                break
            except ExtractorError as e:
                log.info("target failed", extra={"job_id": job_id, "target": t.raw, "reason": e.reason})
                errors.append({"raw": t.raw, "reason": e.reason, "message": str(e)})
            except Exception as e:  # noqa: BLE001
                log.exception("target crashed", extra={"job_id": job_id, "target": t.raw})
                errors.append({"raw": t.raw, "reason": "error", "message": f"Unexpected error: {e}"})

        with session_scope() as sess:
            existing = {v.shortcode for v in sess.scalars(select(Video).where(Video.job_id == job_id))}
            pos = len(existing)
            for meta, source in found:
                if meta.shortcode in existing:
                    continue
                existing.add(meta.shortcode)
                sess.add(_meta_to_row(meta, job_id, pos, source))
                pos += 1
            job = sess.get(Job, job_id)
            job.input_errors = errors
            n = pos
            if n == 0:
                job.status = JobStatus.FAILED
                job.error = errors[0]["message"] if errors else "No videos matched your filters."
                job.message = None
                job.finished_at = utcnow()
            else:
                job.status = JobStatus.READY
                job.message = f"Found {n} video{'s' if n != 1 else ''}"
                job.options = {**(job.options or {}), "preview_stats": stats}
            job.heartbeat_at = None
    log.info("preview done", extra={"job_id": job_id, "videos": len(found), "errors": len(errors)})


# ---- run --------------------------------------------------------------------------------

def claim(job_id: str) -> bool:
    """Atomically take ownership of a job. Prevents two workers running the same job."""
    stale = utcnow() - timedelta(seconds=get_settings().stale_after_seconds)
    with session_scope() as s:
        res = s.execute(
            update(Job)
            .where(Job.id == job_id)
            .where(Job.status.in_(list(JobStatus.RESUMABLE)))
            .where(or_(Job.status == JobStatus.QUEUED, Job.heartbeat_at.is_(None), Job.heartbeat_at < stale))
            .values(status=JobStatus.RUNNING, heartbeat_at=utcnow(), updated_at=utcnow(), message="Starting…")
        )
        return res.rowcount == 1


def _is_done(v: Video, mode: str) -> bool:
    if v.status in (VideoStatus.DONE, VideoStatus.SKIPPED):
        need_video = mode in (Mode.DOWNLOAD, Mode.DOWNLOAD_TRANSCRIBE)
        need_tx = mode in (Mode.TRANSCRIBE, Mode.DOWNLOAD_TRANSCRIBE)
        if need_video and not exists_nonempty(absolute(v.video_path)):
            return False
        if need_tx and not v.transcript_text and v.fail_reason != "no_audio":
            return False
        return True
    return False


def run_job(job_id: str) -> None:
    if not claim(job_id):
        log.info("job not claimable (finished, running elsewhere, or not started)", extra={"job_id": job_id})
        return
    s = get_settings()
    with session_scope() as sess:
        job = sess.get(Job, job_id)
        mode = job.mode
        opts = dict(job.options or {})
        if job.started_at is None:
            job.started_at = utcnow()

    transcriber: Transcriber | None = None
    if mode in (Mode.TRANSCRIBE, Mode.DOWNLOAD_TRANSCRIBE):
        try:
            transcriber = get_transcriber(opts.get("engine") or s.transcribe_engine, s, opts.get("model"))
        except TranscriptionError as e:
            _set_job(job_id, status=JobStatus.FAILED, error=str(e), message=None, finished_at=utcnow(),
                     heartbeat_at=None)
            return

    cd = Cooldowns(job_id)
    with Heartbeat(job_id):
        with session_scope() as sess:
            todo = [v.id for v in sess.scalars(
                select(Video).where(Video.job_id == job_id, Video.selected.is_(True)).order_by(Video.position))
                if not _is_done(v, mode)]
        total = len(todo)
        _set_job(job_id, message=f"Processing {total} video{'s' if total != 1 else ''}…")
        log.info("job started", extra={"job_id": job_id, "mode": mode, "todo": total})

        stop = threading.Event()
        outcome: dict[str, str | None] = {"error": None}

        def worker(video_id: int) -> None:
            if stop.is_set():
                return
            try:
                process_video(job_id, video_id, mode, opts, transcriber, cd)
            except JobCancelled:
                stop.set()
            except GiveUp as e:
                outcome["error"] = str(e)
                stop.set()

        with ThreadPoolExecutor(max_workers=max(1, s.concurrency), thread_name_prefix=f"job-{job_id}") as pool:
            list(pool.map(worker, todo))

        # Final status
        with session_scope() as sess:
            job = sess.get(Job, job_id)
            vids = [v for v in job.videos if v.selected]
            failed = [v for v in vids if v.status == VideoStatus.FAILED]
            if job.cancel_requested:
                job.status, job.message = JobStatus.CANCELLED, "Cancelled"
            elif outcome["error"]:
                for v in vids:
                    if v.status == VideoStatus.PENDING:
                        v.status, v.fail_reason = VideoStatus.FAILED, "rate_limited"
                job.status, job.error = JobStatus.FAILED, outcome["error"] + ". Wait an hour, then use Re-run."
                job.message = None
            elif failed:
                job.status = JobStatus.COMPLETED_WITH_ERRORS
                job.message = f"{len(vids) - len(failed)} done, {len(failed)} failed"
            else:
                job.status, job.message = JobStatus.COMPLETED, f"All {len(vids)} done"
            job.finished_at = utcnow()
            job.heartbeat_at = None
            job.cooldown_until = None
        zip_path = s.exports_dir / f"reelvault_{job_id}.zip"
        zip_path.unlink(missing_ok=True)  # stale export
    log.info("job finished", extra={"job_id": job_id})


def _meta_from_row(v: Video) -> VideoMeta:
    return VideoMeta(shortcode=v.shortcode, handle=v.handle, url=v.url, posted_at=v.posted_at, caption=v.caption,
                     hashtags=v.hashtags or [], views=v.views, likes=v.likes, comments=v.comments,
                     duration=v.duration, thumbnail_url=v.thumbnail_url)


def process_video(job_id: str, video_id: int, mode: str, opts: dict, transcriber: Transcriber | None,
                  cd: Cooldowns) -> None:
    """Download and/or transcribe one video. Records failures instead of raising."""
    with session_scope() as sess:
        v = sess.get(Video, video_id)
        meta = _meta_from_row(v)
        source = v.source
    p = media_paths(meta.handle, meta.posted_at, meta.shortcode)
    ctx = {"job_id": job_id, "shortcode": meta.shortcode}
    _set_video(video_id, attempts=Video.attempts + 1)
    downloaded_now = False

    try:
        ex = extractor_by_name(source)

        # caption (no network)
        if not exists_nonempty(p["caption"]) and meta.caption:
            p["caption"].parent.mkdir(parents=True, exist_ok=True)
            p["caption"].write_text(meta.caption + "\n", encoding="utf-8")
        cap_path = rel(p["caption"]) if p["caption"].exists() else None

        # thumbnail (best effort)
        if not exists_nonempty(p["thumbnail"]):
            try:
                _with_cooldown(cd, job_id, lambda: ex.download_thumbnail(meta, p["thumbnail"]))
            except (JobCancelled, GiveUp):
                raise
            except Exception as e:  # noqa: BLE001
                log.info("thumbnail failed (non-fatal)", extra={**ctx, "err": str(e)})
        thumb_path = rel(p["thumbnail"]) if exists_nonempty(p["thumbnail"]) else None

        # does a transcript already exist on disk? (dedupe across jobs)
        need_tx = transcriber is not None
        tx_json = p["transcript_base"].with_suffix(".json")
        reuse_tx = need_tx and exists_nonempty(tx_json) and not opts.get("force_transcribe")

        # video
        need_video_file = mode in (Mode.DOWNLOAD, Mode.DOWNLOAD_TRANSCRIBE) or (need_tx and not reuse_tx)
        if need_video_file and not exists_nonempty(p["video"]):
            _set_job(job_id, message=f"Downloading {meta.shortcode}…")
            _with_cooldown(cd, job_id, lambda: ex.download_video(meta, p["video"]))
            downloaded_now = True
            log.info("downloaded", extra={**ctx, "bytes": p["video"].stat().st_size})
        else:
            if need_video_file:
                log.info("already on disk, skipping download", extra=ctx)

        _set_video(video_id, video_path=rel(p["video"]) if p["video"].exists() else None,
                   thumbnail_path=thumb_path, caption_path=cap_path,
                   status=VideoStatus.DOWNLOADED, fail_reason=None, fail_detail=None, video_deleted=False)

        # transcription
        if need_tx:
            fields = _transcribe(video_id, meta, p, opts, transcriber, reuse_tx, ctx)  # type: ignore[arg-type]
            _set_video(video_id, **fields)

        # transcribe-only: drop the video we fetched just for its audio
        if mode == Mode.TRANSCRIBE and downloaded_now and p["video"].exists():
            p["video"].unlink()
            _set_video(video_id, video_deleted=True, video_path=None)

        _set_video(video_id, status=VideoStatus.DONE)

    except (JobCancelled, GiveUp):
        raise
    except ExtractorError as e:
        log.warning("video failed", extra={**ctx, "reason": e.reason, "err": str(e)})
        _set_video(video_id, status=VideoStatus.FAILED, fail_reason=e.reason, fail_detail=str(e)[:500])
    except TranscriptionError as e:
        log.warning("transcription failed", extra={**ctx, "reason": e.reason, "err": str(e)})
        status = VideoStatus.DONE if e.reason == "no_audio" else VideoStatus.FAILED
        _set_video(video_id, status=status, fail_reason=e.reason, fail_detail=str(e)[:500])
    except Exception as e:  # noqa: BLE001
        log.exception("video crashed", extra=ctx)
        _set_video(video_id, status=VideoStatus.FAILED, fail_reason="error", fail_detail=f"{type(e).__name__}: {e}"[:500])
    finally:
        p["audio"].unlink(missing_ok=True)


def _render(native: list[Segment], script: str) -> list[Segment]:
    if script == "roman":
        return [Segment(s.start, s.end, romanize(s.text)) for s in native]
    return [Segment(s.start, s.end, s.text) for s in native]


def _transcribe(video_id: int, meta: VideoMeta, p: dict, opts: dict, transcriber: Transcriber, reuse: bool,
                ctx: dict) -> dict:
    s = get_settings()
    script = opts.get("script") or "native"
    hook_secs = float(opts.get("hook_seconds") or s.hook_seconds)
    tx_json = p["transcript_base"].with_suffix(".json")

    if reuse:
        data = json.loads(tx_json.read_text(encoding="utf-8"))
        native = [Segment(x["start"], x["end"], x["text"]) for x in data.get("native_segments") or data["segments"]]
        result = TranscriptResult(segments=native, language=data.get("language"), engine=data.get("engine", ""),
                                  duration=data.get("duration"))
        log.info("transcript already on disk, reusing", extra=ctx)
    else:
        lang = opts.get("language") or "auto"
        audio = extract_audio(p["video"], p["audio"])
        result = transcriber.transcribe(audio, None if lang == "auto" else lang)
        log.info("transcribed", extra={**ctx, "engine": result.engine, "language": result.language,
                                       "segments": len(result.segments)})

    rendered = TranscriptResult(segments=_render(result.segments, script), language=result.language,
                                engine=result.engine, duration=result.duration)
    write_outputs(rendered, p["transcript_base"], shortcode=meta.shortcode, handle=meta.handle, url=meta.url,
                  script=script if has_devanagari(result.text) else "native",
                  native_segments=[x.to_dict() for x in result.segments])
    return {
        "transcript_text": rendered.text,
        "transcript_language": result.language,
        "transcript_engine": result.engine,
        "hook_text": hook_text(rendered.segments, hook_secs),
        "transcript_txt_path": rel(p["transcript_base"].with_suffix(".txt")),
        "transcript_srt_path": rel(p["transcript_base"].with_suffix(".srt")),
        "transcript_json_path": rel(tx_json),
        "status": VideoStatus.TRANSCRIBED,
    }
