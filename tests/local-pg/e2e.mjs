/* eslint-disable */
// Teste PONTA A PONTA da API LOCAL (localhost:3333 → Postgres 127.0.0.1:54329).
// Nunca produção: antes de escrever qualquer coisa, assertLocalApi() confere que a
// API é a do start-api.sh e que o banco dela é só o local.
//
// Fluxo: reset do banco → fixture PRÓPRIO do teste (março/2025, datas fixas no
// passado: nada depende de "hoje") → seções, na ordem → resumo → re-semeia a demo
// (seed-demo.mjs --reset) para o banco não ficar com o fixture do teste.
//
// Uso: node e2e.mjs                 tudo
//      node e2e.mjs --only=relatório   só as seções cujo nome contém o trecho
//      node e2e.mjs --no-demo          não re-semeia a demo no fim (deixa o fixture para inspecionar)
//
// COMO ACRESCENTAR UMA SEÇÃO: copie um bloco `section('nome', async (ctx) => { ... })`
// para o ponto marcado "ACRESCENTE NOVAS SEÇÕES AQUI". Use os ids de `ctx` (contas,
// cartão, categorias, lançamentos, dados do OUTRO usuário) e `ctx.march` (os gastos
// de março com valor/categoria/origem) para calcular o esperado. Seção que grava algo
// deve desfazer no fim (ou usar datas fora de março/2025), para não mexer nas outras.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  API_URL,
  DB_NAME,
  HERE,
  addDays,
  api,
  assertLocalApi,
  call,
  loadFixture,
  weekdayOf,
  withLocalClient,
} from './lib.mjs';

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const NO_DEMO = args.includes('--no-demo');

// ============================================================================
// Infraestrutura
// ============================================================================

const sections = [];
/** Registra uma seção. Rodam NA ORDEM, todas sobre o mesmo fixture (`ctx`). */
function section(name, fn) {
  sections.push({ name, fn });
}

/** GET que exige 200 e devolve o body. */
const get = (path) => call('GET', path, undefined, 200);

/** Confere só o status (e devolve o body para checagens extras). */
async function expectStatus(method, path, body, status, messageIncludes) {
  const r = await api(method, path, body);
  assert.equal(r.status, status, `${method} ${path} → ${r.status}, esperado ${status}: ${JSON.stringify(r.body)}`);
  if (messageIncludes) {
    assert.ok(
      String(r.body?.error?.message ?? '').includes(messageIncludes),
      `${method} ${path}: mensagem "${r.body?.error?.message}" sem "${messageIncludes}"`,
    );
  }
  return r.body;
}

const sum = (list, pick = (x) => x) => list.reduce((s, x) => s + pick(x), 0);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

// ============================================================================
// Fixture do teste (março/2025) — valores em CENTAVOS
// ============================================================================
//
// Contas: A "Conta Corrente E2E" (checking, inicial 1.000,00), B "Poupança E2E"
// (savings, 500,00), C "Carteira E2E" (cash, 0 — vira a conta padrão). Cartão K
// (fecha dia 10, vence 17, final 1234). Categoria própria "Pets E2E".
//
// Gastos de março (6, total 146.050):
//   03-10 seg  Aluguel        120.000  Moradia      A
//   03-12 qua  Mercado          4.550  Alimentação  K
//   03-15 sáb  TV (1/3)        10.000  Compras      K   (30.000 em 3x: 03-15, 04-15, 05-15)
//   03-20 qui  Pix avulso       2.500  —            C   (sem categoria)
//   03-22 sáb  Ração            8.000  Pets E2E     A
//   03-31 seg  Ônibus           1.000  Transporte   B
// Receita: 03-05 Salário 500.000 (A). Transferência 03-25 A→B 20.000 (não é gasto).
// Fora de março: 02-28 Táxi 7.000 Transporte (A); 04-17 pagamento da fatura 2025-04
// de K (14.550, sai de A). Apagado: 03-29 Lazer 99.900 (A) — não conta em nada.
// OUTRO usuário (direto no banco): conta, cartão, categoria e 2 gastos em março.

const PERIOD = { from: '2025-03-01', to: '2025-03-31' };

async function buildFixture() {
  const fx = loadFixture();
  const categories = (await get('/categories')).data;
  const cat = Object.fromEntries(categories.map((c) => [c.name, c.id]));
  cat['Pets E2E'] = (await call('POST', '/categories', { name: 'Pets E2E', kind: 'expense', color: '#f97316' }, 201)).id;

  const A = await call('POST', '/accounts', { name: 'Conta Corrente E2E', type: 'checking', initialBalance: 100000 }, 201);
  const B = await call('POST', '/accounts', { name: 'Poupança E2E', type: 'savings', initialBalance: 50000 }, 201);
  const C = await call('POST', '/accounts', { name: 'Carteira E2E', type: 'cash', initialBalance: 0 }, 201);
  const K = await call('POST', '/credit-cards', { name: 'Cartão E2E', limit: 500000, closingDay: 10, dueDay: 17, lastDigits: '1234' }, 201);

  const tx = (body) => call('POST', '/transactions', body, 201);
  const t = {};
  t.salario = await tx({ kind: 'income', amount: 500000, categoryId: cat['Salário'], accountId: A.id, occurredAt: '2025-03-05', description: 'Salário' });
  t.aluguel = await tx({ amount: 120000, categoryId: cat.Moradia, accountId: A.id, occurredAt: '2025-03-10', description: 'Aluguel' });
  t.mercado = await tx({ amount: 4550, categoryId: cat['Alimentação'], creditCardId: K.id, occurredAt: '2025-03-12', description: 'Mercado', merchant: 'Supermercado Bom Preço' });
  t.tv = await tx({ amount: 30000, categoryId: cat.Compras, creditCardId: K.id, occurredAt: '2025-03-15', description: 'TV', installments: 3 });
  t.semCategoria = await tx({ amount: 2500, accountId: C.id, occurredAt: '2025-03-20', description: 'Pix avulso' });
  t.racao = await tx({ amount: 8000, categoryId: cat['Pets E2E'], accountId: A.id, occurredAt: '2025-03-22', description: 'Ração' });
  t.transf = await tx({ kind: 'transfer', amount: 20000, accountId: A.id, transferAccountId: B.id, occurredAt: '2025-03-25', description: 'Guardar' });
  t.apagado = await tx({ amount: 99900, categoryId: cat.Lazer, accountId: A.id, occurredAt: '2025-03-29', description: 'Apagado' });
  await call('DELETE', `/transactions/${t.apagado.id}`, undefined, 200);
  t.onibus = await tx({ amount: 1000, categoryId: cat.Transporte, accountId: B.id, occurredAt: '2025-03-31', description: 'Ônibus' });
  t.fev = await tx({ amount: 7000, categoryId: cat.Transporte, accountId: A.id, occurredAt: '2025-02-28', description: 'Táxi (fevereiro)' });
  t.fatura = await call('POST', `/credit-cards/${K.id}/invoices/2025-04/payments`, { accountId: A.id, amount: 14550, paidAt: '2025-04-17' }, 201);

  // OUTRO usuário: a API só age como o usuário de teste, então vai direto no banco LOCAL.
  const other = await withLocalClient(DB_NAME, async (c) => {
    const one = async (sql, params) => (await c.query(sql, params)).rows[0].id;
    const uid = fx.OTHER_USER_ID;
    const accountId = await one(`INSERT INTO accounts (user_id, name, type) VALUES ($1, 'Conta do Outro', 'checking') RETURNING id`, [uid]);
    const cardId = await one(`INSERT INTO credit_cards (user_id, name, card_limit, closing_day, due_day) VALUES ($1, 'Cartão do Outro', 100000, 5, 12) RETURNING id`, [uid]);
    const categoryId = await one(`INSERT INTO categories (user_id, name, kind, color) VALUES ($1, 'Categoria do Outro', 'expense', '#123456') RETURNING id`, [uid]);
    const txId = await one(
      `INSERT INTO transactions (user_id, account_id, category_id, amount, kind, description, occurred_at)
       VALUES ($1, $2, $3, 77700, 'expense', 'Gasto do outro', '2025-03-15') RETURNING id`,
      [uid, accountId, categoryId],
    );
    const cardTxId = await one(
      `INSERT INTO transactions (user_id, account_id, credit_card_id, amount, kind, description, occurred_at)
       VALUES ($1, $2, $3, 33300, 'expense', 'Gasto do outro no cartão', '2025-03-12') RETURNING id`,
      [uid, accountId, cardId],
    );
    return { userId: uid, accountId, cardId, categoryId, txId, cardTxId };
  });

  const key = { A: `account:${A.id}`, B: `account:${B.id}`, C: `account:${C.id}`, K: `card:${K.id}` };
  // Gastos de março do usuário de teste — base para calcular o esperado em qualquer seção.
  const march = [
    { id: t.aluguel.id, date: '2025-03-10', amount: 120000, categoryId: cat.Moradia, source: key.A, description: 'Aluguel' },
    { id: t.mercado.id, date: '2025-03-12', amount: 4550, categoryId: cat['Alimentação'], source: key.K, description: 'Mercado' },
    { id: t.tv.id, date: '2025-03-15', amount: 10000, categoryId: cat.Compras, source: key.K, description: 'TV (1/3)' },
    { id: t.semCategoria.id, date: '2025-03-20', amount: 2500, categoryId: null, source: key.C, description: 'Pix avulso' },
    { id: t.racao.id, date: '2025-03-22', amount: 8000, categoryId: cat['Pets E2E'], source: key.A, description: 'Ração' },
    { id: t.onibus.id, date: '2025-03-31', amount: 1000, categoryId: cat.Transporte, source: key.B, description: 'Ônibus' },
  ];
  const marchIncome = [{ id: t.salario.id, date: '2025-03-05', amount: 500000, categoryId: cat['Salário'], source: key.A }];

  return { fx, cat, acc: { A, B, C }, card: { K }, key, t, other, march, marchIncome, period: PERIOD };
}

