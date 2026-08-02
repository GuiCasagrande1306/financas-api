import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './recurring.service';
import { createRecurringSchema, updateRecurringSchema, idParam } from './recurring.schema';

export const recurringRouter = Router();

// GET /api/recurring — lista + resumo (mensal/anual) + "vence em breve".
// Também dispara o lançamento automático das recorrências vencidas.
recurringRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listRecurring(requireUserId(req)));
  }),
);

// POST /api/recurring — cadastra uma conta fixa/assinatura.
recurringRouter.post(
  '/',
  validate({ body: createRecurringSchema }),
  asyncHandler(async (req, res) => {
    const created = await service.createRecurring(requireUserId(req), req.body);
    res.status(201).json(created);
  }),
);

// PATCH /api/recurring/:id — edita (inclui pausar via isActive).
recurringRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateRecurringSchema }),
  asyncHandler(async (req, res) => {
    const updated = await service.updateRecurring(requireUserId(req), req.params.id, req.body);
    res.json(updated);
  }),
);

// DELETE /api/recurring/:id
recurringRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteRecurring(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
