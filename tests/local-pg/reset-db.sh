#!/usr/bin/env bash
# Recria o banco LOCAL financas_test do zero (127.0.0.1:54329 — nunca produção):
#  1. drop/create do banco (derruba conexões abertas, inclusive as da API local);
#  2. stubs do Supabase (supabase-stubs.sql: schema auth, auth.users, auth.uid(), roles);
#  3. schema do backend via apply.mjs (núcleo numa chamada; trigger em auth.users best-effort);
#  4. 2 usuários fixos em auth.users + profile: o de TESTE (o da API local) e o OUTRO
#     (dono de dados que o de teste nunca pode ver);
#  5. grava os ids em fixture.env.
# Uso: ./reset-db.sh [caminho/do/schema.sql]   (padrão: ../../db/schema.sql)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCHEMA="${1:-$HERE/../../db/schema.sql}"
if [ ! -f "$SCHEMA" ]; then
  echo "❌ Schema não encontrado: $SCHEMA"
  exit 1
fi
SCHEMA="$(cd "$(dirname "$SCHEMA")" && pwd)/$(basename "$SCHEMA")"
cd "$HERE"

# Ids FIXOS (o start-api.sh usa o de teste como AUTH_DEV_BYPASS_USER_ID).
TEST_USER_ID="5e1c0a3b-7d2f-4c8e-9b6a-0f1e2d3c4b5a"
TEST_USER_EMAIL="teste@financas.local"
TEST_USER_NAME="Usuário Teste Local"
OTHER_USER_ID="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
OTHER_USER_EMAIL="outro@financas.local"
OTHER_USER_NAME="Outro Usuário"

./start-db.sh

node sql.mjs --db=postgres "drop database if exists financas_test with (force)" >/dev/null
node sql.mjs --db=postgres "create database financas_test" >/dev/null
echo "✅ Banco financas_test recriado"

node apply.mjs supabase-stubs.sql
node apply.mjs "$SCHEMA"

node sql.mjs "
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    ('00000000-0000-0000-0000-000000000000', '$TEST_USER_ID', 'authenticated', 'authenticated',
     '$TEST_USER_EMAIL', crypt('teste-local', gen_salt('bf')), now(),
     '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{\"full_name\":\"$TEST_USER_NAME\"}',
     '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '$OTHER_USER_ID', 'authenticated', 'authenticated',
     '$OTHER_USER_EMAIL', crypt('outro-local', gen_salt('bf')), now(),
     '{\"provider\":\"email\",\"providers\":[\"email\"]}', '{\"full_name\":\"$OTHER_USER_NAME\"}',
     '', '', '', '');
  -- rede de segurança: profile mesmo se o trigger não tiver sido aplicado
  insert into public.profiles (id, full_name) values
    ('$TEST_USER_ID', '$TEST_USER_NAME'),
    ('$OTHER_USER_ID', '$OTHER_USER_NAME')
  on conflict (id) do nothing;
" >/dev/null

cat > fixture.env <<FIXTURE
# Gerado por reset-db.sh — ids FIXOS do ambiente local (nunca existem em produção).
TEST_USER_ID=$TEST_USER_ID
TEST_USER_EMAIL=$TEST_USER_EMAIL
OTHER_USER_ID=$OTHER_USER_ID
OTHER_USER_EMAIL=$OTHER_USER_EMAIL
DATABASE_URL=postgresql://postgres@127.0.0.1:54329/financas_test?sslmode=disable
API_URL=http://localhost:3333
FIXTURE

node sql.mjs "
  select (select count(*)::int from information_schema.tables where table_schema = 'public') as tabelas,
         (select count(*)::int from public.categories) as categorias_sistema,
         (select count(*)::int from public.profiles) as profiles,
         (select count(*)::int from pg_trigger where tgname = 'on_auth_user_created') as trigger_auth
" | tr -d '\n[]{} ' | sed 's/,/ · /g; s/"//g; s/^/✅ /'
echo
echo "✅ Usuários: teste=$TEST_USER_ID · outro=$OTHER_USER_ID (fixture.env)"
