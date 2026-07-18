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
 * IMPORTANTE: valores monetários em CENTAVOS e positivos (ex.: R$ 1.500,00 =>
 * 150000), igual ao resto do app. `currentAmount` é opcional na criação: um
 * aporte novo vale, por padrão, o que custou (currentAmount = investedAmount).
 * `expectedAnnualRate` é o rendimento esperado em % ao ano (ex.: 12.5).
 */
export const createInvestmentSchema = z.object({
  name: z.string().min(1).max(120),
  assetType: assetType.default('outros'),
  investedAmount: z.number().int().nonnegative(), // CENTAVOS
  currentAmount: z.number().int().nonnegative().optional(), // CENTAVOS; default = investedAmount
  expectedAnnualRate: z.number().min(0).max(9999.99).default(0), // % a.a.
  notes: z.string().max(1000).nullish(),
});

export const updateInvestmentSchema = createInvestmentSchema.partial();

export const listInvestmentsQuery = z.object({
  assetType: assetType.optional(),
});

export const idParam = z.object({ id: z.string().uuid() });

export type AssetType = z.infer<typeof assetType>;
export type CreateInvestmentInput = z.infer<typeof createInvestmentSchema>;
export type UpdateInvestmentInput = z.infer<typeof updateInvestmentSchema>;
export type ListInvestmentsQuery = z.infer<typeof listInvestmentsQuery>;
