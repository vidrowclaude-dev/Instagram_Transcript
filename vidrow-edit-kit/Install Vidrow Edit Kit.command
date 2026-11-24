#!/bin/bash
# Vidrow Edit Kit installer for macOS.
#
# If macOS says it "can't be opened because Apple cannot check it" / "doesn't identify the source":
#   right-click this file → Open → Open.   (or in Terminal:  xattr -dr com.apple.quarantine "<unzipped folder>")
set -u
cd "$(dirname "$0")" || exit 1
HERE="$(pwd)"
BOLD=$'\e[1m'; LIME=$'\e[38;5;191m'; RED=$'\e[31m'; DIM=$'\e[2m'; OFF=$'\e[0m'

echo "${BOLD}${LIME}Vidrow Edit Kit — installer${OFF}"
echo

# Find the extension folder (zip layout or repo layout)
if [ -d "$HERE/co.vidrow.editkit" ]; then SRC="$HERE/co.vidrow.editkit";
elif [ -d "$HERE/extension" ]; then SRC="$HERE/extension";
else echo "${RED}Can't find the extension folder next to this installer.${OFF}"; read -r -p "Press Return to close."; exit 1; fi

# Clear Gatekeeper quarantine on everything we're about to install
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null || true

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/co.vidrow.editkit"
echo "1. Installing the panel to:"
echo "   ${DIM}$DEST${OFF}"
mkdir -p "$(dirname "$DEST")"
# keep a downloaded logo across updates
KEEP_LOGO=""
if [ -f "$DEST/img/logo.svg" ] && grep -q "vidrow.co/Logo.svg" "$DEST/img/.logo-source" 2>/dev/null; then KEEP_LOGO="$(mktemp)"; cp "$DEST/img/logo.svg" "$KEEP_LOGO"; fi
rm -rf "$DEST"
ditto "$SRC" "$DEST" || { echo "${RED}Copy failed.${OFF}"; read -r -p "Press Return to close."; exit 1; }
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
if [ -n "$KEEP_LOGO" ]; then cp "$KEEP_LOGO" "$DEST/img/logo.svg"; echo "https://vidrow.co/Logo.svg" > "$DEST/img/.logo-source"; fi

echo "2. Allowing unsigned panels (PlayerDebugMode) for CSXS 9–12"
for v in 9 10 11 12; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

echo "3. Fetching the Vidrow logo from vidrow.co"
TMPLOGO="$(mktemp)"
if curl -fsSL --max-time 20 "https://vidrow.co/Logo.svg" -o "$TMPLOGO" && grep -qi "<svg" "$TMPLOGO"; then
  cp "$TMPLOGO" "$DEST/img/logo.svg"; echo "https://vidrow.co/Logo.svg" > "$DEST/img/.logo-source"; echo "   done"
else
  echo "   ${DIM}couldn't download it; the panel shows a placeholder wordmark (re-run the installer later to fetch it)${OFF}"
fi
rm -f "$TMPLOGO"

echo "4. Tools (ffmpeg, yt-dlp)"
if command -v brew >/dev/null 2>&1; then
  MISSING=""
  command -v ffmpeg >/dev/null 2>&1 || MISSING="$MISSING ffmpeg"
  command -v yt-dlp >/dev/null 2>&1 || MISSING="$MISSING yt-dlp"
  if [ -n "$MISSING" ]; then
    read -r -p "   Install$MISSING with Homebrew now? [Y/n] " ans
    if [[ ! "$ans" =~ ^[Nn] ]]; then brew install $MISSING; fi
  else
    read -r -p "   ffmpeg and yt-dlp are installed. Update them? [y/N] " ans
    if [[ "$ans" =~ ^[Yy] ]]; then brew upgrade ffmpeg yt-dlp; fi
  fi
  read -r -p "   Also install whisper.cpp for free, offline transcription (downloads ~1.6 GB model)? [y/N] " ans
  if [[ "$ans" =~ ^[Yy] ]]; then
    brew install whisper-cpp
    MDIR="$HOME/Library/Application Support/Vidrow Edit Kit/models"; mkdir -p "$MDIR"
    curl -fL --progress-bar "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" -o "$MDIR/ggml-large-v3-turbo.bin" \
      && echo "   Model saved to: $MDIR/ggml-large-v3-turbo.bin  (Settings → whisper.cpp model)"
    echo "   Binary: $(command -v whisper-cli || echo /opt/homebrew/bin/whisper-cli)  (Settings → whisper.cpp binary)"
  fi
else
  echo "   ${RED}Homebrew not found.${OFF} Install it from https://brew.sh then run:  brew install ffmpeg yt-dlp"
fi

echo
echo "${BOLD}Installed.${OFF} Next:"
echo "  • Quit and reopen Premiere Pro."
echo "  • Premiere → Settings → Media → Default Media Scaling: ${BOLD}None${OFF}."
echo "  • Window → Extensions → ${BOLD}Vidrow Edit Kit${OFF}, then ⚙ Settings: paste your Anthropic and OpenAI keys."
echo
read -r -p "Press Return to close."
