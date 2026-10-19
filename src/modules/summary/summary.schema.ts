import { z } from 'zod';
import { isoMonth } from '../../lib/zod';

export const summaryQuery = z.object({
  // Mês opcional no formato 'YYYY-MM'. Ausente => mês atual.
  month: isoMonth.optional(),
});

export type SummaryQuery = z.infer<typeof summaryQuery>;
