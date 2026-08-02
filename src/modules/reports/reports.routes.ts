import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { getAnnualReport } from './reports.service';
import { annualQuery, type AnnualQuery } from './reports.schema';

export const reportsRouter = Router();

// GET /api/reports/annual?year=YYYY  (year opcional; default = ano atual)
reportsRouter.get(
  '/annual',
  validate({ query: annualQuery }),
  asyncHandler(async (req, res) => {
    const { year } = req.query as unknown as AnnualQuery;
    const report = await getAnnualReport(requireUserId(req), year);
    res.json(report);
  }),
);
