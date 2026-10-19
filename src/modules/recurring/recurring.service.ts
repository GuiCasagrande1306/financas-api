import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { clampDay, isoDate, todaySP } from '../../lib/dates';
import { assertAccountUsable, getOrCreateDefaultAccount } from '../accounts/accounts.service';
import { findCard } from '../credit-cards/credit-cards.service';
import type { CreateRecurringInput, UpdateRecurringInput } from './recurring.schema';

const COLS = `
  id,
  name,
  amount,
  due_day        AS "dueDay",
  category_id    AS "categoryId",
  account_id     AS "accountId",
  credit_card_id AS "creditCardId",
  color,
  icon,
  is_active      AS "isActive",
  created_at     AS "createdAt",
  updated_at     AS "updatedAt"
`;

interface RecurringRow {
  id: string;
  name: string;
  amount: number;
  dueDay: number;
  categoryId: string | null;
  accountId: string | null;
  creditCardId: string | null;
  color: string;
  icon: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Hoje (America/Sao_Paulo) quebrado em partes. m: 0–11. */
function todayParts() {
  const [y, m1, day] = todaySP().split('-').map(Number);
  return { y, m: m1 - 1, day };
}

/** Próximo vencimento a partir de hoje: data 'YYYY-MM-DD' + dias que faltam. */
function nextDue(dueDay: number): { date: string; daysUntil: number } {
  const { y, m, day } = todayParts();
  let ny = y;
  let nm = m;
  let dd = clampDay(ny, nm, dueDay);
  if (day > dd) {
    nm = m + 1;
    if (nm > 11) {
      nm = 0;
      ny += 1;
    }
    dd = clampDay(ny, nm, dueDay);
  }
  const daysUntil = Math.round((Date.UTC(ny, nm, dd) - Date.UTC(y, m, day)) / 86_400_000);
  return { date: isoDate(ny, nm, dd), daysUntil };
}

/**
 * "O app lança sozinho todo mês": posta um gasto para cada recorrência ATIVA
 * cujo vencimento já chegou neste mês e que ainda não foi lançada no mês.
 * Roda de forma preguiçosa (ao abrir o módulo) — confiável mesmo com o free
 * tier do Render hibernando.
 *
 * Origem: com cartão → despesa no cartão (account_id = conta padrão); senão a
 * conta da recorrência (se ainda ativa) ou a conta padrão.
 *
 * Anti-lançamento em dobro: cada recorrência primeiro "reivindica" o mês
 * (UPDATE de last_posted só se ainda não foi lançada no mês) e a transação só é
 * inserida se a reivindicação voltou — tudo numa única instrução. Duas
 * requisições simultâneas: a segunda espera a trava da linha, vê last_posted já
 * neste mês e não insere nada.
 */
export async function postDueRecurring(userId: string): Promise<number> {
  const today = todaySP();
  const monthStart = `${today.slice(0, 7)}-01`;

  const due = await query<{
    id: string;
    name: string;
    amount: number;
    dueDay: number;
    categoryId: string | null;
    accountId: string | null;
    creditCardId: string | null;
  }>(
    `SELECT r.id, r.name, r.amount, r.due_day AS "dueDay", r.category_id AS "categoryId",
            a.id AS "accountId", c.id AS "creditCardId"
       FROM recurring_expenses r
       LEFT JOIN accounts a
         ON a.id = r.account_id AND a.user_id = r.user_id AND a.is_archived = false
       LEFT JOIN credit_cards c
         ON c.id = r.credit_card_id AND c.user_id = r.user_id
      WHERE r.user_id = $1 AND r.is_active = true
        AND (r.last_posted IS NULL OR r.last_posted < $2::date)`,
    [userId, monthStart],
  );
  if (due.length === 0) return 0;

  const { y, m, day } = todayParts();
  let defaultAccountId: string | null = null;
  let posted = 0;
  for (const r of due) {
    const dueDate = clampDay(y, m, r.dueDay);
    if (day < dueDate) continue; // ainda não venceu neste mês
    const occurredAt = isoDate(y, m, dueDate);

    let accountId = r.creditCardId ? null : r.accountId;
    if (!accountId) {
      defaultAccountId ??= await getOrCreateDefaultAccount(userId);
      accountId = defaultAccountId;
    }

    const inserted = await query<{ id: string }>(
      `WITH claimed AS (
         UPDATE recurring_expenses
            SET last_posted = $3::date, updated_at = now()
          WHERE id = $1 AND user_id = $2 AND is_active = true
            AND (last_posted IS NULL OR last_posted < $4::date)
          RETURNING id
       )
       INSERT INTO transactions
         (user_id, account_id, category_id, amount, kind, description, occurred_at, credit_card_id)
       SELECT $2::uuid, $5::uuid, $6::uuid, $7::bigint, 'expense', $8::text, $3::date, $9::uuid
         FROM claimed
       RETURNING id`,
      [r.id, userId, occurredAt, monthStart, accountId, r.categoryId, r.amount, r.name, r.creditCardId],
    );
    if (inserted.length > 0) posted += 1;
  }
  return posted;
}

/**
 * Lista as recorrências do usuário já com o próximo vencimento, o resumo
 * (total mensal/anual) e a lista de "vence em breve" (para o alerta).
 * Antes, dispara o lançamento automático das que já venceram.
 */
export async function listRecurring(userId: string) {
  await postDueRecurring(userId);

  const rows = await query<RecurringRow>(
    `SELECT ${COLS} FROM recurring_expenses
      WHERE user_id = $1
      ORDER BY is_active DESC, due_day ASC, created_at`,
    [userId],
  );

  const data = rows.map((r) => {
    const nd = nextDue(r.dueDay);
    return { ...r, nextDueDate: nd.date, daysUntil: r.isActive ? nd.daysUntil : null };
  });

  const active = data.filter((r) => r.isActive);
  const monthlyTotal = active.reduce((s, r) => s + r.amount, 0);
  const upcoming = active
    .filter((r) => r.daysUntil !== null && r.daysUntil <= 3)
    .sort((a, b) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0));

