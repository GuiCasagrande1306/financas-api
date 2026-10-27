import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';

/**
 * Cliente do Supabase com a ANON KEY, usado apenas para as operações de auth
 * (signup / signin / refresh). O backend é stateless: não persiste sessão nem renova
 * token automaticamente.
 *
 * Um cliente NOVO por operação, nunca um compartilhado: o cliente do Supabase guarda
 * estado da sessão (a sessão em memória e o refresh "em andamento"). Compartilhado
 * entre usuários, dois refresh simultâneos de pessoas diferentes devolviam a sessão
 * da PRIMEIRA para as duas. Criar é barato (~0,03 ms, sem rede).
 *
 * `null` enquanto SUPABASE_URL/ANON_KEY não estiverem configurados — as rotas de auth
 * respondem com erro claro nesse caso.
 */
export function createAuthClient(): SupabaseClient | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
