import type { PoolClient } from 'pg';
import { pool, query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { addDaysISO, addMonthsISO, diffDaysISO, MAX_ISO_DAY, todaySP } from '../../lib/dates';
import { monthlyFromAnnual, xirr, type CashFlow } from '../../lib/finance';
import { assertAccountUsable } from '../accounts/accounts.service';
import { getIndicatorRates } from '../indicators/indicators.service';
import type {
  CreateLoanInput,
  ReceiveInstallmentInput,
  UpdateInstallmentInput,
  UpdateLoanInput,
} from './loans.schema';

/**
 * EMPRÉSTIMOS A RECEBER — dinheiro emprestado a alguém, devolvido em parcelas.
 * Valores em CENTAVOS; "hoje" é sempre o de America/Sao_Paulo (todaySP).
 *
 * Dinheiro nas contas (mesma regra de saldo do app — LEGS_SQL em accounts):
 *  - emprestar com conta de origem → transação `loan_out` (sai do saldo; não é gasto);
 *  - "Recebi" → `loan_in` com a parte que devolve o principal (entra no saldo; não é
 *    receita) + `income` na categoria de sistema "Investimentos" com os juros (é receita);
 *  - todas essas linhas levam `loan_id` (e `loan_installment_id` nos recebimentos) e só
 *    mudam por aqui — /transactions recusa editar/excluir.
 *
 * Recebeu MENOS que o combinado: ou a diferença continua sendo cobrada (vira uma parcela
 * pendente nova logo depois desta, `remainder_of` = a de origem, e a de origem passa a
 * valer o que foi recebido), ou a parcela fica quitada e a diferença deixa de ser cobrada.
 *
 * Toda escrita roda numa transação SQL com o empréstimo travado (SELECT … FOR UPDATE):
 * dois "Recebi" simultâneos não dividem o principal errado nem duplicam lançamentos.
 */

export type InstallmentStatus = 'received' | 'overdue' | 'pending';

export interface LoanInstallment {
  id: string;
  number: number;
  dueDate: string;
  amount: number; // esperado
  status: InstallmentStatus; // overdue = pendente com vencimento antes de hoje
  receivedAt: string | null;
  receivedAmount: number | null;
  principalPortion: number | null;
  interestPortion: number | null;
  daysOverdue: number | null;
  remainderOf: number | null; // nº da parcela de que esta é a diferença (recebida a menos)
}

export interface LoanStats {
  count: number;
  receivedCount: number;
  overdueCount: number;
  overdueAmount: number;
  expectedTotal: number; // Σ (recebido nas recebidas + esperado nas pendentes)
  receivedTotal: number;
  outstanding: number; // Σ esperado das pendentes
  principalRecovered: number;
  expectedProfit: number; // expectedTotal − principal
  receivedProfit: number; // Σ juros já recebidos
  simpleReturn: number; // expectedProfit / principal × 100 (2 casas)
  monthlyRate: number | null; // % a.m. (XIRR), 2 casas
  annualRate: number | null; // % a.a. efetiva (XIRR), 2 casas
  cdiPercent: number | null; // annualRate / CDI × 100; sem CDI → null
  nextDue: { installmentId: string; number: number; dueDate: string; amount: number } | null;
}

export interface Loan {
  id: string;
  borrowerName: string;
  description: string | null;
  notes: string | null;
  principal: number;
  lentAt: string;
  sourceAccountId: string | null;
  receiveAccountId: string | null;
  status: 'active' | 'settled'; // settled = todas as parcelas recebidas (derivado)
  createdAt: string;
  updatedAt: string;
  installments: LoanInstallment[]; // ordem por number
  stats: LoanStats;
}

export interface ReceivableItem {
  installmentId: string;
  loanId: string;
  borrowerName: string;
  number: number;
  count: number; // total de parcelas do empréstimo
  dueDate: string;
  amount: number;
  daysOverdue: number | null;
  receiveAccountId: string | null;
  remainderOf: number | null; // nº da parcela de que esta é a diferença (recebida a menos)
}

/** Colunas do empréstimo em camelCase (tabela com alias `l`). */
const LOAN_COLUMNS = `
  l.id,
  l.borrower_name      AS "borrowerName",
  l.description,
  l.notes,
  l.principal,
  l.lent_at            AS "lentAt",
  l.source_account_id  AS "sourceAccountId",
  l.receive_account_id AS "receiveAccountId",
  l.created_at         AS "createdAt",
  l.updated_at         AS "updatedAt"
`;

/** Colunas da parcela em camelCase (tabela com alias `i`). */
const INSTALLMENT_COLUMNS = `
  i.id,
  i.loan_id           AS "loanId",
  i.number,
  i.due_date          AS "dueDate",
  i.amount,
  i.received_at       AS "receivedAt",
  i.received_amount   AS "receivedAmount",
  i.principal_portion AS "principalPortion",
  i.interest_portion  AS "interestPortion",
  i.remainder_of      AS "remainderOfId"
`;

interface LoanRow {
  id: string;
  borrowerName: string;
  description: string | null;
  notes: string | null;
  principal: number;
  lentAt: string;
  sourceAccountId: string | null;
  receiveAccountId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstallmentRow {
  id: string;
  loanId: string;
  number: number;
  dueDate: string;
  amount: number;
  receivedAt: string | null;
  receivedAmount: number | null;
  principalPortion: number | null;
  interestPortion: number | null;
  remainderOfId: string | null; // parcela de origem (esta é a diferença dela)
}

const NOT_FOUND = 'Empréstimo não encontrado';
const INSTALLMENT_NOT_FOUND = 'Parcela não encontrada';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Nomes de pessoas sempre em ordem alfabética pt-BR (sem diferenciar acento/caixa). */
const byName = (a: string, b: string) => a.localeCompare(b, 'pt', { sensitivity: 'base' });

/** Texto vazio (depois do trim do Zod) vira NULL no banco. */
const emptyToNull = (v: string | null | undefined) => (v ? v : null);

// Descrições dos lançamentos gerados (iguais em criar, receber e renomear).
const loanOutDescription = (name: string) => `Empréstimo para ${name}`;
const receiptDescription = (n: number, total: number, name: string) => `Parcela ${n}/${total} de ${name}`;
const interestDescription = (n: number, total: number, name: string) =>
  `Juros – empréstimo a ${name} (${n}/${total})`;

// ---------------------------------------------------------------------------
// Cálculos (puros)
// ---------------------------------------------------------------------------

function toInstallment(r: InstallmentRow, today: string, numberById: Map<string, number>): LoanInstallment {
  const received = r.receivedAt !== null;
  const overdue = !received && r.dueDate < today;
  return {
    id: r.id,
    number: r.number,
    dueDate: r.dueDate,
    amount: r.amount,
    status: received ? 'received' : overdue ? 'overdue' : 'pending',
    receivedAt: r.receivedAt,
    receivedAmount: r.receivedAmount,
    principalPortion: r.principalPortion,
    interestPortion: r.interestPortion,
    daysOverdue: overdue ? diffDaysISO(r.dueDate, today) : null,
    remainderOf: r.remainderOfId ? (numberById.get(r.remainderOfId) ?? null) : null,
  };
}

/**
 * Números do empréstimo + rentabilidade. Fluxos do XIRR: −principal na data do
 * empréstimo; +recebido na data do recebimento (parcelas recebidas); +esperado no
 * vencimento (pendentes). `cdi` = CDI anual em % (0 = indisponível → cdiPercent null).
 */
function computeStats(principal: number, lentAt: string, installments: LoanInstallment[], cdi: number): LoanStats {
  let receivedCount = 0;
  let overdueCount = 0;
  let overdueAmount = 0;
  let receivedTotal = 0;
  let outstanding = 0;
  let principalRecovered = 0;
  let receivedProfit = 0;
  let next: LoanInstallment | null = null;
  const flows: CashFlow[] = [{ date: lentAt, amount: -principal }];

  for (const i of installments) {
    if (i.status === 'received') {
      const got = i.receivedAmount ?? 0;
      receivedCount++;
      receivedTotal += got;
      principalRecovered += i.principalPortion ?? 0;
      receivedProfit += i.interestPortion ?? 0;
      flows.push({ date: i.receivedAt ?? i.dueDate, amount: got });
      continue;
    }
    outstanding += i.amount;
    if (i.status === 'overdue') {
      overdueCount++;
      overdueAmount += i.amount;
    }
    flows.push({ date: i.dueDate, amount: i.amount });
    if (!next || i.dueDate < next.dueDate || (i.dueDate === next.dueDate && i.number < next.number)) {
      next = i;
    }
  }

  const expectedTotal = receivedTotal + outstanding;
  const expectedProfit = expectedTotal - principal;
  const annual = xirr(flows); // fração (0,19 = 19% a.a.) ou null

  return {
    count: installments.length,
    receivedCount,
    overdueCount,
    overdueAmount,
    expectedTotal,
    receivedTotal,
    outstanding,
    principalRecovered,
    expectedProfit,
    receivedProfit,
    simpleReturn: round2((expectedProfit / principal) * 100),
    monthlyRate: annual === null ? null : round2(monthlyFromAnnual(annual) * 100),
    annualRate: annual === null ? null : round2(annual * 100),
    cdiPercent: annual === null || !(cdi > 0) ? null : round2(((annual * 100) / cdi) * 100),
    nextDue: next
      ? { installmentId: next.id, number: next.number, dueDate: next.dueDate, amount: next.amount }
      : null,
  };
}

function buildLoan(row: LoanRow, rows: InstallmentRow[], today: string, cdi: number): Loan {
  const numberById = new Map(rows.map((r) => [r.id, r.number]));
  const installments = [...rows]
    .sort((a, b) => a.number - b.number)
    .map((r) => toInstallment(r, today, numberById));
  const stats = computeStats(row.principal, row.lentAt, installments, cdi);
  return {
    id: row.id,
    borrowerName: row.borrowerName,
    description: row.description,
    notes: row.notes,
    principal: row.principal,
    lentAt: row.lentAt,
    sourceAccountId: row.sourceAccountId,
    receiveAccountId: row.receiveAccountId,
    status: stats.count > 0 && stats.receivedCount === stats.count ? 'settled' : 'active',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    installments,
    stats,
  };
}

/**
 * Divide um recebimento em principal + juros.
 *  - ratio = principal ÷ Σ esperado de todas as parcelas (Σ ≤ principal → 1, sem juros);
 *  - principal = round(recebido × ratio), mas NUNCA menos do que as outras parcelas
 *    pendentes deixam de cobrir (principal que falta − Σ esperado das outras pendentes):
 *    só sai juro quando o principal que falta já está garantido pelas outras;
 *  - limitado ao recebido e ao principal que ainda falta voltar. Na última parcela
 *    pendente isso dá "tudo o que falta" e o principal fecha exato;
 *  - juros = recebido − principal (≥ 0).
 * Ex.: 15.000 emprestados, 8 × 2.000 → cada parcela = 1.875 + 125 de juros. Se a 1ª vier
 * com 1.000 (diferença perdoada), ela é toda principal: as 7 restantes (14.000) não cobrem
 * os 15.000 — e o lucro final zero não vira receita de juros.
 */
export function splitReceipt(
  principal: number,
  installments: Pick<InstallmentRow, 'id' | 'amount' | 'receivedAt' | 'principalPortion'>[],
  installmentId: string,
  received: number,
): { principalPortion: number; interestPortion: number } {
  const expectedSum = installments.reduce((s, i) => s + i.amount, 0);
  const recovered = installments.reduce((s, i) => s + (i.receivedAt !== null ? i.principalPortion ?? 0 : 0), 0);
  const remaining = Math.max(0, principal - recovered);
  const otherPending = installments.reduce(
    (s, i) => s + (i.id !== installmentId && i.receivedAt === null ? i.amount : 0),
    0,
  );
  const ratio = expectedSum <= principal ? 1 : principal / expectedSum;
  const mustCover = Math.max(0, remaining - otherPending);
  const principalPortion = Math.min(received, remaining, Math.max(Math.round(received * ratio), mustCover));
  return { principalPortion, interestPortion: received - principalPortion };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/** Empréstimos do usuário (todos, ou só `loanId`) já com parcelas e números. */
async function loadLoans(userId: string, loanId?: string): Promise<Loan[]> {
  const params: unknown[] = loanId ? [userId, loanId] : [userId];
  const [loanRows, installmentRows, rates] = await Promise.all([
    query<LoanRow>(
      `SELECT ${LOAN_COLUMNS} FROM loans l
        WHERE l.user_id = $1 ${loanId ? 'AND l.id = $2' : ''}`,
      params,
    ),
    query<InstallmentRow>(
      `SELECT ${INSTALLMENT_COLUMNS} FROM loan_installments i
        WHERE i.user_id = $1 ${loanId ? 'AND i.loan_id = $2' : ''}
        ORDER BY i.loan_id, i.number`,
      params,
    ),
    getIndicatorRates(),
  ]);

  const today = todaySP();
  const byLoan = new Map<string, InstallmentRow[]>();
  for (const r of installmentRows) {
    const list = byLoan.get(r.loanId) ?? [];
    list.push(r);
    byLoan.set(r.loanId, list);
  }
  return loanRows.map((r) => buildLoan(r, byLoan.get(r.id) ?? [], today, rates.CDI));
}

/**
 * Lista os empréstimos em ordem ALFABÉTICA do nome de quem pegou (depois data do
 * empréstimo) + totais da carteira de empréstimos.
 */
export async function listLoans(userId: string) {
  const loans = await loadLoans(userId);
  loans.sort(
    (a, b) =>
      byName(a.borrowerName, b.borrowerName) ||
      (a.lentAt < b.lentAt ? -1 : a.lentAt > b.lentAt ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );

  const totals = {
    principal: 0,
    outstanding: 0,
    receivedTotal: 0,
    expectedProfit: 0,
    receivedProfit: 0,
    overdueCount: 0,
    overdueAmount: 0,
    activeCount: 0,
  };
  for (const loan of loans) {
    totals.principal += loan.principal;
    totals.outstanding += loan.stats.outstanding;
    totals.receivedTotal += loan.stats.receivedTotal;
    totals.expectedProfit += loan.stats.expectedProfit;
    totals.receivedProfit += loan.stats.receivedProfit;
    totals.overdueCount += loan.stats.overdueCount;
    totals.overdueAmount += loan.stats.overdueAmount;
    if (loan.status === 'active') totals.activeCount++;
  }
  return { data: loans, totals };
}

export async function getLoan(userId: string, id: string): Promise<Loan> {
  const [loan] = await loadLoans(userId, id);
  if (!loan) throw AppError.notFound(NOT_FOUND);
  return loan;
}

/**
 * "A receber": parcelas PENDENTES de todos os empréstimos, por vencimento (mais
 * antigo primeiro) e, no mesmo dia, pelo nome (ordem alfabética).
 * Totais: atrasado (vencimento antes de hoje), este mês (vencimento no mês corrente,
 * inclusive as já atrasadas dele), próximos 30 dias (hoje..hoje+30) e total pendente.
 */
export async function listReceivables(userId: string) {
  const rows = await query<Omit<ReceivableItem, 'daysOverdue'>>(
    `SELECT i.id               AS "installmentId",
            i.loan_id          AS "loanId",
            l.borrower_name    AS "borrowerName",
            i.number,
            c.n                AS count,
            i.due_date         AS "dueDate",
            i.amount,
            l.receive_account_id AS "receiveAccountId",
            p.number           AS "remainderOf"
       FROM loan_installments i
       JOIN loans l ON l.id = i.loan_id AND l.user_id = $1
       LEFT JOIN loan_installments p ON p.id = i.remainder_of AND p.user_id = $1
       JOIN (
         SELECT loan_id, COUNT(*)::int AS n
           FROM loan_installments
          WHERE user_id = $1
          GROUP BY loan_id
       ) c ON c.loan_id = i.loan_id
      WHERE i.user_id = $1 AND i.received_at IS NULL`,
    [userId],
  );

  const today = todaySP();
  const month = today.slice(0, 7);
  const in30 = addDaysISO(today, 30);

  const data: ReceivableItem[] = rows
    .map((r) => ({
      installmentId: r.installmentId,
      loanId: r.loanId,
      borrowerName: r.borrowerName,
      number: r.number,
      count: r.count,
      dueDate: r.dueDate,
      amount: r.amount,
      daysOverdue: r.dueDate < today ? diffDaysISO(r.dueDate, today) : null,
      receiveAccountId: r.receiveAccountId,
      remainderOf: r.remainderOf,
    }))
    .sort(
      (a, b) =>
        (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) ||
        byName(a.borrowerName, b.borrowerName) ||
        a.number - b.number,
    );

  const totals = { overdueCount: 0, overdueAmount: 0, thisMonthAmount: 0, next30Amount: 0, totalPending: 0 };
  for (const r of data) {
    totals.totalPending += r.amount;
    if (r.dueDate < today) {
      totals.overdueCount++;
      totals.overdueAmount += r.amount;
    }
    if (r.dueDate.slice(0, 7) === month) totals.thisMonthAmount += r.amount;
    if (r.dueDate >= today && r.dueDate <= in30) totals.next30Amount += r.amount;
  }
  return { data, totals };
}

/**
 * Parcelas PENDENTES somadas por mês de vencimento ('YYYY-MM'), para a previsão de
 * saldo (forecast). Atrasadas aparecem no mês em que venceram — quem chama decide
 * onde encaixá-las.
 */
export async function getPendingReceiptsByMonth(userId: string): Promise<{ ym: string; total: number }[]> {
  return query<{ ym: string; total: number }>(
    `SELECT to_char(due_date, 'YYYY-MM') AS ym, COALESCE(SUM(amount), 0)::bigint AS total
       FROM loan_installments
      WHERE user_id = $1 AND received_at IS NULL
      GROUP BY 1
      ORDER BY 1`,
    [userId],
  );
}

// ---------------------------------------------------------------------------
// Escrita (sempre numa transação SQL, com o empréstimo travado)
// ---------------------------------------------------------------------------

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Trava o empréstimo (FOR UPDATE) até o fim da transação. 404 se não for do usuário. */
async function lockLoan(client: PoolClient, userId: string, id: string): Promise<LoanRow> {
  const rows = await client.query<LoanRow>(
    `SELECT ${LOAN_COLUMNS} FROM loans l WHERE l.id = $1 AND l.user_id = $2 FOR UPDATE`,
    [id, userId],
  );
  if (rows.rows.length === 0) throw AppError.notFound(NOT_FOUND);
  return rows.rows[0];
}

/** Parcelas do empréstimo (já travado), por número. */
async function loanInstallments(client: PoolClient, userId: string, loanId: string): Promise<InstallmentRow[]> {
  const rows = await client.query<InstallmentRow>(
    `SELECT ${INSTALLMENT_COLUMNS} FROM loan_installments i
      WHERE i.loan_id = $1 AND i.user_id = $2
      ORDER BY i.number`,
    [loanId, userId],
  );
  return rows.rows;
}

/**
 * Abre (+1) ou fecha (−1) um espaço na numeração: as parcelas com número > `after`
 * andam `delta`. Em 2 passos (passando por +1.000.000) porque o UNIQUE (loan_id, number)
 * é conferido linha a linha — `number = number + 1` direto colidiria no meio do UPDATE.
 * Quem chama reescreve depois as descrições dos lançamentos (`renameReceipts`).
 */
async function shiftNumbers(client: PoolClient, userId: string, loanId: string, after: number, delta: 1 | -1) {
  await client.query(
    `UPDATE loan_installments SET number = number + 1000000
      WHERE loan_id = $1 AND user_id = $2 AND number > $3`,
    [loanId, userId, after],
  );
  await client.query(
    `UPDATE loan_installments SET number = number - 1000000 + $3
      WHERE loan_id = $1 AND user_id = $2 AND number > 1000000`,
    [loanId, userId, delta],
  );
}

function findInstallment(installments: InstallmentRow[], installmentId: string): InstallmentRow {
  const inst = installments.find((i) => i.id === installmentId);
  if (!inst) throw AppError.notFound(INSTALLMENT_NOT_FOUND);
  return inst;
}

interface LoanOutData {
  borrowerName: string;
  principal: number;
  lentAt: string;
  sourceAccountId: string | null;
}

async function insertLoanOut(client: PoolClient, userId: string, loanId: string, d: LoanOutData & { sourceAccountId: string }) {
  await client.query(
    `INSERT INTO transactions
       (user_id, account_id, category_id, amount, kind, description, occurred_at, loan_id)
     VALUES ($1, $2, NULL, $3, 'loan_out', $4, $5::date, $6)`,
    [userId, d.sourceAccountId, d.principal, loanOutDescription(d.borrowerName), d.lentAt, loanId],
  );
}

/**
 * Deixa a saída do empréstimo (`loan_out`) igual ao empréstimo: sem conta de
 * origem → nenhuma (soft-delete); com conta → exatamente uma, com conta, valor,
 * data e descrição atuais (cria se não houver).
 */
async function syncLoanOut(client: PoolClient, userId: string, loanId: string, d: LoanOutData) {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM transactions
      WHERE user_id = $1 AND loan_id = $2 AND kind = 'loan_out' AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [userId, loanId],
  );
  const [keep, ...extra] = d.sourceAccountId ? existing.rows : [];
  const toDelete = d.sourceAccountId ? extra : existing.rows;
  if (toDelete.length > 0) {
    await client.query(
      `UPDATE transactions SET deleted_at = now()
        WHERE user_id = $1 AND loan_id = $2 AND id = ANY($3::uuid[])`,
      [userId, loanId, toDelete.map((r) => r.id)],
    );
  }
  if (!d.sourceAccountId) return;

  if (keep) {
    await client.query(
      `UPDATE transactions
          SET account_id = $3, amount = $4, occurred_at = $5::date, description = $6
        WHERE id = $1 AND user_id = $2`,
      [keep.id, userId, d.sourceAccountId, d.principal, d.lentAt, loanOutDescription(d.borrowerName)],
    );
  } else {
    await insertLoanOut(client, userId, loanId, { ...d, sourceAccountId: d.sourceAccountId });
  }
}

/** Renomeou quem pegou emprestado → reescreve a descrição dos recebimentos já lançados. */
async function renameReceipts(client: PoolClient, userId: string, loanId: string, name: string, total: number) {
  const rows = await client.query<{ id: string; kind: string; number: number }>(
    `SELECT t.id, t.kind, li.number
       FROM transactions t
       JOIN loan_installments li ON li.id = t.loan_installment_id AND li.user_id = t.user_id
      WHERE t.user_id = $1 AND t.loan_id = $2 AND t.deleted_at IS NULL
        AND t.kind IN ('loan_in', 'income')`,
    [userId, loanId],
  );
  if (rows.rows.length === 0) return;
  const ids = rows.rows.map((r) => r.id);
  const descriptions = rows.rows.map((r) =>
    r.kind === 'loan_in' ? receiptDescription(r.number, total, name) : interestDescription(r.number, total, name),
  );
  await client.query(
    `UPDATE transactions t SET description = v.description
       FROM unnest($3::uuid[], $4::text[]) AS v(id, description)
      WHERE t.id = v.id AND t.user_id = $1 AND t.loan_id = $2`,
    [userId, loanId, ids, descriptions],
  );
}

/** Categoria de sistema dos juros ("Investimentos", receita). Sem ela, o juro entra sem categoria. */
async function interestCategoryId(client: PoolClient): Promise<string | null> {
  const rows = await client.query<{ id: string }>(
    `SELECT id FROM categories
      WHERE user_id IS NULL AND kind = 'income' AND name = 'Investimentos'
      ORDER BY created_at
      LIMIT 1`,
  );
  return rows.rows[0]?.id ?? null;
}

/**
 * Cadastra o empréstimo + as parcelas mensais (parcela i vence em
 * firstDueDate + (i−1) meses, com clamp de fim de mês) + a saída da conta de
 * origem, se houver. Tudo ou nada (uma transação SQL).
 */
export async function createLoan(userId: string, input: CreateLoanInput): Promise<Loan> {
  const { schedule } = input;
  if (schedule.firstDueDate < input.lentAt) {
    throw AppError.badRequest('A 1ª parcela não pode vencer antes da data do empréstimo.');
  }
  if (addMonthsISO(schedule.firstDueDate, schedule.count - 1) > MAX_ISO_DAY) {
    throw AppError.badRequest('A última parcela passaria de 2100. Diminua a quantidade de parcelas.');
  }
  await Promise.all([
    input.sourceAccountId ? assertAccountUsable(userId, input.sourceAccountId, { label: 'de origem' }) : null,
    input.receiveAccountId ? assertAccountUsable(userId, input.receiveAccountId, { label: 'de recebimento' }) : null,
  ]);

  const borrowerName = input.borrowerName;
  const id = await inTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO loans
         (user_id, borrower_name, description, notes, principal, lent_at,
          source_account_id, receive_account_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8)
       RETURNING id`,
      [
        userId,
        borrowerName,
        emptyToNull(input.description),
        emptyToNull(input.notes),
        input.principal,
        input.lentAt,
        input.sourceAccountId ?? null,
        input.receiveAccountId ?? null,
      ],
    );
    const loanId = created.rows[0].id;

    // Bulk insert das parcelas.
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (let n = 1; n <= schedule.count; n++) {
      const o = params.length;
      tuples.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}::date, $${o + 5})`);
      params.push(userId, loanId, n, addMonthsISO(schedule.firstDueDate, n - 1), schedule.amount);
    }
    await client.query(
      `INSERT INTO loan_installments (user_id, loan_id, number, due_date, amount)
       VALUES ${tuples.join(', ')}`,
      params,
    );

    if (input.sourceAccountId) {
      await insertLoanOut(client, userId, loanId, {
        borrowerName,
        principal: input.principal,
        lentAt: input.lentAt,
        sourceAccountId: input.sourceAccountId,
      });
    }
    return loanId;
  });
  return getLoan(userId, id);
}

