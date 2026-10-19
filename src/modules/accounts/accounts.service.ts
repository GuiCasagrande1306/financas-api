import type { PoolClient } from 'pg';
import { pool, query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { addDaysISO, assertDateRange, todaySP } from '../../lib/dates';
import { txColumns, type TransactionRow } from '../transactions/transactions.schema';
import type { AccountType, CreateAccountInput, UpdateAccountInput } from './accounts.schema';

/** Ícone padrão (lucide) de cada tipo de conta, quando o cliente não manda um. */
export const DEFAULT_ICON_BY_TYPE: Record<AccountType, string> = {
  checking: 'landmark',
  savings: 'piggy-bank',
  cash: 'wallet',
  wallet: 'smartphone',
};

const DEFAULT_COLOR = '#10b981';

/** Colunas da conta em camelCase (tabela com alias `a`). */
const ACCOUNT_COLUMNS = `
  a.id,
  a.name,
  a.type,
  a.icon,
  a.color,
  a.initial_balance AS "initialBalance",
  a.is_archived     AS "isArchived",
  a.created_at      AS "createdAt",
  a.updated_at      AS "updatedAt"
`;

/** Conta como sai na API. Valores em CENTAVOS. */
export interface Account {
  id: string;
  name: string;
  type: AccountType;
  icon: string;
  color: string;
  initialBalance: number; // pode ser negativo
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  balance: number; // saldo até hoje (America/Sao_Paulo)
  monthInflow: number; // entradas do mês corrente até hoje
  monthOutflow: number; // saídas do mês corrente até hoje
  transactionCount: number; // linhas não deletadas que movem a conta
}

/**
 * "Pernas" de movimento das contas — a REGRA ÚNICA de saldo do app. Cada linha
 * diz quanto (com sinal) uma transação mexeu em UMA conta:
 *  - income/expense FORA do cartão → +/− na conta `account_id`;
 *  - transfer → − na conta `account_id` (inclui pagamento de fatura);
 *  - transfer com destino → + na conta `transfer_account_id`.
 * Compra/estorno no cartão NÃO mexe em conta (vira fatura; quem tira dinheiro da
 * conta é o pagamento da fatura). Só linhas não deletadas. `$1` = user_id.
 * `tx_id`/`kind`/`credit_card_id` identificam a transação de origem da perna
 * (as duas pernas de uma transferência têm o mesmo tx_id).
 */
const LEGS_SQL = `
  SELECT t.account_id, t.occurred_at,
         CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END AS delta,
         t.id AS tx_id, t.kind, t.credit_card_id
    FROM transactions t
   WHERE t.user_id = $1 AND t.deleted_at IS NULL
     AND (t.credit_card_id IS NULL OR t.kind = 'transfer')
  UNION ALL
  SELECT t.transfer_account_id, t.occurred_at, t.amount,
         t.id, t.kind, t.credit_card_id
    FROM transactions t
   WHERE t.user_id = $1 AND t.deleted_at IS NULL
     AND t.kind = 'transfer' AND t.transfer_account_id IS NOT NULL
`;

/**
 * Executa `fn` numa transação com trava por usuário (advisory lock). Serializa
 * operações que dependem de "quantas contas ativas existem" — criar a conta
 * padrão, arquivar/excluir — para duas requisições simultâneas não criarem duas
 * "Carteiras" nem arquivarem juntas as duas últimas contas.
 */
async function withAccountsLock<T>(userId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`accounts:${userId}`]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// Conta padrão: a de dinheiro (cash) não arquivada mais antiga; sem ela, a
// conta ativa mais antiga (evita recriar a "Carteira" que o usuário arquivou).
const DEFAULT_ACCOUNT_SQL = `
  SELECT id FROM accounts
   WHERE user_id = $1 AND is_archived = false
   ORDER BY (type = 'cash') DESC, created_at
   LIMIT 1`;

/**
 * Conta padrão do usuário — destino de lançamento sem `accountId`, das compras
 * no cartão (account_id é NOT NULL), das recorrências sem origem e do Open
 * Finance. Se o usuário não tem nenhuma conta ativa, cria a "Carteira".
 * Função ÚNICA: nenhum módulo deve ter a sua própria versão disto.
 */
export async function getOrCreateDefaultAccount(userId: string): Promise<string> {
  const existing = await query<{ id: string }>(DEFAULT_ACCOUNT_SQL, [userId]);
  if (existing.length) return existing[0].id;

  return withAccountsLock(userId, async (client) => {
    // Confere de novo já com a trava: outra requisição pode ter criado agora.
    const again = await client.query<{ id: string }>(DEFAULT_ACCOUNT_SQL, [userId]);
    if (again.rows.length) return again.rows[0].id;
    const created = await client.query<{ id: string }>(
      `INSERT INTO accounts (user_id, name, type, icon, color)
         VALUES ($1, 'Carteira', 'cash', 'wallet', '#10b981')
         RETURNING id`,
      [userId],
    );
    return created.rows[0].id;
  });
}

/**
 * Confere que a conta (vinda do cliente) é do usuário e — por padrão — não está
 * arquivada. Conta arquivada pode continuar numa linha antiga, mas não pode ser
 * escolhida como conta NOVA de um lançamento. Lança 400 com mensagem clara.
 * `label` personaliza a mensagem (ex.: 'de origem', 'de destino').
 */
export async function assertAccountUsable(
  userId: string,
  accountId: string,
  opts: { allowArchived?: boolean; label?: string } = {},
): Promise<{ id: string; name: string }> {
  const rows = await query<{ id: string; name: string; isArchived: boolean }>(
    `SELECT id, name, is_archived AS "isArchived" FROM accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  const label = opts.label ? ` ${opts.label}` : '';
  if (rows.length === 0) throw AppError.badRequest(`Conta${label} não encontrada`);
  if (rows[0].isArchived && !opts.allowArchived) {
    throw AppError.badRequest(
      `A conta "${rows[0].name}" está arquivada. Desarquive-a para usá-la em lançamentos novos.`,
    );
  }
  return { id: rows[0].id, name: rows[0].name };
}

/**
 * Saldos das contas do usuário numa ÚNICA query (GROUP BY sobre as pernas de
 * movimento) — nunca uma query por conta. Saldo = initial_balance + Σ pernas
 * até hoje (America/Sao_Paulo); lançamento agendado (data futura) só entra no
 * dia dele. `totals.balance` = soma das contas NÃO arquivadas: é o saldo total
 * do app (resumo, previsão e tela de contas usam este mesmo número).
 *
 * Ordem: não arquivadas primeiro, depois created_at.
 */
export async function getAccountBalances(
  userId: string,
  opts: { includeArchived?: boolean; accountId?: string } = {},
): Promise<{ data: Account[]; totals: { balance: number } }> {
  const today = todaySP();
  const monthStart = `${today.slice(0, 7)}-01`;
  const params: unknown[] = [userId, today, monthStart];
  const where = ['a.user_id = $1'];
  if (!opts.includeArchived) where.push('a.is_archived = false');
  if (opts.accountId) {
    params.push(opts.accountId);
    where.push(`a.id = $${params.length}`);
  }

  const data = await query<Account>(
    `SELECT ${ACCOUNT_COLUMNS},
            (a.initial_balance + COALESCE(m.delta, 0))::bigint AS balance,
            COALESCE(m.month_inflow, 0)::bigint                AS "monthInflow",
            COALESCE(m.month_outflow, 0)::bigint               AS "monthOutflow",
            COALESCE(m.tx_count, 0)::int                       AS "transactionCount"
       FROM accounts a
       LEFT JOIN (
         SELECT l.account_id,
                SUM(l.delta) FILTER (WHERE l.occurred_at <= $2::date) AS delta,
                SUM(l.delta) FILTER (
                  WHERE l.delta > 0 AND l.occurred_at >= $3::date AND l.occurred_at <= $2::date
                ) AS month_inflow,
                SUM(-l.delta) FILTER (
                  WHERE l.delta < 0 AND l.occurred_at >= $3::date AND l.occurred_at <= $2::date
                ) AS month_outflow,
                COUNT(*) AS tx_count
           FROM (${LEGS_SQL}) l
          GROUP BY l.account_id
       ) m ON m.account_id = a.id
      WHERE ${where.join(' AND ')}
      ORDER BY a.is_archived, a.created_at`,
    params,
  );

  const balance = data.filter((a) => !a.isArchived).reduce((s, a) => s + a.balance, 0);
  return { data, totals: { balance } };
}

/** Movimento AGENDADO das contas num mês (CENTAVOS): entradas e saídas, já líquidas por transação. */
export interface ScheduledMonth {
  ym: string; // 'YYYY-MM'
  inflow: number;
  outflow: number;
}

/**
 * Lançamentos com data FUTURA (occurred_at > `today`) que vão mexer no saldo
 * total — mesma regra das pernas (LEGS_SQL), só contas NÃO arquivadas —,
 * agrupados por mês. Base da previsão de saldo.
 *  - Cada transação vira o seu efeito LÍQUIDO no total: transferência entre
 *    duas contas ativas = 0 (some); de uma ativa para uma arquivada = saída;
 *  - Pagamento de fatura agendado (transfer com cartão) fica FORA: a previsão já
 *    desconta as compras do cartão pela data da compra (contaria em dobro).
 */
export async function getScheduledAccountMoves(userId: string, today: string): Promise<ScheduledMonth[]> {
  return query<ScheduledMonth>(
    `SELECT n.ym,
            COALESCE(SUM(n.net) FILTER (WHERE n.net > 0), 0)::bigint  AS inflow,
            COALESCE(-SUM(n.net) FILTER (WHERE n.net < 0), 0)::bigint AS outflow
       FROM (
         SELECT to_char(l.occurred_at, 'YYYY-MM') AS ym, l.tx_id, SUM(l.delta) AS net
           FROM (${LEGS_SQL}) l
           JOIN accounts a ON a.id = l.account_id AND a.user_id = $1 AND a.is_archived = false
          WHERE l.occurred_at > $2::date
            AND NOT (l.kind = 'transfer' AND l.credit_card_id IS NOT NULL)
          GROUP BY 1, 2
       ) n
      GROUP BY n.ym
      ORDER BY n.ym`,
    [userId, today],
  );
}

/**
 * Lista as contas (com saldo e movimento do mês). Antes, garante a conta
 * padrão — a lista nunca vem vazia.
 */
export async function listAccounts(userId: string, includeArchived = false) {
  await getOrCreateDefaultAccount(userId);
  return getAccountBalances(userId, { includeArchived });
}

/** Uma conta (arquivada ou não) já com saldo. 404 se não for do usuário. */
export async function getAccount(userId: string, id: string): Promise<Account> {
  const { data } = await getAccountBalances(userId, { includeArchived: true, accountId: id });
  if (data.length === 0) throw AppError.notFound('Conta não encontrada');
  return data[0];
}

export async function createAccount(userId: string, input: CreateAccountInput): Promise<Account> {
  const rows = await query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, type, icon, color, initial_balance)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
    [
      userId,
      input.name,
      input.type,
      input.icon ?? DEFAULT_ICON_BY_TYPE[input.type],
      input.color ?? DEFAULT_COLOR,
      input.initialBalance ?? 0,
    ],
  );
  return getAccount(userId, rows[0].id);
}

const LAST_ACCOUNT_MESSAGE = 'Você precisa de pelo menos uma conta ativa.';

/** Há outra conta ativa além de `id`? (roda dentro da trava de contas) */
async function hasOtherActiveAccount(client: PoolClient, userId: string, id: string): Promise<boolean> {
  const rows = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM accounts
      WHERE user_id = $1 AND is_archived = false AND id <> $2`,
    [userId, id],
  );
  return rows.rows[0].n > 0;
}

interface AccountBaseRow {
  id: string;
  type: AccountType;
  icon: string;
  isArchived: boolean;
}

async function lockedAccountRow(client: PoolClient, userId: string, id: string): Promise<AccountBaseRow> {
  const rows = await client.query<AccountBaseRow>(
    `SELECT id, type, icon, is_archived AS "isArchived"
       FROM accounts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (rows.rows.length === 0) throw AppError.notFound('Conta não encontrada');
  return rows.rows[0];
}

/**
 * Atualiza campos parciais da conta (inclui arquivar/desarquivar).
 * Arquivar a última conta ativa → 409 LAST_ACCOUNT.
 * Trocar o tipo sem mandar ícone troca também o ícone, se ele ainda era o padrão do tipo antigo.
 */
export async function updateAccount(userId: string, id: string, input: UpdateAccountInput): Promise<Account> {
  await withAccountsLock(userId, async (client) => {
    const current = await lockedAccountRow(client, userId, id);

    if (input.isArchived === true && !current.isArchived && !(await hasOtherActiveAccount(client, userId, id))) {
      throw new AppError(409, LAST_ACCOUNT_MESSAGE, 'LAST_ACCOUNT');
    }

    const fields: Record<string, unknown> = {};
    if (input.name !== undefined) fields.name = input.name;
    if (input.type !== undefined) fields.type = input.type;
    if (input.color !== undefined) fields.color = input.color;
    if (input.icon !== undefined) fields.icon = input.icon;
    else if (
      input.type !== undefined &&
      input.type !== current.type &&
      current.icon === DEFAULT_ICON_BY_TYPE[current.type as AccountType]
    ) {
      fields.icon = DEFAULT_ICON_BY_TYPE[input.type];
    }
    if (input.initialBalance !== undefined) fields.initial_balance = input.initialBalance;
    if (input.isArchived !== undefined) fields.is_archived = input.isArchived;

    const keys = Object.keys(fields);
    if (keys.length === 0) return;

    const setClauses = keys.map((key, i) => `${key} = $${i + 1}`);
    const values = keys.map((key) => fields[key]);
    values.push(id, userId);
    // updated_at é mantido pelo trigger trg_accounts_updated.
    await client.query(
      `UPDATE accounts SET ${setClauses.join(', ')}
        WHERE id = $${keys.length + 1} AND user_id = $${keys.length + 2}`,
      values,
    );
  });
  return getAccount(userId, id);
}

/**
 * Exclui a conta. Só é possível se NENHUMA transação a referencia (nem as
 * soft-deletadas: a FK é RESTRICT) — senão 409 sugerindo arquivar. A última
 * conta ativa também não pode ser excluída (409 LAST_ACCOUNT).
 */
export async function deleteAccount(userId: string, id: string): Promise<void> {
  await withAccountsLock(userId, async (client) => {
    const current = await lockedAccountRow(client, userId, id);

    if (!current.isArchived && !(await hasOtherActiveAccount(client, userId, id))) {
      throw new AppError(409, LAST_ACCOUNT_MESSAGE, 'LAST_ACCOUNT');
    }

    const refs = await client.query<{ used: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM transactions
          WHERE user_id = $1 AND (account_id = $2 OR transfer_account_id = $2)
       ) AS used`,
      [userId, id],
    );
    if (refs.rows[0].used) {
      throw new AppError(
        409,
        'Esta conta tem lançamentos. Arquive para escondê-la sem perder o histórico.',
        'ACCOUNT_HAS_TRANSACTIONS',
      );
    }

    await client.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [id, userId]);
  });
}

