import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { validate } from '../../middlewares/validate';
import { requireUserId } from '../../middlewares/auth';
import * as service from './categories.service';
import {
  createCategorySchema,
  updateCategorySchema,
  listCategoriesQuery,
  idParam,
  type ListCategoriesQuery,
} from './categories.schema';

export const categoriesRouter = Router();

// GET /api/categories — categorias do sistema + do usuário
categoriesRouter.get(
  '/',
  validate({ query: listCategoriesQuery }),
  asyncHandler(async (req, res) => {
    const categories = await service.listCategories(
      requireUserId(req),
      req.query as unknown as ListCategoriesQuery,
    );
    res.json({ data: categories });
  }),
);

// GET /api/categories/:id
categoriesRouter.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const category = await service.getCategory(requireUserId(req), req.params.id);
    res.json(category);
  }),
);

// POST /api/categories
categoriesRouter.post(
  '/',
  validate({ body: createCategorySchema }),
  asyncHandler(async (req, res) => {
    const category = await service.createCategory(requireUserId(req), req.body);
    res.status(201).json(category);
  }),
);

// PATCH /api/categories/:id
categoriesRouter.patch(
  '/:id',
  validate({ params: idParam, body: updateCategorySchema }),
  asyncHandler(async (req, res) => {
    const category = await service.updateCategory(requireUserId(req), req.params.id, req.body);
    res.json(category);
  }),
);

// DELETE /api/categories/:id
categoriesRouter.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await service.deleteCategory(requireUserId(req), req.params.id);
    res.status(204).send();
  }),
);
