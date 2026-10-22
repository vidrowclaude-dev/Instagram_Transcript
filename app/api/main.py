"""FastAPI app: JSON API under /api, the dashboard at /."""
from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.config import get_settings
from app.db import Job, JobStatus, Mode, Video, VideoStatus, get_engine, session_scope, utcnow
from app.extractors import reset_extractors
from app.extractors.cookies import inspect_cookies, save_cookies
from app.extractors.filters import Filters
from app.extractors.urls import parse_inputs
from app.jobs import queue
from app.logging_setup import get_logger, setup_logging
from app.storage import export
from app.storage.paths import absolute, exists_nonempty
from app.transcription.engines import WHISPER_MODELS, available_engines

log = get_logger(__name__)
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

RATE_LIMIT_WARNING = (
    "Instagram rate-limits automated access. Keep the default delays, avoid running several big jobs at once, "
    "and expect pauses on large profiles. Aggressive use can get your IP or Instagram account temporarily blocked."
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    setup_logging()
    get_settings()
    get_engine()
    sweeper = None
    if queue.backend() == "thread":
        # No separate worker process: this process resumes stale jobs itself.
        queue.resume_stale()
        sweeper = queue.StaleSweeper().start()
    yield
    if sweeper:
        sweeper.stop()


app = FastAPI(title="Reel Vault", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


# ---- schemas ----------------------------------------------------------------------------

class PreviewIn(BaseModel):
    inputs: str = Field(..., description="Profile links, @handles or post links; one per line")
    filters: dict = Field(default_factory=dict)


class StartIn(BaseModel):
    shortcodes: list[str] | None = None   # None = everything in the preview
    mode: str = Mode.DOWNLOAD
    engine: str | None = None
    model: str | None = None
    language: str = "auto"                # auto | hi | en | hinglish | any ISO code
    script: str = "native"                # native (Devanagari) | roman (Hinglish)
    hook_seconds: float | None = None
    force_transcribe: bool = False


class RerunIn(BaseModel):
    only_failed: bool = True
    force_transcribe: bool = False


# ---- serialisers --------------------------------------------------------------------------

def _counts(videos: list[Video]) -> dict:
    sel = [v for v in videos if v.selected]
    return {
        "found": len(videos),
        "selected": len(sel),
        "downloaded": sum(1 for v in sel if v.video_path or v.video_deleted),
        "transcribed": sum(1 for v in sel if v.transcript_text),
        "done": sum(1 for v in sel if v.status == VideoStatus.DONE),
        "failed": sum(1 for v in sel if v.status == VideoStatus.FAILED),
        "pending": sum(1 for v in sel if v.status in (VideoStatus.PENDING, VideoStatus.DOWNLOADED,
                                                      VideoStatus.TRANSCRIBED)),
    }


def _video_out(v: Video, full: bool = False) -> dict:
    d = {
        "id": v.id, "shortcode": v.shortcode, "handle": v.handle, "url": v.url,
        "posted_at": v.posted_at.isoformat() if v.posted_at else None,
        "caption": v.caption if full else (v.caption or "")[:160],
        "hashtags": v.hashtags or [], "views": v.views, "likes": v.likes, "comments": v.comments,
        "duration": v.duration, "audio_name": v.audio_name, "is_paid_partnership": v.is_paid_partnership,
        "is_reel": v.is_reel, "selected": v.selected, "status": v.status, "fail_reason": v.fail_reason,
        "fail_detail": v.fail_detail, "has_video": bool(v.video_path) and not v.video_deleted,
        "has_thumbnail": bool(v.thumbnail_path) or bool(v.thumbnail_url),
        "has_transcript": bool(v.transcript_text), "hook": v.hook_text,
        "transcript_language": v.transcript_language, "transcript_engine": v.transcript_engine,
        "video_deleted": v.video_deleted,
    }
    if full:
        d["transcript_text"] = v.transcript_text
        d["segments"] = []
        p = absolute(v.transcript_json_path)
        if exists_nonempty(p):
            try:
                d["segments"] = json.loads(p.read_text(encoding="utf-8")).get("segments", [])  # type: ignore[union-attr]
            except (OSError, ValueError):
                pass
    return d


def _job_out(j: Job, with_videos: bool = False) -> dict:
    d = {
        "id": j.id, "title": j.title, "status": j.status, "mode": j.mode, "inputs": j.inputs,
        "filters": j.filters, "options": {k: v for k, v in (j.options or {}).items()},
        "input_errors": j.input_errors or [], "error": j.error, "message": j.message,
        "cooldown_until": j.cooldown_until.isoformat() + "Z" if j.cooldown_until else None,
        "created_at": j.created_at.isoformat() + "Z", "updated_at": j.updated_at.isoformat() + "Z",
        "started_at": j.started_at.isoformat() + "Z" if j.started_at else None,
        "finished_at": j.finished_at.isoformat() + "Z" if j.finished_at else None,
        "counts": _counts(j.videos),
    }
    if with_videos:
        d["videos"] = [_video_out(v) for v in j.videos]
    return d


def _get_job(sess, job_id: str) -> Job:
    j = sess.get(Job, job_id)
    if j is None:
        raise HTTPException(404, "Job not found")
    return j


# ---- pages --------------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index() -> HTMLResponse:
    return HTMLResponse((WEB_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "queue": queue.backend()}


@app.get("/api/config")
def config() -> dict:
    s = get_settings()
    return {
        "engines": available_engines(s),
        "default_engine": s.transcribe_engine,
        "whisper_models": WHISPER_MODELS,
        "default_model": s.whisper_model,
        "hook_seconds": s.hook_seconds,
        "rate_limit_warning": RATE_LIMIT_WARNING,
        "rate_limits": {"min_delay": s.min_delay, "max_delay": s.max_delay, "concurrency": s.concurrency},
        "demo_mode": s.demo_mode,
        "queue": queue.backend(),
        "cookies": inspect_cookies(s.cookies_path).to_dict(),
    }


# ---- jobs ---------------------------------------------------------------------------------

@app.post("/api/jobs/preview", status_code=201)
def create_preview(body: PreviewIn) -> dict:
    targets, errors = parse_inputs(body.inputs)
    if not targets:
        msg = errors[0].message if errors else "Paste at least one profile or post link"
        raise HTTPException(422, {"message": msg, "errors": [e.to_dict() for e in errors]})
    try:
        filters = Filters.from_dict(body.filters)
    except ValueError as e:
        raise HTTPException(422, {"message": str(e)}) from e
    title = targets[0].label + (f" +{len(targets) - 1} more" if len(targets) > 1 else "")
    with session_scope() as s:
        job = Job(title=title, inputs=[t.raw for t in targets], targets=[t.to_dict() for t in targets],
                  filters=filters.to_dict(), input_errors=[e.to_dict() for e in errors],
                  status=JobStatus.PREVIEWING, message="Queued for lookup…")
        s.add(job)
        s.flush()
        job_id = job.id
    queue.enqueue_preview(job_id)
    return {"job_id": job_id}


@app.get("/api/jobs")
def list_jobs(limit: int = 100) -> list[dict]:
    with session_scope() as s:
        jobs = s.scalars(select(Job).order_by(Job.created_at.desc()).limit(limit))
        return [_job_out(j) for j in jobs]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    with session_scope() as s:
        return _job_out(_get_job(s, job_id), with_videos=True)


@app.post("/api/jobs/{job_id}/start")
def start_job(job_id: str, body: StartIn) -> dict:
    if body.mode not in Mode.ALL:
        raise HTTPException(422, {"message": f"mode must be one of {sorted(Mode.ALL)}"})
    if body.script not in ("native", "roman"):
        raise HTTPException(422, {"message": "script must be 'native' or 'roman'"})
    s_ = get_settings()
    engine = body.engine or s_.transcribe_engine
    if body.mode != Mode.DOWNLOAD:
        eng = next((e for e in available_engines(s_) if e["id"] == engine), None)
        if eng is None:
            raise HTTPException(422, {"message": f"Unknown engine '{engine}'"})
        if not eng["ready"]:
            raise HTTPException(422, {"message": f"{eng['label']} isn't set up: {eng['note']}"})
    with session_scope() as s:
        job = _get_job(s, job_id)
        if job.status in JobStatus.ACTIVE:
            raise HTTPException(409, {"message": "Job is already running"})
        if not job.videos:
            raise HTTPException(409, {"message": "Nothing to download: the preview found no videos"})
        wanted = set(body.shortcodes) if body.shortcodes is not None else None
        n = 0
        for v in job.videos:
            v.selected = wanted is None or v.shortcode in wanted
            if v.selected:
                n += 1
                if v.status in (VideoStatus.SKIPPED, VideoStatus.FAILED):
                    v.status, v.fail_reason, v.fail_detail = VideoStatus.PENDING, None, None
            elif v.status == VideoStatus.PENDING:
                v.status = VideoStatus.SKIPPED
        if n == 0:
            raise HTTPException(422, {"message": "Select at least one video"})
        job.mode = body.mode
        job.options = {**(job.options or {}), "engine": engine, "model": body.model or s_.whisper_model,
                       "language": body.language, "script": body.script,
                       "hook_seconds": body.hook_seconds or s_.hook_seconds,
                       "force_transcribe": body.force_transcribe}
        job.status, job.error, job.cancel_requested = JobStatus.QUEUED, None, False
        job.message, job.finished_at, job.heartbeat_at = "Queued…", None, None
    queue.enqueue_run(job_id)
    return {"ok": True, "selected": n}


@app.post("/api/jobs/{job_id}/rerun")
def rerun_job(job_id: str, body: RerunIn | None = None) -> dict:
    body = body or RerunIn()
    with session_scope() as s:
        job = _get_job(s, job_id)
        if job.status in JobStatus.ACTIVE:
            raise HTTPException(409, {"message": "Job is already running"})
        if job.status == JobStatus.READY or job.mode is None:
            raise HTTPException(409, {"message": "Start the job first"})
        for v in job.videos:
            if not v.selected:
                continue
            if v.status == VideoStatus.FAILED or not body.only_failed:
                v.status, v.fail_reason, v.fail_detail = VideoStatus.PENDING, None, None
        job.options = {**(job.options or {}), "force_transcribe": body.force_transcribe}
        job.status, job.error, job.cancel_requested = JobStatus.QUEUED, None, False
        job.message, job.finished_at, job.heartbeat_at = "Queued…", None, None
    queue.enqueue_run(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/refresh-preview")
def refresh_preview(job_id: str) -> dict:
    """Look the targets up again (e.g. after uploading cookies)."""
    with session_scope() as s:
        job = _get_job(s, job_id)
        if job.status in JobStatus.ACTIVE:
            raise HTTPException(409, {"message": "Job is busy"})
        job.status, job.error, job.message = JobStatus.PREVIEWING, None, "Queued for lookup…"
        job.input_errors = [e for e in (job.input_errors or []) if e.get("reason") == "invalid_input"]
        job.heartbeat_at = None
    queue.enqueue_preview(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    with session_scope() as s:
        job = _get_job(s, job_id)
        if job.status not in JobStatus.ACTIVE:
            return {"ok": True, "status": job.status}
        job.cancel_requested = True
        if job.status == JobStatus.QUEUED:
            job.status, job.message = JobStatus.CANCELLED, "Cancelled"
        else:
            job.message = "Cancelling…"
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    with session_scope() as s:
        job = _get_job(s, job_id)
        if job.status in JobStatus.ACTIVE:
            raise HTTPException(409, {"message": "Cancel the job before deleting it"})
    freed = export.delete_job_files(job_id)
    return {"ok": True, "freed_bytes": freed}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    """Server-Sent Events: pushes the job (with videos) whenever something changes."""
    with session_scope() as s:
        _get_job(s, job_id)

    async def stream():
        last = None
        idle = 0
        while True:
            with session_scope() as s:
                job = s.get(Job, job_id)
                if job is None:
                    yield "event: gone\ndata: {}\n\n"
                    return
                payload = _job_out(job, with_videos=True)
            blob = json.dumps(payload, default=str)
            digest = hashlib.md5(blob.encode()).hexdigest()
            if digest != last:
                last, idle = digest, 0
                yield f"data: {blob}\n\n"
            else:
                idle += 1
                if idle % 15 == 0:
                    yield ": keep-alive\n\n"
            await asyncio.sleep(1.0)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- exports ------------------------------------------------------------------------------

@app.get("/api/jobs/{job_id}/zip")
async def job_zip(job_id: str) -> FileResponse:
    with session_scope() as s:
        job = _get_job(s, job_id)
        title = job.title
    path = await asyncio.to_thread(export.build_zip, job_id)
    name = "".join(c if c.isalnum() or c in "._-" else "_" for c in title.strip("@"))[:40] or job_id
    return FileResponse(path, media_type="application/zip", filename=f"reelvault_{name}_{job_id}.zip")


def _csv_response(text: str, filename: str) -> Response:
    return Response(text, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/jobs/{job_id}/metadata.csv")
def job_metadata_csv(job_id: str) -> Response:
    with session_scope() as s:
        _get_job(s, job_id)
    return _csv_response(export.metadata_csv(job_id), f"metadata_{job_id}.csv")


@app.get("/api/jobs/{job_id}/transcripts.csv")
def job_transcripts_csv(job_id: str) -> Response:
    with session_scope() as s:
        _get_job(s, job_id)
    return _csv_response(export.transcripts_csv(job_id), f"transcripts_{job_id}.csv")


@app.get("/api/jobs/{job_id}/metadata.json")
def job_metadata_json(job_id: str) -> Response:
    with session_scope() as s:
        _get_job(s, job_id)
    return Response(export.metadata_json(job_id), media_type="application/json")


# ---- videos & media -------------------------------------------------------------------------

def _get_video(sess, video_id: int) -> Video:
    v = sess.get(Video, video_id)
    if v is None:
        raise HTTPException(404, "Video not found")
    return v


@app.get("/api/videos/{video_id}")
def get_video(video_id: int) -> dict:
    with session_scope() as s:
        return _video_out(_get_video(s, video_id), full=True)


@app.get("/api/videos/{video_id}/file")
def video_file(video_id: int) -> FileResponse:
    with session_scope() as s:
        v = _get_video(s, video_id)
        p = absolute(v.video_path) if not v.video_deleted else None
    if not exists_nonempty(p):
        raise HTTPException(404, "Video file not on disk")
    return FileResponse(p, media_type="video/mp4")  # Starlette handles Range requests (seeking)


@app.get("/api/videos/{video_id}/transcript.{ext}")
def transcript_file(video_id: int, ext: str) -> FileResponse:
    if ext not in ("txt", "srt", "json"):
        raise HTTPException(404)
    with session_scope() as s:
        v = _get_video(s, video_id)
        p = absolute(getattr(v, f"transcript_{ext}_path"))
    if not exists_nonempty(p):
        raise HTTPException(404, "Transcript not available")
    return FileResponse(p, filename=p.name)  # type: ignore[union-attr]


@app.get("/api/videos/{video_id}/thumb")
async def video_thumb(video_id: int) -> Response:
    """Serve the saved thumbnail, or proxy + cache Instagram's (their CDN blocks hotlinking)."""
    with session_scope() as s:
        v = _get_video(s, video_id)
        local, remote, sc = absolute(v.thumbnail_path), v.thumbnail_url, v.shortcode
    if exists_nonempty(local):
        return FileResponse(local, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    cache = get_settings().cache_dir / "thumbs" / f"{sc}.jpg"
    if exists_nonempty(cache):
        return FileResponse(cache, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    if not remote or not remote.startswith("http"):
        return Response(status_code=404)
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=True) as c:
            r = await c.get(remote, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://www.instagram.com/"})
        if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image"):
            return Response(status_code=404)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(r.content)
        return Response(r.content, media_type=r.headers["content-type"], headers={"Cache-Control": "max-age=86400"})
    except httpx.HTTPError:
        return Response(status_code=404)


# ---- search ---------------------------------------------------------------------------------

@app.get("/api/search")
def search(q: str = Query(..., min_length=2), limit: int = 50) -> dict:
    """Keyword search across every transcript (and caption) in the library, newest first.
    The same reel in several jobs appears once."""
    terms = [t for t in q.split() if t]
    with session_scope() as s:
        stmt = select(Video).where(or_(Video.transcript_text.is_not(None), Video.caption.is_not(None)))
        for t in terms:
            like = f"%{t}%"
            stmt = stmt.where(or_(Video.transcript_text.ilike(like), Video.caption.ilike(like),
                                  Video.handle.ilike(like)))
        rows = s.scalars(stmt.order_by(Video.transcript_text.is_(None), Video.posted_at.desc()).limit(limit * 4))
        seen, out = set(), []
        for v in rows:
            if v.shortcode in seen:
                continue
            seen.add(v.shortcode)
            out.append({**_video_out(v), "job_id": v.job_id,
                        "snippet": _snippet(v.transcript_text or v.caption or "", terms[0])})
            if len(out) >= limit:
                break
        total = s.scalar(select(func.count(func.distinct(Video.shortcode))).where(Video.transcript_text.is_not(None)))
    return {"query": q, "results": out, "library_transcripts": total or 0}


def _snippet(text: str, term: str, width: int = 90) -> str:
    i = text.lower().find(term.lower())
    if i < 0:
        return text[: width * 2]
    start = max(0, i - width)
    return ("…" if start else "") + text[start: i + len(term) + width] + ("…" if i + len(term) + width < len(text) else "")


# ---- storage & settings ------------------------------------------------------------------------

@app.get("/api/storage")
def storage() -> dict:
    return export.storage_report()


@app.post("/api/storage/clear-cache")
def storage_clear_cache() -> dict:
    return {"freed_bytes": export.clear_cache()}


@app.post("/api/storage/clear-old")
def storage_clear_old(keep_last: int = 10) -> dict:
    """Delete all finished jobs except the most recent `keep_last`."""
    with session_scope() as s:
        ids = [j.id for j in s.scalars(select(Job).where(Job.status.not_in(list(JobStatus.ACTIVE)))
                                       .order_by(Job.created_at.desc()))][keep_last:]
    freed = sum(export.delete_job_files(i) for i in ids)
    return {"deleted_jobs": len(ids), "freed_bytes": freed}


@app.get("/api/settings/cookies")
def cookies_status() -> dict:
    return inspect_cookies(get_settings().cookies_path).to_dict()


@app.post("/api/settings/cookies")
async def cookies_upload(file: UploadFile = File(...)) -> dict:
    raw = await file.read()
    if len(raw) > 2_000_000:
        raise HTTPException(413, {"message": "That file is too big to be a cookies.txt"})
    try:
        info = save_cookies(get_settings().cookies_path, raw.decode("utf-8", errors="ignore"))
    except ValueError as e:
        raise HTTPException(422, {"message": str(e)}) from e
    reset_extractors()  # next request uses the new session
    return info.to_dict()


@app.delete("/api/settings/cookies")
def cookies_delete() -> dict:
    get_settings().cookies_path.unlink(missing_ok=True)
    reset_extractors()
    return inspect_cookies(get_settings().cookies_path).to_dict()


@app.get("/api/logs", response_class=PlainTextResponse, include_in_schema=False)
def logs_hint() -> str:
    return "Logs are JSON lines on stdout. With Docker: docker compose logs -f api worker"


_ = utcnow  # re-exported for tests
