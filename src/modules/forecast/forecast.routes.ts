import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { getForecast } from './forecast.service';
import { forecastQuery, type ForecastQuery } from './forecast.schema';

export const forecastRouter = Router();

// GET /api/forecast?months=6 — projeção de saldo (Máquina do Tempo)
forecastRouter.get(
  '/',
  validate({ query: forecastQuery }),
  asyncHandler(async (req, res) => {
    const { months } = req.query as unknown as ForecastQuery;
    res.json(await getForecast(requireUserId(req), months));
  }),
);