/**
 * Edita o empréstimo. Mudar valor, data ou conta de origem atualiza (ou cria/
 * remove) a saída `loan_out`; mudar o nome reescreve as descrições dos
 * lançamentos. Mudar o valor com parcelas já recebidas → 409 (a divisão
 * principal/juros delas foi feita com o valor antigo).
 */
export async function updateLoan(userId: string, id: string, input: UpdateLoanInput): Promise<Loan> {
  await inTransaction(async (client) => {
    const cur = await lockLoan(client, userId, id);
    const installments = await loanInstallments(client, userId, id);

    const next = {
      borrowerName: input.borrowerName ?? cur.borrowerName,
      principal: input.principal ?? cur.principal,
      lentAt: input.lentAt ?? cur.lentAt,
      sourceAccountId:
        input.sourceAccountId !== undefined ? input.sourceAccountId ?? null : cur.sourceAccountId,
      receiveAccountId:
        input.receiveAccountId !== undefined ? input.receiveAccountId ?? null : cur.receiveAccountId,
    };
    const principalChanged = next.principal !== cur.principal;
    const lentAtChanged = next.lentAt !== cur.lentAt;
    const sourceChanged = next.sourceAccountId !== cur.sourceAccountId;
    const nameChanged = next.borrowerName !== cur.borrowerName;

    if (principalChanged && installments.some((i) => i.receivedAt !== null)) {
      throw AppError.conflict('Desfaça os recebimentos antes de mudar o valor emprestado.');
    }
    if (lentAtChanged) {
      if (installments.some((i) => i.dueDate < next.lentAt)) {
        throw AppError.badRequest('A data do empréstimo não pode ser depois do vencimento de uma parcela.');
      }
      if (installments.some((i) => i.receivedAt !== null && i.receivedAt < next.lentAt)) {
        throw AppError.badRequest('A data do empréstimo não pode ser depois de um recebimento já registrado.');
      }
    }
    // Conferidas na conexão da transação (uma de cada vez: um client não roda queries em paralelo).
    if (next.sourceAccountId && sourceChanged) {
      await assertAccountUsable(userId, next.sourceAccountId, { label: 'de origem', client });
    }
    if (next.receiveAccountId && next.receiveAccountId !== cur.receiveAccountId) {
      await assertAccountUsable(userId, next.receiveAccountId, { label: 'de recebimento', client });
    }

    const fields: Record<string, unknown> = {};
    if (input.borrowerName !== undefined) fields.borrower_name = next.borrowerName;
    if (input.description !== undefined) fields.description = emptyToNull(input.description);
    if (input.notes !== undefined) fields.notes = emptyToNull(input.notes);
    if (input.principal !== undefined) fields.principal = next.principal;
    if (input.lentAt !== undefined) fields.lent_at = next.lentAt;
    if (input.sourceAccountId !== undefined) fields.source_account_id = next.sourceAccountId;
    if (input.receiveAccountId !== undefined) fields.receive_account_id = next.receiveAccountId;

    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map((key) => fields[key]);
    values.push(id, userId);
    // updated_at é mantido pelo trigger trg_loans_updated.
    await client.query(
      `UPDATE loans SET ${setClauses.join(', ')}
        WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}`,
      values,
    );

    if (principalChanged || lentAtChanged || sourceChanged || nameChanged) {
      await syncLoanOut(client, userId, id, next);
    }
    if (nameChanged) await renameReceipts(client, userId, id, next.borrowerName, installments.length);
  });
  return getLoan(userId, id);
}

