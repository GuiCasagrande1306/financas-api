import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { getIndicatorRates } from '../indicators/indicators.service';
import type {
  AssetType,
  CreateInvestmentInput,
  ListInvestmentsQuery,
  UpdateInvestmentInput,
  YieldType,
} from './investments.schema';

/**
 * Metadados de cada tipo de ativo: rótulo amigável (pt-BR) e a CLASSE de mercado
 * usada na alocação da carteira (Renda Fixa vs Renda Variável).
 */
type AssetClass = 'renda_fixa' | 'renda_variavel' | 'outros';

const ASSET_META: Record<AssetType, { label: string; class: AssetClass }> = {
  tesouro_direto: { label: 'Tesouro Direto', class: 'renda_fixa' },
  cdb: { label: 'CDB', class: 'renda_fixa' },
  lci_lca: { label: 'LCI/LCA', class: 'renda_fixa' },
  poupanca: { label: 'Poupança', class: 'renda_fixa' },
  fii: { label: 'Fundos Imobiliários (FII)', class: 'renda_variavel' },
  acoes: { label: 'Ações', class: 'renda_variavel' },
  fundo: { label: 'Fundos de Investimento', class: 'renda_variavel' },
  cripto: { label: 'Criptomoedas', class: 'renda_variavel' },
  previdencia: { label: 'Previdência', class: 'outros' },
  outros: { label: 'Outros', class: 'outros' },
};

const CLASS_LABEL: Record<AssetClass, string> = {
  renda_fixa: 'Renda Fixa',
  renda_variavel: 'Renda Variável',
  outros: 'Outros',
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayISO = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Cálculo do VALOR ATUAL (Fase 8)
// ---------------------------------------------------------------------------

type Rates = { SELIC: number; CDI: number };

interface RawInvestment {
  id: string;
  name: string;
  assetType: AssetType;
  investedAmount: number;
  storedCurrent: number; // current_amount armazenado (manual/fallback)
  expectedAnnualRate: number; // pré: % a.a. | pós: % do indicador
  yieldType: YieldType;
  purchaseDate: string | null; // 'YYYY-MM-DD' (NULL = legado/manual)
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Taxa anual EFETIVA do ativo:
 *  - pré-fixado → a própria taxa contratada.
 *  - pós-fixado (CDI/Selic) → indicador atual × (% contratada / 100).
 *    Ex.: 110% do CDI, com CDI a 14% → 14 × 1,10 = 15,4% a.a.
 */
function effectiveAnnualRate(r: RawInvestment, rates: Rates): number {
  if (r.yieldType === 'cdi') return rates.CDI * (r.expectedAnnualRate / 100);
  if (r.yieldType === 'selic') return rates.SELIC * (r.expectedAnnualRate / 100);
  return r.expectedAnnualRate; // pré-fixado
}

/** Dias corridos desde a data de compra (base simples para o MVP). */
function daysSince(dateStr: string): number {
  const start = new Date(`${dateStr}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
}

/**
 * Valor atual do ativo. Para renda fixa com data de compra e taxa > 0, calcula
 * por juros compostos (dias corridos / 365) a partir do valor investido. Ativos
 * variáveis (taxa 0) e legados (sem data) usam o valor manual armazenado.
 */
function computeCurrent(r: RawInvestment, rates: Rates): number {
  const annual = effectiveAnnualRate(r, rates);
  if (!r.purchaseDate || annual <= 0) return r.storedCurrent;
  const factor = Math.pow(1 + annual / 100, daysSince(r.purchaseDate) / 365);
  return Math.round(r.investedAmount * factor);
}

/** Converte a linha do banco no objeto do cliente, com o valor atual calculado. */
function toClient(r: RawInvestment, rates: Rates) {
  return {
    id: r.id,
    name: r.name,
    assetType: r.assetType,
    investedAmount: r.investedAmount,
    currentAmount: computeCurrent(r, rates),
    expectedAnnualRate: r.expectedAnnualRate,
    yieldType: r.yieldType,
    purchaseDate: r.purchaseDate,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Colunas cruas (com stored current + campos do cálculo), em camelCase. */
const RAW_COLUMNS = `
  id,
  name,
  asset_type                    AS "assetType",
  invested_amount               AS "investedAmount",
  current_amount                AS "storedCurrent",
  expected_annual_rate::float8  AS "expectedAnnualRate",
  yield_type                    AS "yieldType",
  purchase_date                 AS "purchaseDate",
  notes,
  created_at                    AS "createdAt",
  updated_at                    AS "updatedAt"
`;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createInvestment(userId: string, input: CreateInvestmentInput) {
  const current = input.currentAmount ?? input.investedAmount;
  const purchaseDate = input.purchaseDate ?? todayISO();

  const rows = await query<RawInvestment>(
    `INSERT INTO investments
       (user_id, name, asset_type, invested_amount, current_amount,
        expected_annual_rate, yield_type, purchase_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${RAW_COLUMNS}`,
    [
      userId,
      input.name,
      input.assetType,
      input.investedAmount,
      current,
      input.expectedAnnualRate,
      input.yieldType,
      purchaseDate,
      input.notes ?? null,
    ],
  );
  const rates = await getIndicatorRates();
  return toClient(rows[0], rates);
}

export async function listInvestments(userId: string, filters: ListInvestmentsQuery) {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (filters.assetType) {
    params.push(filters.assetType);
    where += ` AND asset_type = $${params.length}`;
  }

  const [rows, rates] = await Promise.all([
    query<RawInvestment>(
      `SELECT ${RAW_COLUMNS} FROM investments WHERE ${where} ORDER BY created_at DESC`,
      params,
    ),
    getIndicatorRates(),
  ]);
  // Ordena pelo valor atual CALCULADO (não dá pra ordenar no SQL).
  return rows
    .map((r) => toClient(r, rates))
    .sort((a, b) => b.currentAmount - a.currentAmount);
}

export async function getInvestment(userId: string, id: string) {
  const [rows, rates] = await Promise.all([
    query<RawInvestment>(`SELECT ${RAW_COLUMNS} FROM investments WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]),
    getIndicatorRates(),
  ]);
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
  return toClient(rows[0], rates);
}

