import { z } from 'zod';
import { isoDay, positiveCents } from '../../lib/zod';

/**
 * Tipos de lançamento. `loan_out` (dinheiro emprestado saindo da conta) e
 * `loan_in` (principal de um empréstimo voltando) só nascem pelo módulo de
 * Empréstimos — criar/editar por /transactions com eles dá 400 (no service, com
 * mensagem clara). Nenhum dos dois é gasto nem receita.
 */
export const transactionKind = z.enum(['expense', 'income', 'transfer', 'loan_out', 'loan_in']);

/**
 * IMPORTANTE: `amount` é sempre em CENTAVOS e positivo (teto R$ 10 bi). O que define
 * entrada ou saída é o campo `kind`, nunca o sinal do valor. Ex.: R$ 45,50 => amount: 4550.
 * Datas entre 1900-01-01 e 2100-12-31 (`isoDay`).
 *
 * Origem do dinheiro (regras completas no service):
 *  - expense/income: `accountId` (opcional → conta padrão) OU `creditCardId` (gasto no crédito);
 *  - transfer: sai de `accountId` e entra em `transferAccountId` (contas diferentes).
 *    Pagamento de fatura NÃO passa por aqui: é a rota POST /credit-cards/:id/invoices/:month/payments.
 */
export const createTransactionSchema = z.object({
  amount: positiveCents,
  kind: transactionKind.default('expense'),
  categoryId: z.string().uuid().nullish(),
  accountId: z.string().uuid().nullish(), // opcional: cai na conta padrão ("Carteira")
  transferAccountId: z.string().uuid().nullish(), // só transferência: conta de destino
  description: z.string().max(255).nullish(),
  merchant: z.string().max(120).nullish(),
  occurredAt: isoDay.optional(), // 'YYYY-MM-DD', default = hoje (America/Sao_Paulo)
  notes: z.string().max(1000).nullish(),
  creditCardId: z.string().uuid().nullish(), // gasto no crédito (senão débito/dinheiro)
  // Nº de parcelas desejado (>1 fatia a compra em N transações mensais). 1 = à vista.
  installments: z.number().int().min(1).max(24).nullish(),
});

export const updateTransactionSchema = createTransactionSchema.partial();

// PAGINAÇÃO: no máximo 50 por página. `limit` é CLAMPADO (não rejeitado) para
// nunca devolver a base inteira — mesmo que um cliente peça 5000, volta 50.
const MAX_PAGE = 50;

export const listTransactionsQuery = z.object({
  kind: transactionKind.optional(),
  categoryId: z.string().uuid().optional(),
  // Linhas que MOVEM a conta (saldo): fora do cartão, transferências de/para ela
  // e pagamentos de fatura feitos com ela. Compra no cartão não entra.
  accountId: z.string().uuid().optional(),
  // Linhas do cartão: compras/estornos + pagamentos da fatura.
  creditCardId: z.string().uuid().optional(),
  // Busca parcial case-insensitive na descrição/estabelecimento (ILIKE '%termo%').
  search: z.string().trim().max(100).optional(),
  from: isoDay.optional(),
  to: isoDay.optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_PAGE)
    .transform((n) => Math.min(n, MAX_PAGE)),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idParam = z.object({ id: z.string().uuid() });

// Exclusão: 'single' apaga só a transação; 'all' apaga esta e as parcelas futuras.
export const deleteTransactionQuery = z.object({
  mode: z.enum(['single', 'all']).default('single'),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;

/**
 * Formato da Transação na API: lista de colunas já convertida de snake_case
 * (banco) para camelCase (API). Reaproveitada em todos os RETURNING/SELECT —
 * inclusive em outros módulos (extrato da conta, pagamento de fatura), por isso
 * mora aqui e não no service (evita import circular entre services).
 * `alias` = prefixo da tabela no SELECT (ex.: 't.'); vazio em INSERT/UPDATE.
 */
export function txColumns(alias = ''): string {
  const col = (name: string, as?: string) => `${alias}${name}${as ? ` AS "${as}"` : ''}`;
  return [
    col('id'),
    col('account_id', 'accountId'),
    col('transfer_account_id', 'transferAccountId'),
    col('category_id', 'categoryId'),
    col('amount'),
    col('kind'),
    col('description'),
    col('merchant'),
    col('occurred_at', 'occurredAt'),
    col('receipt_url', 'receiptUrl'),
    col('is_auto_categorized', 'isAutoCategorized'),
    col('notes'),
    col('credit_card_id', 'creditCardId'),
    col('installments'),
    col('installment_group_id', 'installmentGroupId'),
    col('invoice_month', 'invoiceMonth'),
    col('loan_id', 'loanId'),
    col('loan_installment_id', 'loanInstallmentId'),
    col('created_at', 'createdAt'),
    col('updated_at', 'updatedAt'),
  ].join(',\n  ');
}

export const TX_COLUMNS = txColumns();

/** Transação como sai na API (centavos; datas de calendário em 'YYYY-MM-DD'). */
export interface TransactionRow {
  id: string;
  accountId: string;
  transferAccountId: string | null;
  categoryId: string | null;
  amount: number;
  kind: 'expense' | 'income' | 'transfer' | 'loan_out' | 'loan_in';
  description: string | null;
  merchant: string | null;
  occurredAt: string;
  receiptUrl: string | null;
  isAutoCategorized: boolean;
  notes: string | null;
  creditCardId: string | null;
  installments: string | null;
  installmentGroupId: string | null;
  invoiceMonth: string | null;
  loanId: string | null; // lançamento gerado por um empréstimo (só muda pela tela de Empréstimos)
  loanInstallmentId: string | null; // parcela do empréstimo (recebimento)
  createdAt: string;
  updatedAt: string;
}