/** Exclui o empréstimo: soft-delete de TODOS os lançamentos ligados a ele, depois apaga (parcelas em cascata). */
export async function deleteLoan(userId: string, id: string): Promise<void> {
  await inTransaction(async (client) => {
    await lockLoan(client, userId, id);
    await client.query(
      `UPDATE transactions SET deleted_at = now()
        WHERE user_id = $1 AND loan_id = $2 AND deleted_at IS NULL`,
      [userId, id],
    );
    await client.query('DELETE FROM loans WHERE id = $1 AND user_id = $2', [id, userId]);
  });
}

/** Edita data e/ou valor de uma parcela PENDENTE (recebida → 409). */
export async function updateInstallment(
  userId: string,
  loanId: string,
  installmentId: string,
  input: UpdateInstallmentInput,
): Promise<Loan> {
  await inTransaction(async (client) => {
    const loan = await lockLoan(client, userId, loanId);
    const inst = findInstallment(await loanInstallments(client, userId, loanId), installmentId);
    if (inst.receivedAt !== null) {
      throw AppError.conflict('Esta parcela já foi recebida. Desfaça o recebimento para mudar a data ou o valor.');
    }
    if (input.dueDate !== undefined && input.dueDate < loan.lentAt) {
      throw AppError.badRequest('A parcela não pode vencer antes da data do empréstimo.');
    }

    const fields: Record<string, unknown> = {};
    if (input.dueDate !== undefined) fields.due_date = input.dueDate;
    if (input.amount !== undefined) fields.amount = input.amount;
    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map((key) => fields[key]);
    values.push(installmentId, loanId, userId);
    await client.query(
      `UPDATE loan_installments SET ${setClauses.join(', ')}
        WHERE id = $${keys.length + 1} AND loan_id = $${keys.length + 2} AND user_id = $${keys.length + 3}`,
      values,
    );
  });
  return getLoan(userId, loanId);
}