export async function updateInvestment(userId: string, id: string, input: UpdateInvestmentInput) {
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.assetType !== undefined) fields.asset_type = input.assetType;
  if (input.investedAmount !== undefined) fields.invested_amount = input.investedAmount;
  if (input.currentAmount !== undefined) fields.current_amount = input.currentAmount;
  if (input.expectedAnnualRate !== undefined) fields.expected_annual_rate = input.expectedAnnualRate;
  if (input.yieldType !== undefined) fields.yield_type = input.yieldType;
  if (input.purchaseDate !== undefined) fields.purchase_date = input.purchaseDate;
  if (input.notes !== undefined) fields.notes = input.notes;

  const keys = Object.keys(fields);
  if (keys.length === 0) return getInvestment(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query<RawInvestment>(
    `UPDATE investments
        SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${RAW_COLUMNS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
  const rates = await getIndicatorRates();
  return toClient(rows[0], rates);
}

export async function deleteInvestment(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM investments WHERE id = $1 AND user_id = $2 RETURNING id', [
    id,
    userId,
  ]);
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
}

// ---------------------------------------------------------------------------
// Resumo de patrimônio
// ---------------------------------------------------------------------------

interface AllocationRow {
  key: string;
  label: string;
  invested: number;
  current: number;
  percentage: number;
}

interface ComputedRow {
  assetType: AssetType;
  invested: number;
  current: number; // já calculado
  rate: number; // taxa efetiva a.a. (para a média ponderada)
}

function allocate<K extends string>(
  rows: ComputedRow[],
  totalCurrent: number,
  keyOf: (r: ComputedRow) => K,
  labelOf: (k: K) => string,
): AllocationRow[] {
  const map = new Map<K, { invested: number; current: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const acc = map.get(k) ?? { invested: 0, current: 0 };
    acc.invested += r.invested;
    acc.current += r.current;
    map.set(k, acc);
  }
  return [...map.entries()]
    .map(([k, v]) => ({
      key: k,
      label: labelOf(k),
      invested: v.invested,
      current: v.current,
      percentage: totalCurrent > 0 ? round2((v.current / totalCurrent) * 100) : 0,
    }))
    .sort((a, b) => b.current - a.current);
}

export async function getInvestmentsSummary(userId: string) {
  const [raws, rates] = await Promise.all([
    query<RawInvestment>(`SELECT ${RAW_COLUMNS} FROM investments WHERE user_id = $1`, [userId]),
    getIndicatorRates(),
  ]);

  // Aplica o cálculo dinâmico do valor atual e da taxa efetiva a cada ativo.
  const rows: ComputedRow[] = raws.map((r) => ({
    assetType: r.assetType,
    invested: r.investedAmount,
    current: computeCurrent(r, rates),
    rate: effectiveAnnualRate(r, rates),
  }));

  const totalInvested = rows.reduce((s, r) => s + r.invested, 0);
  const totalCurrent = rows.reduce((s, r) => s + r.current, 0);
  const profit = totalCurrent - totalInvested;
  const profitPercentage = totalInvested > 0 ? round2((profit / totalInvested) * 100) : 0;

  const expectedAnnualRate =
    totalCurrent > 0
      ? round2(rows.reduce((s, r) => s + r.rate * r.current, 0) / totalCurrent)
      : 0;

  return {
    totals: {
      invested: totalInvested,
      current: totalCurrent,
      profit,
      profitPercentage,
      expectedAnnualRate,
      count: rows.length,
    },
    allocationByType: allocate(
      rows,
      totalCurrent,
      (r) => r.assetType,
      (k) => ASSET_META[k].label,
    ),
    allocationByClass: allocate(
      rows,
      totalCurrent,
      (r) => ASSET_META[r.assetType].class,
      (k) => CLASS_LABEL[k],
    ),
  };
}