// ============================================================================
// Seções
// ============================================================================

section('contas e saldos', async (ctx) => {
  const { A, B, C } = ctx.acc;
  const list = await get('/accounts');
  assert.deepEqual(list.data.map((a) => a.id), [A.id, B.id, C.id], 'só as 3 contas, em ordem de criação (sem "Carteira" automática)');
  const byId = Object.fromEntries(list.data.map((a) => [a.id, a]));
  // A = 1.000 + 5.000 − 1.200 − 80 − 200 (transf.) − 145,50 (fatura) − 70 (fev.)
  assert.equal(byId[A.id].balance, 430450);
  assert.equal(byId[B.id].balance, 69000); // 500 + 200 − 10
  assert.equal(byId[C.id].balance, -2500); // compra no cartão NÃO sai da conta padrão
  assert.equal(list.totals.balance, 496950);
  assert.equal(byId[A.id].transactionCount, 6);
  assert.equal(byId[B.id].transactionCount, 2);
  assert.equal(byId[C.id].transactionCount, 1);
  for (const a of list.data) {
    assert.equal(a.monthInflow, 0, `${a.name}: nada no mês corrente`);
    assert.equal(a.monthOutflow, 0, `${a.name}: nada no mês corrente`);
  }

  assert.equal((await get(`/accounts/${A.id}`)).balance, 430450);
  await expectStatus('GET', `/accounts/${ctx.other.accountId}`, undefined, 404);

  const st = await get(`/accounts/${A.id}/statement?${qs(PERIOD)}`);
  assert.equal(st.openingBalance, 93000); // 1.000 − 70 (fevereiro)
  assert.equal(st.inflow, 500000);
  assert.equal(st.outflow, 148000);
  assert.equal(st.closingBalance, 445000);
  assert.equal(st.items.length, 4);
  assert.equal(st.dailyBalance.length, 31);

  // Arquivar tira do saldo total; desarquivar devolve.
  await call('PATCH', `/accounts/${C.id}`, { isArchived: true }, 200);
  assert.equal((await get('/accounts')).totals.balance, 499450);
  assert.equal((await get('/accounts?includeArchived=true')).data.length, 3);
  await call('PATCH', `/accounts/${C.id}`, { isArchived: false }, 200);
  assert.equal((await get('/accounts')).totals.balance, 496950);
});

section('transações básicas', async (ctx) => {
  const { A, B } = ctx.acc;
  const { K } = ctx.card;
  const list = (q) => get(`/transactions?${qs(q)}`);

  const march = await list({ ...PERIOD });
  assert.equal(march.pagination.total, 8, 'março: 6 gastos + salário + transferência (apagado fora)');
  assert.equal(march.data[0].id, ctx.t.onibus.id, 'ordem: mais recente primeiro');
  assert.ok(!march.data.some((x) => x.id === ctx.t.apagado.id), 'apagado não aparece');
  assert.ok(!march.data.some((x) => x.id === ctx.other.txId), 'gasto do outro não aparece');

  assert.equal((await list({ ...PERIOD, kind: 'expense' })).pagination.total, 6);
  assert.equal((await list({ kind: 'transfer' })).pagination.total, 2, 'transferência + pagamento de fatura');
  assert.equal((await list({ categoryId: ctx.cat.Moradia })).pagination.total, 1);
  assert.equal((await list({ ...PERIOD, accountId: A.id })).pagination.total, 4);
  assert.equal((await list({ accountId: A.id })).pagination.total, 6, 'com fevereiro e o pagamento da fatura');
  assert.equal((await list({ accountId: B.id })).pagination.total, 2, 'transferência entrando + ônibus');
  assert.equal((await list({ creditCardId: K.id })).pagination.total, 5, 'mercado + 3 parcelas + pagamento');
  assert.equal((await list({ search: 'mercado' })).pagination.total, 1);
  assert.equal((await list({ search: 'bom preço' })).pagination.total, 1, 'busca no estabelecimento');

  const page = await list({ ...PERIOD, limit: 2, offset: 0 });
  assert.equal(page.data.length, 2);
  assert.equal(page.pagination.total, 8);

  // Parcelado: 3 lançamentos de 100,00, mesmo grupo, um por fatura.
  const parcels = (await list({ creditCardId: K.id, kind: 'expense', search: 'TV' })).data
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
  assert.deepEqual(parcels.map((p) => p.amount), [10000, 10000, 10000]);
  assert.deepEqual(parcels.map((p) => p.installments), ['1/3', '2/3', '3/3']);
  assert.deepEqual(parcels.map((p) => p.occurredAt), ['2025-03-15', '2025-04-15', '2025-05-15']);
  assert.equal(new Set(parcels.map((p) => p.installmentGroupId)).size, 1);

  const one = await get(`/transactions/${ctx.t.aluguel.id}`);
  assert.equal(one.amount, 120000);
  assert.equal(one.accountId, A.id);
  assert.equal(one.categoryId, ctx.cat.Moradia);
  await expectStatus('GET', `/transactions/${ctx.t.apagado.id}`, undefined, 404);

  // CRUD num lançamento temporário FORA de março (não mexe nas outras seções).
  const tmp = await call('POST', '/transactions', { amount: 1234, categoryId: ctx.cat.Lazer, accountId: A.id, occurredAt: '2025-06-10', description: 'Temporário' }, 201);
  const edited = await call('PATCH', `/transactions/${tmp.id}`, { amount: 4321, description: 'Editado' }, 200);
  assert.equal(edited.amount, 4321);
  assert.equal(edited.description, 'Editado');
  assert.deepEqual(await call('DELETE', `/transactions/${tmp.id}`, undefined, 200), { deleted: 1 });
  await expectStatus('GET', `/transactions/${tmp.id}`, undefined, 404);
  await expectStatus('DELETE', `/transactions/${tmp.id}`, undefined, 404);

  // Validações.
  await expectStatus('POST', '/transactions', { amount: -5, accountId: A.id }, 400);
  await expectStatus('POST', '/transactions', { amount: 10.5, accountId: A.id }, 400);
  await expectStatus('POST', '/transactions', { kind: 'transfer', amount: 100, accountId: A.id, transferAccountId: A.id }, 400);
  await expectStatus('POST', '/transactions', { kind: 'loan_out', amount: 100, accountId: A.id }, 400);
  await expectStatus('POST', '/transactions', { amount: 100, accountId: A.id, categoryId: ctx.other.categoryId }, 400, 'Categoria inválida');
  await expectStatus('POST', '/transactions', { amount: 100, accountId: ctx.other.accountId }, 400, 'Conta não encontrada');
  await expectStatus('POST', '/transactions', { amount: 100, creditCardId: ctx.other.cardId }, 400, 'Cartão não encontrado');

  // Isolamento: nada do outro usuário é visível nem editável.
  await expectStatus('GET', `/transactions?accountId=${ctx.other.accountId}`, undefined, 404);
  await expectStatus('GET', `/transactions?creditCardId=${ctx.other.cardId}`, undefined, 404);
  await expectStatus('GET', `/transactions/${ctx.other.txId}`, undefined, 404);
  await expectStatus('PATCH', `/transactions/${ctx.other.txId}`, { amount: 1 }, 404);
  await expectStatus('DELETE', `/transactions/${ctx.other.txId}`, undefined, 404);
});

