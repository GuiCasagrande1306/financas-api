import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { env, isProd } from '../env';
import { AppError } from '../lib/AppError';

// Estende o Request do Express para carregar o usuário autenticado.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * JWKS remoto do Supabase: chaves públicas usadas para validar os tokens
 * assinados com chaves ASSIMÉTRICAS (ES256/RS256), o padrão atual do Supabase.
 * A biblioteca faz cache das chaves e resolve pelo `kid` do token.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!env.SUPABASE_URL) {
    throw new AppError(500, 'SUPABASE_URL não configurado (necessário para validar o JWT)', 'CONFIG_ERROR');
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

/**
 * Autentica a request validando o JWT emitido pelo Supabase Auth.
 * - Tokens ES256/RS256 (assimétricos): validados via JWKS.
 * - Tokens HS256 (segredo compartilhado, legado): validados com SUPABASE_JWT_SECRET.
 * O `sub` do token é o UUID do usuário (auth.users.id) e vira req.userId.
 *
 * Em dev, AUTH_DEV_BYPASS_USER_ID injeta um id fixo e pula a validação.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    if (!isProd && env.AUTH_DEV_BYPASS_USER_ID) {
      req.userId = env.AUTH_DEV_BYPASS_USER_ID;
      return next();
    }

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw AppError.unauthorized('Token de autenticação ausente');
    }
    const token = header.slice('Bearer '.length);

    let sub: string | undefined;
    const { alg } = decodeProtectedHeader(token);

    if (alg === 'HS256') {
      if (!env.SUPABASE_JWT_SECRET) {
        throw new AppError(500, 'SUPABASE_JWT_SECRET não configurado', 'CONFIG_ERROR');
      }
      const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET) as jwt.JwtPayload;
      sub = payload.sub as string | undefined;
    } else {
      const { payload } = await jwtVerify(token, getJWKS());
      sub = payload.sub;
    }

    if (!sub) throw AppError.unauthorized('Token sem identificação de usuário');
    req.userId = sub;
    next();
  } catch (err) {
    // AppError (ex.: erro de config) preserva seu status; o resto vira 401.
    if (err instanceof AppError) return next(err);
    return next(AppError.unauthorized('Token inválido ou expirado'));
  }
};

/**
 * Recupera o userId garantindo (em tempo de tipo e execução) que ele existe.
 * Use dentro dos handlers depois do middleware `authenticate`.
 */
export function requireUserId(req: { userId?: string }): string {
  if (!req.userId) throw AppError.unauthorized();
  return req.userId;
}
