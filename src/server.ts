import { createApp } from './app';
import { env } from './env';
import { pool } from './db/pool';
import { startIndicatorsScheduler } from './lib/scheduler';

/**
 * Colunas que ESTA versão do código exige no banco (migração de contas,
 * transferências e faturas — db/schema.sql). Ordem de deploy obrigatória:
 * migração primeiro, código depois (DEPLOY.md).
 */
const REQUIRED_COLUMNS: [table: string, column: string][] = [
  ['transactions', 'transfer_account_id'],
  ['transactions', 'invoice_month'],
  ['accounts', 'updated_at'],
  ['credit_cards', 'is_archived'],
  ['recurring_expenses', 'account_id'],
  ['recurring_expenses', 'credit_card_id'],
];

/**
 * Recusa subir com o banco sem a migração (fail-fast): o processo sai com
 * código 1 ANTES do listen, o health check do Render falha e a versão antiga
 * continua no ar — em vez de a nova responder 500 em toda rota de dinheiro.
 */
async function assertSchemaUpToDate(): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...new Set(REQUIRED_COLUMNS.map(([table]) => table))]],
  );
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const missing = REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((col) => !present.has(col));
  if (missing.length > 0) {
    console.error(
      `❌ Banco desatualizado: faltam as colunas ${missing.join(', ')}. ` +
        'Rode db/migrate.js antes de subir esta versão (ordem em DEPLOY.md).',
    );
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
