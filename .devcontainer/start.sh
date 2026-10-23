#!/usr/bin/env bash
# Runs every time the codespace starts or resumes: starts Reel Vault on port 8000.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
PORT="${PORT:-8000}"

if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  echo "Reel Vault is already running on port ${PORT}."
  exit 0
fi

# setsid + nohup keep the server alive after this script exits.
setsid nohup python -m uvicorn app.api.main:app --host 0.0.0.0 --port "${PORT}" \
  >> data/server.log 2>&1 < /dev/null &

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "Reel Vault is running. Open the Ports tab and click the globe icon next to port ${PORT}."
    exit 0
  fi
  sleep 1
done

echo "Reel Vault didn't start. Last lines of data/server.log:"
tail -n 30 data/server.log
exit 1
