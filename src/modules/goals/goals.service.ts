import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type { CreateGoalInput, UpdateGoalInput } from './goals.schema';

const COLS = `
  id,
  title,
  target_amount  AS "targetAmount",
  current_amount AS "currentAmount",
  deadline,
  icon,
  color,
  created_at     AS "createdAt",
  updated_at     AS "updatedAt"
`;

interface GoalRow {
  id: string;
  title: string;
  targetAmount: number;
  currentAmount: number;
  deadline: string | null;
  icon: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
}

/** Anexa o % de progresso e a flag de concluída (guardado >= objetivo). */
function decorate(g: GoalRow) {
  const percentage = g.targetAmount > 0 ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100)) : 0;
  return { ...g, percentage, completed: g.currentAmount >= g.targetAmount };
}

export async function listGoals(userId: string) {
  const rows = await query<GoalRow>(
    `SELECT ${COLS} FROM goals WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(decorate);
}

async function getGoalRow(userId: string, id: string): Promise<GoalRow> {
  const rows = await query<GoalRow>(`SELECT ${COLS} FROM goals WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (rows.length === 0) throw AppError.notFound('Meta não encontrada');
  return rows[0];
}

export async function createGoal(userId: string, input: CreateGoalInput) {
  const rows = await query<GoalRow>(
    `INSERT INTO goals (user_id, title, target_amount, current_amount, deadline, icon, color)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '#10b981'))
       RETURNING ${COLS}`,
    [userId, input.title, input.targetAmount, input.currentAmount ?? 0, input.deadline ?? null, input.icon ?? null, input.color ?? null],
  );
  return decorate(rows[0]);
}

export async function updateGoal(userId: string, id: string, input: UpdateGoalInput) {
  const fields: Record<string, unknown> = {};
  if (input.title !== undefined) fields.title = input.title;
  if (input.targetAmount !== undefined) fields.target_amount = input.targetAmount;
  if (input.currentAmount !== undefined) fields.current_amount = input.currentAmount;
  if (input.deadline !== undefined) fields.deadline = input.deadline;
  if (input.icon !== undefined) fields.icon = input.icon;
  if (input.color !== undefined) fields.color = input.color;

  const keys = Object.keys(fields);
  if (keys.length === 0) return decorate(await getGoalRow(userId, id));

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  setClauses.push('updated_at = now()');
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query<GoalRow>(
    `UPDATE goals SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${COLS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Meta não encontrada');
  return decorate(rows[0]);
}

export async function deleteGoal(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM goals WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId]);
  if (rows.length === 0) throw AppError.notFound('Meta não encontrada');
}

/**
 * Guarda (amount>0) ou resgata (amount<0) dinheiro de uma meta. O saldo nunca
 * fica negativo. Retorna a meta atualizada + `justCompleted` (bateu 100% agora)
 * para o frontend soltar o confete.
 */
export async function addFunds(userId: string, id: string, amount: number) {
  const goal = await getGoalRow(userId, id);
  const wasCompleted = goal.currentAmount >= goal.targetAmount;
  const newAmount = Math.max(0, goal.currentAmount + amount);

  const rows = await query<GoalRow>(
    `UPDATE goals SET current_amount = $1, updated_at = now()
      WHERE id = $2 AND user_id = $3
      RETURNING ${COLS}`,
    [newAmount, id, userId],
  );
  const updated = decorate(rows[0]);
  return { goal: updated, justCompleted: !wasCompleted && updated.completed };
}
