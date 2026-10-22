import json
import subprocess
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.transcription.audio import extract_audio, has_audio
from app.transcription.base import EngineNotConfiguredError, NoAudioError, Segment, TranscriptResult
from app.transcription.engines import (
    DemoEngine,
    FasterWhisperEngine,
    get_transcriber,
    parse_assemblyai,
    parse_deepgram,
    parse_openai,
)
from app.transcription.formats import hook_text, to_srt, to_txt, write_outputs
from app.transcription.romanize import romanize

RESULT = TranscriptResult(
    segments=[Segment(0.0, 1.5, " Ruko ruko, "), Segment(1.5, 4.0, "scroll mat karo yaar"), Segment(4.0, 6.2, "Aaj ki deal")],
    language="hi", engine="test",
)


def test_txt_is_one_clean_paragraph():
    assert to_txt(RESULT) == "Ruko ruko, scroll mat karo yaar Aaj ki deal\n"


def test_srt_format():
    srt = to_srt(RESULT)
    lines = srt.splitlines()
    assert lines[0] == "1"
    assert lines[1] == "00:00:00,000 --> 00:00:01,500"
    assert lines[2] == "Ruko ruko,"
    assert "00:00:04,000 --> 00:00:06,200" in srt
    assert to_srt(TranscriptResult([Segment(3725.25, 3726.0, "late")])).splitlines()[1] == \
        "01:02:05,250 --> 01:02:06,000"


def test_hook_takes_proportional_words_of_straddling_segment():
    # 0-1.5 all words; 1.5-4.0 straddles 3s -> 60% of 4 words -> 3 words
    assert hook_text(RESULT.segments, 3.0) == "Ruko ruko, scroll mat karo"
    assert hook_text(RESULT.segments, 0) == ""
    assert hook_text(RESULT.segments, 100) == "Ruko ruko, scroll mat karo yaar Aaj ki deal"


def test_write_outputs(tmp_path):
    out = write_outputs(RESULT, tmp_path / "t" / "x", shortcode="SC")
    assert set(out) == {"txt", "srt", "json"}
    data = json.loads(out["json"].read_text())
    assert data["shortcode"] == "SC" and data["segments"][1]["start"] == 1.5 and data["text"].startswith("Ruko")


@pytest.mark.parametrize("dev, roman", [
    ("नमस्ते दोस्तों, आज हम बात करेंगे", "namaste doston, aaj hum baat karenge"),
    ("पैसे बचाने के 3 तरीके", "paise bachane ke 3 tarike"),
    ("समझना", "samajhna"), ("बदलना", "badalna"), ("लड़की", "ladki"), ("ज़्यादा", "zyada"),
    ("कंपनी", "kampani"), ("तीन", "teen"), ("में", "mein"),
    ("Office में meeting है", "Office mein meeting hai"),
])
def test_romanize(dev, roman):
    assert romanize(dev) == roman


def test_parse_openai():
    r = parse_openai({"language": "hindi", "duration": 6.0, "text": "a b",
                      "segments": [{"start": 0, "end": 2.5, "text": " a"}, {"start": 2.5, "end": 6, "text": " b"}]})
    assert r.language == "hi" and [s.text for s in r.segments] == ["a", "b"] and r.engine == "openai:whisper-1"


def test_parse_deepgram_utterances_and_words():
    r = parse_deepgram({"metadata": {"duration": 5}, "results": {
        "channels": [{"detected_language": "hi", "alternatives": [{"transcript": "x"}]}],
        "utterances": [{"start": 0.1, "end": 2.0, "transcript": "Hello dosto"}]}})
    assert r.language == "hi" and r.segments[0].text == "Hello dosto"
    r2 = parse_deepgram({"results": {"channels": [{"alternatives": [{"words": [
        {"start": 0, "end": .4, "word": "hi", "punctuated_word": "Hi."},
        {"start": 2.0, "end": 2.4, "word": "there", "punctuated_word": "there"}]}]}]}})
    assert [s.text for s in r2.segments] == ["Hi.", "there"]


def test_parse_assemblyai():
    r = parse_assemblyai({"language_code": "en", "audio_duration": 4},
                         {"sentences": [{"start": 0, "end": 1500, "text": "One."}, {"start": 1500, "end": 4000, "text": "Two."}]})
    assert r.segments[1].start == 1.5 and r.language == "en"


def test_engine_registry_errors():
    s = get_settings()
    with pytest.raises(EngineNotConfiguredError, match="OPENAI_API_KEY"):
        get_transcriber("openai", s)
    with pytest.raises(EngineNotConfiguredError):
        get_transcriber("nope", s)
    with pytest.raises(EngineNotConfiguredError):
        get_transcriber("faster_whisper", s, "giant-v9")
    assert isinstance(get_transcriber("demo", s), DemoEngine)


def test_faster_whisper_wrapper_with_stub_model(tmp_path, monkeypatch):
    """The real model downloads on first use; here we stub it to check the wrapper's contract."""
    seen = {}

    class StubModel:
        def transcribe(self, path, language=None, **kw):
            seen.update(language=language, **kw)
            segs = iter([SimpleNamespace(start=0.0, end=1.2, text=" Haan dosto "),
                         SimpleNamespace(start=1.2, end=3.0, text=" sab theek?")])
            return segs, SimpleNamespace(language="hi", duration=3.0, language_probability=0.97)

    monkeypatch.setattr(FasterWhisperEngine, "_model", lambda self: StubModel())
    eng = FasterWhisperEngine(get_settings(), "small")
    r = eng.transcribe(tmp_path / "a.wav", "hinglish")
    assert seen["language"] == "hi" and "initial_prompt" in seen and seen["vad_filter"] is True
    assert [s.text for s in r.segments] == ["Haan dosto", "sab theek?"] and r.engine == "faster_whisper:small"
    eng.transcribe(tmp_path / "a.wav", "auto")
    assert seen["language"] is None


def _make_video(path, audio=True):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=160x284:rate=10:duration=2"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=300:duration=2", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True)


def test_extract_audio_16k_mono(tmp_path):
    v = tmp_path / "v.mp4"
    _make_video(v)
    wav = extract_audio(v, tmp_path / "a.wav")
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(wav)],
                                     capture_output=True, text=True).stdout)["streams"][0]
    assert info["sample_rate"] == "16000" and info["channels"] == 1


def test_no_audio_is_reported(tmp_path):
    v = tmp_path / "silent.mp4"
    _make_video(v, audio=False)
    assert not has_audio(v)
    with pytest.raises(NoAudioError):
        extract_audio(v, tmp_path / "a.wav")
