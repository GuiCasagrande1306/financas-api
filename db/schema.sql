-- ============================================================================
--  FINANÇAS API — Schema completo (PostgreSQL / Supabase)
--  Rode no Supabase Dashboard → SQL Editor. Idempotente o suficiente para dev.
--  Valores monetários SEMPRE em CENTAVOS (bigint). Nunca use float para dinheiro.
-- ============================================================================

create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Trigger utilitário: mantém updated_at sempre atual.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ===========================================================================
-- PROFILES (estende auth.users do Supabase)
-- ===========================================================================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text,
  currency     char(3)     not null default 'BRL',
  locale       text        not null default 'pt-BR',
  avatar_url   text,
  onboarded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated on public.profiles;
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- CATEGORIES (user_id NULL = categoria padrão do sistema)
-- ===========================================================================
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete cascade,
  name        text        not null,
  icon        text        not null default 'circle',
  color       text        not null default '#6366f1',
  kind        text        not null default 'expense'
                check (kind in ('expense', 'income')),
  parent_id   uuid references public.categories(id) on delete set null,
  sort_order  int         not null default 0,
  is_archived boolean     not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_categories_user on public.categories(user_id);
-- Garante que o seed de categorias do sistema (user_id NULL) seja idempotente:
-- sem isto, o `insert ... on conflict do nothing` re-duplica a cada migração.
create unique index if not exists uniq_system_category
  on public.categories (name, kind) where user_id is null;

-- ===========================================================================
-- ACCOUNTS (carteira, conta, cartão — de onde o dinheiro sai/entra)
-- ===========================================================================
create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  type            text not null default 'checking'
                    check (type in ('checking', 'savings', 'credit_card', 'cash', 'wallet')),
  icon            text not null default 'wallet',
  color           text not null default '#10b981',
  initial_balance bigint not null default 0,        -- CENTAVOS
  is_archived     boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists idx_accounts_user on public.accounts(user_id);

-- ===========================================================================
-- TRANSACTIONS (o coração do app)
-- ===========================================================================
create table if not exists public.transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  account_id          uuid not null references public.accounts(id) on delete restrict,
  category_id         uuid references public.categories(id) on delete set null,
  amount              bigint not null check (amount > 0),  -- CENTAVOS, sempre positivo
  kind                text not null default 'expense'
                        check (kind in ('expense', 'income', 'transfer')),
  description         text,
  merchant            text,
  occurred_at         date not null default current_date,
  receipt_url         text,
  is_auto_categorized boolean not null default false,
  notes               text,
  deleted_at          timestamptz,                          -- soft delete
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_tx_user_date  on public.transactions(user_id, occurred_at desc);
create index if not exists idx_tx_user_cat   on public.transactions(user_id, category_id);
create index if not exists idx_tx_merchant   on public.transactions(merchant);

drop trigger if exists trg_tx_updated on public.transactions;
create trigger trg_tx_updated before update on public.transactions
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- BUDGETS (orçamento por categoria/período)
-- ===========================================================================
create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  amount      bigint not null check (amount >= 0),  -- teto em CENTAVOS
  period      text not null default 'monthly'
                check (period in ('weekly', 'monthly', 'yearly')),
  start_date  date not null default date_trunc('month', current_date),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (user_id, category_id, period, start_date)
);
create index if not exists idx_budgets_user on public.budgets(user_id);

-- ===========================================================================
-- MERCHANT RULES (motor de categorização automática que aprende com o uso)
-- ===========================================================================
create table if not exists public.merchant_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  merchant    text not null,
  category_id uuid not null references public.categories(id) on delete cascade,
  hit_count   int not null default 1,
  created_at  timestamptz not null default now(),
  unique (user_id, merchant)
);

