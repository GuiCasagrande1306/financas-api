# Deploy — Finanças API (MVP, custo ~zero)

## Visão geral da arquitetura

| Camada | Onde | Custo |
|---|---|---|
| Banco de dados | **Supabase** (Postgres) — já em uso | Free |
| Backend (esta API) | **Render** (ou Fly.io) | Free |
| Frontend (`financas-app`) | **Vercel / Netlify / Cloudflare Pages** | Free |

O banco **já está na nuvem** (Supabase). Não migre para Neon/MongoDB — o modelo é
relacional e já funciona.

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
> servidor persistente como este.

---

## 2. O que mudou no código para produção (já feito)

- **Porta:** `app.listen(env.PORT)` — o provedor injeta `PORT` automaticamente. Não
  defina `PORT` manualmente no deploy.
- **CORS por allowlist:** em produção, só as origens de `CORS_ORIGIN` (CSV) são
  aceitas; em dev continua liberado. (`src/app.ts`)
- **`trust proxy`:** a API roda atrás do proxy do provedor — IP real e HTTPS corretos.
- **Rate limit:** 30 tentativas / 15 min por IP em `/api/auth/*` (anti-brute-force).
- **`NODE_ENV=production`:** desliga automaticamente o `AUTH_DEV_BYPASS_USER_ID`
  (o atalho de dev não funciona em produção) e reduz o detalhe dos erros.

---

## 3. Deploy do backend no Render (recomendado)

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
- [ ] Rate limit ativo em `/auth` (já configurado)
