import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { askAdvisor } from './ai.service';
import { askSchema, type AskInput } from './ai.schema';

export const aiRouter = Router();

// POST /api/ai/ask — conselheiro financeiro (Gemini) com contexto dos últimos 30 dias
aiRouter.post(
  '/ask',
  validate({ body: askSchema }),
  asyncHandler(async (req, res) => {
    const { prompt } = req.body as AskInput;
    const answer = await askAdvisor(requireUserId(req), prompt);
    res.json({ answer });
  }),
);
