import { z } from 'zod';

/** Valores monetários em CENTAVOS (igual ao resto do app). */
export const createCardSchema = z.object({
  name: z.string().min(1).max(60),
  limit: z.number().int().nonnegative(), // limite total, CENTAVOS
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  lastDigits: z.string().max(4).nullish(),
  color: z.string().max(9).optional(),
});

export const updateCardSchema = createCardSchema.partial();

export const idParam = z.object({ id: z.string().uuid() });

// Mês de referência da fatura ('YYYY-MM'). Ausente => fatura aberta (atual).
export const invoiceQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato esperado: YYYY-MM')
    .optional(),
});

export type CreateCardInput = z.infer<typeof createCardSchema>;
export type UpdateCardInput = z.infer<typeof updateCardSchema>;
