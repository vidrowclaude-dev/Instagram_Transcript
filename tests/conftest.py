import os

import pytest


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    """Every test gets its own data dir, database and in-process queue. No network."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("DEMO_MODE", "true")
    monkeypatch.setenv("QUEUE_BACKEND", "thread")
    monkeypatch.setenv("MIN_DELAY", "0")
    monkeypatch.setenv("MAX_DELAY", "0")
    monkeypatch.setenv("BACKOFF_BASE", "0.2")
    monkeypatch.setenv("BACKOFF_MAX", "0.5")
    monkeypatch.setenv("HEARTBEAT_SECONDS", "1")
    monkeypatch.setenv("STALE_AFTER_SECONDS", "2")
    for k in ("OPENAI_API_KEY", "DEEPGRAM_API_KEY", "ASSEMBLYAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)

    from app import config, db, extractors
    from app.jobs import queue

    config.reset_settings_cache()
    db.reset_engine()
    queue.reset_backend()
    extractors.set_extractors_for_tests(None)
    extractors.reset_extractors()
    yield
    extractors.set_extractors_for_tests(None)
    db.reset_engine()
    config.reset_settings_cache()
    queue.reset_backend()


def pytest_configure(config):
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
