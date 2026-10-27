/* eslint-disable */
// Servidor HTTP de TESTE que serve o backend SEM o src/server.ts (sem listen do app,
// sem cron, sem checagem de boot) — do jeito que a Vercel roda a função:
//  - HARNESS_ENTRY=vercel (padrão): o default export de ../../api/index.ts (a entrada
//    serverless da Vercel → src/vercel.ts), desembrulhando `default` como o runtime dela;
//  - HARNESS_ENTRY=app: createApp() de ../../src/app.ts (o app do servidor tradicional),
//    só para medir consultas do caminho tradicional;
//  - HARNESS_ENTRY=/caminho/absoluto/index.js: um handler já compilado (ex.: a saída do
//    `vercel build`, .vercel/output/functions/api/index.func/api/index.js).
// Sobe pelo `./start-api.sh --serverless | --harness` (env -i, só o banco local :54329;
// o --serverless põe VERCEL=1 para exercitar o caminho serverless).
//
// Só neste servidor de teste (nada disso existe no backend):
//  - conta as consultas ao Postgres (todas as do processo): GET /__harness/queries;
//  - HARNESS_QUERY_DELAY_MS=N atrasa cada consulta em N ms (simula a ida e volta até o banco).
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, '..', '..');
const PORT = Number(process.env.PORT || 3333);
const ENTRY = process.env.HARNESS_ENTRY || 'vercel';
const DELAY_MS = Number(process.env.HARNESS_QUERY_DELAY_MS || 0);

// ---- contador (e atraso opcional) de consultas — o MESMO `pg` que o backend carrega ----
const requireFromApi = createRequire(path.join(API_DIR, 'package.json'));
const pg = requireFromApi('pg');
let queries = 0;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: unknown, ...args: unknown[]) {
  queries += 1;
  if (!DELAY_MS) return originalQuery.apply(this, args);
  const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (e: unknown, r?: unknown) => void) : null;
  const run = new Promise((resolve) => setTimeout(resolve, DELAY_MS)).then(() => originalQuery.apply(this, args));
  if (cb) {
    run.then((r) => cb(null, r), (e) => cb(e));
    return undefined;
  }
  return run;
};

// ---- handler ----
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function loadHandler(): Promise<Handler> {
  if (ENTRY === 'app') {
    const mod = await import(pathToFileURL(path.join(API_DIR, 'src', 'app.ts')).href);
    const createApp = mod.createApp ?? mod.default?.createApp;
    return createApp();
  }
  const file = ENTRY === 'vercel' ? path.join(API_DIR, 'api', 'index.ts') : ENTRY;
  if (!path.isAbsolute(file)) throw new Error(`HARNESS_ENTRY inválido: ${ENTRY}`);
  let mod = await import(pathToFileURL(file).href);
  // Mesmo desembrulho do runtime da Vercel (@vercel/node): até 5 níveis de `default`.
  for (let i = 0; i < 5 && mod?.default; i++) mod = mod.default;
  if (typeof mod !== 'function') throw new Error(`${file} não exporta um handler (função).`);
  return mod as Handler;
}

const handler = await loadHandler();
const server = http.createServer((req, res) => {
  if (req.url === '/__harness/queries') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ queries, entry: ENTRY, vercel: process.env.VERCEL ?? null, delayMs: DELAY_MS }));
    return;
  }
  handler(req, res);
});
server.listen(PORT, () => {
  console.log(
    `🧪 Handler "${ENTRY}" em http://localhost:${PORT} (VERCEL=${process.env.VERCEL ?? ''} · atraso ${DELAY_MS} ms/consulta)`,
  );
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
