import { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../lib/AppError';
import { isProd } from '../env';

/** Captura qualquer rota não registrada e transforma em 404 padronizado. */
export const notFoundHandler: RequestHandler = (req) => {
  throw AppError.notFound(`Rota não encontrada: ${req.method} ${req.originalUrl}`);
};

/**
 * Middleware de erro central. É o ÚNICO lugar que formata resposta de erro.
 * Traduz AppError (erros de negócio) e alguns códigos do Postgres em respostas
 * HTTP consistentes; o resto vira 500 com log completo no servidor.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  // Erros de negócio conhecidos
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
  }

  // Erros conhecidos do Postgres (https://www.postgresql.org/docs/current/errcodes-appendix.html)
  const pgCode = (err as { code?: string })?.code;
  switch (pgCode) {
    case '23505': // unique_violation
      return res
        .status(409)
        .json({ error: { code: 'CONFLICT', message: 'Registro duplicado' } });
    case '23503': // foreign_key_violation
      return res.status(400).json({
        error: { code: 'FK_VIOLATION', message: 'Referência inválida (categoria ou conta inexistente)' },
      });
    case '23514': // check_violation
      return res
        .status(400)
        .json({ error: { code: 'CHECK_VIOLATION', message: 'Valor viola uma restrição do banco' } });
    case '22P02': // invalid_text_representation (ex: uuid malformado)
      return res
        .status(400)
        .json({ error: { code: 'INVALID_INPUT', message: 'Formato de dado inválido' } });
    case '22003': // numeric_value_out_of_range (ex: valor/soma estoura o BIGINT)
      return res.status(400).json({
        error: { code: 'OUT_OF_RANGE', message: 'Valor fora do intervalo permitido. Confira o valor digitado.' },
      });
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow (ex: ano 0, mês 13)
      return res.status(400).json({
        error: { code: 'INVALID_DATE', message: 'Data inválida ou fora do intervalo permitido (1900–2100).' },
      });
  }

  // Fallback: erro não previsto — loga tudo no servidor, expõe pouco ao cliente.
  console.error('🔥 Erro não tratado:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor',
      ...(isProd ? {} : { debug: String((err as Error)?.message ?? err) }),
    },
  });
};
