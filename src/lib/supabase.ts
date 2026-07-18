import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env';

/**
 * Cliente do Supabase com a ANON KEY, usado apenas para as operações de auth
 * (signup / signin). O backend é stateless: não persiste sessão nem renova token
 * automaticamente. Fica `null` enquanto SUPABASE_URL/ANON_KEY não estiverem
 * configurados — as rotas de auth respondem com erro claro nesse caso.
 */
export const supabase: SupabaseClient | null =
  env.SUPABASE_URL && env.SUPABASE_ANON_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;
