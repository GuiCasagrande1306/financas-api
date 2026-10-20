import { z } from 'zod';
import { isoDay, positiveCents } from '../../lib/zod';

/**
 * Empréstimos a receber. Valores em CENTAVOS (inteiros > 0, teto R$ 10 bi);
 * datas 'YYYY-MM-DD' entre 1900 e 2100 (`isoDay`). Regras que dependem de
 * mais de um campo (1ª parcela ≥ data do empréstimo, posse das contas…) são
 * conferidas no service, com mensagem clara.
 */

const borrowerName = z.string().trim().min(1, 'Informe quem pegou emprestado').max(80);
const description = z.string().trim().max(255).nullish();
const notes = z.string().trim().max(1000).nullish();
const accountRef = z.string().uuid().nullish(); // null = nenhuma conta

/** Cronograma: `count` parcelas mensais de `amount`, a 1ª vencendo em `firstDueDate`. */
export const scheduleSchema = z.object({
  count: z.number().int().min(1, 'Pelo menos 1 parcela').max(120, 'No máximo 120 parcelas'),
  amount: positiveCents,
  firstDueDate: isoDay,
});

export const createLoanSchema = z.object({
  borrowerName,
  description,
  notes,
  principal: positiveCents,
  lentAt: isoDay,
  sourceAccountId: accountRef, // de onde o dinheiro saiu (opcional → não mexe em saldo)
  receiveAccountId: accountRef, // conta padrão para receber as parcelas (opcional)
  schedule: scheduleSchema,
});

// Edição parcial. O cronograma não muda aqui (cada parcela pendente se edita na própria rota).
export const updateLoanSchema = z.object({
  borrowerName: borrowerName.optional(),
  description,
  notes,
  principal: positiveCents.optional(),
  lentAt: isoDay.optional(),
  sourceAccountId: accountRef, // null = parar de descontar de conta (remove a saída)
  receiveAccountId: accountRef,
});

export const updateInstallmentSchema = z.object({
  dueDate: isoDay.optional(),
  amount: positiveCents.optional(),
});

/**
 * "Recebi": conta (default = a do empréstimo), data (default = hoje SP), valor (default = o da parcela).
 * `remainderDueDate`: só vale quando o valor recebido é MENOR que o da parcela — a diferença
 * continua sendo cobrada numa parcela nova com esse vencimento. Sem ele (ou null), a parcela
 * fica quitada com o valor recebido e a diferença deixa de ser cobrada.
 */
export const receiveInstallmentSchema = z.object({
  accountId: z.string().uuid().nullish(),
  receivedAt: isoDay.optional(),
  amount: positiveCents.optional(),
  remainderDueDate: isoDay.nullish(),
});

/** Cor do empréstimo na UI (contraparte no extrato da conta). */
export const LOAN_COLOR = '#0ea5e9';

export const idParam = z.object({ id: z.string().uuid() });

export const installmentParams = z.object({
  id: z.string().uuid(),
  installmentId: z.string().uuid(),
});

export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;
export type UpdateInstallmentInput = z.infer<typeof updateInstallmentSchema>;
export type ReceiveInstallmentInput = z.infer<typeof receiveInstallmentSchema>;
