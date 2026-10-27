# Deploy — Finanças API (MVP, custo ~zero)

## Visão geral da arquitetura

| Camada | Onde | Custo |
|---|---|---|
| Banco de dados | **Supabase** (Postgres, `us-east-1`) — já em uso | Free |
| Backend (esta API) | **Vercel** (projeto próprio, região `iad1`) — ver seção **Vercel** abaixo. O **Render** fica no ar até a Vercel ser validada (rollback) | Pro (time) / Free |
| Frontend (`financas-app`) | **Vercel** (outro projeto) | Free |

O banco **já está na nuvem** (Supabase). Não migre para Neon/MongoDB — o modelo é
relacional e já funciona.

---

## Vercel — backend serverless (recomendado: abre rápido, não hiberna)

**Por quê.** No Render grátis (Oregon) a API hiberna: a 1ª chamada levou **22 s** (medido em
26/10) e o app fica em branco esperando o `/auth/me`. Acordada, cada consulta Oregon → Supabase
(Virgínia) custa ~70 ms. Na Vercel a função não hiberna (partida a frio ~1 s) e roda em
**`iad1` (Washington, D.C.)**, vizinha do Supabase `us-east-1` — cada consulta fica em 1–2 ms.

### Como o código roda na Vercel (já feito)

| Arquivo | Papel |
|---|---|
| `api/index.ts` | A função. Só reexporta `src/vercel.ts` (a Vercel cria uma função por arquivo de `api/`). |
| `src/vercel.ts` | `createApp({ checkSchemaOnRequest: true })` — o MESMO app do Render, sem `listen`, sem `process.exit`, sem `node-cron`. Exporta o app Express em si: assim o runtime da Vercel não injeta os "helpers" dele e o Express trata `req.query`/`req.body`/multipart como no Render (não precisa de `NODEJS_HELPERS=0`). |
| `vercel.json` | `framework: null` (impede a Vercel de detectar "Express" e escolher sozinha um `src/app.ts`/`src/server.ts` como entrada), `regions: ["iad1"]`, `functions["api/index.ts"].maxDuration = 60` (o Conselheiro IA com Gemini leva 25–45 s), `rewrites` de TUDO (`/health`, `/api/*`) para a função, `crons` diário e `buildCommand: npm run typecheck` (deploy com erro de tipo falha; quem compila a função é o `@vercel/node`). `outputDirectory: public`. |
| `public/robots.txt` | Única coisa estática. Sem a pasta `public`, a Vercel serviria a RAIZ do projeto como site estático. |
| `.vercelignore` | Tira do upload `.env` (é o banco de PRODUÇÃO desta máquina!), `tests/`, `db/`, `dist/`… Padrões de pasta com `/` no começo (`/db`): sem a barra, `db` tiraria também o `src/db`. |
| `src/db/schema-check.ts` | A conferência de colunas (`REQUIRED_COLUMNS`). No Render: no boot, como sempre (sai com código 1). Na Vercel: 1ª requisição de `/api` de cada instância, memorizada; faltando coluna → **503 `SCHEMA_OUTDATED`** com a mesma mensagem ("Banco desatualizado: faltam as colunas …"). O `/health` não depende do banco. Rodou a migração? A função volta sozinha na próxima requisição, sem redeploy. |
| `src/db/pool.ts` | Com `VERCEL=1` (a Vercel define sozinha): `max` 3 conexões por instância e ociosa fecha em 10 s. Render continua com 10 / 30 s. Sem prepared statement nomeado nem `SET` de sessão: funciona com o pooler em modo sessão (5432) e transação (6543). |
| `src/modules/cron/cron.routes.ts` | `GET /api/cron/indicators` — atualiza SELIC/CDI (BCB), idempotente. Só existe na função da Vercel (no Render a rota nem é montada: lá o `node-cron` roda no processo). Só aceita a Vercel Cron: exige `Authorization: Bearer <CRON_SECRET>` (a Vercel manda sozinha). **Sem `CRON_SECRET` em produção a rota fica fechada (503 `CRON_NOT_CONFIGURED`) e as taxas não atualizam** — o `user-agent` `vercel-cron/…` qualquer um forja, então ele só vale em desenvolvimento. Agendado `0 6 * * *` (UTC) = **03:00 em Brasília**, o mesmo horário do `node-cron` do Render. |

