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
