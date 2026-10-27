import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import {
  addDaysISO,
  assertDateRange,
  currentYearSP,
  diffDaysISO,
  shortDateBR,
  todaySP,
  weekdayISO,
} from '../../lib/dates';
import { CATEGORY_NONE } from '../../lib/zod';
import type { AccountType } from '../accounts/accounts.schema';
import type { SourcesQuery } from './reports.schema';

/** Rótulos curtos dos meses (índice 0 = Janeiro), para o eixo X do gráfico. */
const MONTH_LABELS = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

interface MonthRow {
  month: number; // 1–12
  income: number;
  expense: number;
  uncategorized: number; // despesas sem categoria no mês
}

/** Total de despesas de UMA categoria (só as categorizadas). */
export interface CategoryTotalRow {
  categoryId: string;
  name: string;
  color: string;
  icon: string;
  total: number;
}

/** Fatia do gráfico de categorias, já com o % sobre o total de despesas. */
export interface CategoryShare {
  categoryId: string | null; // null = "Sem categoria"
  name: string;
  color: string;
  icon: string;
  total: number;
  percentage: number;
}

/** Fatia das despesas sem categoria — mesma cara no resumo e em todos os relatórios. */
export const UNCATEGORIZED = { name: 'Sem categoria', color: '#9ca3af', icon: 'help-circle' } as const;

/** Percentual com 2 casas (0 quando o todo é 0). */
const percentOf = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0;

/**
 * Junta as categorias com a fatia "Sem categoria" (se houver gasto sem
 * categoria) e calcula o % de cada uma sobre `expenseTotal` (2 casas), da maior
 * para a menor. Usado pelo resumo do mês e pelos relatórios.
 */
