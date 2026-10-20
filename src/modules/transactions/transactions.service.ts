import { randomUUID } from 'node:crypto';
import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { addMonthsISO, addMonthsYM, todaySP } from '../../lib/dates';
import { assertAccountUsable, getOrCreateDefaultAccount } from '../accounts/accounts.service';
import { cycleForMonth, findCard, invoiceMonthOf } from '../credit-cards/credit-cards.service';
import {
  TX_COLUMNS,
  type CreateTransactionInput,
  type ListTransactionsQuery,
  type TransactionRow,
  type UpdateTransactionInput,
} from './transactions.schema';

type TxKind = TransactionRow['kind'];

/** Lançamentos de empréstimo só nascem e mudam pela tela de Empréstimos (módulo loans). */
const LOAN_LOCKED_MESSAGE = 'Este lançamento é de um empréstimo. Altere pela tela de Empréstimos.';
const LOAN_KIND_MESSAGE =
  'Empréstimo se cadastra em Investimentos → Empréstimos (o app lança a saída e os recebimentos sozinho).';
const isLoanKind = (kind: TxKind | undefined) => kind === 'loan_out' || kind === 'loan_in';

/** Garante que a categoria (se informada) pertence ao usuário ou é do sistema. */
async function assertCategoryValid(userId: string, categoryId?: string | null): Promise<void> {
  if (!categoryId) return;
  const rows = await query(
    'SELECT id FROM categories WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)',
    [categoryId, userId],
  );
  if (rows.length === 0) throw AppError.badRequest('Categoria inválida');
}

/** Cartão (vindo do cliente) tem de ser do usuário. Devolve o dia de fechamento. */
async function assertCardOwned(userId: string, cardId: string): Promise<{ closingDay: number }> {
  const card = await findCard(userId, cardId);
  if (!card) throw AppError.badRequest('Cartão não encontrado');
  return { closingDay: card.closingDay };
}

interface SourceInput {
  kind: TxKind;
  accountId: string | null;
  transferAccountId: string | null;
  creditCardId: string | null;
}

/** Quais ids são escolhas NOVAS (só elas são conferidas e não podem estar arquivadas). */
interface SourceChecks {
  account: boolean;
  transferAccount: boolean;
  card: boolean;
}

interface ResolvedSource {
  accountId: string;
  transferAccountId: string | null;
  creditCardId: string | null;
  closingDay: number | null; // fechamento do cartão, se a compra é no crédito e o cartão foi conferido
}

/**
 * Valida "de onde saiu / para onde foi" o dinheiro (spec §4.3) e devolve a
 * origem pronta para gravar:
 *  - transfer: exige conta de origem e de destino, diferentes, do usuário e não
 *    arquivadas; cartão não pode (pagamento de fatura tem rota própria);
 *  - expense/income: sem conta de destino; conta opcional (sem ela → conta
 *    padrão; com ela → do usuário e não arquivada); cartão, se vier, do usuário.
 * Ids que não mudaram numa edição não são reconferidos (linha antiga pode
 * manter a conta arquivada).
 */
async function resolveSource(userId: string, src: SourceInput, checks: SourceChecks): Promise<ResolvedSource> {
  if (src.kind === 'transfer') {
    if (src.creditCardId) {
      throw AppError.badRequest('Para pagar fatura use o botão Pagar fatura do cartão.');
    }
    if (!src.accountId || !src.transferAccountId) {
      throw AppError.badRequest('Transferência precisa da conta de origem e da conta de destino.');
    }
    if (src.accountId === src.transferAccountId) {
      throw AppError.badRequest('A conta de origem e a de destino precisam ser diferentes.');
    }
    await Promise.all([
      checks.account ? assertAccountUsable(userId, src.accountId, { label: 'de origem' }) : null,
      checks.transferAccount
        ? assertAccountUsable(userId, src.transferAccountId, { label: 'de destino' })
        : null,
    ]);
    return {
      accountId: src.accountId,
      transferAccountId: src.transferAccountId,
      creditCardId: null,
      closingDay: null,
    };
  }

  if (src.transferAccountId) {
    throw AppError.badRequest('Só transferência tem conta de destino.');
  }

  const [accountId, card] = await Promise.all([
    src.accountId
      ? checks.account
        ? assertAccountUsable(userId, src.accountId).then((a) => a.id)
        : Promise.resolve(src.accountId)
      : getOrCreateDefaultAccount(userId),
    src.creditCardId && checks.card ? assertCardOwned(userId, src.creditCardId) : null,
  ]);
  return {
    accountId,
    transferAccountId: null,
    creditCardId: src.creditCardId,
    closingDay: card?.closingDay ?? null,
  };
}

