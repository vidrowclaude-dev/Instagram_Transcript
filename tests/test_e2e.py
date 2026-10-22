"""End-to-end through the HTTP API with the demo extractor (real ffmpeg, no Instagram)."""
import csv
import io
import time
import zipfile
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import extractors
from app.db import Job, JobStatus, Video, session_scope, utcnow
from app.extractors.base import RateLimitedError
from app.extractors.demo import DemoExtractor


@pytest.fixture
def demo():
    ex = DemoExtractor(count=6)
    extractors.set_extractors_for_tests([ex])
    return ex


@pytest.fixture
def client():
    from app.api.main import app
    with TestClient(app) as c:
        yield c


def wait_for(client, job_id, statuses, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        j = client.get(f"/api/jobs/{job_id}").json()
        if j["status"] in statuses:
            return j
        time.sleep(0.2)
    raise AssertionError(f"job stuck in {j['status']}: {j.get('message')} {j.get('error')}")


def preview(client, inputs, **filters):
    r = client.post("/api/jobs/preview", json={"inputs": inputs, "filters": filters})
    assert r.status_code == 201, r.text
    return wait_for(client, r.json()["job_id"], {"ready", "failed"})


def test_full_flow_download_transcribe_zip(client, demo):
    job = preview(client, "@demo_brand", content_type="all_videos")
    assert job["status"] == "ready" and len(job["videos"]) == 6
    pick = [v["shortcode"] for v in job["videos"][:4]]
    r = client.post(f"/api/jobs/{job['id']}/start", json={"shortcodes": pick, "mode": "download_transcribe",
                                                          "engine": "demo", "script": "roman"})
    assert r.status_code == 200, r.text
    job = wait_for(client, job["id"], {"completed", "completed_with_errors", "failed"})
    assert job["status"] == "completed", job
    assert job["counts"] == {"found": 6, "selected": 4, "downloaded": 4, "transcribed": 4, "done": 4,
                             "failed": 0, "pending": 0}

    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/jobs/{job['id']}/zip").content))
    names = z.namelist()
    for folder, ext, n in (("videos", ".mp4", 4), ("thumbnails", ".jpg", 4), ("captions", ".txt", 4)):
        assert len([x for x in names if x.startswith(folder + "/") and x.endswith(ext)]) == n
    for ext in (".txt", ".srt", ".json"):
        assert len([x for x in names if x.startswith("transcripts/") and x.endswith(ext)]) == 4
    assert {"metadata.csv", "metadata.json", "transcripts.csv"} <= set(names)
    assert names[0].startswith("videos/demo_brand_2026-")  # {handle}_{date}_{shortcode}.mp4

    rows = list(csv.DictReader(io.StringIO(z.read("transcripts.csv").decode("utf-8-sig"))))
    assert list(rows[0].keys()) == ["handle", "shortcode", "url", "date", "views", "likes", "duration", "caption",
                                    "transcript", "hook"]
    assert rows[0]["transcript"].startswith("Ruko ruko") and rows[0]["hook"]

    vid = job["videos"][0]["id"]
    detail = client.get(f"/api/videos/{vid}").json()
    assert len(detail["segments"]) == 3 and detail["segments"][1]["start"] == 1.6
    assert client.get(f"/api/videos/{vid}/file", headers={"Range": "bytes=0-99"}).status_code == 206
    assert client.get(f"/api/videos/{vid}/transcript.srt").text.startswith("1\n00:00:00,000")

    hits = client.get("/api/search", params={"q": "simple trick"}).json()
    assert len(hits["results"]) == 4 and "trick" in hits["results"][0]["snippet"]


def test_private_and_invalid_profiles_give_clear_errors(client, demo):
    job = preview(client, "@demo_private\n@demo_missing\nhttps://facebook.com/x")
    assert job["status"] == "failed" and job["videos"] == []
    reasons = {e["reason"] for e in job["input_errors"]}
    assert reasons == {"private", "not_found", "invalid_input"}
    assert "private" in job["error"] or "not an Instagram link" in job["error"]

    r = client.post("/api/jobs/preview", json={"inputs": "not a link!!", "filters": {}})
    assert r.status_code == 422 and "not a valid" in r.json()["detail"]["message"]


def test_one_good_one_private_still_works(client, demo):
    job = preview(client, "@demo_brand @demo_private", latest_n=2)
    assert job["status"] == "ready" and len(job["videos"]) == 2
    assert job["input_errors"][0]["reason"] == "private"


def test_transcribe_only_deletes_videos(client, demo):
    job = preview(client, "@demo_brand", latest_n=2)
    client.post(f"/api/jobs/{job['id']}/start", json={"mode": "transcribe", "engine": "demo"})
    job = wait_for(client, job["id"], {"completed", "completed_with_errors", "failed"})
    assert job["status"] == "completed"
    with session_scope() as s:
        vids = s.query(Video).filter_by(job_id=job["id"]).all()
        assert all(v.video_deleted and v.video_path is None and v.transcript_text for v in vids)
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/jobs/{job['id']}/zip").content))
    assert not [n for n in z.namelist() if n.startswith("videos/")]


def test_dedupe_across_jobs(client, demo):
    a = preview(client, "@demo_brand", latest_n=3)
    client.post(f"/api/jobs/{a['id']}/start", json={"mode": "download"})
    wait_for(client, a["id"], {"completed"})
    assert len(demo.download_calls) == 3
    b = preview(client, "@demo_brand", latest_n=3)
    client.post(f"/api/jobs/{b['id']}/start", json={"mode": "download"})
    wait_for(client, b["id"], {"completed"})
    assert len(demo.download_calls) == 3  # nothing downloaded twice

    # deleting job A keeps the files job B still uses
    client.delete(f"/api/jobs/{a['id']}")
    zb = zipfile.ZipFile(io.BytesIO(client.get(f"/api/jobs/{b['id']}/zip").content))
    assert len([n for n in zb.namelist() if n.startswith("videos/")]) == 3


class Crash(BaseException):
    """Stands in for the worker process being killed (not caught by the pipeline)."""


class CrashingDemo(DemoExtractor):
    def __init__(self, crash_after):
        super().__init__(count=6)
        self.crash_after = crash_after

    def download_video(self, meta, dest):
        if self.crash_after is not None and len(self.download_calls) >= self.crash_after:
            raise Crash()
        super().download_video(meta, dest)


def test_killed_worker_resumes_without_redownloading():
    from app.jobs import pipeline, queue

    ex = CrashingDemo(crash_after=2)
    extractors.set_extractors_for_tests([ex])
    with session_scope() as s:
        job = Job(title="t", targets=[{"kind": "profile", "raw": "@demo_brand", "handle": "demo_brand"}],
                  filters={"content_type": "all_videos"})
        s.add(job)
        s.flush()
        job_id = job.id
    pipeline.run_preview(job_id)
    with session_scope() as s:
        j = s.get(Job, job_id)
        j.status, j.mode = JobStatus.QUEUED, "download"
    import app.config as cfg
    cfg.get_settings().concurrency = 1  # deterministic order for the test

    with pytest.raises(Crash):
        pipeline.run_job(job_id)  # "worker dies" after 2 downloads
    with session_scope() as s:
        j = s.get(Job, job_id)
        assert j.status == JobStatus.RUNNING
        done_before = {v.shortcode for v in j.videos if v.video_path}
        assert len(done_before) == 2
        # pretend the heartbeat went quiet a while ago
        j.heartbeat_at = j.updated_at = utcnow() - timedelta(seconds=30)

    ex.crash_after = None
    calls_before = list(ex.download_calls)
    queue.reset_backend()
    resumed = queue.resume_stale()
    assert resumed == [job_id]
    end = time.time() + 30
    while time.time() < end:
        with session_scope() as s:
            if s.get(Job, job_id).status == JobStatus.COMPLETED:
                break
        time.sleep(0.2)
    with session_scope() as s:
        j = s.get(Job, job_id)
        assert j.status == JobStatus.COMPLETED
        assert all(v.status == "done" for v in j.videos)
    new_calls = ex.download_calls[len(calls_before):]
    assert not set(new_calls) & done_before, "finished videos were downloaded again"
    assert len(new_calls) == 4


class RateLimitedOnce(DemoExtractor):
    def __init__(self):
        super().__init__(count=3)
        self.hit = False

    def download_video(self, meta, dest):
        if not self.hit:
            self.hit = True
            raise RateLimitedError(detail="429 test")
        super().download_video(meta, dest)


def test_rate_limit_cools_down_then_finishes(client):
    ex = RateLimitedOnce()
    extractors.set_extractors_for_tests([ex])
    job = preview(client, "@demo_brand", content_type="all_videos")
    client.post(f"/api/jobs/{job['id']}/start", json={"mode": "download"})
    seen = set()
    end = time.time() + 30
    while time.time() < end:
        j = client.get(f"/api/jobs/{job['id']}").json()
        seen.add(j["status"])
        if j["status"] in ("completed", "failed", "completed_with_errors"):
            break
        time.sleep(0.05)
    assert j["status"] == "completed" and j["counts"]["done"] == 3
    assert "cooling_down" in seen


def test_cancel_and_rerun(client, demo):
    job = preview(client, "@demo_brand", content_type="all_videos")
    client.post(f"/api/jobs/{job['id']}/start", json={"mode": "download"})
    client.post(f"/api/jobs/{job['id']}/cancel")
    j = wait_for(client, job["id"], {"cancelled", "completed"})
    client.post(f"/api/jobs/{job['id']}/rerun", json={"only_failed": False})
    j = wait_for(client, job["id"], {"completed"})
    assert j["counts"]["done"] == 6


def test_engine_not_ready_is_rejected(client, demo):
    job = preview(client, "@demo_brand", latest_n=1)
    r = client.post(f"/api/jobs/{job['id']}/start", json={"mode": "download_transcribe", "engine": "openai"})
    assert r.status_code == 422 and "OPENAI_API_KEY" in r.json()["detail"]["message"]


def test_storage_and_cookies_endpoints(client, demo):
    st = client.get("/api/storage").json()
    assert "total_bytes" in st and "disk_free_bytes" in st
    r = client.post("/api/settings/cookies", files={"file": ("cookies.txt",
        b".instagram.com\tTRUE\t/\tTRUE\t4102444800\tcsrftoken\tA\n.instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tB\n")})
    assert r.status_code == 200 and r.json()["valid"]
    assert client.delete("/api/settings/cookies").json()["present"] is False
