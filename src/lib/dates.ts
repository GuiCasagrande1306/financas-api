import { AppError } from './AppError';

/**
 * Datas de CALENDÁRIO do app (strings 'YYYY-MM-DD', iguais ao DATE do banco).
 *
 * "Hoje" é SEMPRE o dia em America/Sao_Paulo — nunca o do servidor. O Render
 * roda em UTC: depois das 21h de Brasília o relógio do servidor já está no dia
 * seguinte, e um gasto lançado à noite cairia "amanhã" (ou no mês seguinte).
 *
 * As contas de calendário abaixo usam Date.UTC + getters UTC de propósito:
 * assim o fuso do processo nunca desloca o dia.
 */

const SP_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}); // en-CA formata como 'YYYY-MM-DD'

/** Data de hoje ('YYYY-MM-DD') no fuso America/Sao_Paulo. */
export function todaySP(): string {
  return SP_DATE.format(new Date());
}

/** Mês corrente ('YYYY-MM') no fuso America/Sao_Paulo. */
export function currentMonthSP(): string {
  return todaySP().slice(0, 7);
}

/** Ano corrente (ex.: 2026) no fuso America/Sao_Paulo. */
export function currentYearSP(): number {
  return Number(todaySP().slice(0, 4));
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Faixa de datas aceita na ENTRADA da API (schema `isoDay` em lib/zod.ts).
 * Fora dela não há caso de uso real, e datas como '9999-12-31' quebrariam as
 * contas de calendário: o dia seguinte vira '+010000-01-01', que na comparação
 * de string é MENOR que '9999-12-31' (laço infinito travando a API inteira).
 */
export const MIN_ISO_DAY = '1900-01-01';
export const MAX_ISO_DAY = '2100-12-31';
export const DATE_RANGE_MESSAGE = 'Data fora do intervalo permitido (1900–2100).';

/** Date em meia-noite UTC de uma data 'YYYY-MM-DD' (use só com getters UTC). */
export function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/**
 * 'YYYY-MM-DD' de um Date, lido em UTC. Sempre 4 dígitos de ano: data inválida
 * ou ano fora de 0000–9999 lança 400 (o toISOString geraria '+010000-…', que
 * estraga qualquer comparação de string entre datas).
 */
export function isoUTC(d: Date): string {
  const year = d.getUTCFullYear();
  if (!Number.isFinite(year) || year < 0 || year > 9999) {
    throw AppError.badRequest(DATE_RANGE_MESSAGE);
  }
  return `${String(year).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Monta 'YYYY-MM-DD' a partir de (ano, mês 0–11, dia). Valores fora da faixa
 * "rolam" como no Date (mês 12 = janeiro do ano seguinte, dia 0 = último do mês anterior).
 */
export function isoDate(year: number, monthIndex: number, day: number): string {
  return isoUTC(new Date(Date.UTC(year, monthIndex, day)));
}

/** Limita o dia ao último dia válido do mês (trata Fev e meses de 30/31 dias). mês 0–11. */
export function clampDay(year: number, monthIndex: number, day: number): number {
  return Math.min(day, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate());
}

/**
 * Soma `add` meses a uma data 'YYYY-MM-DD' com CLAMP no fim do mês.
 * Ex.: 31/01 + 1 mês => 28/02 (nunca "vaza" para 03/03 como o Date puro faria).
 */
export function addMonthsISO(iso: string, add: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = m - 1 + add;
  const year = y + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12; // 0–11
  const day = clampDay(year, month, d);
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Soma `add` meses a um mês 'YYYY-MM'. Ex.: '2026-12' + 1 => '2027-01'. */
export function addMonthsYM(ym: string, add: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = m - 1 + add;
  const year = y + Math.floor(idx / 12);
  const month = ((idx % 12) + 12) % 12;
  return `${year}-${pad2(month + 1)}`;
}

/** Soma `days` dias a uma data 'YYYY-MM-DD'. */
export function addDaysISO(iso: string, days: number): string {
  const d = utcDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return isoUTC(d);
}

/** Dias entre duas datas 'YYYY-MM-DD' (to − from). Mesmo dia = 0. */
export function diffDaysISO(from: string, to: string): number {
  return Math.round((utcDate(to).getTime() - utcDate(from).getTime()) / 86_400_000);
}

/** Dia da semana de uma data 'YYYY-MM-DD': 0 = domingo … 6 = sábado. */
export function weekdayISO(iso: string): number {
  return utcDate(iso).getUTCDay();
}

/** Último dia do mês de uma data 'YYYY-MM-DD' (também em 'YYYY-MM-DD'). */
export function endOfMonthISO(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return isoDate(y, m, 0); // dia 0 do mês seguinte = último dia deste
}

/** 'YYYY-MM-DD' → 'dd/MM' (rótulo curto pt-BR, sem passar por Date). */
export function shortDateBR(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/**
 * Valida um intervalo from..to de datas 'YYYY-MM-DD' vindo do cliente:
 * from <= to e no máximo `maxSpanDays` dias entre as duas (to − from).
 * Lança 400 com mensagem clara; devolve o nº de dias do intervalo (inclusivo).
 */
export function assertDateRange(from: string, to: string, maxSpanDays: number): number {
  const span = diffDaysISO(from, to);
  if (span < 0) throw AppError.badRequest('A data inicial não pode ser depois da data final.');
  if (span > maxSpanDays) {
    throw AppError.badRequest(`Período muito longo: o máximo é de ${maxSpanDays} dias.`);
  }
  return span + 1;
}
