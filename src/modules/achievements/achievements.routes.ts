import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { requireUserId } from '../../middlewares/auth';
import { getAchievements } from './achievements.service';

export const achievementsRouter = Router();

// GET /api/achievements — catálogo de medalhas com `unlocked` avaliado em tempo real
achievementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await getAchievements(requireUserId(req)));
  }),
);
