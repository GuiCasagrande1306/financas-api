import { z } from 'zod';

export const createGoalSchema = z.object({
  title: z.string().trim().min(1, 'Dê um nome à meta').max(80),
  targetAmount: z.number().int().positive(), // objetivo, CENTAVOS
  currentAmount: z.number().int().min(0).optional(), // valor inicial guardado
  deadline: z.string().date().nullish(), // 'YYYY-MM-DD'
  icon: z.string().max(40).nullish(),
  color: z.string().max(20).optional(),
});

export const updateGoalSchema = createGoalSchema.partial();

// amount positivo = guardar; negativo = resgatar.
export const addFundsSchema = z.object({
  amount: z.number().int().refine((n) => n !== 0, 'Informe um valor'),
});

export const idParam = z.object({ id: z.string().uuid() });

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type AddFundsInput = z.infer<typeof addFundsSchema>;
