import { query } from '../../db/pool';

interface CategoryBreakdownRow {
  categoryId: string;
  name: string;
  color: string;
  icon: string;
  total: number;
}

/**
 * Resumo financeiro do mês. Todos os valores monetários em CENTAVOS.
 *
 * Retorna:
 *  - currentBalance: saldo real ATUAL (saldo inicial das contas + todas as
 *    entradas − todas as saídas; transferências se anulam no agregado).
 *  - income / expense / net: totais do MÊS selecionado.
 *  - byCategory: total gasto por categoria no mês (base do gráfico "pra onde
 *    foi meu dinheiro"), já com o % de participação nas despesas.
 *
 * Obs. de fuso: o corte do mês usa a data (occurred_at) no fuso do servidor.
 * Num app de verdade, calcule o início do mês no fuso do usuário.
 */
export async function getSummary(userId: string, month?: string) {
  // Primeiro dia do mês alvo ('YYYY-MM-01'), em UTC quando não informado.
  const now = new Date();
  const monthStart = month
    ? `${month}-01`
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const [balanceRow, totalsRow, byCategory, uncategorizedRow] = await Promise.all([
    // Saldo atual (all-time, todas as contas ativas).
    query<{ balance: number }>(
      `SELECT (
          (SELECT COALESCE(SUM(initial_balance), 0)
             FROM accounts WHERE user_id = $1 AND is_archived = false)
          + COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)
          -- Gastos no CARTÃO não saem da conta (dívida futura) → não entram no saldo.
          - COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND credit_card_id IS NULL), 0)
       )::bigint AS balance
       FROM transactions
      WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    ),

    // Totais do mês (receitas e despesas).
    query<{ income: number; expense: number }>(
      `SELECT
          COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::bigint  AS income,
          COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::bigint AS expense
       FROM transactions
      WHERE user_id = $1
        AND deleted_at IS NULL
        AND occurred_at >= $2::date
        AND occurred_at <  ($2::date + interval '1 month')`,
      [userId, monthStart],
    ),

    // Gasto por categoria no mês (só despesas categorizadas).
    query<CategoryBreakdownRow>(
      `SELECT c.id AS "categoryId", c.name, c.color, c.icon,
              COALESCE(SUM(t.amount), 0)::bigint AS total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1
          AND t.deleted_at IS NULL
          AND t.kind = 'expense'
          AND t.occurred_at >= $2::date
          AND t.occurred_at <  ($2::date + interval '1 month')
        GROUP BY c.id, c.name, c.color, c.icon
        ORDER BY total DESC`,
      [userId, monthStart],
    ),

    // Despesas sem categoria no mês (aparecem como "Sem categoria").
    query<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND kind = 'expense'
          AND category_id IS NULL
          AND occurred_at >= $2::date
          AND occurred_at <  ($2::date + interval '1 month')`,
      [userId, monthStart],
    ),
  ]);

  const income = totalsRow[0].income;
  const expense = totalsRow[0].expense;

  const breakdown = [...byCategory];
  if (uncategorizedRow[0].total > 0) {
    breakdown.push({
      categoryId: null as unknown as string,
      name: 'Sem categoria',
      color: '#9ca3af',
      icon: 'help-circle',
      total: uncategorizedRow[0].total,
    });
  }

  // Percentual de cada categoria sobre o total de despesas (2 casas).
  const byCategoryWithShare = breakdown
    .map((row) => ({
      ...row,
      percentage: expense > 0 ? Math.round((row.total / expense) * 10000) / 100 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  return {
    month: monthStart.slice(0, 7),
    currency: 'BRL',
    currentBalance: balanceRow[0].balance,
    income,
    expense,
    net: income - expense,
    byCategory: byCategoryWithShare,
  };
}
