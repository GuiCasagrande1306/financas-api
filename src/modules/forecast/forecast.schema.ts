import { z } from 'zod';

export const forecastQuery = z.object({
  // Horizonte da projeção em meses (1–12). Padrão: 6.
  months: z.coerce.number().int().min(1).max(12).default(6),
});

export type ForecastQuery = z.infer<typeof forecastQuery>;
