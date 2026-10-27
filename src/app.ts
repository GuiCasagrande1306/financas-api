import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { routes } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/error';
import { requireSchemaReady } from './db/schema-check';
import { env, isProd } from './env';

/**
 * Por quanto tempo o navegador guarda a resposta do preflight (OPTIONS), em
 * segundos. Sem isso, TODA chamada autenticada faz um OPTIONS antes (2 idas e
 * voltas). 7200 s = 2 h, o teto do Chrome.
 */
const CORS_MAX_AGE = 7200;

/**
 * Em produção, libera no CORS apenas as origens de CORS_ORIGIN (CSV).
 * Em dev (ou sem allowlist), reflete qualquer origem para facilitar o desenvolvimento.
 */
function buildCorsOptions(): CorsOptions {
  const origins = env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!isProd || !origins?.length) return { maxAge: CORS_MAX_AGE }; // libera geral

  return {
    origin: (origin, cb) => {
      // Sem Origin (curl, health check, apps nativos) passa; browsers precisam estar na lista.
      if (!origin || origins.includes(origin)) return cb(null, true);
      cb(new Error('Origem não permitida pelo CORS'));
    },
    maxAge: CORS_MAX_AGE,
  };
}

export interface CreateAppOptions {
  /**
   * Serverless (Vercel): confere o schema do banco na 1ª requisição de /api de cada
   * instância (memorizado) e responde 503 se faltar coluna. O servidor tradicional
   * confere no boot (src/server.ts) e não precisa disto.
   */
  checkSchemaOnRequest?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Atrás do proxy do provedor (Render/Vercel/Fly): IP real e protocolo HTTPS corretos.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // Healthcheck simples (sem autenticação e sem banco).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  if (options.checkSchemaOnRequest) app.use('/api', requireSchemaReady);
  app.use('/api', routes);

  // 404 e handler de erro precisam ser os ÚLTIMOS middlewares registrados.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
