import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { getAnnualReport, getSourcesReport } from './reports.service';
import { annualQuery, sourcesQuery, type AnnualQuery, type SourcesQuery } from './reports.schema';

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

// GET /api/reports/sources?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month&source=account:<id>|card:<id>
// Quanto e quando saiu de cada conta e cartão.
reportsRouter.get(
  '/sources',
  validate({ query: sourcesQuery }),
  asyncHandler(async (req, res) => {
    const report = await getSourcesReport(requireUserId(req), req.query as unknown as SourcesQuery);
    res.json(report);
  }),
);
