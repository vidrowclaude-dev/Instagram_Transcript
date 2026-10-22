"""Transcription interface. Every engine returns the same TranscriptResult."""
from __future__ import annotations

import abc
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Segment:
    start: float
    end: float
    text: str

    def to_dict(self) -> dict:
        return {"start": round(self.start, 3), "end": round(self.end, 3), "text": self.text}


@dataclass
class TranscriptResult:
    segments: list[Segment]
    language: str | None = None
    engine: str = ""
    duration: float | None = None
    extra: dict = field(default_factory=dict)

    @property
    def text(self) -> str:
        return " ".join(s.text.strip() for s in self.segments if s.text.strip())

    def to_dict(self) -> dict:
        d = asdict(self)
        d["segments"] = [s.to_dict() for s in self.segments]
        d["text"] = self.text
        return d


class TranscriptionError(Exception):
    reason = "transcription_failed"


class NoAudioError(TranscriptionError):
    """The video has no audio track."""
    reason = "no_audio"


class EngineNotConfiguredError(TranscriptionError):
    reason = "engine_not_configured"


class Transcriber(abc.ABC):
    name: str = "base"

    @abc.abstractmethod
    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        """Transcribe a 16 kHz mono WAV. `language` is an ISO code or None for auto-detect."""
