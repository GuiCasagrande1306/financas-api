import { z } from 'zod';
import { DATE_RANGE_MESSAGE, MAX_ISO_DAY, MIN_ISO_DAY } from './dates';

/**
 * Peças de validação (Zod) compartilhadas por todos os módulos.
 *
 * Toda data e todo valor que chega do cliente passa por aqui — assim nenhum
 * módulo esquece um limite e nenhum valor absurdo chega ao banco (estouro de
 * BIGINT vira 500) ou às contas de calendário (ano 9999 virava laço infinito).
 */

/** Data de calendário 'YYYY-MM-DD' válida, entre 1900-01-01 e 2100-12-31. */
export const isoDay = z
  .string()
  .date()
  .refine((d) => d >= MIN_ISO_DAY && d <= MAX_ISO_DAY, DATE_RANGE_MESSAGE);

/** Mês 'YYYY-MM' entre 1900-01 e 2100-12 (fatura, resumo, orçamento). */
export const isoMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Formato esperado: YYYY-MM')
  .refine((m) => m >= MIN_ISO_DAY.slice(0, 7) && m <= MAX_ISO_DAY.slice(0, 7), DATE_RANGE_MESSAGE);

/**
 * Filtro por categoria vindo do cliente: o id (uuid) da categoria OU 'none'
 * (= "Sem categoria", `category_id IS NULL`). Sai em minúsculas. A visibilidade
 * do id é conferida no service.
 */
export const CATEGORY_NONE = 'none';
export const categoryFilterParam = z
  .string()
  .regex(
    /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    "Formato esperado: id da categoria ou 'none'",
  )
  .transform((s) => s.toLowerCase());

/** Teto de qualquer valor monetário de entrada: R$ 10 bilhões, em CENTAVOS. */
export const MAX_CENTS = 1_000_000_000_000;
const MAX_CENTS_MESSAGE = 'Valor acima do máximo permitido (R$ 10 bilhões).';
const MIN_CENTS_MESSAGE = 'Valor abaixo do mínimo permitido (−R$ 10 bilhões).';

/** Valor em CENTAVOS inteiro e positivo (> 0), com teto. Ex.: R$ 45,50 => 4550. */
export const positiveCents = z.number().int().positive().max(MAX_CENTS, MAX_CENTS_MESSAGE);

/** Valor em CENTAVOS inteiro e >= 0, com teto (limite do cartão, valor investido). */
export const nonNegativeCents = z.number().int().nonnegative().max(MAX_CENTS, MAX_CENTS_MESSAGE);

/** Valor em CENTAVOS inteiro com sinal (saldo inicial, guardar/resgatar), entre −teto e +teto. */
export const signedCents = z
  .number()
  .int()
  .min(-MAX_CENTS, MIN_CENTS_MESSAGE)
  .max(MAX_CENTS, MAX_CENTS_MESSAGE);
