import { env } from '../../env';
import { query } from '../../db/pool';
import { AppError } from '../../lib/AppError';

const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-flash-latest';

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Lê a foto de um recibo/nota fiscal e extrai os dados do gasto usando a visão
 * do Google Gemini (free tier). Força um JSON via `responseSchema`, então a
 * resposta sempre tem: title, amount (CENTAVOS), date, category (+ categoryId).
 * Lança 422 se a foto estiver ilegível.
 */
export async function scanReceipt(userId: string, buffer: Buffer, mimetype: string) {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(500, 'Scan indisponível: GEMINI_API_KEY não configurada', 'CONFIG_ERROR');
  }

  // Categorias de despesa do usuário (+ do sistema) para restringir a sugestão.
  const cats = await query<{ id: string; name: string }>(
    `select id, name from categories
      where (user_id = $1 or user_id is null) and kind = 'expense' and is_archived = false
      order by name`,
    [userId],
  );
  const names = cats.map((c) => c.name);
  const categoryIdByName = new Map(cats.map((c) => [c.name, c.id]));

  // O Gemini é forçado a devolver EXATAMENTE este JSON (responseSchema).
  const responseSchema = {
    type: 'OBJECT',
    properties: {
      readable: { type: 'BOOLEAN', description: 'true se dá para ler; false se borrado, ilegível ou não é um recibo' },
      title: { type: 'STRING', description: 'Nome do estabelecimento' },
      amount: { type: 'NUMBER', description: 'Valor TOTAL pago, em reais, como número (ex.: 45.90). Use o total final.' },
      date: { type: 'STRING', description: "Data da compra em 'YYYY-MM-DD'" },
      category: {
        type: 'STRING',
        ...(names.length > 0 ? { enum: names } : {}),
        description: 'A categoria da lista que melhor descreve o estabelecimento',
      },
    },
    required: ['readable', 'title', 'amount', 'date', 'category'],
  };

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimetype, data: buffer.toString('base64') } },
          {
            text:
              'Extraia os dados deste recibo/nota fiscal brasileiro. ' +
              `Se o ano não estiver visível na data, assuma ${new Date().getFullYear()}. ` +
              'Se a imagem estiver borrada, ilegível ou não for um recibo, defina readable=false.',
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0,
    },
  };

  let parsed: { readable?: boolean; title?: string; amount?: number; date?: string; category?: string };
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
      console.error('[scan] Gemini erro', res.status, detail.slice(0, 300));
      if (res.status === 429) {
        throw new AppError(429, 'Muitas leituras seguidas. Aguarde alguns segundos e tente de novo.', 'RATE_LIMITED');
      }
      throw new AppError(502, 'Falha ao processar a imagem com a IA. Tente novamente em instantes.', 'AI_ERROR');
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new AppError(422, 'Não deu pra ler o recibo. Tente uma foto mais nítida.', 'UNREADABLE_RECEIPT');
    }
    parsed = JSON.parse(text);
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error('[scan] erro:', (err as Error)?.message ?? err);
    throw new AppError(502, 'Falha ao processar a imagem com a IA. Tente novamente em instantes.', 'AI_ERROR');
  }

  if (!parsed || !parsed.readable) {
    throw new AppError(
      422,
      'Não deu pra ler o recibo. Tente uma foto mais nítida, bem enquadrada e sem reflexo.',
      'UNREADABLE_RECEIPT',
    );
  }

  // reais -> centavos
  const amount = Math.round((Number(parsed.amount) || 0) * 100);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(422, 'Não consegui identificar o valor total no recibo.', 'UNREADABLE_RECEIPT');
  }

  const date = parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : todayISO();

  return {
    title: parsed.title ?? 'Recibo',
    amount, // CENTAVOS
    date,
    category: parsed.category ?? null,
    categoryId: parsed.category ? categoryIdByName.get(parsed.category) ?? null : null,
  };
}