section('relatório por origem (/reports/sources): totais, série, origens, categorias', async (ctx) => {
  const { A } = ctx.acc;
  const { K } = ctx.card;
  const r = await get(`/reports/sources?${qs(PERIOD)}`);

  assert.equal(r.from, PERIOD.from);
  assert.equal(r.to, PERIOD.to);
  assert.equal(r.granularity, 'day');
  assert.equal(r.currency, 'BRL');
  assert.equal(r.source, null);

  // Totais: só gastos/receitas (transferência, pagamento de fatura, apagado e o outro usuário ficam fora).
  assert.deepEqual(r.totals, { expense: 146050, income: 500000, count: 6, days: 31, dailyAverage: 4711 });

  // Origens: da que mais gastou para a que menos; % sobre o gasto de todas.
  assert.deepEqual(
    r.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]),
    [
      [ctx.key.A, 128000, 500000, 2, 87.64],
      [ctx.key.K, 14550, 0, 2, 9.96],
      [ctx.key.C, 2500, 0, 1, 1.71],
      [ctx.key.B, 1000, 0, 1, 0.68],
    ],
  );
  const k = r.sources.find((s) => s.key === ctx.key.K);
  assert.equal(k.type, 'card');
  assert.equal(k.id, K.id);
  assert.equal(k.name, 'Cartão E2E');
  assert.equal(k.lastDigits, '1234');
  assert.equal(k.accountType, null);
  const a = r.sources.find((s) => s.key === ctx.key.A);
  assert.equal(a.type, 'account');
  assert.equal(a.accountType, 'checking');
  assert.equal(a.name, A.name);
  assert.ok(!r.sources.some((s) => [ctx.other.accountId, ctx.other.cardId].includes(s.id)), 'origens do outro ficam fora');

  // Série: um balde por dia, zeros incluídos.
  assert.equal(r.series.length, 31);
  assert.equal(r.series[0].start, '2025-03-01');
  assert.equal(r.series[0].label, '01/03');
  assert.equal(r.series[30].end, '2025-03-31');
  assert.equal(sum(r.series, (p) => p.total), 146050);
  const day = (iso) => r.series.find((p) => p.start === iso);
  assert.deepEqual([day('2025-03-10').total, day('2025-03-10').bySource], [120000, { [ctx.key.A]: 120000 }]);
  assert.deepEqual([day('2025-03-15').total, day('2025-03-15').bySource], [10000, { [ctx.key.K]: 10000 }]);
  assert.equal(day('2025-03-05').total, 0, 'receita não entra na série');
  assert.equal(day('2025-03-25').total, 0, 'transferência não entra na série');

  // Dia da semana (0 = domingo).
  const expectedWeekday = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
  for (const e of ctx.march) {
    expectedWeekday[weekdayOf(e.date)].total += e.amount;
    expectedWeekday[weekdayOf(e.date)].count += 1;
  }
  assert.deepEqual(r.byWeekday.map((w) => ({ total: w.total, count: w.count })), expectedWeekday);
  assert.deepEqual(r.byWeekday.map((w) => w.label), ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
  assert.equal(r.byWeekday[1].total, 121000); // segundas: aluguel + ônibus

  // Categorias: maior → menor, "Sem categoria" com categoryId null, % sobre o gasto.
  assert.deepEqual(
    r.byCategory.map((c) => [c.categoryId, c.name, c.total, c.percentage]),
    [
      [ctx.cat.Moradia, 'Moradia', 120000, 82.16],
      [ctx.cat.Compras, 'Compras', 10000, 6.85],
      [ctx.cat['Pets E2E'], 'Pets E2E', 8000, 5.48],
      [ctx.cat['Alimentação'], 'Alimentação', 4550, 3.12],
      [null, 'Sem categoria', 2500, 1.71],
      [ctx.cat.Transporte, 'Transporte', 1000, 0.68],
    ],
  );
  assert.ok(!r.byCategory.some((c) => c.categoryId === ctx.other.categoryId), 'categoria do outro fica fora');

  // Maiores gastos: maior → menor, com categoria e origem.
  assert.deepEqual(r.topExpenses.map((t) => t.amount), [120000, 10000, 8000, 4550, 2500, 1000]);
  const [top] = r.topExpenses;
  assert.equal(top.id, ctx.t.aluguel.id);
  assert.equal(top.categoryName, 'Moradia');
  assert.equal(top.source.key, ctx.key.A);
  const tv = r.topExpenses.find((t) => t.amount === 10000);
  assert.equal(tv.installments, '1/3');
  assert.equal(tv.source.type, 'card');
  assert.equal(tv.source.lastDigits, '1234');
  assert.equal(r.topExpenses.find((t) => t.amount === 2500).categoryName, null);

  // Granularidade explícita.
  const week = await get(`/reports/sources?${qs({ ...PERIOD, granularity: 'week' })}`);
  assert.deepEqual(
    week.series.map((p) => [p.start, p.end, p.total]),
    [
      ['2025-03-01', '2025-03-02', 0],
      ['2025-03-03', '2025-03-09', 0],
      ['2025-03-10', '2025-03-16', 134550],
      ['2025-03-17', '2025-03-23', 10500],
      ['2025-03-24', '2025-03-30', 0],
      ['2025-03-31', '2025-03-31', 1000],
    ],
  );
  const month = await get(`/reports/sources?${qs({ ...PERIOD, granularity: 'month' })}`);
  assert.deepEqual(month.series.map((p) => [p.label, p.total]), [['Mar', 146050]]);

  // Intervalo sem nada: tudo zerado, sem quebrar.
  const empty = await get(`/reports/sources?${qs({ from: '2024-01-01', to: '2024-01-31' })}`);
  assert.deepEqual(empty.totals, { expense: 0, income: 0, count: 0, days: 31, dailyAverage: 0 });
  assert.deepEqual([empty.sources, empty.byCategory, empty.topExpenses], [[], [], []]);
});

section('relatório por origem: filtro source', async (ctx) => {
  const card = await get(`/reports/sources?${qs({ ...PERIOD, source: ctx.key.K })}`);
  assert.equal(card.source, ctx.key.K);
  assert.deepEqual(card.totals, { expense: 14550, income: 0, count: 2, days: 31, dailyAverage: 469 });
  assert.equal(card.sources.length, 4, 'sources IGNORA o filtro source');
  assert.equal(sum(card.series, (p) => p.total), 14550);
  for (const p of card.series) {
    assert.deepEqual(Object.keys(p.bySource).filter((k) => k !== ctx.key.K), [], 'série só com a origem filtrada');
  }
  assert.deepEqual(
    card.byCategory.map((c) => [c.name, c.total, c.percentage]),
    [['Compras', 10000, 68.73], ['Alimentação', 4550, 31.27]],
  );
  assert.deepEqual(card.topExpenses.map((t) => [t.amount, t.source.key]), [[10000, ctx.key.K], [4550, ctx.key.K]]);
  assert.equal(sum(card.byWeekday, (w) => w.total), 14550);

  const acc = await get(`/reports/sources?${qs({ ...PERIOD, source: ctx.key.A })}`);
  assert.deepEqual(acc.totals, { expense: 128000, income: 500000, count: 2, days: 31, dailyAverage: 4129 });
  assert.deepEqual(acc.byCategory.map((c) => [c.name, c.total, c.percentage]), [['Moradia', 120000, 93.75], ['Pets E2E', 8000, 6.25]]);
  assert.deepEqual(acc.topExpenses.map((t) => t.id), [ctx.t.aluguel.id, ctx.t.racao.id]);

  const cash = await get(`/reports/sources?${qs({ ...PERIOD, source: ctx.key.C })}`);
  assert.deepEqual(cash.byCategory.map((c) => [c.categoryId, c.name, c.total]), [[null, 'Sem categoria', 2500]]);

  // Maiúsculas no id são normalizadas.
  const upper = await get(`/reports/sources?${qs({ ...PERIOD, source: ctx.key.K.toUpperCase() })}`);
  assert.equal(upper.source, ctx.key.K);
});

