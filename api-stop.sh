#!/usr/bin/env bash
set -euo pipefail
if [ -f .api.pid ]; then
  PID=$(cat .api.pid)
  if ps -p $PID >/dev/null 2>&1; then
    echo "[api-stop] Killing PID $PID" >&2
    kill $PID || true
    sleep 0.3
    if ps -p $PID >/dev/null 2>&1; then
      echo "[api-stop] SIGKILL $PID" >&2
      kill -9 $PID || true
    fi
  else
    echo "[api-stop] PID fichier présent mais process absent" >&2
  fi
  rm -f .api.pid
else
  echo "[api-stop] Aucun .api.pid" >&2
fi
# S'assurer qu'aucun listener résiduel
lsof -ti tcp:8787 | xargs -r kill -9 || true
echo "[api-stop] Port 8787 libéré" >&2
