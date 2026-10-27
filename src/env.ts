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
  // Pluggy (Open Finance). Sem elas, a conexão bancária responde erro claro.
  PLUGGY_CLIENT_ID: z.string().optional(),
  PLUGGY_CLIENT_SECRET: z.string().optional(),
  PLUGGY_WEBHOOK_SECRET: z.string().optional(), // valida o webhook (opcional)
  AUTH_DEV_BYPASS_USER_ID: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('')),
  // Definida pela própria Vercel em toda função ("1"). Liga o modo serverless:
  // pool pequeno, checagem do schema na 1ª requisição, sem process.exit.
  VERCEL: z.string().optional(),
  // Segredo do Vercel Cron — OBRIGATÓRIO em produção na Vercel: com ele, GET /api/cron/*
  // só aceita "Authorization: Bearer <CRON_SECRET>" (a Vercel manda sozinha); sem ele, em
  // produção a rota fica fechada (503) e em dev aceita o user-agent da Vercel Cron.
  CRON_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = JSON.stringify(parsed.error.flatten().fieldErrors, null, 2);
  console.error('❌ Variáveis de ambiente inválidas:', details);
  // Na função serverless não existe processo para derrubar: a importação falha e o
  // log da função mostra o motivo. No servidor tradicional, sai antes do listen.
  if (process.env.VERCEL) throw new Error(`Variáveis de ambiente inválidas: ${details}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
/** Rodando como função serverless da Vercel (e não como servidor com listen). */
export const isServerless = Boolean(env.VERCEL);
