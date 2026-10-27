# Teste local do backend (Postgres embutido + API local)

> **NUNCA produção.** Tudo nesta pasta fala só com o Postgres embutido em
> `127.0.0.1:54329` (banco `financas_test`) e com a API local na porta `3333`.
> O `../../.env` do backend é o banco de **PRODUÇÃO**: não rode `db/migrate.js`,
> `db/query.js`, `db/seed-user.js` nem `npm run dev` com ele para testar.

Comandos com Postgres/rede rodam fora do sandbox do Claude Code.

## Primeira vez

```sh
cd tests/local-pg
npm install          # Postgres 17.10 embutido (@embedded-postgres/darwin-arm64) + pg
./start-db.sh        # cria .data/ na 1ª vez e sobe em 127.0.0.1:54329
./reset-db.sh        # banco do zero: stubs do Supabase + ../../db/schema.sql + 2 usuários
./start-api.sh       # API do backend na 3333, só com o banco local
node seed-demo.mjs   # dados de demonstração (pela API)
node e2e.mjs         # teste ponta a ponta
```

## Comandos

| Comando | O que faz |
|---|---|
| `./start-db.sh` / `./stop-db.sh` | Sobe/para o Postgres local (dados em `.data/`, log em `postgres.log`, socket na pasta). |
| `./reset-db.sh [schema.sql]` | Apaga e recria `financas_test`: `supabase-stubs.sql`, o schema (padrão `../../db/schema.sql`, via `apply.mjs`) e os usuários fixos. Grava `fixture.env`. Derruba as conexões abertas (a API reconecta sozinha). |
| `./start-api.sh` / `./stop-api.sh` | Sobe/para a API (`tsx src/server.ts`). Log em `api.log`, PIDs em `api.pid`. |
| `./start-api.sh --serverless` | Em vez do `server.ts`, serve o handler da **Vercel** (`api/index.ts` → `src/vercel.ts`) num `http.createServer` (`serve-handler.ts`), com `VERCEL=1` (pool de 3 conexões, schema conferido na 1ª requisição). O `e2e.mjs` roda igual contra ele. `--entry=/abs/…/index.js` serve um handler já compilado (ex.: a saída do `vercel build`). |
| `./start-api.sh --harness` | `createApp()` do servidor tradicional (sem o boot do `server.ts`) no mesmo `serve-handler.ts` — para medir o caminho tradicional. |
| `--query-delay=N` | (com `--serverless`/`--harness`) atrasa cada consulta ao banco em N ms — simula a distância até o Supabase (ex.: 70 = Render/Oregon → Virgínia). |
| `node measure-queries.mjs [--reps=3] [--json]` | Com a API num dos modos acima: quantas consultas ao Postgres e quanto tempo cada endpoint de abertura/troca de página leva (`/auth/me` só 1 vez, pelo limite de `/auth/*`). Só GET. |
| `node check-api.mjs` | Confere que a API na 3333 é a nossa e que o único banco dela é o `:54329`. |
| `node seed-demo.mjs [--reset]` | Demo pela API: 5 contas, 2 cartões, 3 meses de lançamentos em várias categorias (alguns sem categoria), transferências, parcelados, faturas pagas, recorrentes e 1 empréstimo (1 parcela recebida, 1 atrasada). Recusa semear em cima de dados; `--reset` reseta antes. |
| `node e2e.mjs [--only=trecho] [--no-demo]` | Reseta, monta o fixture próprio (março/2025), roda as seções e, no fim, re-semeia a demo (`--no-demo` deixa o fixture para inspecionar). |
| `node sql.mjs "<SQL>"` | SQL avulso no banco local (`--db=postgres` para o banco de manutenção). |
| `node apply.mjs arquivo.sql` | Aplica um `.sql` no banco local (mesma regra do `db/migrate.js`). |

## Usuários fixos (`fixture.env`)

- **teste** `5e1c0a3b-7d2f-4c8e-9b6a-0f1e2d3c4b5a` (`teste@financas.local`): é o
  `AUTH_DEV_BYPASS_USER_ID` da API local. Qualquer requisição, com ou sem token, age como ele.
- **outro** `9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d` (`outro@financas.local`): dono de
  dados que o de teste nunca pode ver. O e2e grava os dados dele direto no banco local.

## Travas

- `start-api.sh` sobe com `env -i` (nada do seu shell entra) e `DOTENV_CONFIG_PATH=empty.env`,
  e se recusa a subir se o backend usar dotenv com override ou de outro jeito que não
  `import 'dotenv/config'`, se a porta 3333 estiver ocupada por outro processo, ou se a
  API abrir conexão com qualquer banco que não seja `127.0.0.1:54329`.
- `seed-demo.mjs` e `e2e.mjs` rodam a mesma conferência (`assertLocalApi`) antes de escrever.

## Avisos

- A API lê o código **uma vez**. Mudou o `src/`? `./stop-api.sh && ./start-api.sh`.
- Para trocar de modo (tradicional ↔ `--serverless`/`--harness`): `./stop-api.sh` antes.
- O contador de consultas (`GET /__harness/queries`) e o atraso só existem no `serve-handler.ts`
  (servidor de teste) — nada disso está no backend.
- `reset-db.sh` e `e2e.mjs` apagam tudo do banco local (o e2e devolve a demo no fim).
- Taxas do BCB: neste Mac o `fetch` do Node para `api.bcb.gov.br` tenta IPv6 e falha (HTTP 502
  ou timeout; o `curl` funciona). Por isso o "📈 Indicadores atualizados" do boot e o
  `GET /api/cron/indicators` com `user-agent: vercel-cron/1.0` costumam dar
  `BCB_UNAVAILABLE` aqui — é a rede desta máquina, não o código (com
  `NODE_OPTIONS=--dns-result-order=ipv4first` no processo da API o BCB responde). A rota do
  cron só existe no `--serverless` (no tradicional/`--harness` dá 404); o e2e só confere os
  401/404 dela (sem rede). Em produção sem `CRON_SECRET` ela responde 503 — não dá para ver
  aqui (a API local sobe com `NODE_ENV=development`).
- `/api/auth/*` tem limite de 30 chamadas por 15 min por IP. O e2e não chama `/auth/me`;
  ao testar o frontend, carregue a página uma vez e navegue por cliques.
- Frontend: `npm run dev` do `financas-app` (porta 5186) já aponta para `http://localhost:3333`.

## Acrescentar uma seção ao e2e

Em `e2e.mjs`, copie um bloco `section('nome', async (ctx) => { ... })` para o ponto
marcado **ACRESCENTE NOVAS SEÇÕES AQUI**. O `ctx` traz as contas (`ctx.acc.A/B/C`), o
cartão (`ctx.card.K`), as categorias por nome (`ctx.cat`), os lançamentos (`ctx.t`), as
chaves de origem (`ctx.key`), os dados do outro usuário (`ctx.other`) e os gastos de
março com valor/categoria/origem (`ctx.march`) para calcular o esperado. Seção que grava
algo deve desfazer no fim ou usar datas fora de março/2025. Rode só ela com
`node e2e.mjs --only=<trecho do nome>`.
