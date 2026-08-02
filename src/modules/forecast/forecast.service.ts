import { query } from '../../db/pool';

const MONTH_LABELS = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

const ymKey = (y: number, mIndex: number) => `${y}-${String(mIndex + 1).padStart(2, '0')}`;

/** Saldo real ATUAL (igual ao do resumo): contas + entradas − saídas fora do cartão. */
async function currentBalance(userId: string): Promise<number> {
  const rows = await query<{ balance: number }>(
    `SELECT (
        (SELECT COALESCE(SUM(initial_balance), 0)
           FROM accounts WHERE user_id = $1 AND is_archived = false)
        + COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)
        - COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND credit_card_id IS NULL), 0)
     )::bigint AS balance
     FROM transactions
    WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  return rows[0].balance;
}

/**
 * "Máquina do Tempo": projeta o saldo dos próximos `months` meses.
 * Parte do saldo de hoje e, a cada mês futuro, soma a receita média estimada
 * e subtrai as contas fixas (recorrentes) + as parcelas de cartão já agendadas
 * para aquele mês. Tudo em CENTAVOS.
 */
export async function getForecast(userId: string, months: number) {
  const [balance, incomeRow, recurringRow, cardRows] = await Promise.all([
    currentBalance(userId),
    // Receita média mensal estimada = entradas dos últimos 90 dias ÷ 3.
    query<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE user_id = $1 AND deleted_at IS NULL AND kind = 'income'
          AND occurred_at >= current_date - interval '90 days'`,
      [userId],
    ),
    // Total mensal das contas fixas ativas.
    query<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM recurring_expenses WHERE user_id = $1 AND is_active = true`,
      [userId],
    ),
    // Parcelas de cartão FUTURAS (a partir do próximo mês), agrupadas por mês.
    query<{ ym: string; total: number }>(
      `SELECT to_char(occurred_at, 'YYYY-MM') AS ym, COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE user_id = $1 AND deleted_at IS NULL AND kind = 'expense'
          AND credit_card_id IS NOT NULL
          AND occurred_at >= date_trunc('month', current_date) + interval '1 month'
        GROUP BY 1`,
      [userId],
    ),
  ]);

  const estimatedMonthlyIncome = Math.round(incomeRow[0].total / 3);
  const recurringMonthly = recurringRow[0].total;
  const cardByMonth = new Map(cardRows.map((r) => [r.ym, r.total]));

  const now = new Date();
  const y0 = now.getUTCFullYear();
  const m0 = now.getUTCMonth();

  const points = [];
  // Ponto 0: hoje (mês atual, saldo real — nada projetado).
  let running = balance;
  points.push({
    month: ymKey(y0, m0),
    label: MONTH_LABELS[m0],
    balance: running,
    income: 0,
    expense: 0,
    cardInstallments: 0,
    recurring: 0,
    isToday: true,
  });

  for (let i = 1; i <= months; i++) {
    const d = new Date(Date.UTC(y0, m0 + i, 1));
    const key = ymKey(d.getUTCFullYear(), d.getUTCMonth());
    const cardInstallments = cardByMonth.get(key) ?? 0;
    const income = estimatedMonthlyIncome;
    const expense = recurringMonthly + cardInstallments;
    running = running + income - expense;
    points.push({
      month: key,
      label: MONTH_LABELS[d.getUTCMonth()],
      balance: running,
      income,
      expense,
      cardInstallments,
      recurring: recurringMonthly,
      isToday: false,
    });
  }

  const lowest = points.reduce((min, p) => (p.balance < min.balance ? p : min), points[0]);

  return {
    currency: 'BRL',
    currentBalance: balance,
    estimatedMonthlyIncome,
    recurringMonthly,
    points,
    lowestPoint: { month: lowest.month, label: lowest.label, balance: lowest.balance },
    goesNegative: points.some((p) => p.balance < 0),
  };
}
