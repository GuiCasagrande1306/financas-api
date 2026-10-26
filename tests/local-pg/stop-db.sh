#!/usr/bin/env bash
# Para o Postgres LOCAL (127.0.0.1:54329). Os dados ficam em .data/ (o próximo
# ./start-db.sh sobe com eles; ./reset-db.sh recria o banco do zero).
# Uso: ./stop-db.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/node_modules/@embedded-postgres/darwin-arm64/native/bin"
DATA="$HERE/.data"

if [ ! -x "$BIN/pg_ctl" ] || [ ! -f "$DATA/PG_VERSION" ]; then
  echo "Nada a parar (cluster ainda não foi criado)."
  exit 0
fi
if ! "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  echo "Postgres local já está parado."
  exit 0
fi
"$BIN/pg_ctl" -D "$DATA" -m fast -w -t 30 stop >/dev/null
echo "✅ Postgres local parado."
