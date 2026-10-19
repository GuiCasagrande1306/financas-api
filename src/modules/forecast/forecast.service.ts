import { query } from '../../db/pool';
import { addMonthsYM, todaySP } from '../../lib/dates';
import { getAccountBalances, getScheduledAccountMoves } from '../accounts/accounts.service';

const MONTH_LABELS = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

const ymKey = (y: number, mIndex: number) => `${y}-${String(mIndex + 1).padStart(2, '0')}`;

/**
 * "Máquina do Tempo": projeta o saldo dos próximos `months` meses.
 * Parte do saldo de hoje e, a cada mês futuro, soma a receita média estimada
 * e subtrai as contas fixas (recorrentes) + as parcelas de cartão já agendadas
 * para aquele mês. Tudo em CENTAVOS.
 * Também entram os lançamentos AGENDADOS (data futura) que mexem em conta —
 * receita/despesa fora do cartão e transferência para conta arquivada — no mês
 * em que caem (getScheduledAccountMoves). O resto do mês corrente (depois de
 * hoje) entra no 1º mês projetado, porque o ponto 0 é o saldo real de hoje.
 * Pagamento de fatura agendado NÃO entra: as compras do cartão já são
 * descontadas pela data da compra. No ponto, `income`/`expense` já incluem os
 * agendados (`scheduledIncome`/`scheduledExpense` mostram a parte agendada).
 * "Hoje" e o mês atual são os de America/Sao_Paulo; o saldo de partida é o
 * mesmo do resumo (getAccountBalances: contas não arquivadas até hoje).
 */
export async function getForecast(userId: string, months: number) {
  const today = todaySP();
  const [balances, incomeRow, recurringRow, cardRows, scheduledRows] = await Promise.all([
    getAccountBalances(userId),
    // Receita média mensal estimada = entradas dos últimos 90 dias (até hoje) ÷ 3.
    // Receita agendada (data futura) fica fora da média: ela entra no mês dela.
    query<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total
         FROM transactions
        WHERE user_id = $1 AND deleted_at IS NULL AND kind = 'income'
          AND occurred_at >= $2::date - interval '90 days'
          AND occurred_at <= $2::date`,
      [userId, today],
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
          AND occurred_at >= date_trunc('month', $2::date) + interval '1 month'
        GROUP BY 1`,
      [userId, today],
    ),
    // Lançamentos agendados que mexem em conta (líquidos por transação), por mês.
    getScheduledAccountMoves(userId, today),
  ]);

  const balance = balances.totals.balance;

  const estimatedMonthlyIncome = Math.round(incomeRow[0].total / 3);
  const recurringMonthly = recurringRow[0].total;
  const cardByMonth = new Map(cardRows.map((r) => [r.ym, r.total]));

  const [y0, m1] = today.split('-').map(Number);
  const m0 = m1 - 1; // 0–11

  // Agendados por mês; o resto do mês corrente vai para o 1º mês projetado.
  const currentKey = ymKey(y0, m0);
  const firstKey = addMonthsYM(currentKey, 1);
  const scheduledByMonth = new Map<string, { inflow: number; outflow: number }>();
  for (const r of scheduledRows) {
    const key = r.ym === currentKey ? firstKey : r.ym;
    const acc = scheduledByMonth.get(key) ?? { inflow: 0, outflow: 0 };
    acc.inflow += r.inflow;
    acc.outflow += r.outflow;
    scheduledByMonth.set(key, acc);
  }

  const points = [];
  // Ponto 0: hoje (mês atual, saldo real — nada projetado).
  let running = balance;
  points.push({
    month: currentKey,
    label: MONTH_LABELS[m0],
    balance: running,
    income: 0,
    expense: 0,
    cardInstallments: 0,
    recurring: 0,
    scheduledIncome: 0,
    scheduledExpense: 0,
    isToday: true,
  });

  for (let i = 1; i <= months; i++) {
    const d = new Date(Date.UTC(y0, m0 + i, 1));
    const key = ymKey(d.getUTCFullYear(), d.getUTCMonth());
    const cardInstallments = cardByMonth.get(key) ?? 0;
    const scheduled = scheduledByMonth.get(key) ?? { inflow: 0, outflow: 0 };
    const income = estimatedMonthlyIncome + scheduled.inflow;
    const expense = recurringMonthly + cardInstallments + scheduled.outflow;
    running = running + income - expense;
    points.push({
      month: key,
      label: MONTH_LABELS[d.getUTCMonth()],
      balance: running,
      income,
      expense,
      cardInstallments,
      recurring: recurringMonthly,
      scheduledIncome: scheduled.inflow,
      scheduledExpense: scheduled.outflow,
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
