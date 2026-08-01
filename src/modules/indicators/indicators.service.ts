import { query } from '../../db/pool';

// API pública do Banco Central — SGS (Sistema Gerenciador de Séries Temporais).
const BCB_BASE = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';
const SERIES = {
  selicMetaAnnual: 432, // Meta Selic definida pelo Copom (% a.a.)
  cdiDaily: 12, // Taxa CDI (% ao dia) → anualizamos base 252
};
const BUSINESS_DAYS = 252;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Busca o último valor de uma série do SGS. */
async function fetchSeriesLast(code: number): Promise<number> {
  const res = await fetch(`${BCB_BASE}.${code}/dados/ultimos/1?formato=json`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`BCB série ${code}: HTTP ${res.status}`);
  const data = (await res.json()) as { data: string; valor: string }[];
  const valor = Number(data?.[0]?.valor);
  if (!Number.isFinite(valor)) throw new Error(`BCB série ${code}: valor inválido`);
  return valor;
}

/** Busca SELIC e CDI atuais no BCB, ambos anualizados (% a.a.). */
export async function fetchBcbRates(): Promise<{ SELIC: number; CDI: number }> {
  const [selicAnnual, cdiDaily] = await Promise.all([
    fetchSeriesLast(SERIES.selicMetaAnnual),
    fetchSeriesLast(SERIES.cdiDaily),
  ]);
  // O CDI vem diário (% a.d.); anualiza pela convenção de 252 dias úteis.
  const cdiAnnual = (Math.pow(1 + cdiDaily / 100, BUSINESS_DAYS) - 1) * 100;
  return { SELIC: round2(selicAnnual), CDI: round2(cdiAnnual) };
}

/** Busca no BCB e faz upsert de SELIC/CDI na tabela. Chamado pelo cron. */
export async function refreshIndicators(): Promise<{ SELIC: number; CDI: number }> {
  const rates = await fetchBcbRates();
  await query(
    `INSERT INTO economic_indicators (name, current_rate, last_updated) VALUES
       ('SELIC', $1, now()), ('CDI', $2, now())
     ON CONFLICT (name)
     DO UPDATE SET current_rate = EXCLUDED.current_rate, last_updated = now()`,
    [rates.SELIC, rates.CDI],
  );
  return rates;
}

export interface IndicatorRow {
  name: string;
  currentRate: number; // % a.a.
  lastUpdated: string;
}

export async function getIndicators(): Promise<IndicatorRow[]> {
  return query<IndicatorRow>(
    `SELECT name, current_rate::float8 AS "currentRate", last_updated AS "lastUpdated"
       FROM economic_indicators ORDER BY name`,
  );
}

/**
 * Mapa { SELIC, CDI } em % a.a. para os cálculos de rendimento dos investimentos.
 * Retorna 0 se ainda não houver dado (evita quebrar o cálculo).
 */
export async function getIndicatorRates(): Promise<{ SELIC: number; CDI: number }> {
  const rows = await getIndicators();
  const map = { SELIC: 0, CDI: 0 };
  for (const r of rows) {
    if (r.name === 'SELIC') map.SELIC = r.currentRate;
    if (r.name === 'CDI') map.CDI = r.currentRate;
  }
  return map;
}
