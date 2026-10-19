import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { clampDay, isoUTC, todaySP, utcDate } from '../../lib/dates';
import { assertAccountUsable } from '../accounts/accounts.service';
import { TX_COLUMNS, type TransactionRow } from '../transactions/transactions.schema';
import type { CreateCardInput, PayInvoiceInput, UpdateCardInput } from './credit-cards.schema';

/** Colunas do cartão em camelCase (`card_limit` → `limit`). */
const CARD_COLUMNS = `
  id,
  name,
  card_limit   AS "limit",
  closing_day  AS "closingDay",
  due_day      AS "dueDay",
  last_digits  AS "lastDigits",
  color,
  is_archived  AS "isArchived",
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
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

/** "Hoje" (America/Sao_Paulo) como Date em meia-noite UTC — referência das faturas. */
const todayRef = () => utcDate(todaySP());

/**
 * Janela (start..end) da fatura ATUAL (ainda aberta) com base no dia de
 * fechamento. Se o fechamento deste mês já passou, o ciclo aberto vai até o
 * fechamento do próximo mês; senão, vai até o fechamento deste mês.
 * `ref` é lido com getters UTC (default = hoje em America/Sao_Paulo).
 */
export function currentCycle(closingDay: number, ref = todayRef()): { start: string; end: string } {
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

/**
 * Cartões do usuário, já com fatura atual e limite disponível (p/ a UI).
 * Arquivados só com `includeArchived` (e vêm por último).
 */
export async function listCards(userId: string, includeArchived = false) {
  const cards = await query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM credit_cards
      WHERE user_id = $1 ${includeArchived ? '' : 'AND is_archived = false'}
      ORDER BY is_archived, created_at`,
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