section('relatório por origem: validação e isolamento', async (ctx) => {
  const base = `/reports/sources?${qs(PERIOD)}`;
  await expectStatus('GET', `${base}&source=account:${ctx.other.accountId}`, undefined, 404, 'Conta não encontrada');
  await expectStatus('GET', `${base}&source=card:${ctx.other.cardId}`, undefined, 404, 'Cartão não encontrado');
  await expectStatus('GET', `${base}&source=account:00000000-0000-4000-8000-000000000000`, undefined, 404);
  await expectStatus('GET', `${base}&source=card:${ctx.acc.A.id}`, undefined, 404, 'Cartão não encontrado'); // conta passada como cartão
  await expectStatus('GET', `${base}&source=banco:123`, undefined, 400);
  await expectStatus('GET', `${base}&source=account:nao-e-uuid`, undefined, 400);
  await expectStatus('GET', `${base}&granularity=year`, undefined, 400);
  await expectStatus('GET', '/reports/sources?from=2025-03-31&to=2025-03-01', undefined, 400);
  await expectStatus('GET', '/reports/sources?from=2023-01-01&to=2025-03-31', undefined, 400); // > 731 dias
  await expectStatus('GET', '/reports/sources?to=2025-03-31', undefined, 400);
  await expectStatus('GET', '/reports/sources?from=2025-02-30&to=2025-03-31', undefined, 400);
});

section('empréstimos (/loans) básico', async (ctx) => {
  const { A, B } = ctx.acc;
  const balance = async (id) => (await get(`/accounts/${id}`)).balance;
  const before = { A: await balance(A.id), B: await balance(B.id) };

  await expectStatus('POST', '/loans', {
    borrowerName: 'Inválido', principal: 1000, lentAt: '2025-04-10',
    schedule: { count: 1, amount: 1000, firstDueDate: '2025-04-01' },
  }, 400, '1ª parcela');
  await expectStatus('POST', '/loans', {
    borrowerName: 'Inválido', principal: 1000, lentAt: '2025-04-01', sourceAccountId: ctx.other.accountId,
    schedule: { count: 1, amount: 1000, firstDueDate: '2025-04-01' },
  }, 400);

  const loan = await call('POST', '/loans', {
    borrowerName: 'Fulano E2E',
    description: 'Teste',
    principal: 100000,
    lentAt: '2025-04-01',
    sourceAccountId: A.id,
    receiveAccountId: B.id,
    schedule: { count: 3, amount: 40000, firstDueDate: '2025-05-01' },
  }, 201);
  assert.deepEqual(loan.installments.map((i) => [i.number, i.dueDate, i.amount, i.status]), [
    [1, '2025-05-01', 40000, 'overdue'],
    [2, '2025-06-01', 40000, 'overdue'],
    [3, '2025-07-01', 40000, 'overdue'],
  ]);
  assert.equal(loan.status, 'active');
  assert.equal(loan.stats.outstanding, 120000);
  assert.equal(loan.stats.expectedProfit, 20000);
  assert.equal(loan.stats.overdueCount, 3);
  assert.equal(await balance(A.id), before.A - 100000, 'emprestar sai da conta de origem');

  const after = await call('POST', `/loans/${loan.id}/installments/${loan.installments[0].id}/receive`, { receivedAt: '2025-05-01' }, 200);
  const first = after.installments[0];
  assert.equal(first.status, 'received');
  assert.equal(first.receivedAmount, 40000);
  assert.equal(first.principalPortion + first.interestPortion, 40000);
  assert.equal(after.stats.receivedCount, 1);
  assert.equal(after.stats.overdueCount, 2);
  assert.equal(after.stats.outstanding, 80000);
  assert.equal(after.stats.receivedTotal, 40000);
  assert.equal(await balance(B.id), before.B + 40000, 'recebido entra na conta de recebimento');
  await expectStatus('POST', `/loans/${loan.id}/installments/${loan.installments[0].id}/receive`, {}, 409);

  // Empréstimo não é gasto: só os juros entram como receita no relatório.
  const may = await get(`/reports/sources?${qs({ from: '2025-05-01', to: '2025-05-31' })}`);
  assert.equal(may.totals.income, first.interestPortion);
  assert.equal(may.totals.expense, 10000, 'só a parcela 3/3 da TV');

  const loans = await get('/loans');
  assert.deepEqual(loans.data.map((l) => l.id), [loan.id]);
  assert.equal(loans.totals.principal, 100000);
  const receivables = await get('/receivables');
  assert.equal(receivables.data.length, 2);
  assert.equal(receivables.totals.totalPending, 80000);
  assert.equal(receivables.totals.overdueCount, 2);

  // Lançamentos do empréstimo só mudam pela tela de Empréstimos.
  const loanOut = (await get(`/transactions?${qs({ accountId: A.id, kind: 'loan_out' })}`)).data;
  assert.equal(loanOut.length, 1);
  await expectStatus('PATCH', `/transactions/${loanOut[0].id}`, { amount: 1 }, 400);
  await expectStatus('DELETE', `/transactions/${loanOut[0].id}`, undefined, 400);
  await expectStatus('GET', '/loans/00000000-0000-4000-8000-000000000000', undefined, 404);

  // Limpa: apagar o empréstimo devolve os saldos.
  await call('DELETE', `/loans/${loan.id}`, undefined, 204);
  assert.deepEqual((await get('/loans')).data, []);
  assert.equal(await balance(A.id), before.A);
  assert.equal(await balance(B.id), before.B);
});

