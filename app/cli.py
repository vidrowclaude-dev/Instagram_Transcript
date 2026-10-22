"""Command-line interface. Runs everything in-process (no Redis needed).

  python -m app.cli preview @handle --latest 20
  python -m app.cli download @handle --latest 20 --transcribe --language hinglish --script roman --zip
  python -m app.cli download https://www.instagram.com/reel/XXXX/ --transcribe-only
  python -m app.cli transcribe ./some_video.mp4 --engine faster_whisper --model small
  python -m app.cli jobs
  python -m app.cli resume <job_id>
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.config import get_settings
from app.db import Job, Mode, Video, session_scope
from app.extractors.filters import Filters
from app.extractors.urls import parse_inputs
from app.logging_setup import setup_logging


def _filters(a) -> dict:
    return Filters.from_dict({
        "content_type": "all_videos" if a.all_videos else "reels",
        "date_from": a.date_from, "date_to": a.date_to, "latest_n": a.latest,
        "min_views": a.min_views, "sort": a.sort,
    }).to_dict()


def _create_job(a) -> str:
    targets, errors = parse_inputs(" ".join(a.inputs))
    for e in errors:
        print(f"  ! {e.raw}: {e.message}", file=sys.stderr)
    if not targets:
        sys.exit("Nothing to do: no valid profile or post links.")
    with session_scope() as s:
        job = Job(title=targets[0].label, inputs=[t.raw for t in targets], targets=[t.to_dict() for t in targets],
                  filters=_filters(a), input_errors=[e.to_dict() for e in errors])
        s.add(job)
        s.flush()
        return job.id


def _print_videos(job_id: str) -> None:
    with session_scope() as s:
        job = s.get(Job, job_id)
        for e in job.input_errors or []:
            print(f"  ! {e['raw']}: {e['message']}")
        if job.error:
            print(f"  ✗ {job.error}")
        print(f"\n{'#':>3}  {'date':10}  {'views':>9}  {'likes':>7}  {'dur':>5}  {'status':12}  shortcode / caption")
        for i, v in enumerate(job.videos, 1):
            cap = (v.caption or "").replace("\n", " ")[:50]
            print(f"{i:>3}  {v.posted_at:%Y-%m-%d}  {v.views or 0:>9,}  {v.likes or 0:>7,}  "
                  f"{(v.duration or 0):>5.1f}  {v.status:12}  {v.shortcode}  {cap}"
                  + (f"  [{v.fail_reason}]" if v.fail_reason else ""))


def cmd_preview(a) -> None:
    from app.jobs.pipeline import run_preview
    job_id = _create_job(a)
    run_preview(job_id)
    print(f"Job {job_id}")
    _print_videos(job_id)


def cmd_download(a) -> None:
    from app.jobs.pipeline import run_job, run_preview
    from app.storage.export import build_zip
    s = get_settings()
    job_id = _create_job(a)
    print(f"Job {job_id}: looking up videos…")
    run_preview(job_id)
    mode = Mode.TRANSCRIBE if a.transcribe_only else Mode.DOWNLOAD_TRANSCRIBE if a.transcribe else Mode.DOWNLOAD
    with session_scope() as sess:
        job = sess.get(Job, job_id)
        if not job.videos:
            _print_videos(job_id)
            sys.exit(1)
        job.mode = mode
        job.options = {**(job.options or {}), "engine": a.engine or s.transcribe_engine,
                       "model": a.model or s.whisper_model, "language": a.language, "script": a.script,
                       "hook_seconds": a.hook_seconds or s.hook_seconds}
        job.status = "queued"
        print(f"Found {len(job.videos)} videos. Mode: {mode}")
    run_job(job_id)
    _print_videos(job_id)
    if a.zip:
        print(f"\nZIP: {build_zip(job_id).resolve()}")


def cmd_transcribe(a) -> None:
    from app.transcription.audio import extract_audio
    from app.transcription.engines import get_transcriber
    from app.transcription.formats import hook_text, write_outputs
    from app.transcription.base import Segment, TranscriptResult
    from app.transcription.romanize import romanize
    s = get_settings()
    video = Path(a.file)
    if not video.exists():
        sys.exit(f"No such file: {video}")
    eng = get_transcriber(a.engine or s.transcribe_engine, s, a.model)
    wav = s.cache_dir / "audio" / (video.stem + ".wav")
    try:
        extract_audio(video, wav)
        res = eng.transcribe(wav, None if a.language == "auto" else a.language)
    finally:
        wav.unlink(missing_ok=True)
    if a.script == "roman":
        res = TranscriptResult([Segment(x.start, x.end, romanize(x.text)) for x in res.segments],
                               res.language, res.engine, res.duration)
    out = write_outputs(res, video.with_suffix(""), source=str(video))
    print(f"language={res.language} engine={res.engine} segments={len(res.segments)}")
    print(f"hook ({s.hook_seconds:g}s): {hook_text(res.segments, s.hook_seconds)}")
    for k, p in out.items():
        print(f"  {k}: {p}")


def cmd_jobs(_a) -> None:
    with session_scope() as s:
        for j in s.query(Job).order_by(Job.created_at.desc()).limit(30):
            n = len(j.videos)
            print(f"{j.id}  {j.created_at:%Y-%m-%d %H:%M}  {j.status:22}  {n:>4} videos  {j.title}")


def cmd_resume(a) -> None:
    from app.db import JobStatus
    from app.jobs.pipeline import run_job
    with session_scope() as s:
        job = s.get(Job, a.job_id)
        if job is None:
            sys.exit("No such job")
        job.status, job.heartbeat_at, job.cancel_requested = JobStatus.QUEUED, None, False
        for v in job.videos:
            if v.selected and v.status == "failed":
                v.status, v.fail_reason = "pending", None
    run_job(a.job_id)
    _print_videos(a.job_id)


def main(argv: list[str] | None = None) -> None:
    setup_logging("WARNING")
    p = argparse.ArgumentParser(prog="reelvault", description="Reel Vault command line")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_filters(sp):
        sp.add_argument("inputs", nargs="+", help="profile links, @handles or post links")
        sp.add_argument("--all-videos", action="store_true", help="all video posts, not just Reels")
        sp.add_argument("--from", dest="date_from", help="YYYY-MM-DD")
        sp.add_argument("--to", dest="date_to", help="YYYY-MM-DD")
        sp.add_argument("--latest", type=int, help="only the latest N videos")
        sp.add_argument("--min-views", type=int)
        sp.add_argument("--sort", choices=["newest", "most_viewed"], default="newest")

    sp = sub.add_parser("preview", help="list videos without downloading")
    add_filters(sp)
    sp.set_defaults(fn=cmd_preview)

    sp = sub.add_parser("download", help="download (and optionally transcribe)")
    add_filters(sp)
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--transcribe", action="store_true", help="download + transcribe")
    g.add_argument("--transcribe-only", action="store_true", help="transcribe, then delete the videos")
    sp.add_argument("--engine", choices=["faster_whisper", "openai", "deepgram", "assemblyai", "demo"])
    sp.add_argument("--model", help="Whisper model: large-v3, medium, small…")
    sp.add_argument("--language", default="auto", help="auto, hi, en, hinglish, …")
    sp.add_argument("--script", choices=["native", "roman"], default="native")
    sp.add_argument("--hook-seconds", type=float)
    sp.add_argument("--zip", action="store_true", help="build the ZIP at the end")
    sp.set_defaults(fn=cmd_download)

    sp = sub.add_parser("transcribe", help="transcribe a local video/audio file")
    sp.add_argument("file")
    sp.add_argument("--engine", choices=["faster_whisper", "openai", "deepgram", "assemblyai", "demo"])
    sp.add_argument("--model")
    sp.add_argument("--language", default="auto")
    sp.add_argument("--script", choices=["native", "roman"], default="native")
    sp.set_defaults(fn=cmd_transcribe)

    sp = sub.add_parser("jobs", help="list recent jobs")
    sp.set_defaults(fn=cmd_jobs)

    sp = sub.add_parser("resume", help="resume / retry a job")
    sp.add_argument("job_id")
    sp.set_defaults(fn=cmd_resume)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
