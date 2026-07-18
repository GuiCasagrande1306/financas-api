import { createApp } from './app';
import { env } from './env';
import { pool } from './db/pool';

async function main() {
  // Valida a conexão com o banco antes de aceitar tráfego (fail-fast).
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado ao Postgres');
  } catch (err) {
    console.error('❌ Falha ao conectar no Postgres:', err);
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`🚀 API de finanças rodando em http://localhost:${env.PORT}`);
  });

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