section('fumaça: rotas principais respondem 200', async (ctx) => {
  const { K } = ctx.card;
  const health = await fetch('http://localhost:3333/health');
  assert.equal(health.status, 200, '/health');
  const paths = [
    '/indicators',
    '/accounts',
    '/accounts?includeArchived=true',
    `/accounts/${ctx.acc.A.id}/statement?${qs(PERIOD)}`,
    '/categories',
    '/transactions',
    '/summary',
    '/summary?month=2025-03',
    '/reports/annual?year=2025',
    `/reports/sources?${qs(PERIOD)}`,
    '/budgets',
    '/investments',
    '/investments/summary',
    '/credit-cards',
    `/credit-cards/${K.id}`,
    `/credit-cards/${K.id}/invoices`,
    `/credit-cards/${K.id}/invoice?month=2025-04`,
    '/recurring',
    '/forecast',
    '/achievements',
    '/goals',
    '/loans',
    '/receivables',
  ];
  const failures = [];
  for (const p of paths) {
    const r = await api('GET', p);
    if (r.status !== 200) failures.push(`${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  assert.deepEqual(failures, [], `rotas fora do 200:\n${failures.join('\n')}`);

  // Números que batem com o fixture.
  const summary = await get('/summary?month=2025-03');
  assert.deepEqual([summary.income, summary.expense, summary.currentBalance], [500000, 146050, 496950]);
  const annual = await get('/reports/annual?year=2025');
  assert.deepEqual([annual.totals.income, annual.totals.expense], [500000, 173050]); // + fev 70 + parcelas 2/3 e 3/3
  const invoice = await get(`/credit-cards/${K.id}/invoice?month=2025-04`);
  assert.deepEqual([invoice.total, invoice.paid, invoice.isPaid], [14550, 14550, true]);
});

section('relatório por origem: filtro por categoria', async (ctx) => {
  const { A, B, C } = ctx.acc;
  const { K } = ctx.card;
  const uid = ctx.fx.TEST_USER_ID;
  const report = (period, q = {}) => get(`/reports/sources?${qs({ ...period, ...q })}`);
  // Mesmo arredondamento do backend (percentOf): 2 casas, 0 quando o todo é 0.
  const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0);
  const db = (sql, params) => withLocalClient(DB_NAME, async (c) => (await c.query(sql, params)).rows);

  // Esperado lido DIRETO do banco local (nunca da API): gastos e receitas do
  // usuário de teste no intervalo, com a origem (cartão antes da conta) e a categoria.
  const dbRows = (period) =>
    db(
      `SELECT t.id, t.occurred_at AS date, t.kind, t.amount,
              t.category_id AS "categoryId", c.name AS "categoryName",
              CASE WHEN t.credit_card_id IS NOT NULL THEN 'card:' || t.credit_card_id::text
                   ELSE 'account:' || t.account_id::text END AS source,
              COALESCE(cc.name, a.name) AS "sourceName"
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN accounts a ON a.id = t.account_id
         LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
        WHERE t.user_id = $1 AND t.deleted_at IS NULL
          AND t.kind IN ('expense', 'income')
          AND t.occurred_at BETWEEN $2::date AND $3::date`,
      [uid, period.from, period.to],
    );
  // Totais por SUM no banco, com os mesmos filtros (categoria: uuid | 'none'; origem: chave).
  const dbTotals = async (period, { category, source } = {}) =>
    (
      await db(
        `SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'expense'), 0)::bigint AS expense,
                COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'income'), 0)::bigint  AS income,
                (COUNT(*) FILTER (WHERE t.kind = 'expense'))::int                    AS count
           FROM transactions t
          WHERE t.user_id = $1 AND t.deleted_at IS NULL
            AND t.kind IN ('expense', 'income')
            AND t.occurred_at BETWEEN $2::date AND $3::date
            AND CASE WHEN $4::text IS NULL THEN true
                     WHEN $4::text = 'none' THEN t.category_id IS NULL
                     ELSE t.category_id::text = $4::text END
            AND ($5::text IS NULL OR
                 (CASE WHEN t.credit_card_id IS NOT NULL THEN 'card:' || t.credit_card_id::text
                       ELSE 'account:' || t.account_id::text END) = $5::text)`,
        [uid, period.from, period.to, category ?? null, source ?? null],
      )
    )[0];

  /** /reports/sources esperado, calculado das linhas do banco (intervalo no passado: média sobre todos os dias). */
  function expected(rows, period, { category, source } = {}) {
    const ofCategory = (r) => !category || (category === 'none' ? r.categoryId === null : r.categoryId === category);
    const ofSource = (r) => !source || r.source === source;
    const byCat = rows.filter(ofCategory); // sources: só a categoria
    const both = byCat.filter(ofSource); // totals/series/byWeekday/topExpenses: os dois
    const expenses = both.filter((r) => r.kind === 'expense');
    const expense = sum(expenses, (r) => r.amount);
    const income = sum(both.filter((r) => r.kind === 'income'), (r) => r.amount);

    const dayList = [];
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) dayList.push(d);
    const series = dayList.map((day) => {
      const bySource = {};
      for (const r of expenses) if (r.date === day) bySource[r.source] = (bySource[r.source] ?? 0) + r.amount;
      return { start: day, total: sum(Object.values(bySource)), bySource };
    });
    const byWeekday = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
    for (const r of expenses) {
      byWeekday[weekdayOf(r.date)].total += r.amount;
      byWeekday[weekdayOf(r.date)].count += 1;
    }
    // Mesma ordem do backend: valor ↓, data ↓, id ↑; no máximo 8.
    const topExpenses = [...expenses]
      .sort((a, b) => b.amount - a.amount || (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? 1 : -1))
      .slice(0, 8)
      .map((r) => r.id);

    const groups = new Map();
    for (const r of byCat) {
      const g = groups.get(r.source) ?? { key: r.source, name: r.sourceName, expense: 0, income: 0, count: 0 };
      if (r.kind === 'expense') {
        g.expense += r.amount;
        g.count += 1;
      } else g.income += r.amount;
      groups.set(r.source, g);
    }
    const ranked = [...groups.values()]
      .filter((g) => g.expense > 0 || g.income > 0)
      .sort((a, b) => b.expense - a.expense || b.income - a.income || (a.name < b.name ? -1 : 1));
    const allExpense = sum(ranked, (g) => g.expense);
    const sources = ranked.map((g) => [g.key, g.expense, g.income, g.count, percent(g.expense, allExpense)]);

    // Rosca: só a ORIGEM (ignora a categoria); % sobre o gasto da própria rosca.
    const catGroups = new Map();
    for (const r of rows.filter((x) => x.kind === 'expense' && ofSource(x))) {
      const k = r.categoryId ?? 'null';
      const g = catGroups.get(k) ?? { categoryId: r.categoryId, name: r.categoryName ?? 'Sem categoria', total: 0 };
      g.total += r.amount;
      catGroups.set(k, g);
    }
    const catTotal = sum([...catGroups.values()], (g) => g.total);
    const byCategory = [...catGroups.values()]
      .sort((a, b) => b.total - a.total)
      .map((g) => [g.categoryId, g.name, g.total, percent(g.total, catTotal)]);

    return {
      totals: { expense, income, count: expenses.length, days: dayList.length, dailyAverage: Math.round(expense / dayList.length) },
      series,
      byWeekday,
      topExpenses,
      sources,
      byCategory,
    };
  }

  const plainCache = new Map();
  /** Confere UMA combinação (categoria × origem) contra o banco. Devolve a resposta. */
  async function check(rows, period, q) {
    const label = `${period.from} ${JSON.stringify(q)}`;
    const r = await report(period, q);
    const e = expected(rows, period, q);
    const plainKey = `${period.from}|${q.source ?? ''}`;
    if (!plainCache.has(plainKey)) plainCache.set(plainKey, await report(period, { source: q.source }));
    const plain = plainCache.get(plainKey); // mesmo filtro de origem, SEM categoria

    assert.equal(r.category, q.category ?? null, `${label}: eco de category`);
    assert.equal(r.source, q.source ?? null, `${label}: eco de source`);
    assert.deepEqual(r.totals, e.totals, `${label}: totals`);
    const s = await dbTotals(period, q);
    assert.deepEqual(
      [r.totals.expense, r.totals.income, r.totals.count],
      [s.expense, s.income, s.count],
      `${label}: totals x SUM no banco`,
    );
    assert.deepEqual(r.series.map((p) => ({ start: p.start, total: p.total, bySource: p.bySource })), e.series, `${label}: series`);
    assert.equal(sum(r.series, (p) => p.total), s.expense, `${label}: soma da série = SUM no banco`);
    assert.deepEqual(r.byWeekday.map((w) => ({ total: w.total, count: w.count })), e.byWeekday, `${label}: byWeekday`);
    assert.deepEqual(r.topExpenses.map((t) => t.id), e.topExpenses, `${label}: topExpenses`);
    assert.deepEqual(r.sources.map((x) => [x.key, x.expense, x.income, x.count, x.percentage]), e.sources, `${label}: sources`);
    assert.deepEqual(r.byCategory.map((c) => [c.categoryId, c.name, c.total, c.percentage]), e.byCategory, `${label}: byCategory x banco`);
    assert.deepEqual(r.byCategory, plain.byCategory, `${label}: byCategory IGUAL com e sem category`);
    return r;
  }

  // Temporários em JULHO/2025 (apagados no fim): Alimentação em 2 origens (para o %
  // do ranking sobre a categoria), receita e gasto SEM categoria e uma transferência
  // (sem categoria, mas nunca entra no 'none').
  const JULY = { from: '2025-07-01', to: '2025-07-31' };
  const tx = (body) => call('POST', '/transactions', body, 201);
  const temp = {};
  let archivedPets = false;
  try {
    temp.feira = await tx({ amount: 3000, categoryId: ctx.cat['Alimentação'], accountId: A.id, occurredAt: '2025-07-07', description: 'Feira (julho)' });
    temp.padaria = await tx({ amount: 1000, categoryId: ctx.cat['Alimentação'], creditCardId: K.id, occurredAt: '2025-07-08', description: 'Padaria (julho)' });
    temp.reembolso = await tx({ kind: 'income', amount: 2000, accountId: B.id, occurredAt: '2025-07-09', description: 'Reembolso (julho)' });
    temp.semCatCartao = await tx({ amount: 500, creditCardId: K.id, occurredAt: '2025-07-10', description: 'Sem categoria no cartão (julho)' });
    temp.transf = await tx({ kind: 'transfer', amount: 700, accountId: A.id, transferAccountId: B.id, occurredAt: '2025-07-11', description: 'Transferência (julho)' });

    const marchRows = await dbRows(PERIOD);
    const julyRows = await dbRows(JULY);
    // O banco bate com o fixture (6 gastos + salário em março; 3 gastos + 1 receita em julho).
    assert.deepEqual(
      marchRows.filter((r) => r.kind === 'expense').map((r) => r.id).sort(),
      ctx.march.map((e) => e.id).sort(),
      'gastos de março no banco = ctx.march',
    );
    assert.deepEqual(marchRows.filter((r) => r.kind === 'income').map((r) => r.id), [ctx.t.salario.id]);
    assert.equal(julyRows.length, 4, 'julho: 3 gastos + 1 receita (transferência fora)');

    // ---- Matriz categoria × origem, tudo contra o banco.
    const sourcesToTry = [undefined, ctx.key.A, ctx.key.B, ctx.key.C, ctx.key.K];
    const marchCategories = [
      ctx.cat.Moradia, // sistema
      ctx.cat['Alimentação'],
      ctx.cat.Compras,
      ctx.cat.Transporte,
      ctx.cat['Pets E2E'], // própria do usuário
      ctx.cat['Salário'], // de receita: aceita
      ctx.cat.Lazer, // só o lançamento apagado: tudo zero
      'none',
    ];
    for (const category of marchCategories) {
      for (const source of sourcesToTry) await check(marchRows, PERIOD, { category, source });
    }
    for (const category of [ctx.cat['Alimentação'], 'none', ctx.cat.Moradia]) {
      for (const source of sourcesToTry) await check(julyRows, JULY, { category, source });
    }

    // ---- Números fixos (independem do banco e da API).
    const all = await report(PERIOD);
    assert.equal(all.category, null, 'sem filtro → category null');
    const keys = Object.keys(all);
    assert.equal(keys.indexOf('category'), keys.indexOf('source') + 1, 'category vem logo depois de source');

    const moradia = await report(PERIOD, { category: ctx.cat.Moradia });
    assert.equal(moradia.category, ctx.cat.Moradia);
    assert.deepEqual(moradia.totals, { expense: 120000, income: 0, count: 1, days: 31, dailyAverage: 3871 });
    assert.deepEqual(moradia.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]), [[ctx.key.A, 120000, 0, 1, 100]]);
    assert.deepEqual(moradia.topExpenses.map((t) => [t.id, t.categoryName]), [[ctx.t.aluguel.id, 'Moradia']]);
    assert.deepEqual(moradia.series.filter((p) => p.total > 0).map((p) => [p.start, p.total, p.bySource]), [['2025-03-10', 120000, { [ctx.key.A]: 120000 }]]);
    assert.deepEqual(moradia.byWeekday.map((w) => w.total), [0, 120000, 0, 0, 0, 0, 0]);
    assert.deepEqual(moradia.byCategory, all.byCategory, 'a rosca continua com TODAS as categorias');
    assert.equal(moradia.byCategory.length, 6);

    const pets = await report(PERIOD, { category: ctx.cat['Pets E2E'] });
    assert.deepEqual(pets.totals, { expense: 8000, income: 0, count: 1, days: 31, dailyAverage: 258 });
    assert.deepEqual(pets.topExpenses.map((t) => t.id), [ctx.t.racao.id]);
    assert.deepEqual(pets.byWeekday.map((w) => w.total), [0, 0, 0, 0, 0, 0, 8000]); // 22/03 é sábado

    const none = await report(PERIOD, { category: 'none' });
    assert.equal(none.category, 'none');
    assert.deepEqual(none.totals, { expense: 2500, income: 0, count: 1, days: 31, dailyAverage: 81 });
    assert.deepEqual(none.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]), [[ctx.key.C, 2500, 0, 1, 100]]);
    assert.deepEqual(none.topExpenses.map((t) => [t.id, t.categoryName]), [[ctx.t.semCategoria.id, null]]);
    assert.equal(none.series.find((p) => p.start === '2025-03-25').total, 0, 'transferência (sem categoria) não entra');

    const salario = await report(PERIOD, { category: ctx.cat['Salário'] });
    assert.deepEqual(salario.totals, { expense: 0, income: 500000, count: 0, days: 31, dailyAverage: 0 });
    assert.deepEqual(salario.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]), [[ctx.key.A, 0, 500000, 0, 0]]);
    assert.deepEqual([salario.topExpenses, sum(salario.series, (p) => p.total)], [[], 0]);

    const lazer = await report(PERIOD, { category: ctx.cat.Lazer });
    assert.deepEqual(lazer.totals, { expense: 0, income: 0, count: 0, days: 31, dailyAverage: 0 }, 'só o apagado: zero');
    assert.deepEqual([lazer.sources, lazer.topExpenses], [[], []]);
    assert.deepEqual(lazer.byCategory, all.byCategory);

    // Origem + categoria combinam ($4 = origem, $5 = categoria na mesma consulta).
    const kCompras = await report(PERIOD, { source: ctx.key.K, category: ctx.cat.Compras });
    assert.deepEqual([kCompras.source, kCompras.category], [ctx.key.K, ctx.cat.Compras]);
    assert.deepEqual(kCompras.totals, { expense: 10000, income: 0, count: 1, days: 31, dailyAverage: 323 });
    assert.deepEqual(kCompras.topExpenses.map((t) => [t.id, t.installments, t.source.key]), [[ctx.t.tv.id, '1/3', ctx.key.K]]);
    assert.deepEqual(kCompras.sources.map((s) => [s.key, s.expense]), [[ctx.key.K, 10000]]);
    assert.deepEqual(
      kCompras.byCategory.map((c) => [c.name, c.total, c.percentage]),
      [['Compras', 10000, 68.73], ['Alimentação', 4550, 31.27]],
      'rosca respeita a origem (K), não a categoria',
    );
    const aCompras = await report(PERIOD, { source: ctx.key.A, category: ctx.cat.Compras });
    assert.deepEqual(aCompras.totals, { expense: 0, income: 0, count: 0, days: 31, dailyAverage: 0 }, 'Compras não saiu da conta A');
    assert.deepEqual(aCompras.topExpenses, []);
    assert.deepEqual(aCompras.sources.map((s) => [s.key, s.expense]), [[ctx.key.K, 10000]], 'sources ignora a origem');
    assert.deepEqual(aCompras.byCategory.map((c) => [c.name, c.total, c.percentage]), [['Moradia', 120000, 93.75], ['Pets E2E', 8000, 6.25]]);
    const cNone = await report(PERIOD, { source: ctx.key.C, category: 'none' });
    assert.deepEqual(cNone.totals, { expense: 2500, income: 0, count: 1, days: 31, dailyAverage: 81 });
    const aNone = await report(PERIOD, { source: ctx.key.A, category: 'none' });
    assert.deepEqual(aNone.totals, { expense: 0, income: 0, count: 0, days: 31, dailyAverage: 0 }, 'salário tem categoria: fora do none');

    // Granularidade semanal com categoria.
    const comprasWeek = await report(PERIOD, { category: ctx.cat.Compras, granularity: 'week' });
    assert.deepEqual(comprasWeek.series.map((p) => [p.start, p.total]), [
      ['2025-03-01', 0], ['2025-03-03', 0], ['2025-03-10', 10000], ['2025-03-17', 0], ['2025-03-24', 0], ['2025-03-31', 0],
    ]);

    // Julho: uma categoria em 2 origens → % do ranking sobre o total DA CATEGORIA.
    const julFood = await report(JULY, { category: ctx.cat['Alimentação'] });
    assert.deepEqual(julFood.totals, { expense: 4000, income: 0, count: 2, days: 31, dailyAverage: 129 });
    assert.deepEqual(
      julFood.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]),
      [[ctx.key.A, 3000, 0, 1, 75], [ctx.key.K, 1000, 0, 1, 25]],
    );
    const julFoodK = await report(JULY, { category: ctx.cat['Alimentação'], source: ctx.key.K });
    assert.deepEqual(julFoodK.totals, { expense: 1000, income: 0, count: 1, days: 31, dailyAverage: 32 });
    assert.deepEqual(julFoodK.sources.map((s) => [s.key, s.percentage]), [[ctx.key.A, 75], [ctx.key.K, 25]], 'sources ignora a origem');
    assert.deepEqual(julFoodK.byCategory.map((c) => [c.categoryId, c.total, c.percentage]), [[ctx.cat['Alimentação'], 1000, 66.67], [null, 500, 33.33]]);
    // 'none' com receita sem categoria: entra em totals.income e sources[].income.
    const julNone = await report(JULY, { category: 'none' });
    assert.deepEqual(julNone.totals, { expense: 500, income: 2000, count: 1, days: 31, dailyAverage: 16 });
    assert.deepEqual(
      julNone.sources.map((s) => [s.key, s.expense, s.income, s.count, s.percentage]),
      [[ctx.key.K, 500, 0, 1, 100], [ctx.key.B, 0, 2000, 0, 0]],
    );
    const julAll = await report(JULY);
    assert.deepEqual(julAll.byCategory.map((c) => [c.categoryId, c.total, c.percentage]), [[ctx.cat['Alimentação'], 4000, 88.89], [null, 500, 11.11]]);
    assert.deepEqual(julNone.byCategory, julAll.byCategory);

    // Categoria ARQUIVADA continua aceita (arquiva direto no banco local e desfaz).
    await db('UPDATE categories SET is_archived = true WHERE id = $1 AND user_id = $2', [ctx.cat['Pets E2E'], uid]);
    archivedPets = true;
    const archived = await report(PERIOD, { category: ctx.cat['Pets E2E'] });
    assert.equal(archived.totals.expense, 8000, 'categoria arquivada: 200 com o gasto');

    // ---- Eco e normalização.
    const upper = await report(PERIOD, { category: ctx.cat.Moradia.toUpperCase() });
    assert.equal(upper.category, ctx.cat.Moradia, 'uuid em maiúsculas volta em minúsculas');
    assert.equal(upper.totals.expense, 120000);
    const noneUpper = await report(PERIOD, { category: 'NONE' });
    assert.equal(noneUpper.category, 'none');
    assert.equal(noneUpper.totals.expense, 2500);

    // ---- Validação e isolamento.
    const base = `/reports/sources?${qs(PERIOD)}`;
    const FORMAT = "Formato esperado: id da categoria ou 'none'";
    const hasFormatDetail = (body) => (body?.error?.details ?? []).some((d) => String(d.message).includes(FORMAT));
    await expectStatus('GET', `${base}&category=${ctx.other.categoryId}`, undefined, 404, 'Categoria não encontrada');
    await expectStatus('GET', `${base}&category=00000000-0000-4000-8000-000000000000`, undefined, 404, 'Categoria não encontrada');
    for (const bad of ['abc', '', 'nenhuma', 'none-x', `${ctx.cat.Moradia}x`, `account:${ctx.cat.Moradia}`]) {
      const body = await expectStatus('GET', `${base}&category=${encodeURIComponent(bad)}`, undefined, 400, 'Dados inválidos');
      assert.ok(hasFormatDetail(body), `category=${bad}: detalhe "${FORMAT}" (${JSON.stringify(body)})`);
    }
    await expectStatus('GET', `${base}&source=${ctx.key.A}&category=${ctx.other.categoryId}`, undefined, 404, 'Categoria não encontrada');
    await expectStatus('GET', `${base}&source=account:${ctx.other.accountId}&category=${ctx.cat.Moradia}`, undefined, 404, 'Conta não encontrada');

    // ---- GET /transactions?categoryId=<uuid>|none
    const list = async (q) => {
      const body = await get(`/transactions?${qs(q)}`);
      assert.equal(body.pagination.total, body.data.length, `${JSON.stringify(q)}: cabe numa página`);
      return body.data;
    };
    const ids = (rows) => rows.map((x) => x.id);
    const dbIds = async (categoryId) =>
      (
        await db(
          categoryId === 'none'
            ? `SELECT id FROM transactions
                WHERE user_id = $1 AND deleted_at IS NULL AND category_id IS NULL AND kind IN ('expense', 'income')`
            : `SELECT id FROM transactions WHERE user_id = $1 AND deleted_at IS NULL AND category_id = $2`,
          categoryId === 'none' ? [uid] : [uid, categoryId],
        )
      )
        .map((r) => r.id)
        .sort();

    const noneAll = await list({ categoryId: 'none' });
    assert.deepEqual(ids(noneAll).sort(), await dbIds('none'), "categoryId=none x banco");
    for (const x of noneAll) {
      assert.equal(x.categoryId, null);
      assert.ok(['expense', 'income'].includes(x.kind), `none: ${x.kind} não deveria entrar`);
    }
    for (const id of [ctx.t.transf.id, temp.transf.id, ctx.t.apagado.id, ctx.other.txId, ctx.other.cardTxId]) {
      assert.ok(!ids(noneAll).includes(id), `none: ${id} não deveria entrar`);
    }
    assert.deepEqual(ids(await list({ ...PERIOD, categoryId: 'none' })), [ctx.t.semCategoria.id], 'março: só o Pix avulso');
    assert.deepEqual(ids(await list({ ...JULY, categoryId: 'none' })), [temp.semCatCartao.id, temp.reembolso.id], 'julho: gasto + receita, sem a transferência');
    assert.deepEqual(ids(await list({ ...PERIOD, categoryId: 'NONE' })), [ctx.t.semCategoria.id], 'NONE em maiúsculas');
    assert.deepEqual(ids(await list({ categoryId: 'none', kind: 'transfer' })), [], 'transferência nunca é "sem categoria"');
    assert.deepEqual(ids(await list({ ...PERIOD, categoryId: 'none', accountId: C.id })), [ctx.t.semCategoria.id]);
    assert.deepEqual(ids(await list({ ...JULY, categoryId: 'none', creditCardId: K.id })), [temp.semCatCartao.id]);
    assert.deepEqual(ids(await list({ ...JULY, categoryId: 'none', kind: 'income' })), [temp.reembolso.id]);

    for (const name of ['Moradia', 'Compras', 'Pets E2E', 'Alimentação', 'Salário', 'Lazer']) {
      assert.deepEqual(ids(await list({ categoryId: ctx.cat[name] })).sort(), await dbIds(ctx.cat[name]), `categoryId=${name} x banco`);
    }
    assert.deepEqual(ids(await list({ categoryId: ctx.cat.Moradia })), [ctx.t.aluguel.id]);
    assert.deepEqual(ids(await list({ categoryId: ctx.cat['Pets E2E'] })), [ctx.t.racao.id], 'categoria própria');
    assert.deepEqual((await list({ categoryId: ctx.cat.Compras })).map((x) => x.installments), ['3/3', '2/3', '1/3']);
    assert.deepEqual(ids(await list({ ...JULY, categoryId: ctx.cat['Alimentação'] })), [temp.padaria.id, temp.feira.id]);
    assert.deepEqual(ids(await list({ categoryId: ctx.cat.Moradia.toUpperCase() })), [ctx.t.aluguel.id], 'uuid em maiúsculas');
    assert.deepEqual(ids(await list({ categoryId: ctx.other.categoryId })), [], 'categoria do outro: nada vaza');
    for (const bad of ['abc', '', 'none-x']) {
      const body = await expectStatus('GET', `/transactions?categoryId=${encodeURIComponent(bad)}`, undefined, 400, 'Dados inválidos');
      assert.ok(hasFormatDetail(body), `categoryId=${bad}: detalhe "${FORMAT}"`);
    }
  } finally {
    if (archivedPets) await db('UPDATE categories SET is_archived = false WHERE id = $1 AND user_id = $2', [ctx.cat['Pets E2E'], uid]);
    for (const t of Object.values(temp)) await api('DELETE', `/transactions/${t.id}`);
  }

  // Limpo: julho vazio de novo e março intacto.
  const julyAfter = await report(JULY);
  assert.deepEqual([julyAfter.totals.expense, julyAfter.totals.income, julyAfter.sources], [0, 0, []]);
  assert.equal((await report(PERIOD)).totals.expense, 146050);
});

section('infra: preflight do CORS, rota do cron, webhook e limite do recibo', async () => {
  // Preflight guardado 2 h pelo navegador (sem OPTIONS antes de cada chamada). Não toca o banco.
  const pre = await fetch(`${API_URL}/api/summary`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5186',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  assert.equal(pre.status, 204, 'preflight');
  assert.equal(pre.headers.get('access-control-max-age'), '7200', 'Access-Control-Max-Age');

  // Cron: a rota só existe na função da Vercel (VERCEL=1, o --serverless). Lá só o agendador
  // passa: sem o user-agent dele (o harness sobe sem CRON_SECRET, em desenvolvimento) → 401,
  // sem chamar o BCB. (O caminho feliz depende da rede — fica fora do e2e; o 503 de produção
  // sem CRON_SECRET não dá para subir aqui, NODE_ENV é development.) No servidor tradicional
  // o node-cron roda no processo e a rota não é montada → 404 (com o bypass de dev).
  const harness = await fetch(`${API_URL}/__harness/queries`).then((r) => (r.ok ? r.json() : null));
  const serverless = harness?.vercel === '1';
  if (serverless) {
    await expectStatus('GET', '/cron/indicators', undefined, 401, 'agendador');
    const bearer = await fetch(`${API_URL}/api/cron/indicators`, { headers: { Authorization: 'Bearer qualquer' } });
    assert.equal(bearer.status, 401, 'Bearer sem CRON_SECRET no servidor não vale');
  } else {
    await expectStatus('GET', '/cron/indicators', undefined, 404, 'Rota não encontrada');
    const forged = await fetch(`${API_URL}/api/cron/indicators`, { headers: { 'user-agent': 'vercel-cron/1.0' } });
    assert.equal(forged.status, 404, 'servidor tradicional: user-agent do cron não abre nada');
  }
  const post = await fetch(`${API_URL}/api/cron/indicators`, { method: 'POST', headers: { 'user-agent': 'vercel-cron/1.0' } });
  assert.equal(post.status, 404, 'só GET');

  // Webhook da Pluggy (público): 200 na hora, importação depois da resposta (waitUntil na
  // Vercel). Item que não é de ninguém / evento irrelevante / corpo vazio: nada a importar,
  // sem chamar a Pluggy (o harness sobe sem PLUGGY_*).
  for (const body of [{ event: 'item/updated', itemId: 'item-inexistente-e2e' }, { event: 'connector/status_updated' }, {}]) {
    const r = await fetch(`${API_URL}/api/open-finance/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, `webhook ${JSON.stringify(body)}`);
    assert.deepEqual(await r.json(), { received: true });
  }

  // Recibo acima de 4 MB → 400 claro (a Vercel recusa requisição > 4,5 MB antes da função).
  const scan = async (bytes, type = 'image/jpeg') => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type }), 'recibo.jpg');
    const res = await fetch(`${API_URL}/api/transactions/scan`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };
  for (const bytes of [4 * 1024 * 1024 + 1, Math.round(4.5 * 1024 * 1024)]) {
    const r = await scan(bytes);
    assert.equal(r.status, 400, `${bytes} bytes: ${JSON.stringify(r.body)}`);
    assert.equal(
      r.body.error.message,
      'Imagem muito grande (máx. 4 MB). Envie uma foto menor ou com resolução mais baixa.',
    );
  }
  // Abaixo do limite passa do upload (aqui sem GEMINI_API_KEY → erro de configuração, não de tamanho).
  const small = await scan(1024 * 1024);
  assert.notEqual(small.body?.error?.message?.startsWith('Imagem muito grande'), true, JSON.stringify(small.body));
  assert.equal((await scan(1000, 'text/plain')).status, 400, 'só imagem');
});

