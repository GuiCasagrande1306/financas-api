import { z } from 'zod';

export const annualQuery = z.object({
  // Ano do relatório (ex.: 2026). Ausente => ano atual (resolvido no service).
  year: z.coerce
    .number()
    .int('Ano inválido')
    .min(2000, 'Ano fora do intervalo')
    .max(2100, 'Ano fora do intervalo')
    .optional(),
});

export type AnnualQuery = z.infer<typeof annualQuery>;
