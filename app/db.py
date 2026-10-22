"""Database models and session handling (SQLite by default, Postgres-ready)."""
from __future__ import annotations

import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from app.config import get_settings


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class JobStatus:
    PREVIEWING = "previewing"      # listing videos from Instagram
    READY = "ready"                # preview done, waiting for the user to pick videos
    QUEUED = "queued"
    RUNNING = "running"
    COOLING_DOWN = "cooling_down"  # rate limited, waiting before retrying
    COMPLETED = "completed"
    COMPLETED_WITH_ERRORS = "completed_with_errors"
    FAILED = "failed"
    CANCELLED = "cancelled"

    ACTIVE = {PREVIEWING, QUEUED, RUNNING, COOLING_DOWN}
    RESUMABLE = {QUEUED, RUNNING, COOLING_DOWN}


class VideoStatus:
    PENDING = "pending"
    DOWNLOADED = "downloaded"
    TRANSCRIBED = "transcribed"
    DONE = "done"
    FAILED = "failed"
    SKIPPED = "skipped"   # not selected by the user


class Mode:
    DOWNLOAD = "download"
    DOWNLOAD_TRANSCRIBE = "download_transcribe"
    TRANSCRIBE = "transcribe"
    ALL = {DOWNLOAD, DOWNLOAD_TRANSCRIBE, TRANSCRIBE}


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: uuid.uuid4().hex[:12])
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    title: Mapped[str] = mapped_column(String(300), default="")
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.PREVIEWING, index=True)
    mode: Mapped[str] = mapped_column(String(32), default=Mode.DOWNLOAD)
    inputs: Mapped[list] = mapped_column(JSON, default=list)          # raw lines the user pasted
    targets: Mapped[list] = mapped_column(JSON, default=list)         # parsed targets
    filters: Mapped[dict] = mapped_column(JSON, default=dict)
    options: Mapped[dict] = mapped_column(JSON, default=dict)         # engine, language, script, ...
    input_errors: Mapped[list] = mapped_column(JSON, default=list)    # per-target problems (private, invalid...)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)  # live status line for the UI
    cooldown_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)

    videos: Mapped[list["Video"]] = relationship(
        back_populates="job", cascade="all, delete-orphan", order_by="Video.position"
    )


class Video(Base):
    __tablename__ = "videos"
    __table_args__ = (UniqueConstraint("job_id", "shortcode", name="uq_job_shortcode"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    selected: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(32), default=VideoStatus.PENDING, index=True)
    fail_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fail_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)

    # Source metadata
    source: Mapped[str] = mapped_column(String(32), default="instagram")
    shortcode: Mapped[str] = mapped_column(String(64), index=True)
    handle: Mapped[str] = mapped_column(String(64), index=True)
    url: Mapped[str] = mapped_column(String(300))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    caption: Mapped[str | None] = mapped_column(Text, nullable=True)
    hashtags: Mapped[list] = mapped_column(JSON, default=list)
    views: Mapped[int | None] = mapped_column(Integer, nullable=True)
    likes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comments: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    audio_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    is_paid_partnership: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_reel: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Local files (relative to data_dir)
    video_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    thumbnail_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    caption_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    transcript_txt_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    transcript_srt_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    transcript_json_path: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Transcript (also stored in DB for search)
    transcript_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    transcript_engine: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hook_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    video_deleted: Mapped[bool] = mapped_column(Boolean, default=False)  # transcribe-only mode

    job: Mapped[Job] = relationship(back_populates="videos")


_engine = None
_SessionLocal: sessionmaker | None = None


def get_engine():
    global _engine, _SessionLocal
    if _engine is None:
        url = get_settings().db_url
        kwargs: dict = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        _engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(_engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.execute("PRAGMA busy_timeout=30000")
                cur.close()
        _SessionLocal = sessionmaker(bind=_engine, expire_on_commit=False)
        Base.metadata.create_all(_engine)
    return _engine


def reset_engine() -> None:
    """Used by tests to point at a fresh database."""
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None


@contextmanager
def session_scope() -> Iterator[Session]:
    get_engine()
    assert _SessionLocal is not None
    session = _SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
