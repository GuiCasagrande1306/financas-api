import { isAuthRetryableFetchError, type AuthError } from '@supabase/supabase-js';
import { createAuthClient } from '../../lib/supabase';
import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import type { SigninInput, SignupInput } from './auth.schema';

type SupabaseSession = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
} | null;

/** Normaliza a sessão do Supabase para o formato da nossa API (camelCase). */
function mapSession(session: SupabaseSession) {
  if (!session) return null;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
  };
}

/** Cliente novo do Supabase Auth para ESTA operação (ver lib/supabase.ts). */
function ensureConfigured() {
  const client = createAuthClient();
  if (!client) {
    throw new AppError(
      500,
      'Supabase Auth não configurado (defina SUPABASE_URL e SUPABASE_ANON_KEY)',
      'CONFIG_ERROR',
    );
  }
  return client;
}

/**
 * Erro do Supabase Auth que NÃO diz nada sobre a credencial: sem rede até o Supabase
 * (status 0), Supabase fora do ar (5xx), resposta que não é JSON (AuthUnknownError) ou
 * limite de chamadas (429). Vira 503/429 — nunca 401, que o app trata como sessão morta
 * (desloga e apaga os dados guardados). `null` = erro de verdade da credencial.
 */
function unavailableError(error: AuthError): AppError | null {
  if (error.status === 429) {
    return new AppError(429, 'Muitas tentativas. Tente novamente em alguns minutos.', 'RATE_LIMITED');
  }
  const status = error.status ?? 0;
  if (isAuthRetryableFetchError(error) || error.name === 'AuthUnknownError' || status === 0 || status >= 500) {
    console.warn(`⚠️  Supabase Auth indisponível (${error.name} ${status}): ${error.message}`);
    return new AppError(
      503,
      'Não foi possível falar com o serviço de login agora. Tente de novo em instantes.',
      'AUTH_UNAVAILABLE',
    );
  }
  return null;
}

export async function signup(input: SignupInput) {
  const client = ensureConfigured();

  // O Supabase faz o hash (bcrypt) da senha; ela nunca chega ao nosso banco.
  const { data, error } = await client.auth.signUp({
    email: input.email,
    password: input.password,
    options: { data: { full_name: input.name } }, // vira profiles.full_name (trigger)
  });

  if (error) {
    const unavailable = unavailableError(error);
    if (unavailable) throw unavailable;
    if (/already registered|already exists|already been registered/i.test(error.message)) {
      throw AppError.conflict('E-mail já cadastrado');
    }
    throw AppError.badRequest(error.message);
  }

  return {
    user: data.user ? { id: data.user.id, email: data.user.email, name: input.name } : null,
    session: mapSession(data.session as SupabaseSession),
    // Sem sessão => o projeto exige confirmação de e-mail antes do login.
    needsEmailConfirmation: !data.session,
  };
}

export async function signin(input: SigninInput) {
  const client = ensureConfigured();

  const { data, error } = await client.auth.signInWithPassword({
    email: input.email,
    password: input.password,
  });

  if (error || !data.user) {
    const unavailable = error && unavailableError(error);
    if (unavailable) throw unavailable;
    // Mensagem genérica de propósito: não revela se o e-mail existe.
    throw AppError.unauthorized('E-mail ou senha inválidos');
  }

  const name = (data.user.user_metadata?.full_name as string | undefined) ?? null;
  return {
    user: { id: data.user.id, email: data.user.email, name },
    session: mapSession(data.session as SupabaseSession),
  };
}

/**
 * Troca um refresh token por uma sessão nova (access + refresh + expiração).
 * 401 só quando o Supabase RECUSA o refresh token (inválido, já usado, sessão
 * encerrada); falha passageira do Supabase → 503/429 e o app mantém a sessão.
 */
export async function refresh(refreshToken: string) {
  const client = ensureConfigured();

  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    const unavailable = error && unavailableError(error);
    if (unavailable) throw unavailable;
    throw AppError.unauthorized('Sessão expirada, faça login novamente');
  }

  const name = (data.user?.user_metadata?.full_name as string | undefined) ?? null;
  return {
    user: data.user ? { id: data.user.id, email: data.user.email, name } : null,
    session: mapSession(data.session as SupabaseSession),
  };
}

/** Dados do usuário autenticado (id, nome, e-mail) — nunca a senha. */
export async function me(userId: string) {
  const rows = await query<{ id: string; name: string | null; email: string | null }>(
    `select p.id, p.full_name as name, u.email
       from public.profiles p
       join auth.users u on u.id = p.id
      where p.id = $1`,
    [userId],
  );
  if (rows.length === 0) throw AppError.notFound('Perfil não encontrado');
  return rows[0];
}
