import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { getSummary } from './summary.service';
import { summaryQuery, type SummaryQuery } from './summary.schema';

export const summaryRouter = Router();

// GET /api/summary?month=YYYY-MM  (month opcional; default = mês atual)
summaryRouter.get(
  '/',
  validate({ query: summaryQuery }),
  asyncHandler(async (req, res) => {
    const { month } = req.query as unknown as SummaryQuery;
    const summary = await getSummary(requireUserId(req), month);
    res.json(summary);
  }),
);
