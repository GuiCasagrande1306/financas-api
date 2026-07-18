import { RequestHandler } from 'express';
import { ZodError, ZodSchema } from 'zod';
import { AppError } from '../lib/AppError';

type Schemas = {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
};

/**
 * Valida e normaliza body/query/params com Zod antes do handler rodar.
 * Em caso de falha, devolve 400 com a lista de problemas (details).
 * Os valores parseados substituem os originais (já coeridos/tipados).
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query) as typeof req.query;
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        throw AppError.badRequest('Dados inválidos', err.issues);
      }
      throw err;
    }
  };
