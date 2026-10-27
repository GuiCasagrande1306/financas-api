import rateLimit from 'express-rate-limit';

/**
 * Limite de tentativas nas rotas de autenticação — proteção contra força bruta
 * em login/cadastro. Conta por IP (precisa de `trust proxy` atrás do provedor).
 *
 * O contador fica na MEMÓRIA do processo. No Render (um processo só) vale para a API
 * inteira; na Vercel vale POR INSTÂNCIA da função (zera quando ela é reciclada, e cada
 * instância nova aceita mais 30) — lá a trava de verdade é a regra de Rate Limiting do
 * Firewall da Vercel em /api/auth/* (DEPLOY.md, seção Vercel).
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
