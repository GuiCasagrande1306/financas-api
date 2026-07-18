import { z } from 'zod';

export const signupSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  // bcrypt trunca em 72 bytes; exigimos um mínimo razoável.
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres').max(72),
});

export const signinSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type SigninInput = z.infer<typeof signinSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
