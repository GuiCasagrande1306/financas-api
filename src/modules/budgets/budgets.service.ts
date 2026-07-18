import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type { UpsertBudgetInput } from './budgets.schema';

// Limiar do alerta amarelo. Abaixo = verde; a partir de 100% = vermelho (estourou).
const WARNING_AT = 80;

function statusFor(percentage: number): 'ok' | 'warning' | 'danger' {
  if (percentage >= 100) return 'danger';
  if (percentage >= WARNING_AT) return 'warning';
  return 'ok';
}

interface BudgetRow {
  id: string;
  categoryId: string;
  name: string;
  color: string;
  icon: string;
  limitAmount: number;
  spent: number;
}

/**
 * Orçamentos ativos (mensais) + quanto já foi gasto em cada categoria no mês.
 * Valores em CENTAVOS. O gasto é sempre do mês pedido; o teto é recorrente.
 */
export async function listBudgets(userId: string, month?: string) {
  const now = new Date();
  const monthStart = month
    ? `${month}-01`
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const rows = await query<BudgetRow>(
    `SELECT b.id,
            b.category_id AS "categoryId",
            c.name, c.color, c.icon,
            b.amount AS "limitAmount",
            COALESCE(t.spent, 0)::bigint AS spent
       FROM budgets b
       JOIN categories c ON c.id = b.category_id
       LEFT JOIN (
         SELECT category_id, SUM(amount) AS spent
           FROM transactions
          WHERE user_id = $1 AND deleted_at IS NULL AND kind = 'expense'
            AND occurred_at >= $2::date
            AND occurred_at <  ($2::date + interval '1 month')
          GROUP BY category_id
       ) t ON t.category_id = b.category_id
      WHERE b.user_id = $1 AND b.is_active = true AND b.period = 'monthly'
      ORDER BY (COALESCE(t.spent, 0)::numeric / NULLIF(b.amount, 0)) DESC NULLS LAST, c.name`,
    [userId, monthStart],
  );

  const data = rows.map((r) => {
    const percentage = r.limitAmount > 0 ? Math.round((r.spent / r.limitAmount) * 10000) / 100 : 0;
    return {
      ...r,
      remaining: r.limitAmount - r.spent, // negativo = estourou
      percentage,
      status: statusFor(percentage),
    };
  });

  const limit = data.reduce((s, r) => s + r.limitAmount, 0);
  const spent = data.reduce((s, r) => s + r.spent, 0);

  return {
    month: monthStart.slice(0, 7),
    totals: {
      limit,
      spent,
      percentage: limit > 0 ? Math.round((spent / limit) * 10000) / 100 : 0,
    },
    data,
  };
}

async function assertCategory(userId: string, categoryId: string): Promise<void> {
  const rows = await query('SELECT id FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)', [
    categoryId,
    userId,
  ]);
  if (rows.length === 0) throw AppError.badRequest('Categoria inválida');
}

const BUDGET_COLUMNS = `id, category_id AS "categoryId", amount, period`;

/**
 * Define (ou atualiza) o orçamento mensal de uma categoria. Um orçamento ativo
 * por categoria — chamar de novo para a mesma categoria só ajusta o valor.
 */
export async function upsertBudget(userId: string, input: UpsertBudgetInput) {
  await assertCategory(userId, input.categoryId);

  const existing = await query<{ id: string }>(
    `SELECT id FROM budgets
      WHERE user_id = $1 AND category_id = $2 AND period = 'monthly' AND is_active = true
      LIMIT 1`,
    [userId, input.categoryId],
  );

  if (existing.length) {
    const rows = await query(
      `UPDATE budgets SET amount = $1 WHERE id = $2 RETURNING ${BUDGET_COLUMNS}`,
      [input.amount, existing[0].id],
    );
    return rows[0];
  }

  const rows = await query(
    `INSERT INTO budgets (user_id, category_id, amount, period)
       VALUES ($1, $2, $3, 'monthly')
       RETURNING ${BUDGET_COLUMNS}`,
    [userId, input.categoryId, input.amount],
  );
  return rows[0];
}

export async function deleteBudget(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM budgets WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (rows.length === 0) throw AppError.notFound('Orçamento não encontrado');
}
