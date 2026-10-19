import { z } from 'zod';
import { isoMonth, positiveCents } from '../../lib/zod';

export const listBudgetsQuery = z.object({
  month: isoMonth.optional(), // 'YYYY-MM'
});

export const upsertBudgetSchema = z.object({
  categoryId: z.string().uuid(),
  amount: positiveCents, // teto em CENTAVOS
});

export const idParam = z.object({ id: z.string().uuid() });

export type ListBudgetsQuery = z.infer<typeof listBudgetsQuery>;
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
