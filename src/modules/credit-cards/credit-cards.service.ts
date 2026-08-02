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

type InvoiceStatus = 'closed' | 'current' | 'future';

/** Janela (start..end) da fatura que FECHA no mês (year, monthIndex 0–11). */
function cycleForMonth(closingDay: number, year: number, monthIndex: number): { start: string; end: string } {
  const closeThis = clampDay(year, monthIndex, closingDay);
  const prevClose = clampDay(year, monthIndex - 1, closingDay);
  return {
    start: isoUTC(new Date(Date.UTC(year, monthIndex - 1, prevClose + 1))),
    end: isoUTC(new Date(Date.UTC(year, monthIndex, closeThis))),
  };
}

/** Mês de referência (YYYY-MM) da fatura ABERTA hoje = mês em que ela fecha. */
function currentInvoiceMonth(closingDay: number, ref = new Date()): string {
  const end = currentCycle(closingDay, ref).end; // 'YYYY-MM-DD'
  return end.slice(0, 7);
}

/** closed: já fechou; current: aberta (hoje dentro do ciclo); future: ainda vai abrir. */
function invoiceStatus(start: string, end: string): InvoiceStatus {
  const today = isoUTC(new Date());
  if (today > end) return 'closed';
  if (today >= start) return 'current';
  return 'future';
}

/** Vencimento da fatura: no mês do fechamento se o dia vier depois; senão, no mês seguinte. */
function dueDateFor(closingDay: number, dueDay: number, year: number, monthIndex: number): string {
  const dueMonth = dueDay > closingDay ? monthIndex : monthIndex + 1;
  return isoUTC(new Date(Date.UTC(year, dueMonth, clampDay(year, dueMonth, dueDay))));
}

/**
 * Fatura detalhada de um cartão num mês de referência (default = fatura aberta).
 * Retorna a janela do ciclo, vencimento, status, total e as transações.
 */
export async function getInvoice(userId: string, cardId: string, monthRef?: string) {
  const card = await getCard(userId, cardId);
  const ref = monthRef ?? currentInvoiceMonth(card.closingDay);
  const [year, month1] = ref.split('-').map(Number);
  const monthIndex = month1 - 1;

  const { start, end } = cycleForMonth(card.closingDay, year, monthIndex);

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
    month: ref,
    cycleStart: start,
    cycleEnd: end,
    dueDate: dueDateFor(card.closingDay, card.dueDay, year, monthIndex),
    status: invoiceStatus(start, end),
    total,
    transactions,
  };
}

/**
 * Resumo de TODAS as faturas do cartão (fechadas, atual e futuras), agrupando as
 * transações pelo ciclo de fechamento. A fatura aberta entra mesmo sem gastos.
 */
export async function listInvoices(userId: string, cardId: string) {
  const card = await getCard(userId, cardId);

  const rows = await query<{ month: string; total: number; count: number }>(
    `SELECT to_char(
              CASE WHEN extract(day from occurred_at)::int > $3
                   THEN date_trunc('month', occurred_at) + interval '1 month'
                   ELSE date_trunc('month', occurred_at) END, 'YYYY-MM') AS month,
            COALESCE(SUM(amount), 0)::bigint AS total,
            COUNT(*)::int AS count
       FROM transactions
      WHERE user_id = $1 AND credit_card_id = $2 AND deleted_at IS NULL AND kind = 'expense'
      GROUP BY 1`,
    [userId, cardId, card.closingDay],
  );

  const current = currentInvoiceMonth(card.closingDay);
  const byKey = new Map(rows.map((r) => [r.month, r]));
  if (!byKey.has(current)) rows.push({ month: current, total: 0, count: 0 });

  const invoices = rows
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((r) => {
      const [y, m1] = r.month.split('-').map(Number);
      const { start, end } = cycleForMonth(card.closingDay, y, m1 - 1);
      return {
        month: r.month,
        total: r.total,
        count: r.count,
        cycleStart: start,
        cycleEnd: end,
        dueDate: dueDateFor(card.closingDay, card.dueDay, y, m1 - 1),
        status: invoiceStatus(start, end),
      };
    });

  return {
    card: {
      id: card.id,
      name: card.name,
      limit: card.limit,
      color: card.color,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
    },
    current,
    invoices,
  };
}
