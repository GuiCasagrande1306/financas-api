import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './goals.service';
import { createGoalSchema, updateGoalSchema, addFundsSchema, idParam } from './goals.schema';

export const goalsRouter = Router();

// GET /api/goals — metas do usuário (com % e flag de concluída)
goalsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.listGoals(requireUserId(req)) });
  }),
);

// POST /api/goals
goalsRouter.post(
  '/',
  validate({ body: createGoalSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createGoal(requireUserId(req), req.body));
  }),
);

// PATCH /api/goals/:id
goalsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateGoalSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateGoal(requireUserId(req), req.params.id, req.body));
  }),
);

// DELETE /api/goals/:id
goalsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteGoal(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);

// POST /api/goals/:id/add-funds — guardar (amount>0) ou resgatar (amount<0)
goalsRouter.post(
  '/:id/add-funds',
  validate({ params: idParam, body: addFundsSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.addFunds(requireUserId(req), req.params.id, req.body.amount));
  }),
);
