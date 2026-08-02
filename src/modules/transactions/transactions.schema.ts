import { z } from 'zod';

export const transactionKind = z.enum(['expense', 'income', 'transfer']);

/**
 * IMPORTANTE: `amount` é sempre em CENTAVOS e positivo. O que define entrada ou
 * saída é o campo `kind`, nunca o sinal do valor. Ex.: R$ 45,50 => amount: 4550.
 */
export const createTransactionSchema = z.object({
  amount: z.number().int().positive(),
  kind: transactionKind.default('expense'),
  categoryId: z.string().uuid().nullish(),
  accountId: z.string().uuid().nullish(), // opcional: cai na "Carteira" padrão
  description: z.string().max(255).nullish(),
  merchant: z.string().max(120).nullish(),
  occurredAt: z.string().date().optional(), // 'YYYY-MM-DD', default = hoje
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
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .default(MAX_PAGE)
    .transform((n) => Math.min(n, MAX_PAGE)),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idParam = z.object({ id: z.string().uuid() });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;