export async function createTransaction(userId: string, input: CreateTransactionInput) {
  const kind = input.kind ?? 'expense';
  if (isLoanKind(kind)) throw AppError.badRequest(LOAN_KIND_MESSAGE);
  const parcels = input.installments ?? 1;
  if (kind === 'transfer' && parcels > 1) {
    throw AppError.badRequest('Transferência não pode ser parcelada.');
  }

  const [source] = await Promise.all([
    resolveSource(
      userId,
      {
        kind,
        accountId: input.accountId ?? null,
        transferAccountId: input.transferAccountId ?? null,
        creditCardId: input.creditCardId ?? null,
      },
      { account: true, transferAccount: true, card: true },
    ),
    kind === 'transfer' ? null : assertCategoryValid(userId, input.categoryId),
  ]);

  // Transferência não é gasto nem receita → nunca tem categoria.
  const categoryId = kind === 'transfer' ? null : input.categoryId ?? null;
  const baseDate = input.occurredAt ?? todaySP();
  const baseDesc = (input.description ?? '').trim();

  // À vista (1x): uma única transação, como sempre.
  if (parcels <= 1) {
    const rows = await query(
      `INSERT INTO transactions
         (user_id, account_id, transfer_account_id, category_id, amount, kind, description,
          merchant, occurred_at, notes, credit_card_id, installments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12)
       RETURNING ${TX_COLUMNS}`,
      [
        userId,
        source.accountId,
        source.transferAccountId,
        categoryId,
        input.amount,
        kind,
        input.description ?? null,
        input.merchant ?? null,
        baseDate,
        input.notes ?? null,
        source.creditCardId,
        null,
      ],
    );
    return rows[0];
  }

  // Parcelado: fatia o TOTAL em N parcelas. A divisão em centavos pode sobrar —
  // a sobra vai na 1ª parcela para que a soma feche exatamente com o total.
  const base = Math.floor(input.amount / parcels);
  const remainder = input.amount - base * parcels;
  // Mesmo id em TODAS as parcelas desta compra → permite apagá-las em massa depois.
  const groupId = randomUUID();

  // No cartão, cada parcela tem de cair numa fatura diferente: a parcela i vai na
  // fatura da compra + (i−1) meses. Com compra no dia 29–31 e fechamento ≥ 28, a
  // data "compra + (i−1) meses" (com clamp) pode cair ANTES do ciclo da fatura-alvo
  // (duas parcelas na mesma fatura e um mês vazio) — aí a parcela vai para o
  // primeiro dia do ciclo da fatura-alvo.
  const closingDay = source.closingDay;
  const firstInvoice = closingDay !== null ? invoiceMonthOf(closingDay, baseDate) : null;

  const tuples: string[] = [];
  const params: unknown[] = [];
  for (let i = 1; i <= parcels; i++) {
    const amount = i === 1 ? base + remainder : base;
    let occurredAt = addMonthsISO(baseDate, i - 1); // parcela 1 = mês base, 2 = +1 mês…
    if (closingDay !== null && firstInvoice) {
      const [ty, tm] = addMonthsYM(firstInvoice, i - 1).split('-').map(Number);
      const cycle = cycleForMonth(closingDay, ty, tm - 1);
      if (occurredAt < cycle.start || occurredAt > cycle.end) occurredAt = cycle.start;
    }
    const label = `${i}/${parcels}`;
    const description = baseDesc ? `${baseDesc} (${label})` : `Parcela ${label}`;

    const o = params.length;
    tuples.push(
      `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}::date, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12})`,
    );
    params.push(
      userId,
      source.accountId,
      categoryId,
      amount,
      kind,
      description,
      input.merchant ?? null,
      occurredAt,
      input.notes ?? null,
      source.creditCardId,
      label,
      groupId,
    );
  }

  // Bulk insert: todas as parcelas de uma vez.
  const rows = await query(
    `INSERT INTO transactions
       (user_id, account_id, category_id, amount, kind, description, merchant,
        occurred_at, notes, credit_card_id, installments, installment_group_id)
     VALUES ${tuples.join(', ')}
     RETURNING ${TX_COLUMNS}`,
    params,
  );
  return rows[0]; // a resposta 201 devolve a 1ª parcela
}

