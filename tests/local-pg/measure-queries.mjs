/* eslint-disable */
// Mede, na API LOCAL, quantas consultas ao Postgres cada endpoint que o app chama ao
// abrir/trocar de página faz e quanto tempo leva. Só lê (GET) — nada é gravado.
// Precisa da API subida por um dos modos de teste, que contam as consultas:
//   ./start-api.sh --harness   [--query-delay=70]   (app do servidor tradicional)
//   ./start-api.sh --serverless [--query-delay=70]  (handler da Vercel, VERCEL=1)
// Com --query-delay=N cada consulta leva +N ms: o tempo mostra quantas idas e voltas
// ao banco ficam EM SEQUÊNCIA (ex.: 70 ms ≈ Render/Oregon → Supabase/Virgínia).
// Consultas = o MENOR número entre as repetições (imune a outra aba chamando a API junto).
// /auth/me roda 1 vez só (limite de 30 chamadas por 15 min em /api/auth/*).
// Uso: node measure-queries.mjs [--reps=3] [--json]
import { API_URL, assertLocalApi, call, todaySP } from './lib.mjs';

const args = process.argv.slice(2);
const REPS = Number(args.find((a) => a.startsWith('--reps='))?.slice('--reps='.length) ?? 3);
const AS_JSON = args.includes('--json');

try {
  await assertLocalApi({ quiet: true });
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}

async function counter() {
  const res = await fetch(`${API_URL}/__harness/queries`).catch(() => null);
  if (!res?.ok) return null;
  return res.json();
}

const info = await counter();
if (!info) {
  console.error('❌ A API não expõe /__harness/queries — suba com ./start-api.sh --harness ou --serverless.');
  process.exit(1);
}

const today = todaySP();
const month = today.slice(0, 7);
const from = `${month}-01`;
const monthEnd = (() => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
})();
const accounts = (await call('GET', '/accounts')).data;
const cards = (await call('GET', '/credit-cards')).data;
const acc = accounts[0]?.id;
const card = cards[0]?.id;

/** [rótulo, caminho depois de /api, repetições] */
const ENDPOINTS = [
  ['GET /auth/me', '/auth/me', 1],
  ['GET /summary?month', `/summary?month=${month}`],
  ['GET /accounts?includeArchived=true', '/accounts?includeArchived=true'],
  ['GET /accounts', '/accounts'],
  ['GET /credit-cards?includeArchived=true', '/credit-cards?includeArchived=true'],
  ['GET /reports/sources (mês)', `/reports/sources?from=${from}&to=${monthEnd}`],
  ['GET /reports/sources (mês + conta)', acc && `/reports/sources?from=${from}&to=${monthEnd}&source=account:${acc}`],
  ['GET /budgets?month', `/budgets?month=${month}`],
  ['GET /goals', '/goals'],
  ['GET /receivables', '/receivables'],
  ['GET /transactions (mês)', `/transactions?from=${from}&to=${monthEnd}&limit=50&offset=0`],
  ['GET /transactions (conta)', acc && `/transactions?accountId=${acc}&limit=50&offset=0`],
  ['GET /transactions (cartão)', card && `/transactions?creditCardId=${card}&limit=50&offset=0`],
  ['GET /loans', '/loans'],
  ['GET /recurring', '/recurring'],
  ['GET /forecast', '/forecast'],
  ['GET /categories', '/categories'],
  ['GET /accounts/:id/statement (mês)', acc && `/accounts/${acc}/statement?from=${from}&to=${monthEnd}`],
  ['GET /achievements', '/achievements'],
].filter(([, p]) => p);

async function timed(path) {
  const before = (await counter()).queries;
  const t0 = performance.now();
  const res = await fetch(`${API_URL}/api${path}`);
  await res.arrayBuffer();
  const ms = performance.now() - t0;
  const after = (await counter()).queries;
  return { status: res.status, ms, queries: after - before };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const rows = [];
for (const [label, path, reps = REPS] of ENDPOINTS) {
  if (reps > 1) await timed(path); // aquece (pool aberto, recorrentes já lançadas)
  const runs = [];
  for (let i = 0; i < reps; i++) runs.push(await timed(path));
  const bad = runs.find((r) => r.status !== 200);
  rows.push({
    label,
    status: bad ? bad.status : 200,
    queries: Math.min(...runs.map((r) => r.queries)),
    ms: Math.round(median(runs.map((r) => r.ms))),
  });
}

if (AS_JSON) {
  console.log(JSON.stringify({ entry: info.entry, vercel: info.vercel, delayMs: info.delayMs, rows }, null, 2));
} else {
  console.log(`Modo: ${info.entry} · VERCEL=${info.vercel ?? ''} · atraso ${info.delayMs} ms/consulta · ${REPS} repetições`);
  const w = Math.max(...rows.map((r) => r.label.length));
  console.log(`${'endpoint'.padEnd(w)}  consultas  tempo (ms)`);
  for (const r of rows) {
    console.log(`${r.label.padEnd(w)}  ${String(r.queries).padStart(9)}  ${String(r.ms).padStart(10)}${r.status !== 200 ? `  ⚠️ HTTP ${r.status}` : ''}`);
  }
  console.log(`${'TOTAL'.padEnd(w)}  ${String(rows.reduce((s, r) => s + r.queries, 0)).padStart(9)}`);
}
