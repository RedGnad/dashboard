#!/usr/bin/env bash
set -euo pipefail
PORT=${PORT:-8787}
LOG=server-live.log
echo "[run-api] Killing old listeners on :$PORT" >&2
lsof -ti tcp:$PORT | xargs -r kill -9 || true
echo "[run-api] Env summary:" >&2
env | grep -E 'RPC_URL|ZERO_DEV|PIMLICO|DELEGATE|NO_API' || true
echo "[run-api] Node: $(node -v)" >&2
echo "[run-api] Starting tsx src/index.ts" >&2
( npx tsx src/index.ts 2>&1 | tee -a "$LOG" ) &
PID=$!
echo $PID > .api.pid
echo "[run-api] PID=$PID" >&2
sleep 1.2
if curl -fsS http://127.0.0.1:$PORT/api/routes >/dev/null 2>&1; then
  echo "[run-api] /api/routes OK" >&2
else
  echo "[run-api] routes endpoint not yet available (retry manually)" >&2
fi
exit 0