-- ===========================================================================
-- INVESTMENTS (carteira de patrimônio: renda fixa, FIIs, ações, cripto...)
-- Valores em CENTAVOS. `asset_type` é o tipo concreto do ativo; a classe
-- (renda fixa/variável) é derivada dele na API (investments.service.ts).
-- ===========================================================================
create table if not exists public.investments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  name                 text   not null,                       -- ex.: "Tesouro Selic 2029"
  asset_type           text   not null default 'outros'
                         check (asset_type in (
                           'tesouro_direto','cdb','lci_lca','poupanca',
                           'fii','acoes','fundo','cripto',
                           'previdencia','outros'
                         )),
  invested_amount      bigint not null default 0 check (invested_amount >= 0), -- custo de aquisição (CENTAVOS)
  current_amount       bigint not null default 0 check (current_amount >= 0),  -- valor de mercado hoje (CENTAVOS)
  expected_annual_rate numeric(6,2) not null default 0,       -- rendimento esperado % a.a. (ex.: 12.50)
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_investments_user on public.investments(user_id);

drop trigger if exists trg_investments_updated on public.investments;
create trigger trg_investments_updated before update on public.investments
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- SEED: categorias padrão do sistema (user_id NULL, visíveis a todos)
-- ===========================================================================
insert into public.categories (user_id, name, icon, color, kind, sort_order) values
  (null, 'Moradia',       'home',          '#6366f1', 'expense', 1),
  (null, 'Alimentação',   'utensils',      '#f59e0b', 'expense', 2),
  (null, 'Transporte',    'car',           '#3b82f6', 'expense', 3),
  (null, 'Lazer',         'party-popper',  '#ec4899', 'expense', 4),
  (null, 'Saúde',         'heart-pulse',   '#ef4444', 'expense', 5),
  (null, 'Educação',      'graduation-cap','#8b5cf6', 'expense', 6),
  (null, 'Compras',       'shopping-bag',  '#14b8a6', 'expense', 7),
  (null, 'Contas',        'file-text',     '#64748b', 'expense', 8),
  (null, 'Assinaturas',   'repeat',        '#a855f7', 'expense', 9),
  (null, 'Salário',       'wallet',        '#10b981', 'income',  10),
  (null, 'Investimentos', 'trending-up',   '#22c55e', 'income',  11),
  (null, 'Outros',        'circle',        '#9ca3af', 'expense', 99)
on conflict do nothing;

-- ===========================================================================
-- ROW LEVEL SECURITY
-- O backend Express conecta direto no Postgres (role postgres) e BYPASSA a RLS,
-- fazendo o escopo por user_id na própria query. A RLS abaixo protege o caso em
-- que o frontend fala DIRETO com o Supabase (supabase-js) usando o JWT do user.
-- ===========================================================================
alter table public.profiles     enable row level security;
alter table public.categories   enable row level security;
alter table public.accounts     enable row level security;
alter table public.transactions enable row level security;
alter table public.budgets      enable row level security;
alter table public.merchant_rules enable row level security;
alter table public.investments  enable row level security;

-- profiles: cada um enxerga/edita só a si mesmo
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  using (id = auth.uid()) with check (id = auth.uid());

-- categories: leitura das próprias + do sistema; escrita só das próprias
drop policy if exists "read categories" on public.categories;
create policy "read categories" on public.categories
  for select using (user_id = auth.uid() or user_id is null);

drop policy if exists "write own categories" on public.categories;
create policy "write own categories" on public.categories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- accounts / transactions / budgets / merchant_rules: dono total
drop policy if exists "own accounts" on public.accounts;
create policy "own accounts" on public.accounts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own transactions" on public.transactions;
create policy "own transactions" on public.transactions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own budgets" on public.budgets;
create policy "own budgets" on public.budgets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own merchant_rules" on public.merchant_rules;
create policy "own merchant_rules" on public.merchant_rules
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own investments" on public.investments;
create policy "own investments" on public.investments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===========================================================================
-- Cria o profile automaticamente quando um usuário se cadastra no Supabase Auth.
-- ===========================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
