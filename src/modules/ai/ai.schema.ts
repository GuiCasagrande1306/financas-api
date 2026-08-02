import { z } from 'zod';

export const askSchema = z.object({
  // A pergunta do usuário para o conselheiro. Curta e obrigatória.
  prompt: z.string().trim().min(1, 'Escreva uma pergunta').max(500),
});

export type AskInput = z.infer<typeof askSchema>;
