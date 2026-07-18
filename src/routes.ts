import { Router } from 'express';
import { authenticate } from './middlewares/auth';
import { authLimiter } from './middlewares/rateLimit';
import { authRouter } from './modules/auth/auth.routes';
import { transactionsRouter } from './modules/transactions/transactions.routes';
import { categoriesRouter } from './modules/categories/categories.routes';
import { summaryRouter } from './modules/summary/summary.routes';
import { budgetsRouter } from './modules/budgets/budgets.routes';

export const routes = Router();

// Rotas de autenticação são PÚBLICAS (signup/signin), com rate-limit anti-brute-force.
routes.use('/auth', authLimiter, authRouter);

// Daqui pra baixo, toda rota exige um usuário autenticado.
routes.use(authenticate);

routes.use('/transactions', transactionsRouter);
routes.use('/categories', categoriesRouter);
routes.use('/summary', summaryRouter);
routes.use('/budgets', budgetsRouter);
