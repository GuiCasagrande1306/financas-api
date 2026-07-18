import { z } from 'zod';

export const summaryQuery = z.object({
  // Mês opcional no formato 'YYYY-MM'. Ausente => mês atual.
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato esperado: YYYY-MM')
    .optional(),
});

export type SummaryQuery = z.infer<typeof summaryQuery>;
