import { Router } from 'express';
import { waitUntil } from '@vercel/functions';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { createConnectToken, connectItem, handleWebhook } from './open-finance.service';

// ---- Rotas AUTENTICADAS (usadas pelo app do usuário) ----
export const openFinanceRouter = Router();

// GET /api/open-finance/token — connect_token para o widget PluggyConnect
openFinanceRouter.get(
  '/token',
  asyncHandler(async (_req, res) => {
    res.json({ connectToken: await createConnectToken() });
  }),
);

// POST /api/open-finance/connect — o frontend informa o itemId após conectar
openFinanceRouter.post(
  '/connect',
  validate({ body: z.object({ itemId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const result = await connectItem(requireUserId(req), req.body.itemId);
    res.json(result); // { imported: N }
  }),
);

// ---- Rota PÚBLICA (a Pluggy chama; sem auth) ----
export const openFinanceWebhookRouter = Router();

// POST /api/open-finance/webhook
openFinanceWebhookRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    // Responde 200 rápido (a Pluggy espera confirmação) e importa depois da resposta.
    // Na Vercel a instância pode ser congelada assim que a resposta sai: o waitUntil a
    // mantém viva até a importação terminar (no máximo o maxDuration da função, 60 s).
    // No servidor tradicional (Render) o waitUntil não faz nada e o processo segue com
    // a promessa como antes.
    const importing = handleWebhook(req.body).catch((e) =>
      console.warn('⚠️  Falha ao processar webhook Pluggy:', (e as Error).message),
    );
    waitUntil(importing);
    res.status(200).json({ received: true });
  }),
);