/** Filtro de conta/cartão vindo do cliente: confere a posse antes de usar. */
async function assertFilterOwnership(userId: string, filters: ListTransactionsQuery): Promise<void> {
  await Promise.all([
    filters.accountId
      ? query('SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2', [filters.accountId, userId]).then(
          (rows) => {
            if (rows.length === 0) throw AppError.notFound('Conta não encontrada');
          },
        )
      : null,
    filters.creditCardId
      ? findCard(userId, filters.creditCardId).then((card) => {
          if (!card) throw AppError.notFound('Cartão não encontrado');
        })
      : null,
  ]);
}

export async function listTransactions(userId: string, filters: ListTransactionsQuery) {
  await assertFilterOwnership(userId, filters);

  const where: string[] = ['t.user_id = $1', 't.deleted_at IS NULL'];
  const params: unknown[] = [userId];

  if (filters.kind) {
    params.push(filters.kind);
    where.push(`t.kind = $${params.length}`);
  }
  if (filters.categoryId) {
    params.push(filters.categoryId);
    where.push(`t.category_id = $${params.length}`);
  }
  if (filters.accountId) {
    // Linhas que MOVEM a conta — nunca só account_id = X: compra no cartão também
    // guarda account_id (conta padrão) e não sai da conta.
    params.push(filters.accountId);
    const p = `$${params.length}`;
    where.push(
      `((t.account_id = ${p} AND (t.credit_card_id IS NULL OR t.kind = 'transfer')) OR t.transfer_account_id = ${p})`,
    );
  }
  if (filters.creditCardId) {
    // Compras/estornos do cartão + pagamentos da fatura.
    params.push(filters.creditCardId);
    where.push(`t.credit_card_id = $${params.length}`);
  }
  if (filters.search) {
    // Busca parcial case-insensitive no nome (descrição) e no estabelecimento.
    params.push(`%${filters.search}%`);
    where.push(`(t.description ILIKE $${params.length} OR t.merchant ILIKE $${params.length})`);
  }
  if (filters.from) {
    params.push(filters.from);
    where.push(`t.occurred_at >= $${params.length}::date`);
  }
  if (filters.to) {
    params.push(filters.to);
    where.push(`t.occurred_at <= $${params.length}::date`);
  }

  const whereSql = where.join(' AND ');
  const whereParams = [...params]; // snapshot antes de acrescentar limit/offset

  params.push(filters.limit);
  const limitIdx = params.length;
  params.push(filters.offset);
  const offsetIdx = params.length;

  const data = await query(
    `SELECT ${TX_COLUMNS}
       FROM transactions t
      WHERE ${whereSql}
      ORDER BY t.occurred_at DESC, t.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const totalRows = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transactions t WHERE ${whereSql}`,
    whereParams,
  );

  return {
    data,
    pagination: {
      total: totalRows[0].count,
      limit: filters.limit,
      offset: filters.offset,
    },
  };
}

