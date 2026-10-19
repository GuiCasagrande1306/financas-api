import { z } from 'zod';
import { isoDay, signedCents } from '../../lib/zod';

/**
 * Tipos de conta aceitos pela API: checking = Conta corrente · savings = Poupança ·
 * cash = Dinheiro · wallet = Carteira digital. O CHECK do banco ainda aceita
 * 'credit_card' (legado), mas cartão de crédito é a tabela `credit_cards`.
 */
export const accountType = z.enum(['checking', 'savings', 'cash', 'wallet']);

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor deve estar no formato hex #RRGGBB');
const accountName = z.string().trim().min(1, 'Dê um nome à conta').max(60);
const accountIcon = z.string().trim().min(1).max(40);

/** `initialBalance` em CENTAVOS (±R$ 10 bi); pode ser negativo (conta que já começa no cheque especial). */
export const createAccountSchema = z.object({
  name: accountName,
  type: accountType,
  color: hexColor.optional(),
  icon: accountIcon.optional(), // ausente => ícone padrão do tipo
  initialBalance: signedCents.default(0),
});

export const updateAccountSchema = z.object({
  name: accountName.optional(),
  type: accountType.optional(),
  color: hexColor.optional(),
  icon: accountIcon.optional(),
  initialBalance: signedCents.optional(),
  isArchived: z.boolean().optional(),
});

// Booleano de query string: só 'true'/'false' (z.coerce.boolean trataria 'false' como true).
export const listAccountsQuery = z.object({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// Extrato: intervalo obrigatório (datas entre 1900 e 2100). from <= to e no máximo
// 366 dias (conferido no service).
export const statementQuery = z.object({
  from: isoDay, // 'YYYY-MM-DD'
  to: isoDay,
});

export const idParam = z.object({ id: z.string().uuid() });

export type AccountType = z.infer<typeof accountType>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;
export type StatementQuery = z.infer<typeof statementQuery>;
