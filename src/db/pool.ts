import { Pool, types } from 'pg';
import { env } from '../env';

/**
 * Type parsers do node-postgres.
 *
 * 1) BIGINT (int8, OID 20): por padrão volta como STRING para não perder
 *    precisão. Nossos valores monetários são armazenados em CENTAVOS (inteiro),
 *    seguros como Number do JS até 2^53 (~90 trilhões de reais). Convertemos
 *    para number para o JSON sair limpo.
 * 2) DATE (OID 1082): por padrão volta como objeto Date (com fuso), o que suja
 *    o JSON. Mantemos a string 'YYYY-MM-DD' crua.
 */
types.setTypeParser(20, (value) => (value === null ? null : parseInt(value, 10)));
types.setTypeParser(1082, (value) => value);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // O Supabase exige SSL. rejectUnauthorized:false evita erro de cadeia de
  // certificado em ambientes locais; em produção você pode fornecer o CA.
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Erros em clients ociosos não derrubam a request atual, mas precisam ser logados.
  console.error('Erro inesperado em client ocioso do Postgres:', err);
});

/**
 * Helper tipado para queries parametrizadas.
 * SEMPRE use placeholders ($1, $2, ...) — nunca interpole valores na string SQL
 * (proteção contra SQL injection).
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(text, params as unknown[]);
  return result.rows as T[];
}
