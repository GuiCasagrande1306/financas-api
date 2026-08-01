import { PluggyClient } from 'pluggy-sdk';
import { env } from '../../env';
import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';

let client: PluggyClient | null = null;

/** Cliente Pluggy (lazy). Erro claro se as chaves não estiverem configuradas. */
function pluggy(): PluggyClient {
  if (!env.PLUGGY_CLIENT_ID || !env.PLUGGY_CLIENT_SECRET) {
    throw new AppError(
      503,
      'Open Finance indisponível: configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET.',
      'PLUGGY_NOT_CONFIGURED',
    );
  }
  if (!client) {
    client = new PluggyClient({
      clientId: env.PLUGGY_CLIENT_ID,
      clientSecret: env.PLUGGY_CLIENT_SECRET,
    });
  }
  return client;
}

/** Gera o connect_token que o widget PluggyConnect usa no frontend. */
export async function createConnectToken(): Promise<string> {
  const { accessToken } = await pluggy().createConnectToken();
  return accessToken;
}

/** Conta padrão (Carteira) do usuário — destino das transações importadas. */
async function resolveDefaultAccount(userId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1 AND is_archived = false ORDER BY created_at LIMIT 1`,
    [userId],
  );
  if (existing.length) return existing[0].id;
  const created = await query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, type, icon, color)
       VALUES ($1, 'Carteira', 'cash', 'wallet', '#10b981') RETURNING id`,
    [userId],
  );
  return created[0].id;
}

/** Palavra-chave da categoria da Pluggy → categoria do sistema mais próxima. */
async function nearestCategoryId(userId: string, pluggyCategory?: string | null): Promise<string | null> {
  if (!pluggyCategory) return null;
  const c = pluggyCategory.toLowerCase();
  const rules: [RegExp, string][] = [
    [/food|restaurant|supermarket|grocer|aliment/, 'Alimentação'],
    [/transport|uber|fuel|gas|mobility|transporte/, 'Transporte'],
    [/health|pharm|medical|saúde|saude/, 'Saúde'],
    [/rent|housing|home|moradia|aluguel/, 'Moradia'],
    [/leisure|entertainment|travel|lazer/, 'Lazer'],
    [/shopping|store|compras/, 'Compras'],
    [/education|educ/, 'Educação'],
    [/bill|utilit|subscription|conta/, 'Contas'],
  ];
  const target = rules.find(([re]) => re.test(c))?.[1];
  if (!target) return null;
  const rows = await query<{ id: string }>(
    `SELECT id FROM categories WHERE name = $1 AND (user_id = $2 OR user_id IS NULL) LIMIT 1`,
    [target, userId],
  );
  return rows[0]?.id ?? null;
}

interface PluggyTx {
  id: string;
  description?: string | null;
  amount: number; // na moeda da conta (reais)
  date: string | Date;
  type?: 'DEBIT' | 'CREDIT';
  category?: string | null;
  merchant?: { name?: string | null } | null;
}

/**
 * Busca as transações de todas as contas de um item na Pluggy e salva na nossa
 * tabela `transactions` (deduplicando por `external_id`). Categoriza pelo
 * mapeamento de palavras-chave.
 */
export async function importItemTransactions(
  userId: string,
  itemId: string,
): Promise<{ imported: number }> {
  const p = pluggy();
  const accountsResp = await p.fetchAccounts(itemId);
  const accounts = accountsResp.results ?? [];
  const localAccountId = await resolveDefaultAccount(userId);
  let imported = 0;

  for (const acc of accounts) {
    const txResp = await p.fetchTransactions(acc.id, { pageSize: 200 });
    for (const raw of (txResp.results ?? []) as unknown as PluggyTx[]) {
      const kind = raw.type === 'DEBIT' ? 'expense' : 'income';
      const amount = Math.round(Math.abs(raw.amount) * 100); // → centavos
      if (amount <= 0) continue;
      const occurredAt = String(raw.date).slice(0, 10);
      const categoryId = await nearestCategoryId(userId, raw.category);

      const res = await query(
        `INSERT INTO transactions
           (user_id, account_id, category_id, amount, kind, description, merchant,
            occurred_at, external_id, is_auto_categorized)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, true)
         ON CONFLICT (user_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          userId,
          localAccountId,
          categoryId,
          amount,
          kind,
          raw.description ?? null,
          raw.merchant?.name ?? null,
          occurredAt,
          `pluggy:${raw.id}`,
        ],
      );
      if (res.length) imported++;
    }
  }
  return { imported };
}

/**
 * Chamado pelo frontend logo após o widget conectar: guarda o mapeamento
 * item→usuário e faz a 1ª importação (funciona mesmo sem webhook configurado).
 */
export async function connectItem(userId: string, itemId: string): Promise<{ imported: number }> {
  await query(
    `INSERT INTO pluggy_items (item_id, user_id) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
    [itemId, userId],
  );
  return importItemTransactions(userId, itemId);
}

/**
 * Trata o webhook da Pluggy: quando um item é atualizado/sincronizado, importa
 * as transações do usuário dono daquele item.
 */
export async function handleWebhook(payload: {
  event?: string;
  itemId?: string;
  data?: { itemId?: string };
}): Promise<void> {
  const event = payload?.event ?? '';
  const itemId = payload?.itemId ?? payload?.data?.itemId;
  if (!itemId) return;

  const relevant = /^item\/(created|updated)$|^transactions\//.test(event);
  if (!relevant) return;

  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM pluggy_items WHERE item_id = $1`,
    [itemId],
  );
  const userId = rows[0]?.user_id;
  if (userId) await importItemTransactions(userId, itemId);
}
