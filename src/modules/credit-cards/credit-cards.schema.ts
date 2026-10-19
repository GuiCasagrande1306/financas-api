import { z } from 'zod';
import { isoDay, isoMonth, nonNegativeCents, positiveCents } from '../../lib/zod';

/** Valores monetários em CENTAVOS (igual ao resto do app). */
export const createCardSchema = z.object({
  name: z.string().min(1).max(60),
  limit: nonNegativeCents, // limite total, CENTAVOS (teto R$ 10 bi)
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  lastDigits: z.string().max(4).nullish(),
  color: z.string().max(9).optional(),
});

// Arquivar (isArchived) esconde o cartão sem apagar o histórico.
export const updateCardSchema = createCardSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

// Booleano de query string: só 'true'/'false' (z.coerce.boolean trataria 'false' como true).
export const listCardsQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const idParam = z.object({ id: z.string().uuid() });

// 'YYYY-MM' entre 1900-01 e 2100-12.
const monthRef = isoMonth;

// Mês de referência da fatura ('YYYY-MM'). Ausente => fatura aberta (atual).
export const invoiceQuery = z.object({
  month: monthRef.optional(),
});

// POST /credit-cards/:id/invoices/:month/payments
export const invoicePaymentParams = z.object({
  id: z.string().uuid(),
  month: monthRef, // mês da fatura paga
});

/** Pagamento de fatura: sai da conta `accountId` (CENTAVOS). paidAt default = hoje (America/Sao_Paulo). */
export const payInvoiceSchema = z.object({
  accountId: z.string().uuid(),
  amount: positiveCents,
  paidAt: isoDay.optional(), // 'YYYY-MM-DD'
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
export type ListCardsQuery = z.infer<typeof listCardsQuery>;
export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;
