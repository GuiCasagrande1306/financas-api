import { z } from 'zod';
import { positiveCents } from '../../lib/zod';

export const createRecurringSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome').max(60),
  amount: positiveCents, // valor mensal, CENTAVOS (teto R$ 10 bi)
  dueDay: z.number().int().min(1).max(31), // dia do vencimento
  categoryId: z.string().uuid().nullish(),
  color: z.string().max(20).optional(),
  icon: z.string().max(40).nullish(),
  // De onde sai: uma conta OU um cartão (nenhum => conta padrão). Os dois juntos => 400.
  accountId: z.string().uuid().nullish(),
  creditCardId: z.string().uuid().nullish(),
});

export const updateRecurringSchema = createRecurringSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const idParam = z.object({ id: z.string().uuid() });

export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;
