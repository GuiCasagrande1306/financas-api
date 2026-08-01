import { z } from 'zod';

/**
 * Tipos de ativo suportados. São os tipos CONCRETOS (o instrumento). A classe
 * de mercado — Renda Fixa vs Renda Variável — é derivada daqui na service,
 * usada na alocação da carteira. Manter em sincronia com o CHECK do schema.sql.
 */
export const assetType = z.enum([
  'tesouro_direto',
  'cdb',
  'lci_lca',
  'poupanca',
  'fii',
  'acoes',
  'fundo',
  'cripto',
  'previdencia',
  'outros',
]);

/**
 * Tipo de rendimento (Fase 8):
 *  - 'pre'   → pré-fixado: `expectedAnnualRate` é a taxa fixa em % a.a.
 *  - 'cdi'   → pós-fixado no CDI: `expectedAnnualRate` é a % DO CDI (ex.: 110).
 *  - 'selic' → pós-fixado na Selic: `expectedAnnualRate` é a % DA Selic.
 */
export const yieldType = z.enum(['pre', 'cdi', 'selic']);

/**
 * IMPORTANTE: valores monetários em CENTAVOS e positivos (ex.: R$ 1.500,00 =>
 * 150000). `currentAmount` é opcional (valor manual p/ ativos variáveis/legado).
 * Para renda fixa com `purchaseDate`, o backend CALCULA o valor atual sozinho.
 */
export const createInvestmentSchema = z.object({
  name: z.string().min(1).max(120),
  assetType: assetType.default('outros'),
  investedAmount: z.number().int().nonnegative(), // CENTAVOS
  currentAmount: z.number().int().nonnegative().optional(), // CENTAVOS; manual/fallback
  expectedAnnualRate: z.number().min(0).max(9999.99).default(0), // pré: % a.a. | pós: % do indicador
  yieldType: yieldType.default('pre'),
  purchaseDate: z.string().date().optional(), // 'YYYY-MM-DD' (default = hoje)
  notes: z.string().max(1000).nullish(),
});

export const updateInvestmentSchema = createInvestmentSchema.partial();

export const listInvestmentsQuery = z.object({
  assetType: assetType.optional(),
});

export const idParam = z.object({ id: z.string().uuid() });

export type AssetType = z.infer<typeof assetType>;
export type YieldType = z.infer<typeof yieldType>;
export type CreateInvestmentInput = z.infer<typeof createInvestmentSchema>;
export type UpdateInvestmentInput = z.infer<typeof updateInvestmentSchema>;
export type ListInvestmentsQuery = z.infer<typeof listInvestmentsQuery>;