Outras mudanças que valem nos dois provedores: CORS com `maxAge` 7200 (o navegador guarda o
preflight por 2 h em vez de fazer um `OPTIONS` antes de cada chamada) e upload do recibo
(`/transactions/scan`) limitado a **4 MB** — a Vercel recusa requisição acima de 4,5 MB; o app
reduz a foto antes de enviar. Falha passageira do Supabase Auth (sem rede, 5xx, 429) ou da busca
das chaves (JWKS) agora responde **503/429**, não 401: o app só desloga com 401 (refresh token
recusado de verdade). E cada login/cadastro/refresh usa um cliente do Supabase próprio (antes
era um só para todos: dois refresh simultâneos de pessoas diferentes recebiam a sessão da
primeira).

#### O que muda de comportamento na Vercel (atenção)

- **Webhook da Pluggy** (`POST /api/open-finance/webhook`): responde 200 na hora e importa
  depois da resposta. Na Vercel a instância pode congelar assim que a resposta sai, então a
  importação vai em `waitUntil` (`@vercel/functions`), que segura a função até ela terminar —
  **no máximo 60 s** (`maxDuration`). Uma importação maior que isso é cortada no meio; a
  seguinte (próximo webhook ou "Conectar banco" de novo) completa sem duplicar (cada transação
  entra uma vez só, por `external_id`). No Render nada muda.
- **Limite de tentativas em `/api/auth/*`** (30 a cada 15 min por IP): o contador fica na
  memória do processo. No Render vale para a API inteira; na Vercel vale **por instância** (zera
  quando a instância é reciclada, e sob ataque a Vercel sobe mais instâncias, cada uma aceitando
  mais 30). A trava de verdade lá é a regra de Rate Limiting do Firewall (passo 6).
- **Cron**: rota fechada sem `CRON_SECRET` em produção (ver tabela acima).

### Passo a passo

> Ordem: migração no banco (se a versão pedir — seções 0/0a) → API na Vercel → validar →
> trocar o `VITE_API_URL` do frontend → validar no app → só então suspender o Render.

1. **Projeto novo, separado do frontend**, no time "Elo Marketing's projects":
   ```bash
   cd /Users/guilherme/financas-api
   vercel link        # criar projeto novo "financas-api" no time; Root Directory: ./
   ```
   Framework Preset: deixe como vier — o `vercel.json` força "Other" (`framework: null`). Não
   preencha Build/Output no painel: o `vercel.json` já define.
2. **Região**: o `vercel.json` pede `iad1`. Confira em Settings → Functions → *Function Region*
   = Washington, D.C., USA (East) – iad1. Fluid compute: ligado (padrão de projeto novo).
