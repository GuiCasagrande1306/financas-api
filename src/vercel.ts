import { createApp } from './app';

/**
 * Entrada SERVERLESS (Vercel). O arquivo api/index.ts só reexporta este app — a
 * Vercel transforma cada arquivo de api/ numa função e o vercel.json manda TODAS
 * as rotas (/health, /api/*) para ela.
 *
 * Diferenças para o src/server.ts (servidor tradicional, que continua igual):
 *  - sem listen e sem process.exit: a Vercel chama o app a cada requisição;
 *  - o schema do banco é conferido na 1ª requisição de cada instância (memorizado;
 *    faltando coluna → 503 com a mesma mensagem do boot tradicional);
 *  - o robô das taxas do BCB não roda aqui: é o Vercel Cron diário que chama
 *    GET /api/cron/indicators (vercel.json → crons);
 *  - pool pequeno por instância (src/db/pool.ts, quando VERCEL=1).
 *
 * Exportar o app Express EM SI (e não `(req, res) => app(req, res)`): como ele tem
 * `.listen`, o runtime da Vercel não injeta os "helpers" dela (req.query/req.body
 * próprios, res.json etc.) — o Express trata a requisição exatamente como no Render.
 */
const app = createApp({ checkSchemaOnRequest: true });

export default app;