export async function getTransaction(userId: string, id: string) {
  const rows = await query(
    `SELECT ${TX_COLUMNS} FROM transactions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (rows.length === 0) throw AppError.notFound('Transação não encontrada');
  return rows[0];
}

/** Aplica o SET dinâmico (só os campos em `fields`) e devolve a transação atualizada. */
async function applyUpdate(userId: string, id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getTransaction(userId, id);

  const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
  setClauses.push('updated_at = now()');
  const values = keys.map((key) => fields[key]);
  values.push(id, userId);

  const rows = await query(
    `UPDATE transactions
        SET ${setClauses.join(', ')}
      WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2} AND deleted_at IS NULL
      RETURNING ${TX_COLUMNS}`,
    values,
  );
  if (rows.length === 0) throw AppError.notFound('Transação não encontrada');
  return rows[0];
}

/**
 * Edita uma transação. Carrega a linha atual, mescla com o patch e valida o
 * RESULTADO com as mesmas regras da criação (origem, posse, transferência).
 * Pagamento de fatura (invoice_month) só aceita valor, data, conta e descrição.
 * Trocar o tipo limpa o que não existe no tipo novo, se o patch não disser nada
 * (ex.: virar transferência tira o cartão e a categoria).
 */
export async function updateTransaction(
  userId: string,
  id: string,
  input: UpdateTransactionInput,
) {
  const found = await query<
    Pick<
      TransactionRow,
      | 'kind'
      | 'accountId'
      | 'transferAccountId'
      | 'creditCardId'
      | 'categoryId'
      | 'installments'
      | 'invoiceMonth'
      | 'loanId'
    >
  >(
    `SELECT kind, account_id AS "accountId", transfer_account_id AS "transferAccountId",
            credit_card_id AS "creditCardId", category_id AS "categoryId",
            installments, invoice_month AS "invoiceMonth", loan_id AS "loanId"
       FROM transactions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (found.length === 0) throw AppError.notFound('Transação não encontrada');
  const cur = found[0];

  // Lançamento de empréstimo (saída, principal ou juros): só pela tela de Empréstimos.
  if (cur.loanId || isLoanKind(cur.kind)) throw AppError.badRequest(LOAN_LOCKED_MESSAGE);
  if (isLoanKind(input.kind)) throw AppError.badRequest(LOAN_KIND_MESSAGE);

  const fields: Record<string, unknown> = {};

  // ---- Pagamento de fatura: só valor, data, conta e descrição podem mudar. ----
  if (cur.invoiceMonth) {
    const changes = (v: string | null | undefined, now: string | null) => v !== undefined && (v ?? null) !== now;
    if (
      (input.kind !== undefined && input.kind !== cur.kind) ||
      changes(input.creditCardId, cur.creditCardId) ||
      changes(input.transferAccountId, cur.transferAccountId)
    ) {
      throw AppError.badRequest(
        'Pagamento de fatura: só dá para mudar valor, data, conta e descrição. Para mudar o resto, desfaça o pagamento.',
      );
    }
    if (input.accountId && input.accountId !== cur.accountId) {
      await assertAccountUsable(userId, input.accountId);
      fields.account_id = input.accountId;
    }
    if (input.amount !== undefined) fields.amount = input.amount;
    if (input.occurredAt !== undefined) fields.occurred_at = input.occurredAt;
    if (input.description !== undefined) fields.description = input.description;
    return applyUpdate(userId, id, fields);
  }

  // ---- Demais linhas: mescla e valida o resultado. ----
  const kind: TxKind = input.kind ?? cur.kind;
  const kindChanged = kind !== cur.kind;
  if (kind === 'transfer' && cur.installments) {
    throw AppError.badRequest('Uma parcela não pode virar transferência.');
  }

  const accountId = input.accountId ? input.accountId : cur.accountId; // conta nunca é "limpada"
  let transferAccountId =
    input.transferAccountId !== undefined ? input.transferAccountId ?? null : cur.transferAccountId;
  let creditCardId = input.creditCardId !== undefined ? input.creditCardId ?? null : cur.creditCardId;
  if (kindChanged && kind !== 'transfer' && input.transferAccountId === undefined) transferAccountId = null;
  if (kindChanged && kind === 'transfer' && input.creditCardId === undefined) creditCardId = null;

  const [source] = await Promise.all([
    resolveSource(
      userId,
      { kind, accountId, transferAccountId, creditCardId },
      {
        account: accountId !== cur.accountId,
        transferAccount: transferAccountId !== cur.transferAccountId,
        card: creditCardId !== cur.creditCardId,
      },
    ),
    kind !== 'transfer' && input.categoryId !== undefined ? assertCategoryValid(userId, input.categoryId) : null,
  ]);

  if (input.kind !== undefined) fields.kind = kind;
  if (source.accountId !== cur.accountId) fields.account_id = source.accountId;
  if (source.transferAccountId !== cur.transferAccountId) fields.transfer_account_id = source.transferAccountId;
  if (source.creditCardId !== cur.creditCardId) fields.credit_card_id = source.creditCardId;
  if (kind === 'transfer') {
    if (cur.categoryId !== null) fields.category_id = null; // transferência nunca tem categoria
  } else if (input.categoryId !== undefined) {
    fields.category_id = input.categoryId;
  }
  if (input.amount !== undefined) fields.amount = input.amount;
  if (input.description !== undefined) fields.description = input.description;
  if (input.merchant !== undefined) fields.merchant = input.merchant;
  if (input.occurredAt !== undefined) fields.occurred_at = input.occurredAt;
  if (input.notes !== undefined) fields.notes = input.notes;
  // `installments` não é editável: o rótulo da parcela ("2/4") é definido na criação.

  return applyUpdate(userId, id, fields);
}

