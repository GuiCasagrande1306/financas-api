import { Router, type RequestHandler } from 'express';
import multer, { MulterError } from 'multer';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import { AppError } from '../../lib/AppError';
import * as service from './transactions.service';
import { scanReceipt } from './scan.service';
import {
  createTransactionSchema,
  updateTransactionSchema,
  listTransactionsQuery,
  idParam,
  deleteTransactionQuery,
  type ListTransactionsQuery,
} from './transactions.schema';

export const transactionsRouter = Router();

// Upload em memória (buffer), só imagens, até 5MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Formato inválido: envie uma imagem JPEG, PNG, WebP ou GIF'));
  },
});

// Wrapper que traduz os erros do multer em AppError (400/413) legíveis.
const uploadImage: RequestHandler = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(AppError.badRequest('Imagem muito grande (máx. 5MB)'));
      return next(AppError.badRequest(err.message));
    }
    if (err) return next(AppError.badRequest((err as Error).message));
    next();
  });
};

// POST /api/transactions/scan — foto de recibo → dados do gasto (via IA)
transactionsRouter.post(
  '/scan',
  uploadImage,
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Nenhuma imagem enviada (campo "image")');
    const result = await scanReceipt(requireUserId(req), req.file.buffer, req.file.mimetype);
    res.json(result);
  }),
);

// POST /api/transactions — cria uma entrada ou saída
transactionsRouter.post(
  '/',
  validate({ body: createTransactionSchema }),
  asyncHandler(async (req, res) => {
    const tx = await service.createTransaction(requireUserId(req), req.body);
    res.status(201).json(tx);
  }),
);

// GET /api/transactions — lista com filtros e paginação
transactionsRouter.get(
  '/',
  validate({ query: listTransactionsQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.listTransactions(
      requireUserId(req),
      req.query as unknown as ListTransactionsQuery,
    );
    res.json(result);
  }),
);

// GET /api/transactions/:id — detalha uma transação
transactionsRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const tx = await service.getTransaction(requireUserId(req), req.params.id);
    res.json(tx);
  }),
);

// PATCH /api/transactions/:id — atualiza campos parciais
transactionsRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateTransactionSchema }),
  asyncHandler(async (req, res) => {
    const tx = await service.updateTransaction(requireUserId(req), req.params.id, req.body);
    res.json(tx);
  }),
);

// DELETE /api/transactions/:id?mode=single|all — soft delete (mode=all apaga esta + futuras)
transactionsRouter.delete(
  '/:id',
  validate({ params: idParam, query: deleteTransactionQuery }),
  asyncHandler(async (req, res) => {
    const { mode } = req.query as unknown as { mode: 'single' | 'all' };
    const deleted = await service.deleteTransaction(requireUserId(req), req.params.id, mode);
    res.json({ deleted });
  }),
);
