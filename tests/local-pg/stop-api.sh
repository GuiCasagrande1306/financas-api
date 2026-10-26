#!/usr/bin/env bash
# Para a API local que o start-api.sh subiu (PIDs em api.pid). Só derruba processos
# do backend (tsx/node rodando src/server.ts) — nunca outro programa na porta 3333.
# Uso: ./stop-api.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PORT=3333
cd "$HERE"

is_backend() { ps -o command= -p "$1" 2>/dev/null | grep -qE "src/server\.ts|tsx"; }

PIDS=""
[ -f api.pid ] && PIDS="$(cat api.pid)"
# Sem api.pid: só aceita derrubar o que for o nosso backend escutando na 3333.
for p in $(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true); do
  if is_backend "$p" && ps -o command= -p "$p" | grep -q "src/server.ts"; then PIDS="$PIDS $p"; fi
done
PIDS="$(echo $PIDS | tr ' ' '\n' | sort -u | tr '\n' ' ')"

if [ -z "${PIDS// /}" ]; then
  rm -f api.pid
  echo "API local já está parada."
  exit 0
fi

for p in $PIDS; do
  if kill -0 "$p" 2>/dev/null && is_backend "$p"; then
    pkill -TERM -P "$p" 2>/dev/null || true
    kill -TERM "$p" 2>/dev/null || true
  fi
done
for _ in $(seq 1 20); do
  ALIVE=""
  for p in $PIDS; do kill -0 "$p" 2>/dev/null && ALIVE="$ALIVE $p"; done
  [ -z "$ALIVE" ] && break
  sleep 0.5
done
for p in ${ALIVE:-}; do is_backend "$p" && kill -KILL "$p" 2>/dev/null || true; done
rm -f api.pid
echo "✅ API local parada."
