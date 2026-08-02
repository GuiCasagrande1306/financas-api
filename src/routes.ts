import { Router } from 'express';
import { authenticate } from './middlewares/auth';
import { authLimiter } from './middlewares/rateLimit';
import { authRouter } from './modules/auth/auth.routes';
import { transactionsRouter } from './modules/transactions/transactions.routes';
import { categoriesRouter } from './modules/categories/categories.routes';
import { summaryRouter } from './modules/summary/summary.routes';
import { budgetsRouter } from './modules/budgets/budgets.routes';
import { investmentsRouter } from './modules/investments/investments.routes';
import { indicatorsRouter } from './modules/indicators/indicators.routes';
import { creditCardsRouter } from './modules/credit-cards/credit-cards.routes';
import { openFinanceRouter, openFinanceWebhookRouter } from './modules/open-finance/open-finance.routes';
import { reportsRouter } from './modules/reports/reports.routes';

export const routes = Router();

// Rotas de autenticação são PÚBLICAS (signup/signin), com rate-limit anti-brute-force.
routes.use('/auth', authLimiter, authRouter);

// Indicadores econômicos (BCB) são PÚBLICOS — antes do middleware de auth.
routes.use('/indicators', indicatorsRouter);
// Webhook da Pluggy é PÚBLICO (chamado pela Pluggy, sem token).
routes.use('/open-finance/webhook', openFinanceWebhookRouter);

// Daqui pra baixo, toda rota exige um usuário autenticado.
routes.use(authenticate);

routes.use('/transactions', transactionsRouter);
routes.use('/categories', categoriesRouter);
routes.use('/summary', summaryRouter);
routes.use('/reports', reportsRouter);
routes.use('/budgets', budgetsRouter);
routes.use('/investments', investmentsRouter);
routes.use('/credit-cards', creditCardsRouter);
routes.use('/open-finance', openFinanceRouter);
