import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './accounts.service';
import {
  createAccountSchema,
  updateAccountSchema,
  listAccountsQuery,
  statementQuery,
  idParam,
  type ListAccountsQuery,
  type StatementQuery,
} from './accounts.schema';

export const accountsRouter = Router();

// GET /api/accounts?includeArchived=true|false — contas com saldo + saldo total
accountsRouter.get(
  '/',
  validate({ query: listAccountsQuery }),
  asyncHandler(async (req, res) => {
    const { includeArchived } = req.query as unknown as ListAccountsQuery;
    res.json(await service.listAccounts(requireUserId(req), includeArchived));
  }),
);

// POST /api/accounts — cria uma conta (corrente, poupança, dinheiro, carteira digital)
accountsRouter.post(
  '/',
  validate({ body: createAccountSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createAccount(requireUserId(req), req.body));
  }),
);

// GET /api/accounts/:id/statement?from=YYYY-MM-DD&to=YYYY-MM-DD — extrato da conta
accountsRouter.get(
  '/:id/statement',
  validate({ params: idParam, query: statementQuery }),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as StatementQuery;
    res.json(await service.getAccountStatement(requireUserId(req), req.params.id, from, to));
  }),
);

// GET /api/accounts/:id
accountsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await service.getAccount(requireUserId(req), req.params.id));
  }),
);

// PATCH /api/accounts/:id — edita (inclui arquivar via isArchived)
accountsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateAccountSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateAccount(requireUserId(req), req.params.id, req.body));
  }),
);

// DELETE /api/accounts/:id — só sem lançamentos (senão 409: arquive)
accountsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteAccount(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
