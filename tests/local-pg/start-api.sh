#!/usr/bin/env bash
# Sobe a API do backend (../../src/server.ts, via tsx) na porta 3333 falando SÓ com
# o Postgres local. Ambiente EXPLÍCITO e LIMPO (env -i): nada do seu shell entra e o
# dotenv lê o empty.env (DOTENV_CONFIG_PATH) — o ../../.env de PRODUÇÃO nunca é lido.
#  - recusa subir se o backend carregar o dotenv de outro jeito (override, caminho próprio);
#  - recusa subir se a porta 3333 já estiver ocupada por outro processo;
#  - espera o /health e confere por lsof que a única conexão de banco é com :54329.
# O código é lido UMA vez: mudou o backend? ./stop-api.sh && ./start-api.sh
# Uso: ./start-api.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$(cd "$HERE/../.." && pwd)"
BIN="$HERE/node_modules/@embedded-postgres/darwin-arm64/native/bin"
PORT=3333
DATABASE_URL_LOCAL="postgresql://postgres@127.0.0.1:54329/financas_test?sslmode=disable"
cd "$HERE"

fail() { echo "❌ $*"; exit 1; }

# ---- pré-requisitos ---------------------------------------------------------
[ -f fixture.env ] || fail "fixture.env não existe — rode ./reset-db.sh primeiro."
TEST_USER_ID="$(sed -n 's/^TEST_USER_ID=//p' fixture.env)"
[ -n "$TEST_USER_ID" ] || fail "fixture.env sem TEST_USER_ID — rode ./reset-db.sh."
"$BIN/pg_ctl" -D "$HERE/.data" status >/dev/null 2>&1 || fail "Postgres local parado — rode ./start-db.sh."
[ -x "$API_DIR/node_modules/.bin/tsx" ] || fail "tsx não encontrado em $API_DIR/node_modules (rode npm install no backend)."

# ---- já rodando? ------------------------------------------------------------
LISTENER="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -n "$LISTENER" ]; then
  if [ -f api.pid ] && grep -qw "$LISTENER" api.pid; then
    echo "✅ API local já está rodando (PID $LISTENER)."
    node check-api.mjs
    exit 0
  fi
  fail "A porta $PORT está ocupada pelo PID $LISTENER ($(ps -o command= -p "$LISTENER" | cut -c1-140)).
   Pode ser um backend com o .env de PRODUÇÃO. Pare-o antes de subir a API local."
fi
rm -f api.pid

# ---- o backend só pode carregar o dotenv por "import 'dotenv/config'" sem override --------
OTHER_DOTENV="$(grep -rnE "dotenv" "$API_DIR/src" | grep -vE ":[[:space:]]*import 'dotenv/config';?[[:space:]]*$" || true)"
[ -z "$OTHER_DOTENV" ] || fail "O backend carrega o dotenv de um jeito que o DOTENV_CONFIG_PATH pode não cobrir:
$OTHER_DOTENV
   Confira antes (risco de ler o .env de PRODUÇÃO). Nada foi iniciado."
OVERRIDE="$(grep -rnE "override[[:space:]]*:[[:space:]]*true|DOTENV_CONFIG_OVERRIDE" "$API_DIR/src" || true)"
[ -z "$OVERRIDE" ] || fail "O backend usa dotenv com override (o .env sobrescreveria o ambiente):
$OVERRIDE
   Nada foi iniciado."
if grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' empty.env; then
  fail "empty.env tem variáveis — ele precisa ficar vazio."
fi

# ---- sobe com ambiente limpo e explícito -------------------------------------
cd "$API_DIR"
nohup env -i \
  PATH="$PATH" HOME="$HOME" \
  NODE_ENV=development \
  PORT="$PORT" \
  DATABASE_URL="$DATABASE_URL_LOCAL" \
  AUTH_DEV_BYPASS_USER_ID="$TEST_USER_ID" \
  DOTENV_CONFIG_PATH="$HERE/empty.env" \
  SUPABASE_URL= SUPABASE_ANON_KEY= CORS_ORIGIN= \
  GEMINI_API_KEY= GEMINI_MODEL= \
  PLUGGY_CLIENT_ID= PLUGGY_CLIENT_SECRET= PLUGGY_WEBHOOK_SECRET= \
  "$API_DIR/node_modules/.bin/tsx" src/server.ts >"$HERE/api.log" 2>&1 &
LAUNCHER=$!
cd "$HERE"

# ---- espera o /health (até 40 s) ---------------------------------------------
for _ in $(seq 1 80); do
  if ! kill -0 "$LAUNCHER" 2>/dev/null; then
    tail -30 api.log
    fail "A API morreu ao subir (log acima, completo em api.log)."
  fi
  if curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -fsS "http://localhost:$PORT/health" >/dev/null 2>&1 || { tail -30 api.log; kill "$LAUNCHER" 2>/dev/null || true; fail "A API não respondeu /health em 40 s."; }

LISTENER="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
echo "$LAUNCHER $LISTENER" > api.pid

# O dotenv tem de ter lido o empty.env (0 variáveis) — nunca um .env.
if grep -qE "injecting env \([1-9]|from \.env([^.a-z]|$)" api.log; then
  grep -E "injecting env" api.log
  ./stop-api.sh >/dev/null
  fail "O dotenv carregou variáveis de um .env — API derrubada."
fi

# ---- trava final: a única conexão de banco é com 127.0.0.1:54329 ------------------
if ! node check-api.mjs; then
  ./stop-api.sh >/dev/null
  fail "Conferência da conexão falhou — API derrubada."
fi
echo "✅ API local em http://localhost:$PORT (PID $LISTENER · usuário $TEST_USER_ID · log em api.log)"
