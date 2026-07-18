import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './investments.service';
import {
  createInvestmentSchema,
  updateInvestmentSchema,
  listInvestmentsQuery,
  idParam,
  type ListInvestmentsQuery,
} from './investments.schema';

export const investmentsRouter = Router();

// GET /api/investments/summary — resumo de patrimônio p/ gráficos.
// Vem ANTES de /:id para "summary" não ser interpretado como um id.
investmentsRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(await service.getInvestmentsSummary(requireUserId(req)));
  }),
);

// GET /api/investments — lista a carteira (filtro opcional por tipo de ativo)
investmentsRouter.get(
  '/',
  validate({ query: listInvestmentsQuery }),
  asyncHandler(async (req, res) => {
    const data = await service.listInvestments(
      requireUserId(req),
      req.query as unknown as ListInvestmentsQuery,
    );
    res.json({ data });
  }),
);

// POST /api/investments — cadastra um ativo
investmentsRouter.post(
  '/',
  validate({ body: createInvestmentSchema }),
  asyncHandler(async (req, res) => {
    const investment = await service.createInvestment(requireUserId(req), req.body);
    res.status(201).json(investment);
  }),
);

// GET /api/investments/:id — detalha um ativo
investmentsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await service.getInvestment(requireUserId(req), req.params.id));
  }),
);

// PATCH /api/investments/:id — atualiza campos parciais (ex.: valor atual)
investmentsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateInvestmentSchema }),
  asyncHandler(async (req, res) => {
    const investment = await service.updateInvestment(
      requireUserId(req),
      req.params.id,
      req.body,
    );
    res.json(investment);
  }),
);

// DELETE /api/investments/:id
investmentsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteInvestment(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
