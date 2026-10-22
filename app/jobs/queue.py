"""Job queue: Redis + RQ in production, an in-process thread pool when Redis isn't there.

Both backends call the same two functions in app.jobs.pipeline, so behaviour is identical.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from sqlalchemy import or_, select

from app.config import get_settings
from app.db import Job, JobStatus, session_scope, utcnow
from app.logging_setup import get_logger

log = get_logger(__name__)

QUEUE_NAME = "reelvault"
PREVIEW_TIMEOUT = 60 * 60
RUN_TIMEOUT = 24 * 60 * 60

_backend: str | None = None
_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def _redis():
    from redis import Redis
    return Redis.from_url(get_settings().redis_url, socket_connect_timeout=2)


def backend() -> str:
    """Resolve the queue backend once: 'rq' or 'thread'."""
    global _backend
    if _backend:
        return _backend
    want = get_settings().queue_backend.lower()
    if want == "thread":
        _backend = "thread"
    elif want == "rq":
        _backend = "rq"
    else:
        try:
            _redis().ping()
            _backend = "rq"
        except Exception:  # noqa: BLE001
            _backend = "thread"
    log.info("queue backend selected", extra={"backend": _backend})
    return _backend


def reset_backend() -> None:
    global _backend
    _backend = None


def _thread_pool() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="rv-worker")
        return _pool


def _safe(fn, job_id: str):
    def run():
        try:
            fn(job_id)
        except Exception:  # noqa: BLE001
            log.exception("background task crashed", extra={"job_id": job_id})
    return run


def enqueue_preview(job_id: str) -> None:
    from app.jobs import pipeline
    if backend() == "rq":
        from rq import Queue
        Queue(QUEUE_NAME, connection=_redis()).enqueue(
            "app.jobs.pipeline.run_preview", job_id, job_timeout=PREVIEW_TIMEOUT, job_id=f"preview-{job_id}-{utcnow():%H%M%S%f}")
    else:
        _thread_pool().submit(_safe(pipeline.run_preview, job_id))


def enqueue_run(job_id: str) -> None:
    from app.jobs import pipeline
    if backend() == "rq":
        from rq import Queue
        Queue(QUEUE_NAME, connection=_redis()).enqueue(
            "app.jobs.pipeline.run_job", job_id, job_timeout=RUN_TIMEOUT, job_id=f"run-{job_id}-{utcnow():%H%M%S%f}")
    else:
        _thread_pool().submit(_safe(pipeline.run_job, job_id))


def resume_stale() -> list[str]:
    """Re-enqueue jobs that were mid-flight when a worker died.

    A job is stale when it's queued/running/cooling down/previewing but its heartbeat
    hasn't moved for `stale_after_seconds`. `pipeline.claim()` makes double-enqueueing harmless.
    """
    s = get_settings()
    cutoff = utcnow() - timedelta(seconds=s.stale_after_seconds)
    resumed: list[str] = []
    with session_scope() as sess:
        jobs = list(sess.scalars(
            select(Job).where(Job.status.in_(list(JobStatus.RESUMABLE) + [JobStatus.PREVIEWING]))
            .where(or_(Job.heartbeat_at.is_(None), Job.heartbeat_at < cutoff))
            .where(Job.updated_at < cutoff)
        ))
        plan = [(j.id, j.status) for j in jobs]
    for job_id, status in plan:
        if status == JobStatus.PREVIEWING:
            enqueue_preview(job_id)
        else:
            enqueue_run(job_id)
        resumed.append(job_id)
        log.info("resumed stale job", extra={"job_id": job_id, "status": status})
    return resumed


class StaleSweeper:
    """Background thread that calls resume_stale() every half stale-window (30s by default)."""

    def __init__(self, every: float | None = None):
        self.every = every or max(5.0, get_settings().stale_after_seconds / 2)
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True, name="stale-sweeper")

    def _run(self):
        while not self._stop.wait(self.every):
            try:
                resume_stale()
            except Exception:  # noqa: BLE001
                log.exception("stale sweep failed")

    def start(self):
        self._t.start()
        return self

    def stop(self):
        self._stop.set()
