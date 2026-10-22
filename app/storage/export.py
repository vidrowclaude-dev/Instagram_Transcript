"""CSV / JSON / ZIP exports and disk management."""
from __future__ import annotations

import csv
import io
import json
import os
import shutil
import zipfile
from pathlib import Path

from sqlalchemy import select

from app.config import get_settings
from app.db import Job, Video, session_scope
from app.storage.paths import absolute, exists_nonempty

METADATA_COLUMNS = [
    "handle", "shortcode", "url", "date", "views", "likes", "comments", "duration", "caption", "hashtags",
    "audio_name", "is_paid_partnership", "is_reel", "status", "fail_reason", "transcript_language",
    "transcript_engine", "hook", "transcript", "thumbnail_path", "video_path", "transcript_path",
]
# The "paste into Google Sheets" sheet the team asked for, in this exact order.
TRANSCRIPT_COLUMNS = ["handle", "shortcode", "url", "date", "views", "likes", "duration", "caption", "transcript",
                      "hook"]


def _row(v: Video) -> dict:
    return {
        "handle": v.handle,
        "shortcode": v.shortcode,
        "url": v.url,
        "date": v.posted_at.strftime("%Y-%m-%d") if v.posted_at else "",
        "views": v.views if v.views is not None else "",
        "likes": v.likes if v.likes is not None else "",
        "comments": v.comments if v.comments is not None else "",
        "duration": round(v.duration, 1) if v.duration else "",
        "caption": v.caption or "",
        "hashtags": " ".join(f"#{h}" for h in (v.hashtags or [])),
        "audio_name": v.audio_name or "",
        "is_paid_partnership": "" if v.is_paid_partnership is None else ("yes" if v.is_paid_partnership else "no"),
        "is_reel": "" if v.is_reel is None else ("yes" if v.is_reel else "no"),
        "status": v.status,
        "fail_reason": v.fail_reason or "",
        "transcript_language": v.transcript_language or "",
        "transcript_engine": v.transcript_engine or "",
        "hook": v.hook_text or "",
        "transcript": v.transcript_text or "",
        "thumbnail_path": v.thumbnail_path or "",
        "video_path": "" if v.video_deleted else (v.video_path or ""),
        "transcript_path": v.transcript_txt_path or "",
    }


def _csv(rows: list[dict], columns: list[str]) -> str:
    buf = io.StringIO()
    buf.write("﻿")  # BOM so Excel/Sheets read Devanagari and emoji correctly
    w = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore", quoting=csv.QUOTE_MINIMAL)
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def _job_videos(job_id: str) -> list[Video]:
    with session_scope() as s:
        return list(s.scalars(select(Video).where(Video.job_id == job_id, Video.selected.is_(True))
                              .order_by(Video.position)))


def metadata_csv(job_id: str) -> str:
    return _csv([_row(v) for v in _job_videos(job_id)], METADATA_COLUMNS)


def transcripts_csv(job_id: str) -> str:
    return _csv([_row(v) for v in _job_videos(job_id)], TRANSCRIPT_COLUMNS)


def metadata_json(job_id: str) -> str:
    rows = []
    for v in _job_videos(job_id):
        r = _row(v)
        r["hashtags"] = v.hashtags or []
        r["posted_at"] = v.posted_at.isoformat() if v.posted_at else None
        rows.append(r)
    return json.dumps(rows, ensure_ascii=False, indent=2)


def build_zip(job_id: str) -> Path:
    """ZIP layout: videos/ thumbnails/ captions/ transcripts/ metadata.csv metadata.json transcripts.csv"""
    s = get_settings()
    out = s.exports_dir / f"reelvault_{job_id}.zip"
    tmp = out.with_suffix(".zip.part")
    videos = _job_videos(job_id)
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        for v in videos:
            items = [
                ("videos", None if v.video_deleted else v.video_path, zipfile.ZIP_STORED),
                ("thumbnails", v.thumbnail_path, zipfile.ZIP_STORED),
                ("captions", v.caption_path, zipfile.ZIP_DEFLATED),
                ("transcripts", v.transcript_txt_path, zipfile.ZIP_DEFLATED),
                ("transcripts", v.transcript_srt_path, zipfile.ZIP_DEFLATED),
                ("transcripts", v.transcript_json_path, zipfile.ZIP_DEFLATED),
            ]
            for folder, relpath, comp in items:
                p = absolute(relpath)
                if exists_nonempty(p):
                    z.write(p, f"{folder}/{p.name}", compress_type=comp)  # type: ignore[union-attr]
        z.writestr("metadata.csv", metadata_csv(job_id))
        z.writestr("metadata.json", metadata_json(job_id))
        z.writestr("transcripts.csv", transcripts_csv(job_id))
    tmp.replace(out)
    return out


# ---- disk management ------------------------------------------------------------------

def dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def _files_of(v: Video) -> list[str]:
    return [p for p in (v.video_path, v.thumbnail_path, v.caption_path, v.transcript_txt_path,
                        v.transcript_srt_path, v.transcript_json_path) if p]


def storage_report() -> dict:
    s = get_settings()
    per_job = []
    with session_scope() as sess:
        jobs = list(sess.scalars(select(Job).order_by(Job.created_at.desc())))
        for j in jobs:
            size = 0
            for v in j.videos:
                for p in _files_of(v):
                    ap = absolute(p)
                    if ap and ap.exists():
                        size += ap.stat().st_size
            per_job.append({"job_id": j.id, "title": j.title, "bytes": size, "created_at": j.created_at.isoformat()})
    disk = shutil.disk_usage(s.data_dir)
    return {
        "data_dir": str(s.data_dir.resolve()),
        "library_bytes": dir_size(s.library_dir),
        "exports_bytes": dir_size(s.exports_dir),
        "cache_bytes": dir_size(s.cache_dir),
        "total_bytes": dir_size(s.data_dir),
        "disk_free_bytes": disk.free,
        "jobs": per_job,
    }


def delete_job_files(job_id: str) -> int:
    """Delete a job and every file only it uses. Files shared with other jobs are kept."""
    freed = 0
    with session_scope() as sess:
        job = sess.get(Job, job_id)
        if job is None:
            return 0
        mine = {p for v in job.videos for p in _files_of(v)}
        others = {p for v in sess.scalars(select(Video).where(Video.job_id != job_id)) for p in _files_of(v)}
        for p in mine - others:
            ap = absolute(p)
            if ap and ap.exists():
                freed += ap.stat().st_size
                ap.unlink()
        z = get_settings().exports_dir / f"reelvault_{job_id}.zip"
        if z.exists():
            freed += z.stat().st_size
            z.unlink()
        sess.delete(job)
    return freed


def clear_cache() -> int:
    s = get_settings()
    freed = dir_size(s.cache_dir) + dir_size(s.exports_dir)
    for d in (s.cache_dir, s.exports_dir):
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)
    return freed