  return {
    data,
    summary: { monthlyTotal, yearlyTotal: monthlyTotal * 12, count: active.length },
    upcoming,
  };
}

async function assertCategory(userId: string, categoryId: string): Promise<void> {
  const cat = await query('SELECT id FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [
    categoryId,
    userId,
  ]);
  if (cat.length === 0) throw AppError.badRequest('Categoria inválida');
}

/**
 * Confere a origem escolhida (posse; conta não arquivada). Conta e cartão
 * juntos → 400: a assinatura sai de um OU de outro.
 */
async function assertSource(userId: string, accountId?: string | null, creditCardId?: string | null) {
  if (accountId && creditCardId) {
    throw AppError.badRequest('Escolha uma conta OU um cartão para pagar, não os dois.');
  }
  if (accountId) await assertAccountUsable(userId, accountId);
  if (creditCardId && !(await findCard(userId, creditCardId))) {
    throw AppError.badRequest('Cartão não encontrado');
  }
}

export async function createRecurring(userId: string, input: CreateRecurringInput) {
  await Promise.all([
    input.categoryId ? assertCategory(userId, input.categoryId) : null,
    assertSource(userId, input.accountId, input.creditCardId),
  ]);
  const rows = await query<RecurringRow>(
    `INSERT INTO recurring_expenses
       (user_id, name, amount, due_day, category_id, color, icon, account_id, credit_card_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, '#6366f1'), $7, $8, $9)
       RETURNING ${COLS}`,
    [
      userId,
      input.name,
      input.amount,
      input.dueDay,
      input.categoryId ?? null,
      input.color ?? null,
      input.icon ?? null,
      input.accountId ?? null,
      input.creditCardId ?? null,
    ],
  );
  return rows[0];
}

async function getRecurring(userId: string, id: string): Promise<RecurringRow> {
  const rows = await query<RecurringRow>(`SELECT ${COLS} FROM recurring_expenses WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  if (rows.length === 0) throw AppError.notFound('Recorrência não encontrada');
  return rows[0];
}

export async function updateRecurring(userId: string, id: string, input: UpdateRecurringInput) {
  await Promise.all([
    input.categoryId ? assertCategory(userId, input.categoryId) : null,
    assertSource(userId, input.accountId, input.creditCardId),
  ]);

  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.amount !== undefined) fields.amount = input.amount;
  if (input.dueDay !== undefined) fields.due_day = input.dueDay;
  if (input.categoryId !== undefined) fields.category_id = input.categoryId;
  if (input.color !== undefined) fields.color = input.color;
  if (input.icon !== undefined) fields.icon = input.icon;
  if (input.isActive !== undefined) fields.is_active = input.isActive;
  // Origem: escolher uma conta tira o cartão (e vice-versa), mesmo que o patch não diga.
  if (input.accountId !== undefined) {
    fields.account_id = input.accountId ?? null;
    if (input.accountId && input.creditCardId === undefined) fields.credit_card_id = null;
  }
  if (input.creditCardId !== undefined) {
    fields.credit_card_id = input.creditCardId ?? null;
    if (input.creditCardId && input.accountId === undefined) fields.account_id = null;
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) return getRecurring(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  setClauses.push('updated_at = now()');
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query<RecurringRow>(
    `UPDATE recurring_expenses SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${COLS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Recorrência não encontrada');
  return rows[0];
}

export async function deleteRecurring(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM recurring_expenses WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (rows.length === 0) throw AppError.notFound('Recorrência não encontrada');
}