/**
 * "Recebi": registra o recebimento da parcela. Conta = a escolhida ou a padrão do
 * empréstimo (nenhuma → 400); data = hoje (SP) se não vier; valor = o da parcela
 * se não vier. Lança o `loan_in` (principal) e, se houver juros, o `income`
 * (categoria Investimentos). Já recebida → 409.
 *
 * Recebido MENOR que a parcela:
 *  - com `remainderDueDate`: a diferença continua sendo cobrada — vira uma parcela
 *    pendente nova logo depois desta (as seguintes andam +1), vencendo nessa data, e
 *    esta passa a valer o que foi recebido (o total esperado não muda);
 *  - sem: a parcela fica quitada com o valor recebido e a diferença deixa de ser
 *    cobrada (sai do A receber, da previsão e do lucro esperado).
 */
export async function receiveInstallment(
  userId: string,
  loanId: string,
  installmentId: string,
  input: ReceiveInstallmentInput,
): Promise<Loan> {
  await inTransaction(async (client) => {
    const loan = await lockLoan(client, userId, loanId);
    const installments = await loanInstallments(client, userId, loanId);
    const inst = findInstallment(installments, installmentId);
    if (inst.receivedAt !== null) throw AppError.conflict('Esta parcela já foi recebida.');

    const accountId = input.accountId ?? loan.receiveAccountId;
    if (!accountId) throw AppError.badRequest('Escolha a conta onde o dinheiro entrou.');
    await assertAccountUsable(userId, accountId, { client });

    const receivedAt = input.receivedAt ?? todaySP();
    if (receivedAt < loan.lentAt) {
      throw AppError.badRequest('A data do recebimento não pode ser antes da data do empréstimo.');
    }
    const received = input.amount ?? inst.amount;
    const shortfall = inst.amount - received;
    const carryDueDate = shortfall > 0 ? (input.remainderDueDate ?? null) : null;
    if (carryDueDate !== null && carryDueDate < loan.lentAt) {
      throw AppError.badRequest('A diferença não pode vencer antes da data do empréstimo.');
    }

    // Divisão principal/juros com o cronograma como fica DEPOIS deste recebimento.
    const planned = carryDueDate
      ? [
          ...installments.map((i) => (i.id === inst.id ? { ...i, amount: received } : i)),
          { id: '', amount: shortfall, receivedAt: null, principalPortion: null },
        ]
      : installments;
    const { principalPortion, interestPortion } = splitReceipt(loan.principal, planned, inst.id, received);
    const total = installments.length + (carryDueDate ? 1 : 0);

    if (carryDueDate) {
      await shiftNumbers(client, userId, loanId, inst.number, 1);
      await client.query(
        `INSERT INTO loan_installments (user_id, loan_id, number, due_date, amount, remainder_of)
         VALUES ($1, $2, $3, $4::date, $5, $6)`,
        [userId, loanId, inst.number + 1, carryDueDate, shortfall, inst.id],
      );
    }

    if (principalPortion > 0) {
      await client.query(
        `INSERT INTO transactions
           (user_id, account_id, category_id, amount, kind, description, occurred_at,
            loan_id, loan_installment_id)
         VALUES ($1, $2, NULL, $3, 'loan_in', $4, $5::date, $6, $7)`,
        [
          userId,
          accountId,
          principalPortion,
          receiptDescription(inst.number, total, loan.borrowerName),
          receivedAt,
          loanId,
          inst.id,
        ],
      );
    }
    if (interestPortion > 0) {
      await client.query(
        `INSERT INTO transactions
           (user_id, account_id, category_id, amount, kind, description, occurred_at,
            loan_id, loan_installment_id)
         VALUES ($1, $2, $3, $4, 'income', $5, $6::date, $7, $8)`,
        [
          userId,
          accountId,
          await interestCategoryId(client),
          interestPortion,
          interestDescription(inst.number, total, loan.borrowerName),
          receivedAt,
          loanId,
          inst.id,
        ],
      );
    }

    await client.query(
      `UPDATE loan_installments
          SET received_at = $3::date, received_amount = $4,
              principal_portion = $5, interest_portion = $6, amount = $7
        WHERE id = $1 AND user_id = $2`,
      [inst.id, userId, receivedAt, received, principalPortion, interestPortion, carryDueDate ? received : inst.amount],
    );
    // A numeração mudou ("Parcela 4/8" virou "5/9"): reescreve as descrições dos recebimentos.
    if (carryDueDate) await renameReceipts(client, userId, loanId, loan.borrowerName, total);
  });
  return getLoan(userId, loanId);
}