section('conta padrão: GETs simultâneos sem conta ativa criam UMA Carteira', async (ctx) => {
  const uid = ctx.fx.TEST_USER_ID;
  const db = (sql, params) => withLocalClient(DB_NAME, async (c) => (await c.query(sql, params)).rows);
  const before = await db('SELECT id FROM accounts WHERE user_id = $1 AND is_archived = false', [uid]);
  assert.ok(before.length > 0, 'fixture com contas ativas');
  let created = [];
  // Arquiva TODAS direto no banco local (pela API a última ativa não arquiva) e desfaz no fim.
  await db('UPDATE accounts SET is_archived = true WHERE user_id = $1', [uid]);
  try {
    const N = 20;
    const rs = await Promise.all(
      Array.from({ length: N }, (_, i) => api('GET', i % 2 ? '/accounts' : '/accounts?includeArchived=true')),
    );
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [200], JSON.stringify(rs.find((r) => r.status !== 200)));
    created = await db(
      `SELECT id, name, type FROM accounts WHERE user_id = $1 AND is_archived = false`,
      [uid],
    );
    assert.equal(created.length, 1, `${N} GETs juntos → 1 conta nova: ${JSON.stringify(created)}`);
    assert.deepEqual([created[0].name, created[0].type], ['Carteira', 'cash']);
    for (const r of rs) {
      assert.equal(r.body.data[0].id, created[0].id, 'toda resposta já traz a Carteira (ativa primeiro)');
    }
    // Já existe conta ativa: o GET não cria mais nada.
    await get('/accounts');
    assert.equal((await db('SELECT id FROM accounts WHERE user_id = $1', [uid])).length, before.length + 1);
  } finally {
    for (const a of created) await db('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [a.id, uid]);
    await db('UPDATE accounts SET is_archived = false WHERE user_id = $1 AND id = ANY($2::uuid[])', [
      uid,
      before.map((a) => a.id),
    ]);
  }
  assert.deepEqual(
    (await get('/accounts')).data.map((a) => a.id).sort(),
    before.map((a) => a.id).sort(),
    'contas do fixture de volta',
  );
});

