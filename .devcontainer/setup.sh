#!/usr/bin/env bash
# Runs once when the codespace is created.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Installing ffmpeg…"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends ffmpeg >/dev/null

echo "Installing Python packages…"
python -m pip install --quiet -r requirements.txt

if [ ! -f .env ]; then
  # Codespace CPUs are slow for large-v3, so start with the small Whisper model.
  sed 's/^WHISPER_MODEL=large-v3/WHISPER_MODEL=small/' .env.example > .env
  echo "Created .env (Whisper model: small). API keys set as Codespaces secrets are picked up automatically."
fi

mkdir -p data
echo "Setup done."
