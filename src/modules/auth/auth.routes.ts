import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { authenticate, requireUserId } from '../../middlewares/auth';
import * as service from './auth.service';
import { refreshSchema, signinSchema, signupSchema } from './auth.schema';

export const authRouter = Router();

// POST /api/auth/signup — cria o usuário (senha hasheada pelo Supabase). PÚBLICO.
authRouter.post(
  '/signup',
  validate({ body: signupSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.signup(req.body);
    res.status(201).json(result);
  }),
);

// POST /api/auth/signin — valida credenciais e devolve o JWT. PÚBLICO.
authRouter.post(
  '/signin',
  validate({ body: signinSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.signin(req.body);
    res.json(result);
  }),
);

// POST /api/auth/refresh — renova a sessão a partir do refresh token. PÚBLICO.
authRouter.post(
  '/refresh',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const result = await service.refresh(req.body.refreshToken);
    res.json(result);
  }),
);

// GET /api/auth/me — dados do usuário logado. PROTEGIDO (exige token válido).
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const profile = await service.me(requireUserId(req));
    res.json(profile);
  }),
);
