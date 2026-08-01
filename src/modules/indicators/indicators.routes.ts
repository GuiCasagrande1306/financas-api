import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { getIndicators } from './indicators.service';

export const indicatorsRouter = Router();

// GET /api/indicators — PÚBLICA (taxas oficiais do BCB, não são por usuário).
indicatorsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await getIndicators() });
  }),
);
