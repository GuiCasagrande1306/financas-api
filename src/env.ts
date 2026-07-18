import 'dotenv/config';
import { z } from 'zod';

/**
 * Validação das variáveis de ambiente na inicialização.
 * Falhar aqui (fail-fast) é muito melhor do que descobrir um env faltando
 * no meio de uma request de produção.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().url(),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),
  // Usados pelas rotas de auth (signup/signin) via Supabase Auth.
  // Aceitam vazio: enquanto não configurados, as rotas de auth respondem 500 claro.
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_ANON_KEY: z.string().optional(),
  // Origens liberadas no CORS em produção (CSV). Ex.: "https://app.com,https://www.app.com".
  // Vazio em produção = nenhuma origem de browser liberada (API vira uso interno).
  CORS_ORIGIN: z.string().optional(),
  // Google Gemini — usado no scan de recibos (/transactions/scan).
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  AUTH_DEV_BYPASS_USER_ID: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('')),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    '❌ Variáveis de ambiente inválidas:',
    JSON.stringify(parsed.error.flatten().fieldErrors, null, 2),
  );
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
