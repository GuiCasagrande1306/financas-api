import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type {
  AssetType,
  CreateInvestmentInput,
  ListInvestmentsQuery,
  UpdateInvestmentInput,
} from './investments.schema';

/**
 * Metadados de cada tipo de ativo: rótulo amigável (pt-BR) e a CLASSE de mercado
 * usada na alocação da carteira (Renda Fixa vs Renda Variável). Assim o resumo
 * entrega tanto o detalhe por tipo quanto o corte que o usuário pediu de exemplo
 * ("40% Renda Fixa, 60% Renda Variável").
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

/** Duas casas decimais (percentuais/taxas). */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Colunas devolvidas ao cliente, já em camelCase. `expected_annual_rate` é
 * NUMERIC — o node-postgres o devolveria como string; forçamos float8 para o
 * JSON sair como número.
 */
const INV_COLUMNS = `
  id,
  name,
  asset_type                    AS "assetType",
  invested_amount               AS "investedAmount",
  current_amount                AS "currentAmount",
  expected_annual_rate::float8  AS "expectedAnnualRate",
  notes,
  created_at                    AS "createdAt",
  updated_at                    AS "updatedAt"
`;

export async function createInvestment(userId: string, input: CreateInvestmentInput) {
  // Aporte novo vale, por padrão, o que custou.
  const current = input.currentAmount ?? input.investedAmount;

  const rows = await query(
    `INSERT INTO investments
       (user_id, name, asset_type, invested_amount, current_amount, expected_annual_rate, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${INV_COLUMNS}`,
    [
      userId,
      input.name,
      input.assetType,
      input.investedAmount,
      current,
      input.expectedAnnualRate,
      input.notes ?? null,
    ],
  );
  return rows[0];
}

export async function listInvestments(userId: string, filters: ListInvestmentsQuery) {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (filters.assetType) {
    params.push(filters.assetType);
    where += ` AND asset_type = $${params.length}`;
  }

  return query(
    `SELECT ${INV_COLUMNS} FROM investments
      WHERE ${where}
      ORDER BY current_amount DESC, created_at DESC`,
    params,
  );
}

export async function getInvestment(userId: string, id: string) {
  const rows = await query(
    `SELECT ${INV_COLUMNS} FROM investments WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
  return rows[0];
}

export async function updateInvestment(userId: string, id: string, input: UpdateInvestmentInput) {
  // Monta o SET dinamicamente só com os campos enviados (updated_at via trigger).
  const fields: Record<string, unknown> = {};
  if (input.name !== undefined) fields.name = input.name;
  if (input.assetType !== undefined) fields.asset_type = input.assetType;
  if (input.investedAmount !== undefined) fields.invested_amount = input.investedAmount;
  if (input.currentAmount !== undefined) fields.current_amount = input.currentAmount;
  if (input.expectedAnnualRate !== undefined) fields.expected_annual_rate = input.expectedAnnualRate;
  if (input.notes !== undefined) fields.notes = input.notes;

  const keys = Object.keys(fields);
  if (keys.length === 0) return getInvestment(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query(
    `UPDATE investments
        SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}
      RETURNING ${INV_COLUMNS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
  return rows[0];
}

export async function deleteInvestment(userId: string, id: string): Promise<void> {
  const rows = await query('DELETE FROM investments WHERE id = $1 AND user_id = $2 RETURNING id', [
    id,
    userId,
  ]);
  if (rows.length === 0) throw AppError.notFound('Investimento não encontrado');
}

interface AllocationRow {
  key: string;
  label: string;
  invested: number;
  current: number;
  percentage: number; // % do saldo atual total da carteira
}

/** Agrupa a carteira por uma chave (tipo ou classe) e calcula o % de alocação. */
function allocate<K extends string>(
  rows: SummaryRow[],
  totalCurrent: number,
  keyOf: (r: SummaryRow) => K,
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

interface SummaryRow {
  assetType: AssetType;
  invested: number;
  current: number;
  rate: number;
}

/**
 * Resumo de patrimônio para os gráficos: total investido, saldo atual,
 * lucro/prejuízo (absoluto e %), retorno anual esperado ponderado e a alocação
 * da carteira por tipo de ativo e por classe (Renda Fixa/Variável). Tudo em
 * CENTAVOS, exceto os percentuais/taxas.
 */
export async function getInvestmentsSummary(userId: string) {
  const rows = await query<SummaryRow>(
    `SELECT asset_type                   AS "assetType",
            invested_amount              AS invested,
            current_amount               AS current,
            expected_annual_rate::float8 AS rate
       FROM investments
      WHERE user_id = $1`,
    [userId],
  );

  const totalInvested = rows.reduce((s, r) => s + r.invested, 0);
  const totalCurrent = rows.reduce((s, r) => s + r.current, 0);
  const profit = totalCurrent - totalInvested;
  const profitPercentage = totalInvested > 0 ? round2((profit / totalInvested) * 100) : 0;

  // Retorno anual esperado da carteira: média das taxas ponderada pelo valor atual.
  const expectedAnnualRate =
    totalCurrent > 0
      ? round2(rows.reduce((s, r) => s + r.rate * r.current, 0) / totalCurrent)
      : 0;

  return {
    totals: {
      invested: totalInvested,
      current: totalCurrent,
      profit, // negativo = prejuízo
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
