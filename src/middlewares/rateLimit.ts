import rateLimit from 'express-rate-limit';

/**
 * Limite de tentativas nas rotas de autenticação — proteção contra força bruta
 * em login/cadastro. Conta por IP (precisa de `trust proxy` atrás do provedor).
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 30, // tentativas por IP na janela
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Muitas tentativas. Tente novamente em alguns minutos.',
    },
  },
});
