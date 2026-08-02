import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './credit-cards.service';
import { createCardSchema, updateCardSchema, idParam, invoiceQuery } from './credit-cards.schema';

export const creditCardsRouter = Router();

// GET /api/credit-cards — cartões com fatura atual e limite disponível
creditCardsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ data: await service.listCards(requireUserId(req)) });
  }),
);

// POST /api/credit-cards
creditCardsRouter.post(
  '/',
  validate({ body: createCardSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createCard(requireUserId(req), req.body));
  }),
);

// GET /api/credit-cards/:id/invoices — resumo de todas as faturas (fechada/atual/futura)
creditCardsRouter.get(
  '/:id/invoices',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await service.listInvoices(requireUserId(req), req.params.id));
  }),
);

// GET /api/credit-cards/:id/invoice?month=YYYY-MM — fatura detalhada (default = atual)
creditCardsRouter.get(
  '/:id/invoice',
  validate({ params: idParam, query: invoiceQuery }),
  asyncHandler(async (req, res) => {
    const { month } = req.query as unknown as { month?: string };
    res.json(await service.getInvoice(requireUserId(req), req.params.id, month));
  }),
);

// GET /api/credit-cards/:id
creditCardsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json(await service.getCard(requireUserId(req), req.params.id));
  }),
);

// PATCH /api/credit-cards/:id
creditCardsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateCardSchema }),
  asyncHandler(async (req, res) => {
    res.json(await service.updateCard(requireUserId(req), req.params.id, req.body));
  }),
);

// DELETE /api/credit-cards/:id
creditCardsRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteCard(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
