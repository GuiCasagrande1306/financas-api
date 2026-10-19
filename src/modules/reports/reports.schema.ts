import { z } from 'zod';
import { isoDay } from '../../lib/zod';

export const annualQuery = z.object({
  // Ano do relatório (ex.: 2026). Ausente => ano atual (resolvido no service).
  year: z.coerce
    .number()
    .int('Ano inválido')
    .min(2000, 'Ano fora do intervalo')
    .max(2100, 'Ano fora do intervalo')
    .optional(),
});

// Origem do dinheiro: 'account:<uuid>' (conta) ou 'card:<uuid>' (cartão de crédito).
const SOURCE_KEY_RE = /^(account|card):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sourcesQuery = z.object({
  // Intervalo obrigatório (datas entre 1900 e 2100). from <= to e no máximo 731 dias
  // (conferido no service).
  from: isoDay, // 'YYYY-MM-DD'
  to: isoDay,
  // Tamanho do balde da série. Ausente => automático pelo tamanho do intervalo.
  granularity: z.enum(['day', 'week', 'month']).optional(),
  // Filtro opcional por origem (série, categorias, dia da semana, maiores gastos e totais).
  source: z
    .string()
    .regex(SOURCE_KEY_RE, "Formato esperado: 'account:<id>' ou 'card:<id>'")
    .transform((s) => s.toLowerCase())
    .optional(),
});

export type AnnualQuery = z.infer<typeof annualQuery>;
export type SourcesQuery = z.infer<typeof sourcesQuery>;
