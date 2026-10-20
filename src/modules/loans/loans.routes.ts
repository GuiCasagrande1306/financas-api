import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './loans.service';
import {
  createLoanSchema,
  updateLoanSchema,
  updateInstallmentSchema,
  receiveInstallmentSchema,
  idParam,
  installmentParams,
} from './loans.schema';

export const loansRouter = Router();

// GET /api/loans — empréstimos (ordem alfabética do nome) com parcelas, números e totais
loansRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listLoans(requireUserId(req)));
  }),
);

// POST /api/loans — cadastra o empréstimo + parcelas mensais (+ saída da conta de origem)
loansRouter.post(
  '/',
  validate({ body: createLoanSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createLoan(requireUserId(req), req.body));
  }),
);

// GET /api/loans/:id
loansRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await service.getLoan(requireUserId(req), req.params.id));
  }),
);

// PATCH /api/loans/:id — edita (valor/data/conta de origem atualizam a saída da conta)
loansRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateLoanSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateLoan(requireUserId(req), req.params.id, req.body));
  }),
);

// DELETE /api/loans/:id — apaga o empréstimo e os lançamentos ligados a ele
loansRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteLoan(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);

// PATCH /api/loans/:id/installments/:installmentId — data/valor de parcela pendente
loansRouter.patch(
  '/:id/installments/:installmentId',
  validate({ params: installmentParams, body: updateInstallmentSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await service.updateInstallment(requireUserId(req), req.params.id, req.params.installmentId, req.body),
    );
  }),
);

// POST /api/loans/:id/installments/:installmentId/receive — "Recebi"
loansRouter.post(
  '/:id/installments/:installmentId/receive',
  validate({ params: installmentParams, body: receiveInstallmentSchema }),
  asyncHandler(async (req, res) => {
    res.json(
      await service.receiveInstallment(requireUserId(req), req.params.id, req.params.installmentId, req.body),
    );
  }),
);

// DELETE /api/loans/:id/installments/:installmentId/receive — desfaz o recebimento
loansRouter.delete(
  '/:id/installments/:installmentId/receive',
  validate({ params: installmentParams }),
  asyncHandler(async (req, res) => {
    res.json(await service.undoReceive(requireUserId(req), req.params.id, req.params.installmentId));
  }),
);

export const receivablesRouter = Router();

// GET /api/receivables — parcelas pendentes de todos os empréstimos (A receber) + totais
receivablesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await service.listReceivables(requireUserId(req)));
  }),
);
