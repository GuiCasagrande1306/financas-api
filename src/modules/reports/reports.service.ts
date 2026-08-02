import { query } from '../../db/pool';

/** Rótulos curtos dos meses (índice 0 = Janeiro), para o eixo X do gráfico. */
const MONTH_LABELS = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

interface MonthRow {
  month: number; // 1–12
  income: number;
  expense: number;
}

interface CategoryRow {
  categoryId: string;
  name: string;
  color: string;
  icon: string;
  total: number;
}

/**
 * Relatório anual do usuário. Todos os valores em CENTAVOS.
 *
 * A matemática pesada (somar o ano inteiro e agrupar categorias) roda no banco
 * com GROUP BY — o servidor nunca carrega as transações individuais na memória.
 * As duas análises são consultadas EM PARALELO (Promise.all).
 *
 * Retorna:
 *  - monthlyComparison: 12 posições (Jan→Dez) com receita e despesa do mês.
 *  - expensesByCategory: despesas do ano por categoria, da maior para a menor.
 *  - totals: receita/despesa/saldo do ano (base do cabeçalho).
 */
export async function getAnnualReport(userId: string, year?: number) {
  const targetYear = year ?? new Date().getUTCFullYear();

  const [monthlyRows, categoryRows, uncategorizedRow] = await Promise.all([
    // Receitas e despesas somadas por mês daquele ano.
    query<MonthRow>(
      `SELECT EXTRACT(MONTH FROM occurred_at)::int AS month,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::bigint  AS income,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::bigint AS expense
         FROM transactions
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND occurred_at >= make_date($2::int, 1, 1)
          AND occurred_at <  make_date($2::int + 1, 1, 1)
        GROUP BY 1`,
      [userId, targetYear],
    ),

    // Despesas do ano por categoria (só categorizadas), maior → menor.
    query<CategoryRow>(
      `SELECT c.id AS "categoryId", c.name, c.color, c.icon,
              COALESCE(SUM(t.amount), 0)::bigint AS total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1
          AND t.deleted_at IS NULL
          AND t.kind = 'expense'
          AND t.occurred_at >= make_date($2::int, 1, 1)
          AND t.occurred_at <  make_date($2::int + 1, 1, 1)
        GROUP BY c.id, c.name, c.color, c.icon
        ORDER BY total DESC`,
      [userId, targetYear],
    ),

    // Despesas do ano sem categoria (viram a fatia "Sem categoria").
    query<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND kind = 'expense'
          AND category_id IS NULL
          AND occurred_at >= make_date($2::int, 1, 1)
          AND occurred_at <  make_date($2::int + 1, 1, 1)`,
      [userId, targetYear],
    ),
  ]);

  // Preenche as 12 posições (meses sem lançamento ficam zerados).
  const byMonth = new Map(monthlyRows.map((r) => [r.month, r]));
  let yearIncome = 0;
  let yearExpense = 0;
  const monthlyComparison = MONTH_LABELS.map((label, i) => {
    const row = byMonth.get(i + 1);
    const income = row?.income ?? 0;
    const expense = row?.expense ?? 0;
    yearIncome += income;
    yearExpense += expense;
    return { month: i + 1, label, income, expense };
  });

  // Junta as categorizadas com a fatia "Sem categoria" (se houver).
  const expenses = [...categoryRows];
  if (uncategorizedRow[0].total > 0) {
    expenses.push({
      categoryId: null as unknown as string,
      name: 'Sem categoria',
      color: '#9ca3af',
      icon: 'help-circle',
      total: uncategorizedRow[0].total,
    });
  }

  // Percentual de cada categoria sobre o total de despesas do ano.
  const expensesByCategory = expenses
    .map((row) => ({
      ...row,
      percentage: yearExpense > 0 ? Math.round((row.total / yearExpense) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    year: targetYear,
    currency: 'BRL',
    monthlyComparison,
    expensesByCategory,
    totals: {
      income: yearIncome,
      expense: yearExpense,
      net: yearIncome - yearExpense,
    },
  };
}
