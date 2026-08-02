import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type { CreateRecurringInput, UpdateRecurringInput } from './recurring.schema';

const COLS = `
  id,
  name,
  amount,
  due_day     AS "dueDay",
  category_id AS "categoryId",
  color,
  icon,
  is_active   AS "isActive",
  created_at  AS "createdAt",
  updated_at  AS "updatedAt"
`;

interface RecurringRow {
  id: string;
  name: string;
  amount: number;
  dueDay: number;
  categoryId: string | null;
  color: string;
  icon: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function todayParts() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() }; // m: 0–11
}
/** Último dia válido do mês (trata Fev, meses de 30/31 dias). */
const clampDay = (y: number, m: number, day: number) => Math.min(day, new Date(y, m + 1, 0).getDate());
const iso = (y: number, m: number, day: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

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
  const daysUntil = Math.round(
    (new Date(ny, nm, dd).getTime() - new Date(y, m, day).getTime()) / 86_400_000,
  );
  return { date: iso(ny, nm, dd), daysUntil };
}

/** Conta em dinheiro padrão do usuário (cria a "Carteira" se ainda não existir). */
async function resolveCashAccount(userId: string): Promise<string> {
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

/**
 * "O app lança sozinho todo mês": posta um gasto para cada recorrência ATIVA
 * cujo vencimento já chegou neste mês e que ainda não foi lançada no mês.
 * Roda de forma preguiçosa (ao abrir o módulo) — confiável mesmo com o free
 * tier do Render hibernando. Idempotente via `last_posted`.
 */
export async function postDueRecurring(userId: string): Promise<number> {
  const due = await query<{ id: string; name: string; amount: number; dueDay: number; categoryId: string | null }>(
    `SELECT id, name, amount, due_day AS "dueDay", category_id AS "categoryId"
       FROM recurring_expenses
      WHERE user_id = $1 AND is_active = true
        AND (last_posted IS NULL OR last_posted < date_trunc('month', current_date))`,
    [userId],
  );
  if (due.length === 0) return 0;

  const { y, m, day } = todayParts();
  let posted = 0;
  for (const r of due) {
    const dueDate = clampDay(y, m, r.dueDay);
    if (day < dueDate) continue; // ainda não venceu neste mês
    const occurredAt = iso(y, m, dueDate);
    const accountId = await resolveCashAccount(userId);
    await query(
      `INSERT INTO transactions
         (user_id, account_id, category_id, amount, kind, description, occurred_at)
       VALUES ($1, $2, $3, $4, 'expense', $5, $6::date)`,
      [userId, accountId, r.categoryId, r.amount, r.name, occurredAt],
    );
    await query(
      `UPDATE recurring_expenses SET last_posted = $1::date, updated_at = now() WHERE id = $2`,
      [occurredAt, r.id],
    );
    posted += 1;
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

export async function createRecurring(userId: string, input: CreateRecurringInput) {
  if (input.categoryId) {
    const cat = await query('SELECT id FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [
      input.categoryId,
      userId,
    ]);
    if (cat.length === 0) throw AppError.badRequest('Categoria inválida');
  }
  const rows = await query<RecurringRow>(
    `INSERT INTO recurring_expenses (user_id, name, amount, due_day, category_id, color, icon)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, '#6366f1'), $7)
       RETURNING ${COLS}`,
    [userId, input.name, input.amount, input.dueDay, input.categoryId ?? null, input.color ?? null, input.icon ?? null],
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
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.amount !== undefined) fields.amount = input.amount;
  if (input.dueDay !== undefined) fields.due_day = input.dueDay;
  if (input.categoryId !== undefined) fields.category_id = input.categoryId;
  if (input.color !== undefined) fields.color = input.color;
  if (input.icon !== undefined) fields.icon = input.icon;
  if (input.isActive !== undefined) fields.is_active = input.isActive;

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
