import { supabase } from '../../lib/supabase';
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

function ensureConfigured() {
  if (!supabase) {
    throw new AppError(
      500,
      'Supabase Auth não configurado (defina SUPABASE_URL e SUPABASE_ANON_KEY)',
      'CONFIG_ERROR',
    );
  }
  return supabase;
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
    // Mensagem genérica de propósito: não revela se o e-mail existe.
    throw AppError.unauthorized('E-mail ou senha inválidos');
  }

  const name = (data.user.user_metadata?.full_name as string | undefined) ?? null;
  return {
    user: { id: data.user.id, email: data.user.email, name },
    session: mapSession(data.session as SupabaseSession),
  };
}

/** Troca um refresh token por uma sessão nova (access + refresh + expiração). */
export async function refresh(refreshToken: string) {
  const client = ensureConfigured();

  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
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
