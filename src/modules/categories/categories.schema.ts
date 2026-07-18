import { z } from 'zod';

export const categoryKind = z.enum(['expense', 'income']);

export const createCategorySchema = z.object({
  name: z.string().min(1).max(60),
  kind: categoryKind.default('expense'),
  icon: z.string().max(40).default('circle'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato hex #RRGGBB')
    .default('#6366f1'),
  parentId: z.string().uuid().nullish(),
});

export const updateCategorySchema = createCategorySchema.partial();

export const listCategoriesQuery = z.object({
  kind: categoryKind.optional(),
  includeArchived: z.coerce.boolean().default(false),
});

export const idParam = z.object({ id: z.string().uuid() });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuery>;
