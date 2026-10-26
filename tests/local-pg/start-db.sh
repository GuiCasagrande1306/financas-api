#!/usr/bin/env bash
# Sobe o Postgres LOCAL (embutido, @embedded-postgres/darwin-arm64) em 127.0.0.1:54329.
# Na 1ª vez cria o cluster em .data/. Socket unix na própria pasta. Idempotente.
# Uso: ./start-db.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="$HERE/node_modules/@embedded-postgres/darwin-arm64/native/bin"
DATA="$HERE/.data"
PORT=54329

if [ ! -x "$BIN/pg_ctl" ]; then
  echo "❌ Binários do Postgres não encontrados. Rode: (cd \"$HERE\" && npm install)"
  exit 1
fi

if [ ! -f "$DATA/PG_VERSION" ]; then
  echo "→ Criando o cluster do Postgres em .data/ (1ª vez)…"
  # Colação ICU en-US: mais perto do en_US.UTF-8 do Supabase do que a colação C.
  if ! "$BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 \
      --locale-provider=icu --icu-locale=en-US \
      --lc-collate=en_US.UTF-8 --lc-ctype=en_US.UTF-8 >"$HERE/initdb.log" 2>&1; then
    cat "$HERE/initdb.log"
    echo "❌ initdb falhou (log acima)."
    exit 1
  fi
fi

if "$BIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  echo "✅ Postgres local já está rodando em 127.0.0.1:$PORT"
  exit 0
fi

BUSY="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$BUSY" ]; then
  echo "❌ A porta $PORT já está em uso pelo PID $BUSY ($(ps -o command= -p "$BUSY" | cut -c1-120))."
  echo "   Pare esse processo (pode ser um Postgres de teste antigo) e rode de novo."
  exit 1
fi

"$BIN/pg_ctl" -D "$DATA" -l "$HERE/postgres.log" -w -t 30 \
  -o "-p $PORT -k '$HERE' -c listen_addresses=127.0.0.1" start >/dev/null
echo "✅ Postgres local rodando em 127.0.0.1:$PORT (dados em .data/, log em postgres.log)"
