import { env } from '../../env';
import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';
import { getInvestmentsSummary } from '../investments/investments.service';

const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-flash-latest';

/** Centavos → "R$ 1.234,56". */
function brl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

interface TotalsRow {
  income: number;
  expense: number;
}
interface CategoryRow {
  name: string;
  total: number;
}

/**
 * Monta, em texto simples, o "Resumo Financeiro" do usuário (últimos 30 dias +
 * patrimônio) que será injetado como contexto na instrução de sistema do Gemini.
 * As agregações rodam no banco (SUM/GROUP BY) e em paralelo (Promise.all).
 */
async function buildContext(userId: string): Promise<string> {
  const [totalsRows, topCats, invSummary] = await Promise.all([
    query<TotalsRow>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::bigint  AS income,
         COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::bigint AS expense
       FROM transactions
      WHERE user_id = $1 AND deleted_at IS NULL
        AND occurred_at >= current_date - interval '30 days'`,
      [userId],
    ),
    query<CategoryRow>(
      `SELECT c.name, COALESCE(SUM(t.amount), 0)::bigint AS total
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1 AND t.deleted_at IS NULL AND t.kind = 'expense'
          AND t.occurred_at >= current_date - interval '30 days'
        GROUP BY c.name
        ORDER BY total DESC
        LIMIT 3`,
      [userId],
    ),
    getInvestmentsSummary(userId),
  ]);

  const income = totalsRows[0].income;
  const expense = totalsRows[0].expense;
  const net = income - expense;
  const patrimonio = invSummary.totals.current;

  const topText = topCats.length
    ? topCats.map((c, i) => `${i + 1}) ${c.name}: ${brl(c.total)}`).join('; ')
    : 'nenhum gasto categorizado no período';

  return [
    'Período analisado: últimos 30 dias.',
    `Total de receitas: ${brl(income)}.`,
    `Total de despesas: ${brl(expense)}.`,
    `Saldo do período (receitas menos despesas): ${brl(net)}.`,
    `As 3 categorias onde mais gastou: ${topText}.`,
    `Patrimônio total investido (valor atual): ${brl(patrimonio)}.`,
  ].join(' ');
}

/**
 * Conselheiro Financeiro IA. Monta o contexto do usuário, injeta na
 * system_instruction e envia a pergunta ao Gemini (mesmo endpoint/chave do scan
 * de recibos). Retorna a resposta em texto.
 */
export async function askAdvisor(userId: string, prompt: string): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(500, 'Conselheiro indisponível: GEMINI_API_KEY não configurada', 'CONFIG_ERROR');
  }

  const context = await buildContext(userId);

  const systemInstruction =
    'Você é um consultor financeiro brasileiro simpático, direto e especialista. ' +
    'O usuário que você está ajudando tem o seguinte cenário financeiro atual: ' +
    context +
    ' Responda à pergunta do usuário de forma concisa (máximo 2 parágrafos), ' +
    'baseando-se estritamente nestes dados. Escreva em português do Brasil e use R$ nos valores. ' +
    'Se a pergunta não tiver relação com finanças pessoais, redirecione gentilmente para o tema.';

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      // Alto de propósito: o Gemini 2.5 gasta tokens "pensando" antes de escrever;
      // com folga, a resposta de 2 parágrafos não sai cortada no meio.
      maxOutputTokens: 2048,
    },
  };

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[ai] Gemini erro', res.status, detail.slice(0, 300));
      if (res.status === 429) {
        throw new AppError(429, 'Muitas perguntas seguidas. Aguarde alguns segundos e tente de novo.', 'RATE_LIMITED');
      }
      throw new AppError(502, 'O conselheiro está indisponível agora. Tente novamente em instantes.', 'AI_ERROR');
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      throw new AppError(502, 'Não consegui gerar uma resposta agora. Tente reformular a pergunta.', 'AI_ERROR');
    }
    return text;
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error('[ai] erro:', (err as Error)?.message ?? err);
    throw new AppError(502, 'O conselheiro está indisponível agora. Tente novamente em instantes.', 'AI_ERROR');
  }
}
