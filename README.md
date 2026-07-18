# Finanças API

Backend de finanças pessoais: **CRUD de transações**, **CRUD de categorias** e
**Resumo Financeiro** (receitas, despesas, saldo atual e gasto por categoria no mês).

Stack: **Node + Express + TypeScript**, **PostgreSQL (Supabase)** via `pg`,
validação com **Zod** e autenticação por **JWT do Supabase Auth**.

> 💰 Todos os valores monetários trafegam em **CENTAVOS** (inteiro). Ex.: R$ 45,50 → `4550`.
> O que define entrada/saída é o campo `kind`, nunca o sinal do valor.

---

## Estrutura

```
financas-api/
├── db/
│   └── schema.sql            # DDL completo + seed de categorias + RLS (rode no Supabase)
├── src/
│   ├── server.ts             # bootstrap (valida DB, sobe HTTP, shutdown gracioso)
│   ├── app.ts                # montagem do Express (helmet, cors, json, rotas)
│   ├── routes.ts             # agrega os módulos sob /api (com auth)
│   ├── env.ts                # validação das variáveis de ambiente (fail-fast)
│   ├── db/pool.ts            # pool do Postgres + type parsers (bigint/date)
│   ├── lib/                  # AppError, asyncHandler
│   ├── middlewares/          # auth (JWT), validate (Zod), error (handler central)
│   └── modules/
│       ├── transactions/     # CRUD de transações
│       ├── categories/       # CRUD de categorias
│       └── summary/          # resumo financeiro do mês
└── .env.example
```

Padrão por módulo: `*.routes.ts` (HTTP) → `*.service.ts` (regra + SQL) → `*.schema.ts` (Zod).

---

## Setup

1. **Banco**: no Supabase, abra **SQL Editor** e rode `db/schema.sql`.
2. **Env**: `cp .env.example .env` e preencha `DATABASE_URL` e `SUPABASE_JWT_SECRET`
   (Dashboard → Project Settings → Database / API).
3. **Instalar e rodar**:
   ```bash
   npm install
   npm run dev        # http://localhost:3333
   ```

### Testando sem gerar JWT (dev)

Crie um usuário no Supabase Auth, copie o `id` (UUID) e coloque em
`AUTH_DEV_BYPASS_USER_ID` no `.env`. Com `NODE_ENV=development`, a API usa esse
usuário e dispensa o header `Authorization`. **Deixe vazio em produção.**

Em produção, envie o token do Supabase: `Authorization: Bearer <access_token>`.

---

## Endpoints (prefixo `/api`)

| Método | Rota                     | Descrição                                  |
|-------:|--------------------------|--------------------------------------------|
| GET    | `/health`                | Healthcheck (sem auth)                     |
| POST   | `/auth/signup`           | Cadastro — cria usuário (bcrypt via Supabase). **Público** |
| POST   | `/auth/signin`           | Login — retorna `session.accessToken` (JWT). **Público** |
| POST   | `/auth/refresh`          | Renova a sessão a partir do `refreshToken`. **Público** |
| GET    | `/auth/me`               | Usuário logado (id, nome, e-mail). **Protegido** |
| POST   | `/transactions`          | Cria entrada/saída                         |
| POST   | `/transactions/scan`     | **Foto de recibo → gasto** (multipart `image`); extrai title/amount/date/category via IA |
| GET    | `/transactions`          | Lista (`kind`, `categoryId`, `from`, `to`, `limit`, `offset`) |
| GET    | `/transactions/:id`      | Detalha uma transação                      |
| PATCH  | `/transactions/:id`      | Atualiza campos parciais                   |
| DELETE | `/transactions/:id`      | Remove (soft delete)                       |
| GET    | `/categories`            | Lista categorias do sistema + do usuário   |
| POST   | `/categories`            | Cria categoria                             |
| GET    | `/categories/:id`        | Detalha                                    |
| PATCH  | `/categories/:id`        | Atualiza (só as próprias)                  |
| DELETE | `/categories/:id`        | Remove (só as próprias)                    |
| GET    | `/summary?month=YYYY-MM` | Resumo do mês (default: mês atual)         |
| GET    | `/budgets?month=YYYY-MM` | Orçamentos + gasto do mês + status do alerta (ok/warning/danger) |
| POST   | `/budgets`               | Define/atualiza o teto mensal de uma categoria |
| DELETE | `/budgets/:id`           | Remove um orçamento                        |

### Exemplos

```bash
# Criar uma saída de R$ 45,50 em Alimentação
curl -X POST http://localhost:3333/api/transactions \
  -H "Content-Type: application/json" \
  -d '{ "amount": 4550, "kind": "expense", "merchant": "iFood", "description": "Almoço" }'

# Resumo do mês atual
curl http://localhost:3333/api/summary

# Cadastro e login
curl -X POST http://localhost:3333/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{ "name": "Ana", "email": "ana@exemplo.com", "password": "senhaForte123" }'

curl -X POST http://localhost:3333/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{ "email": "ana@exemplo.com", "password": "senhaForte123" }'
# → { "user": {...}, "session": { "accessToken": "<JWT>", ... } }

# Usar o token nas rotas protegidas
curl http://localhost:3333/api/summary \
  -H "Authorization: Bearer <JWT>"

# Escanear um recibo (foto → dados do gasto)
curl -X POST http://localhost:3333/api/transactions/scan \
  -H "Authorization: Bearer <JWT>" \
  -F "image=@recibo.jpg"
# → { "title": "...", "amount": 4590, "date": "2026-07-15", "category": "Alimentação", "categoryId": "..." }
```

> 📸 **Scan de recibo:** manda a foto (`multipart/form-data`, campo `image`, até 5MB)
> para o **Google Gemini** (visão, free tier), que devolve um JSON estruturado via
> `responseSchema`. `amount` vem em **centavos**; `categoryId` já resolvido para as
> categorias do usuário. Requer `GEMINI_API_KEY` (grátis). **422** se ilegível.

> 🔐 **Autenticação:** o cadastro/login são delegados ao **Supabase Auth** — a senha
> é hasheada com bcrypt e o JWT é assinado pelo Supabase; nós nunca guardamos nem
> retornamos a senha. O [middleware auth.ts](src/middlewares/auth.ts) valida o token
> em toda rota privada. Em dev, `AUTH_DEV_BYPASS_USER_ID` pula o token (só com
> `NODE_ENV=development`) — deixe vazio para exigir login de verdade.

Resposta de `/api/summary` (valores em centavos):

```json
{
  "month": "2026-07",
  "currency": "BRL",
  "currentBalance": 812350,
  "income": 950000,
  "expense": 137650,
  "net": 812350,
  "byCategory": [
    { "categoryId": "…", "name": "Moradia", "color": "#6366f1", "icon": "home", "total": 90000, "percentage": 65.38 },
    { "categoryId": "…", "name": "Alimentação", "color": "#f59e0b", "icon": "utensils", "total": 47650, "percentage": 34.62 }
  ]
}
```

---

## Boas práticas aplicadas

- **Erros centralizados**: `AppError` + `errorHandler` traduzem regra de negócio e
  códigos do Postgres (23505, 23503, …) em respostas JSON consistentes.
- **Validação na borda**: todo body/query/params passa por Zod antes do handler.
- **SQL parametrizado**: sempre `$1, $2, …` (nunca interpolação) → sem SQL injection.
- **Escopo por usuário**: como o backend bypassa a RLS, **toda** query filtra por
  `user_id`. A RLS do `schema.sql` protege o acesso direto do frontend.
- **Dinheiro em centavos** (bigint), **soft delete** e `updated_at` por trigger.
