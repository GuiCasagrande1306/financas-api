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
});

export const updateTransactionSchema = createTransactionSchema.partial();

export const listTransactionsQuery = z.object({
  kind: transactionKind.optional(),
  categoryId: z.string().uuid().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const idParam = z.object({ id: z.string().uuid() });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuery>;
