import { createApp } from './app';
import { env } from './env';
import { pool } from './db/pool';
import { findMissingColumns, schemaOutdatedMessage } from './db/schema-check';
import { startIndicatorsScheduler } from './lib/scheduler';

/**
 * Servidor TRADICIONAL (Render, Docker, harness local): listen + cron das taxas.
 * Na Vercel a entrada é outra (src/vercel.ts, via api/index.ts) — sem listen,
 * sem process.exit e com o schema conferido na 1ª requisição.
 */

/**
 * Recusa subir com o banco sem a migração (fail-fast): o processo sai com
 * código 1 ANTES do listen, o health check do Render falha e a versão antiga
 * continua no ar — em vez de a nova responder 500 em toda rota de dinheiro.
 */
async function assertSchemaUpToDate(): Promise<void> {
  const missing = await findMissingColumns();
  if (missing.length > 0) {
    console.error(`❌ ${schemaOutdatedMessage(missing)}`);
    process.exit(1);
  }
}

async function main() {
  // Valida a conexão com o banco antes de aceitar tráfego (fail-fast).
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado ao Postgres');
  } catch (err) {
    console.error('❌ Falha ao conectar no Postgres:', err);
    process.exit(1);
  }

  // Valida que a migração desta versão já rodou (senão, não sobe).
  try {
    await assertSchemaUpToDate();
  } catch (err) {
    console.error('❌ Falha ao conferir o schema do banco:', err);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`🚀 API de finanças rodando em http://localhost:${env.PORT}`);
  });

  // Robô das taxas do BCB (atualiza no boot + agenda 03:00).
  startIndicatorsScheduler();

  // Encerramento gracioso: para de aceitar conexões e fecha o pool.
  const shutdown = (signal: string) => {
    console.log(`\n${signal} recebido, encerrando...`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
