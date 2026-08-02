import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type {
  CreateTransactionInput,
  ListTransactionsQuery,
  UpdateTransactionInput,
} from './transactions.schema';

/**
 * Lista de colunas devolvida ao cliente, já convertida de snake_case (banco)
 * para camelCase (API). Reaproveitada em todos os RETURNING/SELECT.
 */
const TX_COLUMNS = `
  id,
  account_id          AS "accountId",
  category_id         AS "categoryId",
  amount,
  kind,
  description,
  merchant,
  occurred_at         AS "occurredAt",
  receipt_url         AS "receiptUrl",
  is_auto_categorized AS "isAutoCategorized",
  notes,
  credit_card_id      AS "creditCardId",
  installments,
  created_at          AS "createdAt",
  updated_at          AS "updatedAt"
`;

/**
 * Resolve a conta da transação. Se o cliente não informar `accountId`, pega
 * (ou cria) a carteira em dinheiro padrão do usuário — mantém o registro sem
 * fricção, fiel à proposta do produto.
 */
async function resolveAccountId(userId: string, accountId?: string | null): Promise<string> {
  if (accountId) {
    const rows = await query('SELECT id FROM accounts WHERE id = $1 AND user_id = $2', [
      accountId,
      userId,
    ]);
    if (rows.length === 0) throw AppError.badRequest('Conta não encontrada');
    return accountId;
  }

  const existing = await query<{ id: string }>(
    `SELECT id FROM accounts
       WHERE user_id = $1 AND type = 'cash' AND is_archived = false
       ORDER BY created_at LIMIT 1`,
    [userId],
  );
  if (existing.length) return existing[0].id;

  const created = await query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, type, icon, color)
       VALUES ($1, 'Carteira', 'cash', 'wallet', '#10b981')
       RETURNING id`,
    [userId],
  );
  return created[0].id;
}

/** Garante que a categoria (se informada) pertence ao usuário ou é do sistema. */
async function assertCategoryValid(userId: string, categoryId?: string | null): Promise<void> {
  if (!categoryId) return;
  const rows = await query(
    'SELECT id FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
    [categoryId, userId],
  );
  if (rows.length === 0) throw AppError.badRequest('Categoria inválida');
}

/** Data de hoje ('YYYY-MM-DD'), no fuso do servidor (espelha o current_date do banco). */
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Soma `add` meses a uma data 'YYYY-MM-DD' com CLAMP no fim do mês.
 * Ex.: 31/01 + 1 mês => 28/02 (nunca "vaza" para 03/03 como o Date puro faria).
 */
function addMonthsISO(iso: string, add: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = m - 1 + add;
  const year = y + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12; // 0–11
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  const accountId = await resolveAccountId(userId, input.accountId);
  await assertCategoryValid(userId, input.categoryId);

  const kind = input.kind ?? 'expense';
  const parcels = input.installments ?? 1;
  const baseDate = input.occurredAt ?? todayISO();
  const baseDesc = (input.description ?? '').trim();

  // À vista (1x): uma única transação, como sempre.
  if (parcels <= 1) {
    const rows = await query(
      `INSERT INTO transactions
         (user_id, account_id, category_id, amount, kind, description, merchant,
          occurred_at, notes, credit_card_id, installments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11)
       RETURNING ${TX_COLUMNS}`,
      [
        userId,
        accountId,
        input.categoryId ?? null,
        input.amount,
        kind,
        input.description ?? null,
        input.merchant ?? null,
        baseDate,
        input.notes ?? null,
        input.creditCardId ?? null,
        null,
      ],
    );
    return rows[0];
  }

  // Parcelado: fatia o TOTAL em N parcelas. A divisão em centavos pode sobrar —
  // a sobra vai na 1ª parcela para que a soma feche exatamente com o total.
  const base = Math.floor(input.amount / parcels);
  const remainder = input.amount - base * parcels;

  const tuples: string[] = [];
  const params: unknown[] = [];
  for (let i = 1; i <= parcels; i++) {
    const amount = i === 1 ? base + remainder : base;
    const occurredAt = addMonthsISO(baseDate, i - 1); // parcela 1 = mês base, 2 = +1 mês…
    const label = `${i}/${parcels}`;
    const description = baseDesc ? `${baseDesc} (${label})` : `Parcela ${label}`;

    const o = params.length;
    tuples.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}::date, $${o + 9}, $${o + 10}, $${o + 11})`,
    );
    params.push(
      userId,
      accountId,
      input.categoryId ?? null,
      amount,
      kind,
      description,
      input.merchant ?? null,
      occurredAt,
      input.notes ?? null,
      input.creditCardId ?? null,
      label,
    );
  }

  // Bulk insert: todas as parcelas de uma vez.
  const rows = await query(
    `INSERT INTO transactions
       (user_id, account_id, category_id, amount, kind, description, merchant,
        occurred_at, notes, credit_card_id, installments)
     VALUES ${tuples.join(', ')}
     RETURNING ${TX_COLUMNS}`,
    params,
  );
  return rows[0]; // a resposta 201 devolve a 1ª parcela
}

