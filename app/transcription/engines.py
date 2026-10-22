"""Transcription engines behind one interface.

  faster_whisper  local, free, default (large-v3; small/medium for speed)
  openai          OpenAI audio transcriptions API (whisper-1)
  deepgram        Deepgram Listen API (nova-3)
  assemblyai      AssemblyAI (universal)
  demo            offline fake, only with DEMO_MODE
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import httpx

from app.config import Settings
from app.transcription.base import (
    EngineNotConfiguredError,
    Segment,
    Transcriber,
    TranscriptionError,
    TranscriptResult,
)

WHISPER_MODELS = ["large-v3", "medium", "small", "base", "tiny"]

# Prompt nudging Whisper to keep code-mixed Hindi/English as spoken rather than translating.
HINGLISH_PROMPT = "Haan toh dosto, aaj hum baat karenge. Yeh video aapke liye hai, toh end tak dekhna. Let's go!"


class FasterWhisperEngine(Transcriber):
    name = "faster_whisper"
    _models: dict[tuple, object] = {}
    _load_lock = threading.Lock()
    _run_lock = threading.Lock()  # one transcription at a time per process (CPU/GPU bound)

    def __init__(self, settings: Settings, model: str | None = None):
        self.settings = settings
        self.model_name = model or settings.whisper_model

    def _model(self):
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:  # pragma: no cover - depends on install
            raise EngineNotConfiguredError("faster-whisper is not installed (pip install faster-whisper)") from e
        device = self.settings.whisper_device
        if device == "auto":
            try:
                import ctranslate2
                device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:  # noqa: BLE001
                device = "cpu"
        compute = self.settings.whisper_compute_type
        if compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        key = (self.model_name, device, compute)
        with self._load_lock:
            if key not in self._models:
                self._models[key] = WhisperModel(self.model_name, device=device, compute_type=compute,
                                                 download_root=str(self.settings.data_dir / "models"))
        return self._models[key]

    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        model = self._model()
        lang = None if language in (None, "", "auto") else language
        kwargs = dict(beam_size=5, vad_filter=True, vad_parameters={"min_silence_duration_ms": 400},
                      condition_on_previous_text=False)
        if lang in ("hi", "hinglish"):
            kwargs["initial_prompt"] = HINGLISH_PROMPT
        with self._run_lock:
            segments, info = model.transcribe(str(wav_path), language="hi" if lang == "hinglish" else lang,
                                              **kwargs)
            segs = [Segment(float(s.start), float(s.end), s.text.strip()) for s in segments]
        return TranscriptResult(segments=segs, language=getattr(info, "language", lang),
                                engine=f"faster_whisper:{self.model_name}",
                                duration=getattr(info, "duration", None),
                                extra={"language_probability": getattr(info, "language_probability", None)})


class OpenAIEngine(Transcriber):
    name = "openai"
    URL = "https://api.openai.com/v1/audio/transcriptions"

    def __init__(self, settings: Settings):
        if not settings.openai_api_key:
            raise EngineNotConfiguredError("OPENAI_API_KEY is not set")
        self.settings = settings

    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        lang = None if language in (None, "", "auto") else ("hi" if language == "hinglish" else language)
        data: dict = {"model": self.settings.openai_transcribe_model, "response_format": "verbose_json",
                      "timestamp_granularities[]": "segment"}
        if lang:
            data["language"] = lang
        if language in ("hi", "hinglish"):
            data["prompt"] = HINGLISH_PROMPT
        with open(wav_path, "rb") as fh:
            r = _post_with_retry(self.URL, headers={"Authorization": f"Bearer {self.settings.openai_api_key}"},
                                 data=data, files={"file": (wav_path.name, fh, "audio/wav")})
        return parse_openai(r.json(), self.settings.openai_transcribe_model)


def parse_openai(payload: dict, model: str = "whisper-1") -> TranscriptResult:
    segs = [Segment(float(s["start"]), float(s["end"]), str(s.get("text", "")).strip())
            for s in payload.get("segments") or []]
    if not segs and payload.get("text"):
        segs = [Segment(0.0, float(payload.get("duration") or 0.0), payload["text"].strip())]
    lang = payload.get("language")
    return TranscriptResult(segments=segs, language=_iso(lang), engine=f"openai:{model}",
                            duration=payload.get("duration"))


class DeepgramEngine(Transcriber):
    name = "deepgram"
    URL = "https://api.deepgram.com/v1/listen"

    def __init__(self, settings: Settings):
        if not settings.deepgram_api_key:
            raise EngineNotConfiguredError("DEEPGRAM_API_KEY is not set")
        self.settings = settings

    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        params = {"model": self.settings.deepgram_model, "smart_format": "true", "punctuate": "true",
                  "utterances": "true"}
        if language in (None, "", "auto"):
            params["detect_language"] = "true"
        elif language == "hinglish":
            params["language"] = "multi"  # Deepgram's code-switching mode
        else:
            params["language"] = language
        r = _post_with_retry(self.URL, params=params, content=wav_path.read_bytes(),
                             headers={"Authorization": f"Token {self.settings.deepgram_api_key}",
                                      "Content-Type": "audio/wav"})
        return parse_deepgram(r.json(), self.settings.deepgram_model)


def parse_deepgram(payload: dict, model: str = "nova-3") -> TranscriptResult:
    results = payload.get("results") or {}
    segs = [Segment(float(u["start"]), float(u["end"]), str(u.get("transcript", "")).strip())
            for u in results.get("utterances") or []]
    channel = ((results.get("channels") or [{}])[0])
    if not segs:
        alt = (channel.get("alternatives") or [{}])[0]
        words = alt.get("words") or []
        if words:
            segs = _words_to_segments([(w["start"], w["end"], w.get("punctuated_word") or w["word"]) for w in words])
        elif alt.get("transcript"):
            segs = [Segment(0.0, float((payload.get("metadata") or {}).get("duration") or 0), alt["transcript"])]
    lang = channel.get("detected_language")
    if not lang:
        langs = ((channel.get("alternatives") or [{}])[0]).get("languages") or []
        lang = langs[0] if langs else None
    return TranscriptResult(segments=segs, language=_iso(lang), engine=f"deepgram:{model}",
                            duration=(payload.get("metadata") or {}).get("duration"))


class AssemblyAIEngine(Transcriber):
    name = "assemblyai"
    BASE = "https://api.assemblyai.com/v2"

    def __init__(self, settings: Settings, poll_every: float = 3.0, timeout: float = 900.0):
        if not settings.assemblyai_api_key:
            raise EngineNotConfiguredError("ASSEMBLYAI_API_KEY is not set")
        self.settings = settings
        self.poll_every = poll_every
        self.timeout = timeout

    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        h = {"authorization": self.settings.assemblyai_api_key}
        up = _post_with_retry(f"{self.BASE}/upload", headers=h, content=wav_path.read_bytes())
        body: dict = {"audio_url": up.json()["upload_url"], "punctuate": True, "format_text": True}
        if language in (None, "", "auto"):
            body["language_detection"] = True
        else:
            body["language_code"] = "hi" if language == "hinglish" else language
        tid = _post_with_retry(f"{self.BASE}/transcript", headers=h, json=body).json()["id"]
        deadline = time.monotonic() + self.timeout
        with httpx.Client(timeout=60) as c:
            while True:
                t = c.get(f"{self.BASE}/transcript/{tid}", headers=h).json()
                if t.get("status") == "completed":
                    break
                if t.get("status") == "error":
                    raise TranscriptionError(f"AssemblyAI error: {t.get('error')}")
                if time.monotonic() > deadline:
                    raise TranscriptionError("AssemblyAI timed out")
                time.sleep(self.poll_every)
            sentences = c.get(f"{self.BASE}/transcript/{tid}/sentences", headers=h).json()
        return parse_assemblyai(t, sentences)


def parse_assemblyai(transcript: dict, sentences: dict | None = None) -> TranscriptResult:
    segs = [Segment(s["start"] / 1000.0, s["end"] / 1000.0, str(s.get("text", "")).strip())
            for s in (sentences or {}).get("sentences") or []]
    if not segs:
        words = transcript.get("words") or []
        if words:
            segs = _words_to_segments([(w["start"] / 1000.0, w["end"] / 1000.0, w["text"]) for w in words])
        elif transcript.get("text"):
            segs = [Segment(0.0, float(transcript.get("audio_duration") or 0), transcript["text"])]
    return TranscriptResult(segments=segs, language=_iso(transcript.get("language_code")), engine="assemblyai",
                            duration=transcript.get("audio_duration"))


class DemoEngine(Transcriber):
    """Offline stand-in used in DEMO_MODE and tests."""
    name = "demo"

    LINES = [
        (0.0, 1.6, "Ruko ruko, scroll mat karo."),
        (1.6, 3.4, "Aaj main aapko ek simple trick bataungi."),
        (3.4, 6.0, "Isse aapka time aur paisa dono bachega."),
    ]

    def transcribe(self, wav_path: Path, language: str | None = None) -> TranscriptResult:
        return TranscriptResult(segments=[Segment(*x) for x in self.LINES], language=language or "hi",
                                engine="demo")


# ---- helpers ------------------------------------------------------------------------

def _iso(lang: str | None) -> str | None:
    if not lang:
        return None
    lang = lang.lower()
    return {"hindi": "hi", "english": "en", "en-us": "en", "en-in": "en", "hi-in": "hi"}.get(lang, lang.split("-")[0])


def _words_to_segments(words: list[tuple[float, float, str]], max_len: float = 6.0, gap: float = 0.8) -> list[Segment]:
    """Group word timings into subtitle-sized segments."""
    segs: list[Segment] = []
    cur: list[tuple[float, float, str]] = []
    for w in words:
        if cur and (w[0] - cur[-1][1] > gap or w[1] - cur[0][0] > max_len or cur[-1][2].endswith((".", "?", "!"))):
            segs.append(Segment(float(cur[0][0]), float(cur[-1][1]), " ".join(x[2] for x in cur)))
            cur = []
        cur.append(w)
    if cur:
        segs.append(Segment(float(cur[0][0]), float(cur[-1][1]), " ".join(x[2] for x in cur)))
    return segs


def _post_with_retry(url: str, attempts: int = 4, **kwargs) -> httpx.Response:
    last: Exception | None = None
    for i in range(attempts):
        try:
            with httpx.Client(timeout=httpx.Timeout(600, connect=30)) as c:
                r = c.post(url, **kwargs)
            if r.status_code in (429, 500, 502, 503, 504):
                raise TranscriptionError(f"{url} returned {r.status_code}")
            if r.status_code >= 400:
                raise TranscriptionError(f"{url} returned {r.status_code}: {r.text[:300]}")
            return r
        except (httpx.TransportError, TranscriptionError) as e:
            last = e
            if isinstance(e, TranscriptionError) and "returned 4" in str(e) and "returned 429" not in str(e):
                raise  # bad key / bad request: retrying won't help
            # rewind any file handles before retrying
            for f in (kwargs.get("files") or {}).values():
                if isinstance(f, tuple) and hasattr(f[1], "seek"):
                    f[1].seek(0)
            time.sleep(min(30, 2 ** (i + 1)))
    raise TranscriptionError(f"Request to {url} failed after {attempts} attempts: {last}")


def available_engines(settings: Settings) -> list[dict]:
    try:
        import faster_whisper  # noqa: F401
        fw = True
    except ImportError:
        fw = False
    out = [
        {"id": "faster_whisper", "label": "faster-whisper (local)", "ready": fw,
         "note": None if fw else "pip install faster-whisper", "models": WHISPER_MODELS},
        {"id": "openai", "label": "OpenAI Whisper API", "ready": bool(settings.openai_api_key),
         "note": None if settings.openai_api_key else "Set OPENAI_API_KEY in .env"},
        {"id": "deepgram", "label": "Deepgram", "ready": bool(settings.deepgram_api_key),
         "note": None if settings.deepgram_api_key else "Set DEEPGRAM_API_KEY in .env"},
        {"id": "assemblyai", "label": "AssemblyAI", "ready": bool(settings.assemblyai_api_key),
         "note": None if settings.assemblyai_api_key else "Set ASSEMBLYAI_API_KEY in .env"},
    ]
    if settings.demo_mode:
        out.append({"id": "demo", "label": "Demo (fake transcript)", "ready": True, "note": "Demo mode only"})
    return out


def get_transcriber(engine: str, settings: Settings, model: str | None = None) -> Transcriber:
    engine = engine or settings.transcribe_engine
    if engine == "faster_whisper":
        if model and model not in WHISPER_MODELS:
            raise EngineNotConfiguredError(f"Unknown Whisper model '{model}'")
        return FasterWhisperEngine(settings, model)
    if engine == "openai":
        return OpenAIEngine(settings)
    if engine == "deepgram":
        return DeepgramEngine(settings)
    if engine == "assemblyai":
        return AssemblyAIEngine(settings)
    if engine == "demo":
        return DemoEngine()
    raise EngineNotConfiguredError(f"Unknown transcription engine '{engine}'")
