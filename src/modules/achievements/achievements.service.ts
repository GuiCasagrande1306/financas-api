import { query } from '../../db/pool';

interface Stats {
  investments: number;
  transactions: number;
  cards: number;
  recurring: number;
  goalsDone: number;
}

/**
 * Catálogo de conquistas (medalhas). `check` decide se está desbloqueada a
 * partir das estatísticas do usuário. Avaliado em tempo real — sem tabela.
 */
const ACHIEVEMENTS: Array<{
  id: string;
  title: string;
  description: string;
  icon: string; // nome do ícone lucide (resolvido no frontend)
  check: (s: Stats) => boolean;
}> = [
  {
    id: 'first_investment',
    title: 'Investidor Iniciante',
    description: 'Fez o seu primeiro aporte em investimentos.',
    icon: 'TrendingUp',
    check: (s) => s.investments >= 1,
  },
  {
    id: 'first_card',
    title: 'Na Régua',
    description: 'Cadastrou o primeiro cartão de crédito.',
    icon: 'CreditCard',
    check: (s) => s.cards >= 1,
  },
  {
    id: 'first_subscription',
    title: 'Radar Ligado',
    description: 'Cadastrou a primeira conta fixa ou assinatura.',
    icon: 'Repeat',
    check: (s) => s.recurring >= 1,
  },
  {
    id: 'ten_transactions',
    title: 'No Controle',
    description: 'Registrou 10 lançamentos no app.',
    icon: 'ListChecks',
    check: (s) => s.transactions >= 10,
  },
  {
    id: 'fifty_transactions',
    title: 'Mestre das Finanças',
    description: 'Registrou 50 lançamentos. Disciplina em dia!',
    icon: 'Crown',
    check: (s) => s.transactions >= 50,
  },
  {
    id: 'first_goal_done',
    title: 'Sonho Realizado',
    description: 'Concluiu a primeira meta na Caixinha.',
    icon: 'Trophy',
    check: (s) => s.goalsDone >= 1,
  },
];

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ c: number }>(sql, params);
  return rows[0]?.c ?? 0;
}

/** Conta que não quebra se a tabela ainda não existir (ex.: goals antes do módulo). */
async function safeCount(sql: string, params: unknown[]): Promise<number> {
  try {
    return await count(sql, params);
  } catch {
    return 0;
  }
}

/**
 * Avalia as conquistas do usuário em tempo real e devolve o catálogo com a
 * flag `unlocked` em cada medalha + o total desbloqueado.
 */
export async function getAchievements(userId: string) {
  const [investments, transactions, cards, recurring, goalsDone] = await Promise.all([
    count(`SELECT count(*)::int AS c FROM investments WHERE user_id = $1`, [userId]),
    count(`SELECT count(*)::int AS c FROM transactions WHERE user_id = $1 AND deleted_at IS NULL`, [userId]),
    count(`SELECT count(*)::int AS c FROM credit_cards WHERE user_id = $1`, [userId]),
    count(`SELECT count(*)::int AS c FROM recurring_expenses WHERE user_id = $1`, [userId]),
    safeCount(`SELECT count(*)::int AS c FROM goals WHERE user_id = $1 AND current_amount >= target_amount`, [userId]),
  ]);

  const stats: Stats = { investments, transactions, cards, recurring, goalsDone };
  const data = ACHIEVEMENTS.map(({ check, ...rest }) => ({ ...rest, unlocked: check(stats) }));
  return { data, unlockedCount: data.filter((a) => a.unlocked).length, total: data.length };
}
