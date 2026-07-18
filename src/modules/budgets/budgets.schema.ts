import { z } from 'zod';

export const listBudgetsQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato esperado: YYYY-MM')
    .optional(),
});

export const upsertBudgetSchema = z.object({
  categoryId: z.string().uuid(),
  amount: z.number().int().positive(), // teto em CENTAVOS
});

export const idParam = z.object({ id: z.string().uuid() });

export type ListBudgetsQuery = z.infer<typeof listBudgetsQuery>;
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
