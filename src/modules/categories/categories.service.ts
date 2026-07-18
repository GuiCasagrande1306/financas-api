import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type {
  CreateCategoryInput,
  ListCategoriesQuery,
  UpdateCategoryInput,
} from './categories.schema';

const CAT_COLUMNS = `
  id,
  user_id     AS "userId",
  name,
  icon,
  color,
  kind,
  parent_id   AS "parentId",
  sort_order  AS "sortOrder",
  is_archived AS "isArchived",
  created_at  AS "createdAt",
  (user_id IS NULL) AS "isSystem"
`;

export async function listCategories(userId: string, filters: ListCategoriesQuery) {
  // Retorna as categorias do sistema (user_id IS NULL) + as do próprio usuário.
  const where: string[] = ['(user_id = $1 OR user_id IS NULL)'];
  const params: unknown[] = [userId];

  if (filters.kind) {
    params.push(filters.kind);
    where.push(`kind = $${params.length}`);
  }
  if (!filters.includeArchived) {
    where.push('is_archived = false');
  }

  return query(
    `SELECT ${CAT_COLUMNS} FROM categories
      WHERE ${where.join(' AND ')}
      ORDER BY sort_order, name`,
    params,
  );
}

export async function getCategory(userId: string, id: string) {
  const rows = await query(
    `SELECT ${CAT_COLUMNS} FROM categories
      WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Categoria não encontrada');
  return rows[0];
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  const rows = await query(
    `INSERT INTO categories (user_id, name, kind, icon, color, parent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CAT_COLUMNS}`,
    [
      userId,
      input.name,
      input.kind ?? 'expense',
      input.icon ?? 'circle',
      input.color ?? '#6366f1',
      input.parentId ?? null,
    ],
  );
  return rows[0];
}

/** Só o dono pode alterar; categorias do sistema (user_id NULL) são intocáveis. */
async function assertOwnedCategory(userId: string, id: string): Promise<void> {
  const rows = await query<{ user_id: string | null }>(
    'SELECT user_id FROM categories WHERE id = $1',
    [id],
  );
  if (rows.length === 0) throw AppError.notFound('Categoria não encontrada');
  if (rows[0].user_id === null) {
    throw AppError.forbidden('Categorias do sistema não podem ser alteradas');
  }
  if (rows[0].user_id !== userId) {
    throw AppError.forbidden('Esta categoria pertence a outro usuário');
  }
}

export async function updateCategory(userId: string, id: string, input: UpdateCategoryInput) {
  await assertOwnedCategory(userId, id);

  const columnByField: Record<string, string> = {
    name: 'name',
    kind: 'kind',
    icon: 'icon',
    color: 'color',
    parentId: 'parent_id',
  };

  const fields: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(columnByField)) {
    const value = (input as Record<string, unknown>)[field];
    if (value !== undefined) fields[column] = value;
  }

  const keys = Object.keys(fields);
  if (keys.length === 0) return getCategory(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query(
    `UPDATE categories SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${CAT_COLUMNS}`,
    values,
  );
  return rows[0];
}

export async function deleteCategory(userId: string, id: string): Promise<void> {
  await assertOwnedCategory(userId, id);
  // As transações mantêm-se: a FK usa ON DELETE SET NULL (viram "sem categoria").
  await query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, userId]);
}
