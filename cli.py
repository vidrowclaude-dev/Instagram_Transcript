"""Command-line version of the app.

    python cli.py https://www.instagram.com/reel/XXXXXXXXX/
    python cli.py --file clip.mp4 --engine whisper --out output/
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv

import pipeline


def main() -> int:
    load_dotenv()
    p = argparse.ArgumentParser(description="Instagram reel/post → character-dialogue script")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("url", nargs="?", help="Instagram reel/post URL")
    src.add_argument("--file", type=Path, help="local video/audio file instead of a URL")
    p.add_argument("--engine", choices=["auto", "assemblyai", "whisper"], default="auto")
    p.add_argument("--whisper-model", default="small", help="tiny | base | small | medium | large-v3")
    p.add_argument("--language", default=None, help="e.g. hi, en (default: auto-detect)")
    p.add_argument("--no-claude", action="store_true", help="skip character naming with Claude")
    p.add_argument("--no-roman", action="store_true", help="keep Hindi in Devanagari")
    p.add_argument("--no-timestamps", action="store_true")
    p.add_argument("--cookies", default=None, help="path to Instagram cookies.txt")
    p.add_argument("--out", type=Path, default=None, help="directory to write .txt/.srt/.json (default: print only)")
    a = p.parse_args()

    if a.file and not a.file.exists():
        p.error(f"file not found: {a.file}")

    t, synopsis = pipeline.run(
        url=a.url,
        local_video=a.file,
        work_dir=Path(tempfile.mkdtemp(prefix="insta_")),
        engine=a.engine,
        whisper_model=a.whisper_model,
        language=a.language,
        name_with_claude=not a.no_claude,
        romanize_hinglish=not a.no_roman,
        cookies_file=a.cookies or os.getenv("INSTAGRAM_COOKIES") or None,
        progress=lambda m: print(f"• {m}", file=sys.stderr),
    )

    script = pipeline.to_script(t, synopsis, timestamps=not a.no_timestamps)
    print(script)

    if a.out:
        a.out.mkdir(parents=True, exist_ok=True)
        base = t.source.rstrip("/").split("/")[-1].rsplit(".", 1)[0] or "transcript"
        (a.out / f"{base}_script.txt").write_text(script, encoding="utf-8")
        (a.out / f"{base}.srt").write_text(pipeline.to_srt(t), encoding="utf-8")
        (a.out / f"{base}.json").write_text(json.dumps(t.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Saved to {a.out}/", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
