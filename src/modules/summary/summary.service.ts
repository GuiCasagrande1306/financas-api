import { query } from '../../db/pool';
import { currentMonthSP } from '../../lib/dates';
import { getAccountBalances } from '../accounts/accounts.service';
import { withCategoryShare, type CategoryTotalRow } from '../reports/reports.service';

/**
 * Resumo financeiro do mês. Todos os valores monetários em CENTAVOS.
 *
 * Retorna:
 *  - currentBalance: saldo real ATUAL = soma dos saldos das contas não
 *    arquivadas até hoje (getAccountBalances — a mesma regra da tela de contas;
 *    compra no cartão só sai da conta quando a fatura é paga).
 *  - income / expense / net: totais do MÊS selecionado (transferências e
 *    pagamentos de fatura não são receita nem despesa).
 *  - byCategory: total gasto por categoria no mês (base do gráfico "pra onde
 *    foi meu dinheiro"), já com o % de participação nas despesas.
 *
 * Fuso: o mês padrão é o mês corrente em America/Sao_Paulo.
 */
export async function getSummary(userId: string, month?: string) {
  // Primeiro dia do mês alvo ('YYYY-MM-01'); sem mês → mês corrente em America/Sao_Paulo.
  const monthStart = `${month ?? currentMonthSP()}-01`;

  const [balances, totalsRow, byCategory, uncategorizedRow] = await Promise.all([
    // Saldo atual: soma das contas não arquivadas até hoje (uma query, GROUP BY).
    getAccountBalances(userId),

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
    query<CategoryTotalRow>(
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

  // Categorizadas + fatia "Sem categoria", com o % sobre as despesas (2 casas).
  const byCategoryWithShare = withCategoryShare(byCategory, uncategorizedRow[0].total, expense);

  return {
    month: monthStart.slice(0, 7),
    currency: 'BRL',
    currentBalance: balances.totals.balance,
    income,
    expense,
    net: income - expense,
    byCategory: byCategoryWithShare,
  };
}
