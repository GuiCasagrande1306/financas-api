import type { RequestHandler } from 'express';
import { pool } from './pool';
import { AppError } from '../lib/AppError';

/**
 * Colunas que ESTA versão do código exige no banco (migrações de contas,
 * transferências e faturas e de empréstimos a receber — db/schema.sql). Ordem de
 * deploy obrigatória: migração primeiro, código depois (DEPLOY.md).
 * Toda listagem de transação lê loan_id/loan_installment_id (txColumns).
 */
const REQUIRED_COLUMNS: [table: string, column: string][] = [
  ['transactions', 'transfer_account_id'],
  ['transactions', 'invoice_month'],
  ['accounts', 'updated_at'],
  ['credit_cards', 'is_archived'],
  ['recurring_expenses', 'account_id'],
  ['recurring_expenses', 'credit_card_id'],
  ['transactions', 'loan_id'],
  ['transactions', 'loan_installment_id'],
  ['loans', 'id'],
  ['loan_installments', 'id'],
  ['loan_installments', 'remainder_of'],
];

/** Colunas exigidas que faltam no banco, como 'tabela.coluna' (vazio = em dia). Uma consulta. */
export async function findMissingColumns(): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...new Set(REQUIRED_COLUMNS.map(([table]) => table))]],
  );
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  return REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`).filter((col) => !present.has(col));
}

/** A mesma mensagem no log do servidor tradicional e no 503 da função serverless. */
export function schemaOutdatedMessage(missing: string[]): string {
  return (
    `Banco desatualizado: faltam as colunas ${missing.join(', ')}. ` +
    'Rode db/migrate.js antes de subir esta versão (ordem em DEPLOY.md).'
  );
}

// Promessa memorizada por instância. Só o SUCESSO fica guardado: banco fora do ar
// ou migração faltando → a próxima requisição confere de novo (a migração pode ter
// rodado nesse meio-tempo, sem precisar reiniciar a função).
let schemaReady: Promise<void> | null = null;

/**
 * Serverless: confere o schema UMA vez por instância, na 1ª requisição (a função
 * não tem "boot" para recusar subir como o src/server.ts). Faltando coluna → 503
 * com a mesma mensagem do servidor tradicional.
 */
export function ensureSchemaReady(): Promise<void> {
  schemaReady ??= findMissingColumns()
    .then((missing) => {
      if (missing.length > 0) {
        const message = schemaOutdatedMessage(missing);
        console.error(`❌ ${message}`);
        throw new AppError(503, message, 'SCHEMA_OUTDATED');
      }
    })
    .catch((err) => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

/** Middleware: segura a requisição até o schema ser conferido (só na 1ª, depois é imediato). */
export const requireSchemaReady: RequestHandler = (_req, _res, next) => {
  ensureSchemaReady().then(() => next(), next);
};
