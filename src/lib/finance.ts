import { diffDaysISO } from './dates';

/**
 * Matemática financeira do app (taxa interna de retorno com datas — XIRR).
 *
 * Usada na rentabilidade dos empréstimos a receber. O frontend repete a MESMA
 * fórmula (src/lib/finance.ts do app) só para a prévia ao vivo do formulário:
 * qualquer mudança aqui tem de ir para lá também.
 *
 * Convenções:
 *  - taxas são FRAÇÕES (0,19 = 19% a.a.) — quem mostra em % é o service;
 *  - prazo de cada fluxo = dias corridos desde o fluxo mais antigo ÷ 365
 *    (a raiz não depende da data de referência: trocar a data-base só
 *    multiplica a soma inteira por uma constante).
 */

/** Fluxo de caixa datado. `amount` com sinal: negativo = saiu, positivo = voltou (ex.: centavos). */
export interface CashFlow {
  date: string; // 'YYYY-MM-DD'
  amount: number;
}

const DAYS_PER_YEAR = 365;
const NEWTON_GUESS = 0.1;
const NEWTON_MAX_ITER = 100;
const BISECTION_MAX_ITER = 300;
const RATE_TOLERANCE = 1e-12;
/**
 * Teto da taxa: 1e4 = +1.000.000% a.a. Acima disso o número não diz nada (ex.: R$ 1.000
 * que voltam R$ 1.100 em 1 ou 2 dias dariam 10¹⁷% ou 10⁹% a.a.) — vira null ("sem taxa").
 */
const MAX_RATE = 1e4;

interface Point {
  t: number; // anos desde o fluxo mais antigo
  amount: number;
}

/** Valor presente líquido a uma taxa anual efetiva `rate`. */
function npv(points: Point[], rate: number): number {
  let sum = 0;
  for (const p of points) sum += p.amount / Math.pow(1 + rate, p.t);
  return sum;
}

/** Derivada do VPL em relação à taxa. */
function npvDerivative(points: Point[], rate: number): number {
  let sum = 0;
  for (const p of points) sum += (-p.t * p.amount) / Math.pow(1 + rate, p.t + 1);
  return sum;
}

/** O VPL em `rate` é ~0? (tolerância relativa ao tamanho dos fluxos) */
function isRoot(points: Point[], rate: number, scale: number): boolean {
  const v = npv(points, rate);
  return Number.isFinite(v) && Math.abs(v) <= scale * 1e-9;
}

// Taxas candidatas para cercar a raiz quando o Newton não converge (de perto de −100% ao teto).
const BRACKET_GRID = [-0.999999, -0.9999, -0.999, -0.99, -0.9, -0.5, 0, 0.5, 1, 2, 5, 10, 100, 1e3, MAX_RATE];

function bisection(points: Point[]): number | null {
  for (let i = 0; i < BRACKET_GRID.length - 1; i++) {
    let lo = BRACKET_GRID[i];
    let hi = BRACKET_GRID[i + 1];
    let fLo = npv(points, lo);
    const fHi = npv(points, hi);
    if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) continue;
    if (fLo === 0) return lo;
    if (fHi === 0) return hi;
    if (Math.sign(fLo) === Math.sign(fHi)) continue;

    for (let k = 0; k < BISECTION_MAX_ITER; k++) {
      const mid = (lo + hi) / 2;
      const fMid = npv(points, mid);
      if (fMid === 0 || hi - lo <= RATE_TOLERANCE * (1 + Math.abs(mid))) return mid;
      if (Math.sign(fMid) === Math.sign(fLo)) {
        lo = mid;
        fLo = fMid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }
  return null;
}

/**
 * XIRR: taxa anual EFETIVA `r` que zera Σ CF_i / (1+r)^(dias_i/365).
 * Newton–Raphson a partir de 10% a.a.; se não convergir, bisseção num
 * intervalo que cerque a raiz. Sem solução (só saídas, só entradas, tudo no
 * mesmo dia ou nenhuma raiz em −100%..+10⁶% a.a., o teto MAX_RATE) → null.
 */
export function xirr(flows: CashFlow[]): number | null {
  const valid = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (!valid.some((f) => f.amount < 0) || !valid.some((f) => f.amount > 0)) return null;

  const start = valid.reduce((min, f) => (f.date < min ? f.date : min), valid[0].date);
  const points: Point[] = valid.map((f) => ({
    t: diffDaysISO(start, f.date) / DAYS_PER_YEAR,
    amount: f.amount,
  }));
  if (points.every((p) => p.t === 0)) return null;

  const scale = points.reduce((s, p) => s + Math.abs(p.amount), 0);

  // 1) Newton–Raphson.
  let rate = NEWTON_GUESS;
  for (let i = 0; i < NEWTON_MAX_ITER; i++) {
    const value = npv(points, rate);
    const slope = npvDerivative(points, rate);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || slope === 0) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) <= RATE_TOLERANCE * (1 + Math.abs(rate))) {
      if (next <= MAX_RATE && isRoot(points, next, scale)) return next;
      break;
    }
    rate = next;
  }

  // 2) Bisseção (fallback).
  const root = bisection(points);
  return root !== null && Number.isFinite(root) && root > -1 && root <= MAX_RATE && isRoot(points, root, scale)
    ? root
    : null;
}

/** Taxa mensal equivalente a uma taxa anual efetiva: (1+r)^(1/12) − 1 (frações). */
export function monthlyFromAnnual(annual: number): number {
  return Math.pow(1 + annual, 1 / 12) - 1;
}
