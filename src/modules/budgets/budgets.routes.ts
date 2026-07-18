import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './budgets.service';
import {
  listBudgetsQuery,
  upsertBudgetSchema,
  idParam,
  type ListBudgetsQuery,
} from './budgets.schema';

export const budgetsRouter = Router();

// GET /api/budgets?month=YYYY-MM — orçamentos + gasto do mês + status do alerta
budgetsRouter.get(
  '/',
  validate({ query: listBudgetsQuery }),
  asyncHandler(async (req, res) => {
    const { month } = req.query as unknown as ListBudgetsQuery;
    res.json(await service.listBudgets(requireUserId(req), month));
  }),
);

// POST /api/budgets — define/atualiza o orçamento mensal de uma categoria
budgetsRouter.post(
  '/',
  validate({ body: upsertBudgetSchema }),
  asyncHandler(async (req, res) => {
    const budget = await service.upsertBudget(requireUserId(req), req.body);
    res.status(201).json(budget);
  }),
);

// DELETE /api/budgets/:id
budgetsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteBudget(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