3. **Variáveis** (Settings → Environment Variables, ambiente *Production*; ou
   `vercel env add NOME production`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | Supabase → Connect → **Transaction pooler** (porta **6543**, host `…pooler.supabase.com`) — o indicado para serverless. O Session pooler (5432) também funciona, mas cada conexão da função prende uma vaga do pool (pequeno no plano grátis) e o Render ainda estará ligado nele durante a transição. **Nunca** a conexão direta `db.<ref>.supabase.co:5432`: sem o add-on de IPv4 ela é só IPv6, e a função da Vercel não alcança IPv6 (erro de conexão em toda rota). |
   | `SUPABASE_URL` | Settings → API → Project URL (valida os tokens ES256/RS256 pelo JWKS) |
   | `SUPABASE_ANON_KEY` | Settings → API → `anon public` |
   | `SUPABASE_JWT_SECRET` | Só se ainda houver token HS256 (legado) — mesmo valor do Render |
   | `GEMINI_API_KEY` | Mesma do Render |
   | `GEMINI_MODEL` | `gemini-flash-latest` |
   | `NODE_ENV` | `production` (desliga o bypass de dev e reduz o detalhe dos erros) |
   | `CORS_ORIGIN` | Opcional: URL(s) do frontend, separadas por vírgula, sem barra no fim. Vazio = libera qualquer origem (como hoje). |
   | `CRON_SECRET` | **Obrigatório**: uma string longa aleatória (`openssl rand -hex 32`). Sem ela o cron diário recebe 503 e SELIC/CDI param de atualizar. |
   | `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` / `PLUGGY_WEBHOOK_SECRET` | Só se usar Open Finance (e aí troque também a URL do webhook na Pluggy — passo 7). |

   **Não** defina `PORT`, `AUTH_DEV_BYPASS_USER_ID` nem `VERCEL` (esta a Vercel põe sozinha).
4. **Deploy**: `vercel deploy --prod`. Pode ir direto para produção: o app continua falando com o
   Render até o passo 7, então ninguém usa a API nova antes de ela ser testada.
5. **Testar a API nova** (troque pela URL do projeto):
   ```bash
   API=https://financas-api-xxxx.vercel.app
   curl -s $API/health                                   # {"status":"ok",...}
   curl -s $API/api/indicators                           # lê o banco: confere DATABASE_URL + schema
   curl -si -X OPTIONS $API/api/summary -H 'Origin: https://SEU-FRONT' \
     -H 'Access-Control-Request-Method: GET' | grep -i access-control-max-age   # 7200
   ```
   `503 SCHEMA_OUTDATED` em `/api/*` = falta a migração (rode-a; a função volta sozinha).
   Cron (com `CRON_SECRET` já definido): Settings → Cron Jobs → `/api/cron/indicators` → *Run* → 200 nos logs
   ("📈 Indicadores atualizados").
6. **CORS e Firewall**:
   - CORS (se for fechar): `CORS_ORIGIN=https://SEU-FRONT` e redeploy (`vercel deploy --prod`).
   - Força bruta no login: projeto → **Firewall** → *Configure* → *New Rule* → se *Request Path*
     for `/api/auth/signin` ou `/api/auth/signup` → ação **Rate Limit** por IP (ex.: 30
     requisições numa janela de 10 min — ou a maior janela que o plano permitir), resposta 429.
     Sem a regra, o limite do código vale só por instância (ver acima). Não inclua
     `/api/auth/me` nem `/api/auth/refresh`: o app chama os dois a cada abertura/hora.
7. **Frontend**: no projeto do `financas-app`, troque `VITE_API_URL` para a URL da API na Vercel
   (sem barra no fim) e faça redeploy do frontend — o Vite embute a variável no build.
   **Open Finance** (só se estiver em uso): no painel da Pluggy, troque a URL do webhook para
   `<URL da Vercel>/api/open-finance/webhook` — senão, depois de suspender o Render, as
   transações novas param de chegar sem erro nenhum no app.
8. **Keepalive** (`.github/workflows/keepalive.yml`, mantém o Supabase grátis acordado): no GitHub,
   Settings → Secrets and variables → Actions → *Variables* → `API_URL` = URL da Vercel. Sem a
   variável o workflow continua usando o Render.
9. **Render**: mantenha no ar até validar o app por alguns dias (rollback = voltar o
   `VITE_API_URL` para o Render e redeploy do frontend). Depois: Render → serviço → Settings →
   **Suspend** (não apague de cara).

> **Deploy com schema desatualizado na Vercel**: diferente do Render, o deploy de produção troca
> na hora — se a migração não tiver rodado, a função nova responde 503 em `/api/*` (com a
> mensagem do que falta). Saídas: rodar a migração (volta sozinha) ou *Instant Rollback* para o
> deploy anterior no painel.

### Validar sem deploy (ambiente local, nunca o banco de produção)

Em `tests/local-pg` (README lá): `./start-api.sh --serverless` serve o handler de
`api/index.ts` num `http.createServer` com `VERCEL=1`, e o `node e2e.mjs` roda contra ele. Para
o bundle que a Vercel gera: numa CÓPIA do projeto sem `.env` (respeitando o `.vercelignore`), com
um `.vercel/project.json` fictício (sem `vercel link`), `npx vercel@63.1.2 build` gera
`.vercel/output/functions/api/index.func/`; `./start-api.sh --serverless --entry=<…>/index.func/api/index.js`
sobe esse bundle e o mesmo e2e roda contra ele.

---

## 0. Ordem OBRIGATÓRIA de deploy — versão "Empréstimo a receber"

Mesma ordem da seção abaixo: **migração primeiro, backend depois, frontend por último**. Esta
versão cria as tabelas `loans` e `loan_installments` (com grant para `authenticated`, RLS e
trigger de `updated_at`), a coluna `loan_installments.remainder_of` (diferença de uma parcela
recebida a menos que continua sendo cobrada), as colunas `transactions.loan_id` /
`transactions.loan_installment_id` e troca o CHECK de `transactions.kind` para aceitar `loan_out` e `loan_in` (aditiva e
idempotente). Toda listagem de transação lê as colunas novas: sem a migração, a API nova
**se recusa a subir** (o `src/server.ts` também confere essas colunas antes do `listen`).

---

## 0a. Ordem OBRIGATÓRIA de deploy — versão "Contas, transferências e faturas"

Esta versão do backend precisa de colunas novas no banco (`transactions.transfer_account_id`,
`transactions.invoice_month`, `accounts.updated_at`, `credit_cards.is_archived`,
`recurring_expenses.account_id` e `recurring_expenses.credit_card_id`). Siga **nesta ordem**:

1. **Migração no banco de PRODUÇÃO** — `node db/migrate.js` com o `DATABASE_URL` de produção.
   Só com a **autorização explícita do dono do projeto**. A migração é aditiva e idempotente
   (pode rodar 2x): só acrescenta colunas, índices e o trigger de `accounts.updated_at`.
2. **Push do backend** (o Render faz o redeploy). Se o passo 1 não tiver rodado, a API nova
   **se recusa a subir**: o `src/server.ts` confere as colunas antes do `listen`, escreve
   "Rode db/migrate.js antes de subir esta versão" no log e sai com código 1 — o health
   check falha e a versão antiga continua no ar.
3. **Push do frontend** (Vercel). O app novo usa as rotas novas (`/accounts`,
   `/reports/sources`, pagamento de fatura); com o backend antigo ele quebraria.

> **Aviso para quem já usa o app: o saldo pode mudar depois do deploy.** A regra de saldo
> agora é uma só (contas não arquivadas, até hoje em São Paulo):
> - **estorno no cartão não soma mais no saldo** — ele abate a fatura, não entra na conta;
> - **lançamento com data futura só conta no dia dele** (antes, despesa/receita agendada
>   já mexia no saldo de hoje);
> - compra no cartão continua fora do saldo: quem tira o dinheiro da conta é o pagamento da fatura.
>
> Para conferir: compare `summary.currentBalance` antes e depois do deploy. A diferença
> (antes − depois) tem de ser exatamente: estornos no cartão + receitas com data futura −
> despesas com data futura fora do cartão.

---

## 1. Banco de dados (Supabase) — conectar via .env

Nada muda no banco; só garanta que a API em produção recebe estas variáveis
(**no painel do provedor, nunca commitadas**):

| Variável | Onde pegar no Supabase |
|---|---|
| `DATABASE_URL` | Connect → Session pooler (porta **5432**) → troque `[YOUR-PASSWORD]` |
| `SUPABASE_URL` | Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Settings → API → Project API keys → `anon public` |
| `SUPABASE_JWT_SECRET` | Settings → API → JWT Settings → JWT Secret |

> **Free tier:** o projeto **pausa após ~7 dias sem atividade** (basta reabrir no
> painel para religar). Use o **Session pooler (5432)** — é o ideal para um
> servidor persistente como este (Render). Na **Vercel** (serverless), use o
> **Transaction pooler (6543)** — ver a seção Vercel.

---

## 2. O que mudou no código para produção (já feito)

- **Porta:** `app.listen(env.PORT)` — o provedor injeta `PORT` automaticamente. Não
  defina `PORT` manualmente no deploy.
- **CORS por allowlist:** em produção, só as origens de `CORS_ORIGIN` (CSV) são
  aceitas; em dev continua liberado. (`src/app.ts`)
- **`trust proxy`:** a API roda atrás do proxy do provedor — IP real e HTTPS corretos.
- **Rate limit:** 30 tentativas / 15 min por IP em `/api/auth/*` (anti-brute-force). Na Vercel
  esse contador é por instância — complete com a regra do Firewall (seção Vercel, passo 6).
- **`NODE_ENV=production`:** desliga automaticamente o `AUTH_DEV_BYPASS_USER_ID`
  (o atalho de dev não funciona em produção) e reduz o detalhe dos erros.

---

## 3. Deploy do backend no Render (o atual — fica até a Vercel ser validada)

**a) Suba o código para o GitHub:**
```bash
cd /Users/guilherme/financas-api
git init && git add . && git commit -m "chore: preparar deploy"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/financas-api.git
git push -u origin main
```
> O `.gitignore` já exclui `.env` e `node_modules`. Confirme que o `.env` **não** foi commitado.