/**
 * Desfaz o recebimento: soft-delete dos lançamentos da parcela e limpa os campos dela.
 * Se o recebimento tinha deixado a diferença numa parcela nova (pendente), ela é apagada,
 * o valor volta para esta e a numeração fecha o espaço. Diferença já recebida → 409.
 */
export async function undoReceive(userId: string, loanId: string, installmentId: string): Promise<Loan> {
  await inTransaction(async (client) => {
    const loan = await lockLoan(client, userId, loanId);
    const installments = await loanInstallments(client, userId, loanId);
    const inst = findInstallment(installments, installmentId);
    if (inst.receivedAt === null) throw AppError.conflict('Esta parcela ainda não foi recebida.');
    const remainder = installments.find((i) => i.remainderOfId === inst.id) ?? null;
    if (remainder && remainder.receivedAt !== null) {
      throw AppError.conflict(
        `A diferença desta parcela já foi recebida (parcela ${remainder.number}/${installments.length}). ` +
          'Desfaça aquele recebimento antes.',
      );
    }

    await client.query(
      `UPDATE transactions SET deleted_at = now()
        WHERE user_id = $1 AND loan_id = $2 AND loan_installment_id = $3 AND deleted_at IS NULL`,
      [userId, loanId, inst.id],
    );
    if (remainder) {
      await client.query('DELETE FROM loan_installments WHERE id = $1 AND loan_id = $2 AND user_id = $3', [
        remainder.id,
        loanId,
        userId,
      ]);
      await shiftNumbers(client, userId, loanId, remainder.number, -1);
    }
    await client.query(
      `UPDATE loan_installments
          SET received_at = NULL, received_amount = NULL,
              principal_portion = NULL, interest_portion = NULL, amount = $3
        WHERE id = $1 AND user_id = $2`,
      [inst.id, userId, inst.amount + (remainder?.amount ?? 0)],
    );
    if (remainder) await renameReceipts(client, userId, loanId, loan.borrowerName, installments.length - 1);
  });
  return getLoan(userId, loanId);
}
