import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type { CreateCardInput, UpdateCardInput } from './credit-cards.schema';

/** Colunas do cartão em camelCase (`card_limit` → `limit`). */
const CARD_COLUMNS = `
  id,
  name,
  card_limit   AS "limit",
  closing_day  AS "closingDay",
  due_day      AS "dueDay",
  last_digits  AS "lastDigits",
  color,
  created_at   AS "createdAt",
  updated_at   AS "updatedAt"
`;

interface CardRow {
  id: string;
  name: string;
  limit: number;
  closingDay: number;
  dueDay: number;
  lastDigits: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
}

const isoUTC = (d: Date) => d.toISOString().slice(0, 10);
const clampDay = (year: number, month: number, day: number) =>
  Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()); // trata meses curtos

/**
 * Janela (start..end) da fatura ATUAL (ainda aberta) com base no dia de
 * fechamento. Se o fechamento deste mês já passou, o ciclo aberto vai até o
 * fechamento do próximo mês; senão, vai até o fechamento deste mês.
 */
export function currentCycle(closingDay: number, ref = new Date()): { start: string; end: string } {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const d = ref.getUTCDate();
  const closeThis = clampDay(y, m, closingDay);

  if (d > closeThis) {
    return {
      start: isoUTC(new Date(Date.UTC(y, m, closeThis + 1))),
      end: isoUTC(new Date(Date.UTC(y, m + 1, clampDay(y, m + 1, closingDay)))),
    };
  }
  return {
    start: isoUTC(new Date(Date.UTC(y, m - 1, clampDay(y, m - 1, closingDay) + 1))),
    end: isoUTC(new Date(Date.UTC(y, m, closeThis))),
  };
}

/** Soma da fatura atual (despesas do cartão dentro do ciclo aberto). */
async function invoiceTotal(userId: string, cardId: string, closingDay: number): Promise<number> {
  const { start, end } = currentCycle(closingDay);
  const rows = await query<{ total: number }>(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS total
       FROM transactions
      WHERE user_id = $1 AND credit_card_id = $2 AND deleted_at IS NULL
        AND kind = 'expense'
        AND occurred_at >= $3::date AND occurred_at <= $4::date`,
    [userId, cardId, start, end],
  );
  return rows[0].total;
}

/** Cartões do usuário, já com fatura atual e limite disponível (p/ a UI). */
export async function listCards(userId: string) {
  const cards = await query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM credit_cards WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return Promise.all(
    cards.map(async (c) => {
      const currentInvoice = await invoiceTotal(userId, c.id, c.closingDay);
      return { ...c, currentInvoice, available: Math.max(0, c.limit - currentInvoice) };
    }),
  );
}

export async function createCard(userId: string, input: CreateCardInput) {
  const rows = await query<CardRow>(
    `INSERT INTO credit_cards (user_id, name, card_limit, closing_day, due_day, last_digits, color)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '#7c3aed'))
       RETURNING ${CARD_COLUMNS}`,
    [userId, input.name, input.limit, input.closingDay, input.dueDay, input.lastDigits ?? null, input.color ?? null],
  );
  return { ...rows[0], currentInvoice: 0, available: rows[0].limit };
}

export async function getCard(userId: string, id: string): Promise<CardRow> {
  const rows = await query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM credit_cards WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Cartão não encontrado');
  return rows[0];
}

export async function updateCard(userId: string, id: string, input: UpdateCardInput) {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.limit !== undefined) fields.card_limit = input.limit;
  if (input.closingDay !== undefined) fields.closing_day = input.closingDay;
  if (input.dueDay !== undefined) fields.due_day = input.dueDay;
  if (input.lastDigits !== undefined) fields.last_digits = input.lastDigits;
  if (input.color !== undefined) fields.color = input.color;

  const keys = Object.keys(fields);
  if (keys.length === 0) return getCard(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query<CardRow>(
    `UPDATE credit_cards SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${CARD_COLUMNS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Cartão não encontrado');
  return rows[0];
}

export async function deleteCard(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM credit_cards WHERE id = $1 AND user_id = $2 RETURNING id', [
    id,
    userId,
  ]);
  if (rows.length === 0) throw AppError.notFound('Cartão não encontrado');
}

/**
 * Fatura atual detalhada de um cartão: total, janela do ciclo, dia de
 * vencimento e as transações que a compõem.
 */
export async function getInvoice(userId: string, cardId: string) {
  const card = await getCard(userId, cardId);
  const { start, end } = currentCycle(card.closingDay);

  const transactions = await query(
    `SELECT id, category_id AS "categoryId", amount, description, merchant,
            occurred_at AS "occurredAt", installments
       FROM transactions
      WHERE user_id = $1 AND credit_card_id = $2 AND deleted_at IS NULL
        AND kind = 'expense'
        AND occurred_at >= $3::date AND occurred_at <= $4::date
      ORDER BY occurred_at DESC`,
    [userId, cardId, start, end],
  );
  const total = transactions.reduce((s, t) => s + Number((t as { amount: number }).amount), 0);

  return {
    cardId,
    cardName: card.name,
    cycleStart: start,
    cycleEnd: end,
    dueDay: card.dueDay,
    total,
    transactions,
  };
}
