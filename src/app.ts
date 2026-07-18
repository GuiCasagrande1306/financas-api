import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { routes } from './routes';
import { errorHandler, notFoundHandler } from './middlewares/error';
import { env, isProd } from './env';

/**
 * Em produção, libera no CORS apenas as origens de CORS_ORIGIN (CSV).
 * Em dev (ou sem allowlist), reflete qualquer origem para facilitar o desenvolvimento.
 */
function buildCorsOptions(): CorsOptions | undefined {
  const origins = env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!isProd || !origins?.length) return undefined; // libera geral

  return {
    origin: (origin, cb) => {
      // Sem Origin (curl, health check, apps nativos) passa; browsers precisam estar na lista.
      if (!origin || origins.includes(origin)) return cb(null, true);
      cb(new Error('Origem não permitida pelo CORS'));
    },
  };
}

export function createApp() {
  const app = express();

  // Atrás do proxy do provedor (Render/Fly/Railway): IP real e protocolo HTTPS corretos.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(buildCorsOptions()));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(isProd ? 'combined' : 'dev'));

  // Healthcheck simples (sem autenticação).
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', ts: new Date().toISOString() });
  });

  app.use('/api', routes);

  // 404 e handler de erro precisam ser os ÚLTIMOS middlewares registrados.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
