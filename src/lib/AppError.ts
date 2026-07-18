/**
 * Erro de aplicação com status HTTP e código semântico.
 * Qualquer AppError lançado nos services/controllers é traduzido para uma
 * resposta JSON consistente pelo errorHandler central.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, code = 'APP_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, message, 'BAD_REQUEST', details);
  }
  static unauthorized(message = 'Não autenticado') {
    return new AppError(401, message, 'UNAUTHORIZED');
  }
  static forbidden(message = 'Acesso negado') {
    return new AppError(403, message, 'FORBIDDEN');
  }
  static notFound(message = 'Recurso não encontrado') {
    return new AppError(404, message, 'NOT_FOUND');
  }
  static conflict(message: string) {
    return new AppError(409, message, 'CONFLICT');
  }
}