/** Cartão do usuário ou null (para validar ids vindos no corpo de outras rotas). */
export async function findCard(userId: string, id: string): Promise<CardRow | null> {
  const rows = await query<CardRow>(
    `SELECT ${CARD_COLUMNS} FROM credit_cards WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  return rows[0] ?? null;
}

export async function getCard(userId: string, id: string): Promise<CardRow> {
  const card = await findCard(userId, id);
  if (!card) throw AppError.notFound('Cartão não encontrado');
  return card;
}

export async function updateCard(userId: string, id: string, input: UpdateCardInput) {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.limit !== undefined) fields.card_limit = input.limit;
  if (input.closingDay !== undefined) fields.closing_day = input.closingDay;
  if (input.dueDay !== undefined) fields.due_day = input.dueDay;
  if (input.lastDigits !== undefined) fields.last_digits = input.lastDigits;
  if (input.color !== undefined) fields.color = input.color;
  if (input.isArchived !== undefined) fields.is_archived = input.isArchived;

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

/**
 * Exclui o cartão — só se não houver lançamento (não deletado) nele. Apagar com
 * histórico solta as compras do cartão (FK set null) e elas passariam a sair do
 * saldo da conta. Com lançamentos → 409: o caminho é arquivar.
 */
export async function deleteCard(userId: string, id: string): Promise<void> {
  // Uma única instrução: confere e apaga juntos (sem janela entre os dois).
  const rows = await query(
    `DELETE FROM credit_cards c
      WHERE c.id = $1 AND c.user_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM transactions t
           WHERE t.user_id = $2 AND t.credit_card_id = c.id AND t.deleted_at IS NULL
        )
      RETURNING c.id`,
    [id, userId],
  );
  if (rows.length > 0) return;

  await getCard(userId, id); // não existe → 404
  throw new AppError(
    409,
    'Este cartão tem lançamentos. Arquive para escondê-lo sem perder o histórico.',
    'CARD_HAS_TRANSACTIONS',
  );
}

type InvoiceStatus = 'closed' | 'current' | 'future';

/** Janela (start..end) da fatura que FECHA no mês (year, monthIndex 0–11). */
export function cycleForMonth(
  closingDay: number,
  year: number,
  monthIndex: number,
): { start: string; end: string } {
  const closeThis = clampDay(year, monthIndex, closingDay);
  const prevClose = clampDay(year, monthIndex - 1, closingDay);
  return {
    start: isoUTC(new Date(Date.UTC(year, monthIndex - 1, prevClose + 1))),
    end: isoUTC(new Date(Date.UTC(year, monthIndex, closeThis))),
  };
}

/** Mês de referência (YYYY-MM) da fatura ABERTA hoje = mês em que ela fecha. */
function currentInvoiceMonth(closingDay: number, ref = todayRef()): string {
  const end = currentCycle(closingDay, ref).end; // 'YYYY-MM-DD'
  return end.slice(0, 7);
}

/**
 * Mês (YYYY-MM) da fatura em que cai uma compra feita em `dateISO` — mesma
 * regra do agrupamento de listInvoices (dia > fechamento → fatura do mês seguinte).
 */
export function invoiceMonthOf(closingDay: number, dateISO: string): string {
  return currentInvoiceMonth(closingDay, utcDate(dateISO));
}

/** closed: já fechou; current: aberta (hoje dentro do ciclo); future: ainda vai abrir. */
function invoiceStatus(start: string, end: string): InvoiceStatus {
  const today = todaySP();
  if (today > end) return 'closed';
  if (today >= start) return 'current';
  return 'future';
}

/** Vencimento da fatura: no mês do fechamento se o dia vier depois; senão, no mês seguinte. */
function dueDateFor(closingDay: number, dueDay: number, year: number, monthIndex: number): string {
  const dueMonth = dueDay > closingDay ? monthIndex : monthIndex + 1;
  return isoUTC(new Date(Date.UTC(year, dueMonth, clampDay(year, dueMonth, dueDay))));
}

/** Pagamentos (transfer com invoice_month) de uma fatura, do mais antigo ao mais novo. */
async function invoicePayments(userId: string, cardId: string, month: string) {
  return query<{ id: string; amount: number; occurredAt: string; accountId: string; accountName: string }>(
    `SELECT t.id, t.amount, t.occurred_at AS "occurredAt",
            t.account_id AS "accountId", COALESCE(a.name, 'Conta') AS "accountName"
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id AND a.user_id = t.user_id
      WHERE t.user_id = $1 AND t.credit_card_id = $2 AND t.deleted_at IS NULL
        AND t.kind = 'transfer' AND t.invoice_month = $3
      ORDER BY t.occurred_at, t.created_at`,
    [userId, cardId, month],
  );
}

/** Pago / restante / quitada de uma fatura (total = só despesas; pagamento é transfer). */
function paymentStatus(total: number, paid: number) {
  return { paid, remaining: Math.max(0, total - paid), isPaid: total > 0 && paid >= total };
}

/**
 * Fatura detalhada de um cartão num mês de referência (default = fatura aberta).
 * Retorna a janela do ciclo, vencimento, status, total, quanto já foi pago
 * (e por quais pagamentos) e as transações.
 */
export async function getInvoice(userId: string, cardId: string, monthRef?: string) {
  const card = await getCard(userId, cardId);
  const ref = monthRef ?? currentInvoiceMonth(card.closingDay);
  const [year, month1] = ref.split('-').map(Number);
  const monthIndex = month1 - 1;

  const { start, end } = cycleForMonth(card.closingDay, year, monthIndex);

  const [transactions, payments] = await Promise.all([
    query(
      `SELECT id, category_id AS "categoryId", amount, description, merchant,
              occurred_at AS "occurredAt", installments
         FROM transactions
        WHERE user_id = $1 AND credit_card_id = $2 AND deleted_at IS NULL
          AND kind = 'expense'
          AND occurred_at >= $3::date AND occurred_at <= $4::date
        ORDER BY occurred_at DESC`,
      [userId, cardId, start, end],
    ),
    invoicePayments(userId, cardId, ref),
  ]);
  const total = transactions.reduce((s, t) => s + Number((t as { amount: number }).amount), 0);
  const paid = payments.reduce((s, p) => s + p.amount, 0);

  return {
    cardId,
    cardName: card.name,
    month: ref,
    cycleStart: start,
    cycleEnd: end,
    dueDate: dueDateFor(card.closingDay, card.dueDay, year, monthIndex),
    status: invoiceStatus(start, end),
    total,
    ...paymentStatus(total, paid),
    payments,
    transactions,
  };
}

/**
 * Resumo de TODAS as faturas do cartão (fechadas, atual e futuras), agrupando as
 * transações pelo ciclo de fechamento. A fatura aberta entra mesmo sem gastos;
 * fatura com pagamento e sem gasto também aparece (para dar para desfazer).
 */
export async function listInvoices(userId: string, cardId: string) {
  const card = await getCard(userId, cardId);

  const [rows, paidRows] = await Promise.all([
    query<{ month: string; total: number; count: number }>(
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
    ),
    query<{ month: string; paid: number }>(
      `SELECT invoice_month AS month, COALESCE(SUM(amount), 0)::bigint AS paid
         FROM transactions
        WHERE user_id = $1 AND credit_card_id = $2 AND deleted_at IS NULL
          AND kind = 'transfer' AND invoice_month IS NOT NULL
        GROUP BY invoice_month`,
      [userId, cardId],
    ),
  ]);

  const current = currentInvoiceMonth(card.closingDay);
  const paidByMonth = new Map(paidRows.map((r) => [r.month, r.paid]));
  const months = new Set(rows.map((r) => r.month));
  for (const month of [...paidByMonth.keys(), current]) {
    if (!months.has(month)) {
      rows.push({ month, total: 0, count: 0 });
      months.add(month);
    }
  }

  const invoices = rows
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((r) => {
      const [y, m1] = r.month.split('-').map(Number);
      const { start, end } = cycleForMonth(card.closingDay, y, m1 - 1);
      return {
        month: r.month,
        total: r.total,
        count: r.count,
        ...paymentStatus(r.total, paidByMonth.get(r.month) ?? 0),
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

/**
 * Paga (total ou parte de) uma fatura: grava uma `transfer` que SAI da conta
 * pagadora, amarrada ao cartão e ao mês da fatura (invoice_month). Não é gasto
 * (o gasto já contou na data de cada compra) — só tira o dinheiro da conta.
 * Desfazer = DELETE /transactions/:id. Devolve a Transação criada.
 */
export async function createInvoicePayment(
  userId: string,
  cardId: string,
  month: string,
  input: PayInvoiceInput,
): Promise<TransactionRow> {
  const card = await getCard(userId, cardId);
  await assertAccountUsable(userId, input.accountId);

  const [year, month2] = month.split('-');
  const rows = await query<TransactionRow>(
    `INSERT INTO transactions
       (user_id, account_id, category_id, amount, kind, description,
        occurred_at, credit_card_id, invoice_month)
     VALUES ($1, $2, NULL, $3, 'transfer', $4, $5::date, $6, $7)
     RETURNING ${TX_COLUMNS}`,
    [
      userId,
      input.accountId,
      input.amount,
      `Pagamento da fatura ${card.name} (${month2}/${year})`,
      input.paidAt ?? todaySP(),
      cardId,
      month,
    ],
  );
  return rows[0];
}