**b) No Render:** New → **Blueprint** → conecte o repositório (ele lê o `render.yaml`).
Ou New → **Web Service** manual com:
- Build: `npm install --include=dev && npm run build`
- Start: `npm start`
- Health check: `/health`

**c) Preencha as variáveis** (Environment) — as 4 do Supabase acima + `NODE_ENV=production`
+ `GEMINI_API_KEY` (scan de recibos) + `GEMINI_MODEL=gemini-flash-latest`
+ `CORS_ORIGIN` (a URL do frontend; deixe em branco por ora e volte no passo 5).

**d)** Deploy. A URL final fica tipo `https://financas-api.onrender.com`.

> **Free tier do Render:** o serviço **hiberna após 15 min** sem tráfego; a primeira
> requisição depois disso demora ~50s (cold start). Para o MVP, ok.

### Alternativa: Fly.io (menor latência)
O Render free só tem regiões EUA/UE. Seu banco está em **São Paulo (sa-east-1)**.
Se a latência incomodar, o Fly.io tem região **`gru` (São Paulo)** e usa o `Dockerfile`:
```bash
brew install flyctl
fly launch --region gru        # detecta o Dockerfile; não faça deploy ainda
fly secrets set DATABASE_URL="..." SUPABASE_URL="..." SUPABASE_ANON_KEY="..." \
  SUPABASE_JWT_SECRET="..." CORS_ORIGIN="https://seu-frontend" NODE_ENV=production
fly deploy
```

