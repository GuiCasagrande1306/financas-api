import { timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { AppError } from '../../lib/AppError';
import { env, isProd } from '../../env';
import { refreshIndicators } from '../indicators/indicators.service';

/** Compara sem vazar pelo tempo de resposta quantos caracteres bateram. */
function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Só o agendador da Vercel (vercel.json → crons) chama estas rotas.
 *  - Com CRON_SECRET definido: exige "Authorization: Bearer <CRON_SECRET>" (a Vercel
 *    manda esse cabeçalho sozinha quando a variável existe no projeto);
 *  - em produção SEM CRON_SECRET: rota fechada (503). O user-agent qualquer um forja, e
 *    cada chamada aberta custaria uma execução da função, uma consulta ao BCB (que pode
 *    bloquear o IP e derrubar o cron de verdade) e uma escrita no banco;
 *  - em desenvolvimento sem ele: aceita o user-agent da Vercel Cron ("vercel-cron/1.0").
 * Só existe na função da Vercel (src/routes.ts): no servidor tradicional (Render) o
 * node-cron roda no próprio processo e a rota nem é montada.
 */
const requireCronCaller: RequestHandler = (req, _res, next) => {
  if (env.CRON_SECRET) {
    if (sameSecret(req.headers.authorization ?? '', `Bearer ${env.CRON_SECRET}`)) return next();
  } else if (isProd) {
    return next(
      new AppError(503, 'Rota do agendador desligada: defina CRON_SECRET no projeto.', 'CRON_NOT_CONFIGURED'),
    );
  } else if (req.headers['user-agent']?.startsWith('vercel-cron/')) {
    return next();
  }
  next(AppError.unauthorized('Rota exclusiva do agendador (Vercel Cron)'));
};

export const cronRouter = Router();

cronRouter.use(requireCronCaller);

// GET /api/cron/indicators — atualiza SELIC/CDI a partir do BCB. Idempotente (upsert):
// rodar de novo só regrava as mesmas taxas. Não mexe em nada de usuário.
cronRouter.get(
  '/indicators',
  asyncHandler(async (_req, res) => {
    try {
      const rates = await refreshIndicators();
      console.log(`📈 Indicadores atualizados (BCB): SELIC ${rates.SELIC}% · CDI ${rates.CDI}%`);
      res.json({ data: rates });
    } catch (err) {
      const message = (err as Error).message;
      console.warn('⚠️  Falha ao atualizar indicadores do BCB:', message);
      throw new AppError(502, `Falha ao atualizar as taxas no BCB: ${message}`, 'BCB_UNAVAILABLE');
    }
  }),
);
