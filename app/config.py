"""Central configuration, loaded from environment / .env."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Storage
    data_dir: Path = Path("./data")
    database_url: str | None = None  # default: sqlite file inside data_dir

    # Queue: "rq" (Redis), "thread" (in-process, no Redis) or "auto"
    queue_backend: str = "auto"
    redis_url: str = "redis://localhost:6379/0"

    # Transcription
    transcribe_engine: str = "faster_whisper"  # faster_whisper | openai | deepgram | assemblyai
    whisper_model: str = "large-v3"            # large-v3 | medium | small | base | tiny
    whisper_device: str = "auto"               # auto | cpu | cuda
    whisper_compute_type: str = "auto"         # auto | int8 | float16 | int8_float16
    openai_api_key: str | None = None
    openai_transcribe_model: str = "whisper-1"
    deepgram_api_key: str | None = None
    deepgram_model: str = "nova-3"
    assemblyai_api_key: str | None = None
    hook_seconds: float = 3.0

    # Rate limiting (conservative defaults)
    min_delay: float = 4.0          # seconds between Instagram requests (lower bound)
    max_delay: float = 9.0          # upper bound of the random delay
    concurrency: int = 2            # parallel downloads per job
    backoff_base: float = 60.0      # first cooldown after a 429, doubles each time
    backoff_max: float = 900.0      # cap a single cooldown at 15 minutes
    max_cooldowns: int = 6          # give up on a job after this many consecutive cooldowns
    max_scan: int = 600             # max posts scanned per profile when a filter needs a full scan
    request_timeout: float = 30.0

    # Workers
    stale_after_seconds: int = 60   # a running job with no heartbeat for this long is resumed
    heartbeat_seconds: int = 15

    # Demo mode: fake extractor + fake transcriber, no network. Handles starting with "demo" only.
    demo_mode: bool = False

    @property
    def db_url(self) -> str:
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'reelvault.db').resolve()}"

    @property
    def library_dir(self) -> Path:
        return self.data_dir / "library"

    @property
    def exports_dir(self) -> Path:
        return self.data_dir / "exports"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def secrets_dir(self) -> Path:
        return self.data_dir / "secrets"

    @property
    def cookies_path(self) -> Path:
        return self.secrets_dir / "cookies.txt"

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.library_dir, self.exports_dir, self.cache_dir, self.secrets_dir):
            d.mkdir(parents=True, exist_ok=True)
        try:
            self.secrets_dir.chmod(0o700)
        except OSError:
            pass


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    s.ensure_dirs()
    return s


def reset_settings_cache() -> None:
    get_settings.cache_clear()
