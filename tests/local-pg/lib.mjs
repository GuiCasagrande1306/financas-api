/* eslint-disable */
// Configuração e travas compartilhadas do ambiente de TESTE LOCAL.
// Tudo aqui fala SÓ com o Postgres embutido (127.0.0.1:54329) e com a API
// local (localhost:3333) que o start-api.sh subiu. Nunca lê o ../../.env.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const API_DIR = path.resolve(HERE, '..', '..');

export const PG_HOST = '127.0.0.1';
export const PG_PORT = 54329;
export const DB_NAME = 'financas_test';
export const API_PORT = 3333;
export const API_URL = `http://localhost:${API_PORT}`;

/** Connection string do banco local (a mesma que o start-api.sh passa ao backend). */
export const localDatabaseUrl = (db = DB_NAME) =>
  `postgresql://postgres@${PG_HOST}:${PG_PORT}/${db}?sslmode=disable`;

// Mesmo tipo de conversão do backend (src/db/pool.ts): bigint → number, date → 'YYYY-MM-DD'.
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
pg.types.setTypeParser(1082, (v) => v);

/**
 * Abre um client no Postgres LOCAL e roda `fn`. Host/porta/usuário EXPLÍCITOS:
 * nenhuma variável de ambiente (PGHOST, DATABASE_URL…) consegue desviar a conexão.
 */
export async function withLocalClient(db, fn) {
  const client = new pg.Client({
    host: PG_HOST,
    port: PG_PORT,
    user: 'postgres',
    database: db,
    ssl: false,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(
      `Não conectei no Postgres local (${PG_HOST}:${PG_PORT}/${db}): ${e.message}. Rode ./start-db.sh.`,
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Lê o fixture.env (gerado pelo reset-db.sh): ids fixos dos usuários de teste. */
export function loadFixture() {
  const file = path.join(HERE, 'fixture.env');
  if (!existsSync(file)) throw new Error('fixture.env não existe — rode ./reset-db.sh primeiro.');
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  for (const key of ['TEST_USER_ID', 'OTHER_USER_ID']) {
    if (!out[key]) throw new Error(`fixture.env sem ${key} — rode ./reset-db.sh de novo.`);
  }
  return out;
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return e.stdout ?? ''; // lsof sai com 1 quando não acha nada
  }
}

/** PIDs que escutam numa porta TCP. */
export function listenersOf(port) {
  return sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n').filter(Boolean);
}

/**
 * Conexões TCP de SAÍDA (estabelecidas) de um PID, como 'host:porta' remotos.
 * Ignora as de entrada na porta da API (clientes HTTP).
 */
export function outgoingConnections(pid) {
  const out = sh('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:ESTABLISHED', '-Fn']);
  const conns = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('n') || !line.includes('->')) continue;
    const [local, remote] = line.slice(1).split('->');
    const localPort = local.slice(local.lastIndexOf(':') + 1);
    if (localPort === String(API_PORT)) continue; // cliente falando com a API
    conns.push(remote);
  }
  return conns;
}

const portOf = (addr) => addr.slice(addr.lastIndexOf(':') + 1);
const hostOf = (addr) => addr.slice(0, addr.lastIndexOf(':')).replace(/^\[|\]$/g, '');

/**
 * TRAVA antes de qualquer escrita pela API: confere que quem responde na 3333 é a
 * API que o start-api.sh subiu (PID gravado em api.pid) e que a ÚNICA conexão de
 * banco dela é com o Postgres local :54329 (as de :443 são o robô de taxas do BCB).
 * Um backend rodando com o .env de PRODUÇÃO na 3333 é barrado aqui.
 */
export async function assertLocalApi({ quiet = false } = {}) {
  const pidFile = path.join(HERE, 'api.pid');
  if (!existsSync(pidFile)) {
    throw new Error('API local não está rodando (sem api.pid). Rode ./start-api.sh.');
  }
  const recorded = readFileSync(pidFile, 'utf8').split(/\s+/).filter(Boolean);
  const listeners = listenersOf(API_PORT);
  if (listeners.length === 0) {
    throw new Error(`Nada escutando na porta ${API_PORT}. Rode ./start-api.sh.`);
  }
  for (const pid of listeners) {
    if (!recorded.includes(pid)) {
      throw new Error(
        `O PID ${pid} na porta ${API_PORT} NÃO foi iniciado pelo start-api.sh (api.pid: ${recorded.join(' ')}). ` +
          'Pode ser um backend com o .env de PRODUÇÃO — abortando sem escrever nada.',
      );
    }
  }

  const health = await fetch(`${API_URL}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`GET ${API_URL}/health não respondeu 200.`);
  // Leitura pura (não grava nada) só para o pool abrir conexão e o lsof enxergá-la.
  await fetch(`${API_URL}/api/categories`).catch(() => null);

  const db = [];
  for (const pid of listeners) {
    for (const remote of outgoingConnections(pid)) {
      const port = portOf(remote);
      const host = hostOf(remote);
      if (port === '443') continue; // HTTPS (BCB) — não é banco
      if (port === String(PG_PORT) && ['127.0.0.1', '::1', 'localhost'].includes(host)) {
        db.push(remote);
        continue;
      }
      throw new Error(
        `A API (PID ${pid}) tem conexão com ${remote} — só ${PG_HOST}:${PG_PORT} é permitido. Abortando.`,
      );
    }
  }
  if (db.length === 0) {
    throw new Error(`A API (PID ${listeners.join(' ')}) não tem conexão com ${PG_HOST}:${PG_PORT}. Abortando.`);
  }
  if (!quiet) {
    console.log(`✅ API local conferida: PID ${listeners.join(' ')} · banco só em ${PG_HOST}:${PG_PORT} (${db.length} conexão(ões))`);
  }
  return { pids: listeners, dbConnections: db };
}

/**
 * Chamada à API local. Devolve { status, body } (body já em JSON quando dá).
 * `path` começa depois de /api (ex.: '/accounts').
 */
export async function api(method, apiPath, body) {
  const res = await fetch(`${API_URL}/api${apiPath}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

/** Como `api`, mas exige 2xx (ou o status pedido) e devolve só o body. */
export async function call(method, apiPath, body, expectStatus) {
  const r = await api(method, apiPath, body);
  const ok = expectStatus ? r.status === expectStatus : r.status >= 200 && r.status < 300;
  if (!ok) {
    throw new Error(
      `${method} ${apiPath} → ${r.status} (esperado ${expectStatus ?? '2xx'}): ${JSON.stringify(r.body)}`,
    );
  }
  return r.body;
}

/** Hoje em America/Sao_Paulo, 'YYYY-MM-DD' (mesma regra do backend). */
export function todaySP() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Soma `n` dias a 'YYYY-MM-DD'. */
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo) de 'YYYY-MM-DD'. */
export const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** 'YYYY-MM' deslocado `n` meses. */
export function addMonthsYM(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Último dia do mês 'YYYY-MM'. */
export function lastDayOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** R$ legível a partir de CENTAVOS (só para log). */
export const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