/** Item do extrato: a transação + sentido, saldo após ela, categoria e contraparte. */
export interface StatementItem extends TransactionRow {
  direction: 'in' | 'out';
  balanceAfter: number;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  counterpart: { type: 'account' | 'card'; id: string; name: string; color: string } | null;
}

interface StatementRow extends TransactionRow {
  direction: 'in' | 'out';
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  cpAccountId: string | null;
  cpAccountName: string | null;
  cpAccountColor: string | null;
  cpCardId: string | null;
  cpCardName: string | null;
  cpCardColor: string | null;
}

// Intervalo máximo do extrato (to − from), em dias.
const STATEMENT_MAX_DAYS = 366;

/**
 * Extrato da conta no intervalo from..to: só as linhas que MOVEM a conta (mesma
 * regra do saldo — compra no cartão não aparece). Devolve saldo de abertura
 * (fim do dia anterior a `from`), de fechamento (fim de `to`, inclui agendados
 * se `to` for futuro), entradas/saídas do intervalo, os itens (mais recentes
 * primeiro, cada um com o saldo logo após ele) e 1 ponto de saldo por dia.
 */
export async function getAccountStatement(userId: string, id: string, from: string, to: string) {
  const days = assertDateRange(from, to, STATEMENT_MAX_DAYS); // nº de dias de from..to (inclusivo)
  const account = await getAccount(userId, id);

  const [openingRows, rows] = await Promise.all([
    query<{ total: number }>(
      `SELECT COALESCE(SUM(l.delta), 0)::bigint AS total
         FROM (${LEGS_SQL}) l
        WHERE l.account_id = $2 AND l.occurred_at < $3::date`,
      [userId, id, from],
    ),
    query<StatementRow>(
      `SELECT ${txColumns('t.')},
              CASE WHEN t.kind = 'transfer' AND t.transfer_account_id = $2 THEN 'in'
                   WHEN t.kind = 'income' THEN 'in'
                   ELSE 'out' END                    AS direction,
              c.name                                 AS "categoryName",
              c.color                                AS "categoryColor",
              c.icon                                 AS "categoryIcon",
              ca.id                                  AS "cpAccountId",
              ca.name                                AS "cpAccountName",
              ca.color                               AS "cpAccountColor",
              cc.id                                  AS "cpCardId",
              cc.name                                AS "cpCardName",
              cc.color                               AS "cpCardColor"
         FROM transactions t
         LEFT JOIN categories c
           ON c.id = t.category_id AND (c.user_id = t.user_id OR c.user_id IS NULL)
         -- Transferência: a OUTRA conta (destino se saiu daqui, origem se entrou aqui).
         LEFT JOIN accounts ca
           ON t.kind = 'transfer' AND ca.user_id = t.user_id
          AND ca.id = CASE WHEN t.transfer_account_id = $2 THEN t.account_id
                           ELSE t.transfer_account_id END
         -- Pagamento de fatura: o cartão pago.
         LEFT JOIN credit_cards cc
           ON t.kind = 'transfer' AND cc.user_id = t.user_id AND cc.id = t.credit_card_id
        WHERE t.user_id = $1 AND t.deleted_at IS NULL
          AND (
                (t.account_id = $2 AND (t.credit_card_id IS NULL OR t.kind = 'transfer'))
             OR (t.kind = 'transfer' AND t.transfer_account_id = $2)
          )
          AND t.occurred_at >= $3::date AND t.occurred_at <= $4::date
        ORDER BY t.occurred_at, t.created_at, t.id`,
      [userId, id, from, to],
    ),
  ]);

  const openingBalance = account.initialBalance + openingRows[0].total;

  // Ordem cronológica (asc) para o saldo corrente; a resposta vai invertida (desc).
  let running = openingBalance;
  let inflow = 0;
  let outflow = 0;
  const endOfDay = new Map<string, number>();
  const itemsAsc: StatementItem[] = rows.map((r) => {
    const {
      cpAccountId,
      cpAccountName,
      cpAccountColor,
      cpCardId,
      cpCardName,
      cpCardColor,
      ...tx
    } = r;
    if (r.direction === 'in') {
      running += r.amount;
      inflow += r.amount;
    } else {
      running -= r.amount;
      outflow += r.amount;
    }
    endOfDay.set(r.occurredAt, running);

    let counterpart: StatementItem['counterpart'] = null;
    if (cpAccountId) {
      counterpart = { type: 'account', id: cpAccountId, name: cpAccountName ?? '', color: cpAccountColor ?? '' };
    } else if (cpCardId) {
      counterpart = { type: 'card', id: cpCardId, name: cpCardName ?? '', color: cpCardColor ?? '' };
    }
    return { ...tx, balanceAfter: running, counterpart };
  });

  // 1 ponto por dia de from..to (saldo no FIM do dia; dia sem movimento repete o anterior).
  // Laço por CONTAGEM de dias, nunca por comparação de string entre datas.
  const dailyBalance: { date: string; balance: number }[] = [];
  let carry = openingBalance;
  for (let i = 0; i < days; i++) {
    const d = addDaysISO(from, i);
    carry = endOfDay.get(d) ?? carry;
    dailyBalance.push({ date: d, balance: carry });
  }

  return {
    account,
    from,
    to,
    openingBalance,
    closingBalance: running,
    inflow,
    outflow,
    items: itemsAsc.reverse(),
    dailyBalance,
  };
}