// >>> ACRESCENTE NOVAS SEÇÕES AQUI <<<

// ============================================================================
// Execução
// ============================================================================

async function main() {
  console.log('→ Resetando o banco local (financas_test)…');
  execFileSync('./reset-db.sh', { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] });
  await assertLocalApi(); // antes de QUALQUER escrita pela API

  console.log('→ Montando o fixture do teste (março/2025)…');
  const ctx = await buildFixture();

  const chosen = ONLY ? sections.filter((s) => s.name.toLowerCase().includes(ONLY.toLowerCase())) : sections;
  if (chosen.length === 0) throw new Error(`Nenhuma seção com "${ONLY}".`);

  let failed = 0;
  for (const s of chosen) {
    const t0 = Date.now();
    try {
      await s.fn(ctx);
      console.log(`  ✓ ${s.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed += 1;
      console.log(`  ✗ ${s.name}\n    ${String(e.message).split('\n').join('\n    ')}`);
    }
  }
  console.log(failed ? `\n❌ ${failed} de ${chosen.length} seções falharam.` : `\n✅ ${chosen.length} seções passaram.`);
  return failed;
}

let failed = 1;
try {
  failed = await main();
} catch (e) {
  console.error(`❌ ${e.message}`);
}

if (!NO_DEMO) {
  console.log('→ Re-semeando a demo (seed-demo.mjs --reset)…');
  try {
    execFileSync('node', ['seed-demo.mjs', '--reset'], { cwd: HERE, stdio: ['ignore', 'ignore', 'inherit'] });
    console.log('✅ Demo de volta no banco local.');
  } catch {
    console.error('⚠️  Não consegui re-semear a demo — rode: node seed-demo.mjs --reset');
  }
} else {
  console.log('(--no-demo: o banco ficou com o fixture do teste)');
}
process.exit(failed ? 1 : 0);