export function withCategoryShare(
  rows: CategoryTotalRow[],
  uncategorizedTotal: number,
  expenseTotal: number,
): CategoryShare[] {
  const all: Omit<CategoryShare, 'percentage'>[] = [...rows];
  if (uncategorizedTotal > 0) {
    all.push({ categoryId: null, ...UNCATEGORIZED, total: uncategorizedTotal });
  }
  return all
    .map((row) => ({ ...row, percentage: percentOf(row.total, expenseTotal) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Relatório anual do usuário. Todos os valores em CENTAVOS.
 *
 * A matemática pesada (somar o ano inteiro e agrupar categorias) roda no banco
 * com GROUP BY — o servidor nunca carrega as transações individuais na memória.
 * As duas análises são consultadas EM PARALELO (Promise.all) — 2 consultas; a
 * fatia "Sem categoria" sai da consulta por mês (mesmo filtro).
 *
 * Retorna:
 *  - monthlyComparison: 12 posições (Jan→Dez) com receita e despesa do mês.
 *  - expensesByCategory: despesas do ano por categoria, da maior para a menor.
 *  - totals: receita/despesa/saldo do ano (base do cabeçalho).
 */
export async function getAnnualReport(userId: string, year?: number) {
  const targetYear = year ?? currentYearSP();

  const [monthlyRows, categoryRows] = await Promise.all([
    // Receitas e despesas somadas por mês daquele ano (+ as despesas sem categoria).
    query<MonthRow>(
      `SELECT EXTRACT(MONTH FROM occurred_at)::int AS month,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::bigint  AS income,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::bigint AS expense,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense' AND category_id IS NULL), 0)::bigint
                AS uncategorized
         FROM transactions
        WHERE user_id = $1
          AND deleted_at IS NULL
          AND occurred_at >= make_date($2::int, 1, 1)
          AND occurred_at <  make_date($2::int + 1, 1, 1)
        GROUP BY 1`,
      [userId, targetYear],
    ),

    // Despesas do ano por categoria (só categorizadas), maior → menor.
    query<CategoryTotalRow>(
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

  // Categorizadas + fatia "Sem categoria", com o % sobre as despesas do ano.
  const yearUncategorized = monthlyRows.reduce((sum, r) => sum + r.uncategorized, 0);
  const expensesByCategory = withCategoryShare(categoryRows, yearUncategorized, yearExpense);

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

// ===========================================================================
// RELATÓRIO POR ORIGEM — "quanto e quando saiu de cada conta e cartão"
// ===========================================================================

type Granularity = 'day' | 'week' | 'month';

// Intervalo máximo do relatório (to − from), em dias.
const SOURCES_MAX_DAYS = 731;
const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TOP_EXPENSES_LIMIT = 8;

/** Uma origem do dinheiro: conta ou cartão. */
export interface SourceRef {
  key: string; // 'account:<id>' | 'card:<id>'
  type: 'account' | 'card';
  id: string;
  name: string;
  color: string;
  isArchived: boolean;
  accountType: AccountType | null; // só contas
  lastDigits: string | null; // só cartões
}

/**
 * Origem de uma despesa/receita: o cartão, se foi no crédito; senão a conta.
 * (Compra no cartão também guarda account_id = conta padrão — por isso o
 * cartão vem primeiro.) Tabela com alias `t`.
 */
const SOURCE_KEY_SQL = `CASE WHEN t.credit_card_id IS NOT NULL
                             THEN 'card:' || t.credit_card_id::text
                             ELSE 'account:' || t.account_id::text END`;

interface RawSource {
  type: 'account' | 'card';
  id: string;
  name: string | null;
  color: string | null;
  isArchived: boolean;
  accountType: AccountType | null;
  lastDigits: string | null;
}

function toSourceRef(r: RawSource): SourceRef {
  return {
    key: `${r.type}:${r.id}`,
    type: r.type,
    id: r.id,
    name: r.name ?? (r.type === 'card' ? 'Cartão' : 'Conta'),
    color: r.color ?? UNCATEGORIZED.color,
    isArchived: r.isArchived,
    accountType: r.type === 'account' ? r.accountType : null,
    lastDigits: r.type === 'card' ? r.lastDigits : null,
  };
}

/** Granularidade automática: até 31 dias → dia; até 120 → semana; senão mês. */
function autoGranularity(days: number): Granularity {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * Baldes da série, cobrindo TODO o intervalo from..to (o 1º começa em `from`,
 * o último termina em `to`). Semana = semana ISO (segunda a domingo).
 * Rótulos pt-BR: dia/semana 'dd/MM' (início); mês 'Out' ou 'Out/26' se o intervalo cruzar anos.
 *
 * Laço por CONTAGEM (`days` = nº de dias de from..to, vindo de assertDateRange),
 * nunca por comparação de string entre datas. Devolve também `bucketOfDay`:
 * índice do balde de cada dia (posição 0 = `from`).
 */
function buildBuckets(from: string, to: string, days: number, granularity: Granularity) {
  const buckets: { start: string; end: string; label: string }[] = [];
  const bucketOfDay: number[] = [];
  const crossesYears = from.slice(0, 4) !== to.slice(0, 4);

  for (let i = 0; i < days; i++) {
    const day = addDaysISO(from, i);
    // Dia que abre balde: o 1º do intervalo; todo dia (day); segunda (week); dia 1 (month).
    const opens =
      i === 0 ||
      granularity === 'day' ||
      (granularity === 'week' && weekdayISO(day) === 1) ||
      (granularity === 'month' && day.endsWith('-01'));
    if (opens) {
      let label: string;
      if (granularity === 'month') {
        const monthIndex = Number(day.slice(5, 7)) - 1;
        label = crossesYears ? `${MONTH_LABELS[monthIndex]}/${day.slice(2, 4)}` : MONTH_LABELS[monthIndex];
      } else {
        label = shortDateBR(day);
      }
      buckets.push({ start: day, end: day, label });
    } else {
      buckets[buckets.length - 1].end = day;
    }
    bucketOfDay[i] = buckets.length - 1;
  }
  return { buckets, bucketOfDay };
}

/**
 * Filtro opcional já conferido. Recebe a lista de parâmetros da consulta,
 * acrescenta nela o seu valor (se tiver) e devolve o trecho SQL com o `$n`
 * certo — assim os filtros combinam em qualquer ordem, sem número fixo.
 * Tabela com alias `t`. Sem filtro → trecho vazio.
 */
type SqlFilter = (params: unknown[]) => string;

const NO_FILTER: SqlFilter = () => '';

/** Parâmetros-base [userId, from, to] seguidos dos valores dos filtros, na ordem dada. */
function applyFilters(base: unknown[], ...filters: SqlFilter[]): { sql: string; params: unknown[] } {
  const params = [...base];
  const sql = filters
    .map((f) => f(params))
    .filter(Boolean)
    .join(' ');
  return { sql, params };
}

/**
 * Filtro + a conferência de posse do id dele. A conferência (`check`, 404 se o id
 * não for do usuário) roda JUNTO com as consultas do relatório — todas filtram
 * por user_id, então com um id alheio elas só voltam vazias e o 404 prevalece.
 */
interface CheckedFilter {
  filter: SqlFilter;
  check: Promise<void> | null;
}

/** Consulta de posse: 404 com `message` se não voltar linha. */
function assertExists(sql: string, params: unknown[], message: string): Promise<void> {
  return query(sql, params).then((rows) => {
    if (rows.length === 0) throw AppError.notFound(message);
  });
}

/** Filtro opcional por origem ('account:<id>' | 'card:<id>'), com a posse conferida. */
function sourceFilter(userId: string, source?: string): CheckedFilter {
  if (!source) return { filter: NO_FILTER, check: null };
  const sep = source.indexOf(':');
  const type = source.slice(0, sep);
  const id = source.slice(sep + 1);

  if (type === 'account') {
    return {
      check: assertExists('SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2', [id, userId], 'Conta não encontrada'),
      // Só o que saiu/entrou DIRETO na conta (compra no cartão também tem account_id).
      filter: (params) => {
        params.push(id);
        return `AND t.credit_card_id IS NULL AND t.account_id = $${params.length}`;
      },
    };
  }
  return {
    check: assertExists('SELECT 1 FROM credit_cards WHERE id = $1 AND user_id = $2', [id, userId], 'Cartão não encontrado'),
    filter: (params) => {
      params.push(id);
      return `AND t.credit_card_id = $${params.length}`;
    },
  };
}

/**
 * Filtro opcional por categoria: 'none' = sem categoria; id = só aquela
 * categoria, que precisa ser visível ao usuário (dele ou do sistema) — senão 404.
 */
function categoryFilter(userId: string, category?: string): CheckedFilter {
  if (!category) return { filter: NO_FILTER, check: null };
  if (category === CATEGORY_NONE) return { filter: () => 'AND t.category_id IS NULL', check: null };

  return {
    check: assertExists(
      'SELECT 1 FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
      [category, userId],
      'Categoria não encontrada',
    ),
    filter: (params) => {
      params.push(category);
      return `AND t.category_id = $${params.length}`;
    },
  };
}

interface SourceTotalsRow extends RawSource {
  expense: number;
  income: number;
  count: number;
}

interface DailyRow {
  date: string;
  key: string;
  expense: number;
  income: number;
  count: number;
}

interface CategoryRawRow {
  categoryId: string | null;
  name: string | null;
  color: string | null;
  icon: string | null;
  total: number;
}

interface TopRow {
  id: string;
  description: string | null;
  merchant: string | null;
  amount: number;
  occurredAt: string;
  installments: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  sourceType: 'account' | 'card';
  sourceId: string;
  sourceName: string | null;
  sourceColor: string | null;
  sourceArchived: boolean;
  accountType: AccountType | null;
  lastDigits: string | null;
}

/**
 * Relatório por ORIGEM (contas e cartões) num intervalo. Valores em CENTAVOS.
 *
 * Só soma despesas (e receitas à parte) — transferências e pagamentos de fatura
 * NUNCA entram (senão o cartão contaria em dobro: na compra e no pagamento).
 * Compra no cartão conta na data da compra (cada parcela na data da parcela).
 *
 * Dois filtros opcionais, que combinam (origem + categoria):
 *  - sources: TODAS as origens com movimento no intervalo, IGNORANDO o filtro
 *    `source` (a UI usa para os chips e o ranking), da que mais gastou para a que
 *    menos — mas respeitando `category` (de qual conta/cartão saiu a categoria);
 *  - byCategory: respeita `source` e IGNORA `category` (a rosca continua com
 *    todas as categorias, para o usuário trocar de uma para outra);
 *  - totals, series, byWeekday, topExpenses: respeitam os dois.
 * Receita não tem categoria de gasto: com `category`, `totals.income` e
 * `sources[].income` só somam receitas daquela categoria (na prática, 0).
 *
 * Média por dia (`totals.dailyAverage` sobre `totals.days` dias):
 *  - intervalo que contém hoje (America/Sao_Paulo) → dias de `from` até hoje
 *    (inclusive) e só as despesas até hoje (ex.: "Este mês" = mês inteiro, mas a
 *    média é do que já passou);
 *  - intervalo todo no passado ou todo no futuro → o intervalo inteiro.
 *
 * 4 consultas em paralelo (Promise.all), agregadas no banco (FILTER/GROUP BY), e
 * — com filtro de origem/categoria — a conferência de posse do id junto com elas
 * (uma ida e volta ao banco em vez de duas).
 */
export async function getSourcesReport(userId: string, params: SourcesQuery) {
  const { from, to } = params;
  const days = assertDateRange(from, to, SOURCES_MAX_DAYS);
  const granularity: Granularity = params.granularity ?? autoGranularity(days);
  const bySource = sourceFilter(userId, params.source);
  const byCategoryFilter = categoryFilter(userId, params.category);
  const base = [userId, from, to];
  // Cada consulta numera os próprios $n (a partir do $4) com os filtros que usa.
  const forSources = applyFilters(base, byCategoryFilter.filter); // ranking: só a categoria
  const forCategories = applyFilters(base, bySource.filter); // rosca: só a origem
  const filtered = applyFilters(base, bySource.filter, byCategoryFilter.filter); // o resto: os dois

  const [, , sourceRows, dailyRows, categoryRows, topRows] = await Promise.all([
    bySource.check,
    byCategoryFilter.check,
    // Totais por origem no intervalo (sem o filtro `source`; com o de categoria).
    query<SourceTotalsRow>(
      `WITH s AS (
         SELECT (t.credit_card_id IS NOT NULL)              AS is_card,
                COALESCE(t.credit_card_id, t.account_id)    AS source_id,
                COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'expense'), 0)::bigint AS expense,
                COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'income'), 0)::bigint  AS income,
                (COUNT(*) FILTER (WHERE t.kind = 'expense'))::int                    AS count
           FROM transactions t
          WHERE t.user_id = $1 AND t.deleted_at IS NULL
            AND t.kind IN ('expense', 'income')
            AND t.occurred_at >= $2::date AND t.occurred_at <= $3::date
            ${forSources.sql}
          GROUP BY 1, 2
       )
       SELECT CASE WHEN s.is_card THEN 'card' ELSE 'account' END       AS type,
              s.source_id                                             AS id,
              COALESCE(c.name, a.name)                                AS name,
              COALESCE(c.color, a.color)                              AS color,
              COALESCE(c.is_archived, a.is_archived, false)           AS "isArchived",
              CASE WHEN s.is_card THEN NULL ELSE a.type END           AS "accountType",
              CASE WHEN s.is_card THEN c.last_digits ELSE NULL END    AS "lastDigits",
              s.expense, s.income, s.count
         FROM s
         LEFT JOIN accounts a
           ON NOT s.is_card AND a.id = s.source_id AND a.user_id = $1
         LEFT JOIN credit_cards c
           ON s.is_card AND c.id = s.source_id AND c.user_id = $1
        WHERE s.expense > 0 OR s.income > 0
        ORDER BY s.expense DESC, s.income DESC, COALESCE(c.name, a.name)`,
      forSources.params,
    ),

    // Por dia × origem (com os dois filtros): base da série, dos totais e do dia da semana.
    query<DailyRow>(
      `SELECT t.occurred_at AS date,
              ${SOURCE_KEY_SQL} AS key,
              COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'expense'), 0)::bigint AS expense,
              COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'income'), 0)::bigint  AS income,
              (COUNT(*) FILTER (WHERE t.kind = 'expense'))::int                    AS count
         FROM transactions t
        WHERE t.user_id = $1 AND t.deleted_at IS NULL
          AND t.kind IN ('expense', 'income')
          AND t.occurred_at >= $2::date AND t.occurred_at <= $3::date
          ${filtered.sql}
        GROUP BY 1, 2`,
      filtered.params,
    ),

    // Despesas por categoria (só com o filtro de origem). Grupo sem categoria = "Sem categoria".
    query<CategoryRawRow>(
      `SELECT c.id AS "categoryId", c.name, c.color, c.icon,
              COALESCE(SUM(t.amount), 0)::bigint AS total
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id AND (c.user_id = t.user_id OR c.user_id IS NULL)
        WHERE t.user_id = $1 AND t.deleted_at IS NULL
          AND t.kind = 'expense'
          AND t.occurred_at >= $2::date AND t.occurred_at <= $3::date
          ${forCategories.sql}
        GROUP BY c.id, c.name, c.color, c.icon`,
      forCategories.params,
    ),

    // Maiores despesas do intervalo (com os dois filtros), já com categoria e origem.
    query<TopRow>(
      `SELECT t.id, t.description, t.merchant, t.amount,
              t.occurred_at AS "occurredAt", t.installments,
              c.name  AS "categoryName",
              c.color AS "categoryColor",
              c.icon  AS "categoryIcon",
              CASE WHEN t.credit_card_id IS NOT NULL THEN 'card' ELSE 'account' END AS "sourceType",
              COALESCE(t.credit_card_id, t.account_id)        AS "sourceId",
              COALESCE(cc.name, a.name)                       AS "sourceName",
              COALESCE(cc.color, a.color)                     AS "sourceColor",
              COALESCE(cc.is_archived, a.is_archived, false)  AS "sourceArchived",
              a.type                                          AS "accountType",
              cc.last_digits                                  AS "lastDigits"
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id AND (c.user_id = t.user_id OR c.user_id IS NULL)
         LEFT JOIN accounts a
           ON t.credit_card_id IS NULL AND a.id = t.account_id AND a.user_id = t.user_id
         LEFT JOIN credit_cards cc
           ON cc.id = t.credit_card_id AND cc.user_id = t.user_id
        WHERE t.user_id = $1 AND t.deleted_at IS NULL
          AND t.kind = 'expense'
          AND t.occurred_at >= $2::date AND t.occurred_at <= $3::date
          ${filtered.sql}
        ORDER BY t.amount DESC, t.occurred_at DESC, t.id
        LIMIT ${TOP_EXPENSES_LIMIT}`,
      filtered.params,
    ),
  ]);

  // ---- Origens (ranking + chips): % sobre o gasto total de todas as origens.
  const allExpense = sourceRows.reduce((s, r) => s + r.expense, 0);
  const sources = sourceRows.map((r) => ({
    ...toSourceRef(r),
    expense: r.expense,
    income: r.income,
    count: r.count,
    percentage: percentOf(r.expense, allExpense),
  }));

  // ---- Série: todos os baldes de from..to (zeros incluídos), só despesas.
  const { buckets, bucketOfDay } = buildBuckets(from, to, days, granularity);
  const series = buckets.map((b) => ({ ...b, total: 0, bySource: {} as Record<string, number> }));

  // ---- Média por dia: com o intervalo contendo hoje, só os dias já vividos
  // (from..hoje) e só as despesas até hoje — parcela/agendado futuro não infla a
  // média do mês corrente. Intervalo todo no passado ou todo no futuro: inteiro.
  const today = todaySP();
  const containsToday = from <= today && today <= to;
  const averageEnd = containsToday ? today : to;
  const averageDays = containsToday ? diffDaysISO(from, today) + 1 : days;

  const byWeekday = WEEKDAY_LABELS.map((label, weekday) => ({ weekday, label, total: 0, count: 0 }));
  let expense = 0;
  let income = 0;
  let count = 0;
  let expenseUntilAverageEnd = 0;
  for (const r of dailyRows) {
    expense += r.expense;
    income += r.income;
    count += r.count;
    if (r.date <= averageEnd) expenseUntilAverageEnd += r.expense;
    if (r.expense <= 0) continue;
    const point = series[bucketOfDay[diffDaysISO(from, r.date)]];
    point.total += r.expense;
    point.bySource[r.key] = (point.bySource[r.key] ?? 0) + r.expense;
    const wd = byWeekday[weekdayISO(r.date)];
    wd.total += r.expense;
    wd.count += r.count;
  }

  // ---- Categorias (mesma forma do resumo, com "Sem categoria"). O % é sobre o
  // gasto da própria rosca (só filtro de origem) — `expense` acima já pode estar
  // filtrado por categoria. Sem filtro de categoria, os dois totais são iguais.
  const categorized: CategoryTotalRow[] = [];
  let uncategorized = 0;
  let categoriesExpense = 0;
  for (const r of categoryRows) {
    categoriesExpense += r.total;
    if (r.categoryId === null) uncategorized += r.total;
    else {
      categorized.push({
        categoryId: r.categoryId,
        name: r.name ?? '',
        color: r.color ?? UNCATEGORIZED.color,
        icon: r.icon ?? UNCATEGORIZED.icon,
        total: r.total,
      });
    }
  }
  const byCategory = withCategoryShare(categorized, uncategorized, categoriesExpense).filter((c) => c.total > 0);

  // ---- Maiores gastos.
  const topExpenses = topRows.map((r) => ({
    id: r.id,
    description: r.description,
    merchant: r.merchant,
    amount: r.amount,
    occurredAt: r.occurredAt,
    installments: r.installments,
    categoryName: r.categoryName,
    categoryColor: r.categoryColor,
    categoryIcon: r.categoryIcon,
    source: toSourceRef({
      type: r.sourceType,
      id: r.sourceId,
      name: r.sourceName,
      color: r.sourceColor,
      isArchived: r.sourceArchived,
      accountType: r.accountType,
      lastDigits: r.lastDigits,
    }),
  }));

  return {
    from,
    to,
    granularity,
    currency: 'BRL' as const,
    source: params.source ?? null,
    category: params.category ?? null, // id da categoria, 'none' ou null (sem filtro)
    totals: {
      expense,
      income,
      count, // nº de despesas
      days: averageDays, // dias usados na média
      dailyAverage: Math.round(expenseUntilAverageEnd / averageDays),
    },
    sources,
    series,
    byCategory,
    byWeekday,
    topExpenses,
  };
}
