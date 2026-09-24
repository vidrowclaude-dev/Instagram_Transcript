import json
import os
import tempfile
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv

import pipeline

load_dotenv()

st.set_page_config(page_title="Instagram Transcript → Script", page_icon="🎬", layout="wide")
st.title("🎬 Instagram Transcript Generator")
st.caption("Paste a reel/post link (or upload a video) → get the dialogue broken down by character.")

# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.header("Settings")
    has_aai = bool(os.getenv("ASSEMBLYAI_API_KEY"))
    has_claude = bool(os.getenv("ANTHROPIC_API_KEY"))

    engine = st.radio(
        "Transcription engine",
        ["auto", "assemblyai", "whisper"],
        help="AssemblyAI = cloud, includes speaker diarization (needs key). "
             "Whisper = runs on your laptop, no key, no diarization (Claude splits speakers from context).",
    )
    whisper_model = st.selectbox("Whisper model (local only)", ["tiny", "base", "small", "medium", "large-v3"], index=2)
    language = st.selectbox("Language", ["auto", "hi", "en", "ta", "te", "kn", "mr", "bn"], index=0)
    name_with_claude = st.checkbox("Name characters with Claude", value=True, disabled=not has_claude,
                                   help="Turns Speaker A/B into 'Mom', 'Delivery Guy', 'VO' etc.")
    romanize = st.checkbox("Write Hinglish in Roman script", value=True, disabled=not has_claude)
    show_ts = st.checkbox("Show timestamps", value=True)
    cookies_file = st.text_input("Instagram cookies.txt (optional)", value=os.getenv("INSTAGRAM_COOKIES", ""),
                                 help="Needed if Instagram asks you to log in. Export with a 'Get cookies.txt' browser extension.")

    st.divider()
    st.markdown("**Keys detected**")
    st.markdown(f"- AssemblyAI: {'✅' if has_aai else '❌ (Whisper fallback)'}")
    st.markdown(f"- Anthropic: {'✅' if has_claude else '❌ (raw speaker labels only)'}")

# ---------------------------------------------------------------- input
tab_url, tab_file = st.tabs(["Instagram link", "Upload video"])
with tab_url:
    url = st.text_input("Instagram URL", placeholder="https://www.instagram.com/reel/XXXXXXXXX/")
with tab_file:
    upload = st.file_uploader("Video file", type=["mp4", "mov", "m4a", "mp3", "webm"])

go = st.button("Generate transcript", type="primary", width="stretch")

# ---------------------------------------------------------------- run
if go:
    if not url and not upload:
        st.error("Paste an Instagram link or upload a video first.")
        st.stop()

    work = Path(tempfile.mkdtemp(prefix="insta_"))
    local_video = None
    if upload and not url:
        local_video = work / upload.name
        local_video.write_bytes(upload.getbuffer())

    with st.status("Working…", expanded=True) as status:
        log = st.empty()
        steps: list[str] = []

        def progress(msg: str):
            steps.append(msg)
            log.markdown("\n".join(f"- {s}" for s in steps))

        try:
            transcript, synopsis = pipeline.run(
                url=url or None,
                local_video=local_video,
                work_dir=work,
                engine=engine,
                whisper_model=whisper_model,
                language=None if language == "auto" else language,
                name_with_claude=name_with_claude,
                romanize_hinglish=romanize,
                cookies_file=cookies_file or None,
                progress=progress,
            )
        except Exception as e:
            status.update(label="Failed", state="error")
            st.error(str(e))
            st.stop()
        status.update(label="Transcript ready", state="complete", expanded=False)

    st.session_state["transcript"] = transcript
    st.session_state["synopsis"] = synopsis

# ---------------------------------------------------------------- output
if "transcript" in st.session_state:
    t: pipeline.Transcript = st.session_state["transcript"]
    synopsis = st.session_state.get("synopsis", "")
    script_txt = pipeline.to_script(t, synopsis, timestamps=show_ts)

    left, right = st.columns([3, 2])
    with left:
        st.subheader("Script")
        st.code(script_txt, language=None)
    with right:
        st.subheader("Lines")
        chars = sorted({l.character for l in t.lines})
        st.markdown("**Characters:** " + ", ".join(chars))
        st.dataframe(
            [{"time": pipeline._ts(l.start), "character": l.character, "line": l.text} for l in t.lines],
            width="stretch", hide_index=True,
        )

    base = (t.source.rstrip("/").split("/")[-1] or "transcript")
    c1, c2, c3 = st.columns(3)
    c1.download_button("⬇️ Script (.txt)", script_txt, f"{base}_script.txt", "text/plain", width="stretch")
    c2.download_button("⬇️ Subtitles (.srt)", pipeline.to_srt(t), f"{base}.srt", "text/plain", width="stretch")
    c3.download_button("⬇️ JSON", json.dumps(t.to_dict(), ensure_ascii=False, indent=2), f"{base}.json",
                       "application/json", width="stretch")