export async function listTransactions(userId: string, filters: ListTransactionsQuery) {
  const where: string[] = ['user_id = $1', 'deleted_at IS NULL'];
  const params: unknown[] = [userId];

  if (filters.kind) {
    params.push(filters.kind);
    where.push(`kind = $${params.length}`);
  }
  if (filters.categoryId) {
    params.push(filters.categoryId);
    where.push(`category_id = $${params.length}`);
  }
  if (filters.search) {
    // Busca parcial case-insensitive no nome (descrição) e no estabelecimento.
    params.push(`%${filters.search}%`);
    where.push(`(description ILIKE $${params.length} OR merchant ILIKE $${params.length})`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`occurred_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`occurred_at <= $${params.length}::date`);
  }

  const whereSql = where.join(' AND ');
  const whereParams = [...params]; // snapshot antes de acrescentar limit/offset

  params.push(filters.limit);
  const limitIdx = params.length;
  params.push(filters.offset);
  const offsetIdx = params.length;

  const data = await query(
    `SELECT ${TX_COLUMNS}
       FROM transactions
      WHERE ${whereSql}
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const totalRows = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transactions WHERE ${whereSql}`,
    whereParams,
  );

  return {
    data,
    pagination: {
      total: totalRows[0].count,
      limit: filters.limit,
      offset: filters.offset,
    },
  };
}

export async function getTransaction(userId: string, id: string) {
  const rows = await query(
    `SELECT ${TX_COLUMNS} FROM transactions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Transação não encontrada');
  return rows[0];
}

export async function updateTransaction(
  userId: string,
  id: string,
  input: UpdateTransactionInput,
) {
  if (input.accountId) await resolveAccountId(userId, input.accountId);
  if (input.categoryId !== undefined) await assertCategoryValid(userId, input.categoryId);

  // Monta o SET dinamicamente só com os campos enviados.
  const fields: Record<string, unknown> = {};
  if (input.amount !== undefined) fields.amount = input.amount;
  if (input.kind !== undefined) fields.kind = input.kind;
  if (input.categoryId !== undefined) fields.category_id = input.categoryId;
  if (input.accountId) fields.account_id = input.accountId; // conta nunca é "limpada"
  if (input.description !== undefined) fields.description = input.description;
  if (input.merchant !== undefined) fields.merchant = input.merchant;
  if (input.occurredAt !== undefined) fields.occurred_at = input.occurredAt;
  if (input.notes !== undefined) fields.notes = input.notes;
  if (input.creditCardId !== undefined) fields.credit_card_id = input.creditCardId;
  // `installments` não é editável: o rótulo da parcela ("2/4") é definido na criação.

  const keys = Object.keys(fields);
  if (keys.length === 0) return getTransaction(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  setClauses.push('updated_at = now()');
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query(
    `UPDATE transactions
        SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2} AND deleted_at IS NULL
      RETURNING ${TX_COLUMNS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Transação não encontrada');
  return rows[0];
}

/** Soft delete: nunca apagamos dinheiro de verdade — só marcamos deleted_at. */
export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const rows = await query(
    `UPDATE transactions SET deleted_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      RETURNING id`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Transação não encontrada');
}
