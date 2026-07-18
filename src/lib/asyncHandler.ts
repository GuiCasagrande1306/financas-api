import { RequestHandler } from 'express';

/**
 * Envolve um handler async e encaminha qualquer rejeição para o middleware
 * de erro central. Evita repetir try/catch em toda rota.
 */
export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
