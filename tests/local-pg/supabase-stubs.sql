-- ============================================================================
--  Stubs do Supabase para o Postgres LOCAL de teste (nunca rode em produção).
--  O db/schema.sql do backend supõe o que o Supabase já traz pronto: o schema
--  `auth` com auth.users, a função auth.uid() (usada nas policies de RLS) e os
--  roles anon/authenticated/service_role (usados nos GRANTs). Aqui vai o mínimo
--  para o schema aplicar igual, com as colunas que o trigger handle_new_user e o
--  /auth/me leem (id, email, raw_user_meta_data, created_at).
-- ============================================================================

create extension if not exists "pgcrypto";

-- Roles são do cluster (sobrevivem ao drop do banco): cria só se faltarem.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  instance_id            uuid,
  id                     uuid primary key,
  aud                    varchar(255),
  role                   varchar(255),
  email                  varchar(255),
  encrypted_password     varchar(255),
  email_confirmed_at     timestamptz,
  raw_app_meta_data      jsonb,
  raw_user_meta_data     jsonb,
  confirmation_token     varchar(255),
  recovery_token         varchar(255),
  email_change_token_new varchar(255),
  email_change           varchar(255),
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- Igual ao Supabase: o `sub` do JWT da requisição (vazio fora do PostgREST).
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