/**
 * Soft delete: nunca apagamos dinheiro de verdade — só marcamos deleted_at.
 * mode='all' + parcela: apaga ESTA e as FUTURAS da mesma compra (mesmo
 * installment_group_id e data >= a da clicada). Retorna quantas foram apagadas.
 * Desfazer um pagamento de fatura é apagar a transação dele (mode single).
 * Lançamento de empréstimo (loan_id) não sai por aqui → 400 (tela de Empréstimos).
 */
export async function deleteTransaction(
  userId: string,
  id: string,
  mode: 'single' | 'all' = 'single',
): Promise<number> {
  if (mode === 'all') {
    const found = await query<{ groupId: string | null; occurredAt: string; loanId: string | null }>(
      `SELECT installment_group_id AS "groupId", occurred_at AS "occurredAt", loan_id AS "loanId"
         FROM transactions
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    if (found.length === 0) throw AppError.notFound('Transação não encontrada');

    const { groupId, occurredAt, loanId } = found[0];
    if (loanId) throw AppError.badRequest(LOAN_LOCKED_MESSAGE);
    if (groupId) {
      const deleted = await query<{ id: string }>(
        `UPDATE transactions SET deleted_at = now()
          WHERE user_id = $1 AND installment_group_id = $2
            AND occurred_at >= $3::date AND deleted_at IS NULL
            AND loan_id IS NULL
          RETURNING id`,
        [userId, groupId, occurredAt],
      );
      return deleted.length;
    }
    // Sem grupo (compra à vista ou parcela antiga) → cai no comportamento padrão.
  }

  // Uma única instrução: confere "não é de empréstimo" e apaga juntos.
  const rows = await query<{ id: string }>(
    `UPDATE transactions SET deleted_at = now()
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL AND loan_id IS NULL
      RETURNING id`,
    [id, userId],
  );
  if (rows.length > 0) return 1;

  const exists = await query<{ loanId: string | null }>(
    `SELECT loan_id AS "loanId" FROM transactions
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  if (exists.length === 0) throw AppError.notFound('Transação não encontrada');
  throw AppError.badRequest(LOAN_LOCKED_MESSAGE);
}
