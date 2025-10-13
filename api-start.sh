#!/usr/bin/env bash
set -euo pipefail
PORT=${PORT:-8787}
LOG=server-live.log
if [ -f .api.pid ]; then
  if ps -p $(cat .api.pid) >/dev/null 2>&1; then
    echo "[api-start] Un process tourne déjà (PID $(cat .api.pid)). Utilisez ./api-stop.sh d'abord." >&2
    exit 1
  else
    rm -f .api.pid
  fi
fi
lsof -ti tcp:$PORT | xargs -r kill -9 || true
echo "[api-start] Node $(node -v)" >&2
echo "[api-start] Environnement clé:" >&2
env | grep -E 'RPC_URL|ZERO_DEV|PIMLICO|DELEGATE|NO_API' || true
( npx tsx src/index.ts 2>&1 | sed -u 's/^/[api] /' | tee -a "$LOG" ) &
PID=$!
echo $PID > .api.pid
echo "[api-start] PID=$PID" >&2
sleep 1
if curl -fsS http://127.0.0.1:$PORT/api/health >/dev/null 2>&1; then
  echo "[api-start] /api/health OK" >&2
else
  echo "[api-start] /api/health indisponible (peut encore démarrer)" >&2
fi