---

## 4. Deploy do frontend (Vercel)

```bash
cd /Users/guilherme/financas-app
# subir para o GitHub (repo separado) e importar na Vercel, OU:
npm i -g vercel && vercel
```
Na Vercel, defina a variável de build:
- `VITE_API_URL = https://financas-api.onrender.com` (a URL do passo 3)
- (não defina `VITE_MOCK`, ou `VITE_MOCK=0`)

---

## 5. Fechar o CORS e o Supabase Auth

1. Copie a URL do frontend (ex.: `https://financas.vercel.app`).
2. No Render, ajuste `CORS_ORIGIN=https://financas.vercel.app` → o serviço redeploya.
3. No Supabase: Authentication → URL Configuration → **Site URL** = a URL do frontend
   (necessário para os links de confirmação de e-mail apontarem certo).

---

## 6. Testar produção
```bash
curl https://financas-api.onrender.com/health
# abrir o frontend, criar conta, logar, registrar um gasto
```

---

## Checklist de segurança (produção)
- [ ] `NODE_ENV=production` no backend (desliga o bypass de dev)
- [ ] `CORS_ORIGIN` = só a URL do frontend
- [ ] `.env` fora do Git (segredos só no painel do provedor)
- [ ] **Rotacionar** a senha do banco e o `SUPABASE_JWT_SECRET` (foram expostos durante o desenvolvimento)
- [ ] Rate limit ativo em `/auth` (já configurado) — na Vercel, mais a regra do Firewall (seção Vercel, passo 6)
- [ ] Na Vercel: `CRON_SECRET` definido (sem ele o cron das taxas fica fechado)
