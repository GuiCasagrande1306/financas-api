/* eslint-disable */
// Dados de DEMONSTRAÇÃO para o usuário de teste, gravados PELA API LOCAL (as
// regras do backend valem: parcelas, faturas, saldos, recorrências, empréstimo).
//  - 5 contas, 2 cartões, 1 categoria própria ("Pets");
//  - 3 meses (2 anteriores + o atual até hoje) de receitas e gastos em VÁRIAS
//    categorias, alguns sem categoria;
//  - transferências, 2 compras parceladas, pagamento das faturas já vencidas;
//  - 3 recorrentes (o app lança sozinho as do mês atual que já venceram);
//  - 1 empréstimo com 1 parcela recebida e 1 atrasada (as demais a vencer).
// Datas relativas a HOJE (America/Sao_Paulo): a demo serve em qualquer dia.
// Uso: node seed-demo.mjs [--reset]   (--reset roda ./reset-db.sh antes)
import { execFileSync } from 'node:child_process';
import {
  DB_NAME,
  HERE,
  addDays,
  addMonthsYM,
  assertLocalApi,
  brl,
  call,
  lastDayOf,
  loadFixture,
  todaySP,
  withLocalClient,
} from './lib.mjs';

if (process.argv.includes('--reset')) {
  execFileSync('./reset-db.sh', { cwd: HERE, stdio: 'inherit' });
}

try {
  await assertLocalApi();
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
const fx = loadFixture();

// Semear duas vezes duplicaria tudo: exige o usuário de teste sem lançamentos.
const already = await withLocalClient(DB_NAME, (c) =>
  c.query('SELECT COUNT(*)::int AS n FROM transactions WHERE user_id = $1', [fx.TEST_USER_ID]),
);
if (already.rows[0].n > 0) {
  console.error(
    `❌ O usuário de teste já tem ${already.rows[0].n} lançamentos. Rode: node seed-demo.mjs --reset`,
  );
  process.exit(1);
}

const today = todaySP();
const M0 = today.slice(0, 7);

/**
 * Dia `day` do mês (atual − `back`), com clamp no fim do mês. No mês atual,
 * nunca passa de hoje (a demo não cria lançamento agendado sem querer).
 */
function d(back, day) {
  const ym = addMonthsYM(M0, -back);
  const iso = `${ym}-${String(Math.min(day, lastDayOf(ym))).padStart(2, '0')}`;
  return back === 0 && iso > today ? today : iso;
}

let created = 0;
async function tx(body) {
  const row = await call('POST', '/transactions', body, 201);
  created += 1;
  return row;
}

// ---- categorias ------------------------------------------------------------
const categories = (await call('GET', '/categories')).data;
const cat = Object.fromEntries(categories.map((c) => [c.name, c.id]));
for (const name of ['Moradia', 'Alimentação', 'Transporte', 'Lazer', 'Saúde', 'Educação', 'Compras', 'Contas', 'Assinaturas', 'Salário']) {
  if (!cat[name]) throw new Error(`Categoria de sistema "${name}" não encontrada — o schema mudou?`);
}
cat.Pets = (await call('POST', '/categories', { name: 'Pets', kind: 'expense', icon: 'circle', color: '#f97316' }, 201)).id;

// ---- contas e cartões ------------------------------------------------------
const nubank = await call('POST', '/accounts', { name: 'Nubank', type: 'checking', color: '#8b5cf6', initialBalance: 350000 }, 201);
const itau = await call('POST', '/accounts', { name: 'Itaú', type: 'checking', color: '#f97316', initialBalance: 820000 }, 201);
const poupanca = await call('POST', '/accounts', { name: 'Poupança Caixa', type: 'savings', color: '#0ea5e9', initialBalance: 1200000 }, 201);
const carteira = await call('POST', '/accounts', { name: 'Carteira', type: 'cash', color: '#10b981', initialBalance: 25000 }, 201);
const picpay = await call('POST', '/accounts', { name: 'PicPay', type: 'wallet', color: '#22c55e', initialBalance: 40000 }, 201);

const roxinho = await call('POST', '/credit-cards', { name: 'Nubank Roxinho', limit: 800000, closingDay: 3, dueDay: 10, lastDigits: '4321', color: '#7c3aed' }, 201);
const itauVisa = await call('POST', '/credit-cards', { name: 'Itaú Visa', limit: 500000, closingDay: 25, dueDay: 5, lastDigits: '8765', color: '#ea580c' }, 201);

// ---- 3 meses de movimento (back = 2, 1, 0) ------------------------------------
for (const back of [2, 1, 0]) {
  const v = (cents) => cents + (2 - back) * 730; // leve variação mês a mês

  // Receitas
  await tx({ kind: 'income', amount: 750000, categoryId: cat['Salário'], accountId: itau.id, occurredAt: d(back, 5), description: 'Salário' });
  await tx({ kind: 'income', amount: 120000 + back * 15000, accountId: picpay.id, occurredAt: d(back, 18), description: 'Freela de design' }); // sem categoria

  // Moradia e contas da casa
  await tx({ amount: 220000, categoryId: cat.Moradia, accountId: itau.id, occurredAt: d(back, 10), description: 'Aluguel' });
  await tx({ amount: 48000, categoryId: cat.Moradia, accountId: itau.id, occurredAt: d(back, 10), description: 'Condomínio' });
  await tx({ amount: v(18900), categoryId: cat.Contas, accountId: nubank.id, occurredAt: d(back, 12), description: 'Conta de luz', merchant: 'Celesc' });
  await tx({ amount: 9990, categoryId: cat.Contas, accountId: nubank.id, occurredAt: d(back, 15), description: 'Internet', merchant: 'Vivo Fibra' });

  // Alimentação
  await tx({ amount: v(38750), categoryId: cat['Alimentação'], creditCardId: roxinho.id, occurredAt: d(back, 2), description: 'Mercado', merchant: 'Angeloni' });
  await tx({ amount: v(41230), categoryId: cat['Alimentação'], creditCardId: roxinho.id, occurredAt: d(back, 13), description: 'Mercado', merchant: 'Giassi' });
  await tx({ amount: v(29870), categoryId: cat['Alimentação'], creditCardId: roxinho.id, occurredAt: d(back, 24), description: 'Mercado', merchant: 'Angeloni' });
  await tx({ amount: 6490, categoryId: cat['Alimentação'], creditCardId: roxinho.id, occurredAt: d(back, 8), description: 'iFood', merchant: 'iFood' });
  await tx({ amount: 5890, categoryId: cat['Alimentação'], creditCardId: roxinho.id, occurredAt: d(back, 20), description: 'iFood', merchant: 'iFood' });
  await tx({ amount: 2350, categoryId: cat['Alimentação'], accountId: carteira.id, occurredAt: d(back, 6), description: 'Padaria' });

  // Transporte
  await tx({ amount: 2890, categoryId: cat.Transporte, creditCardId: itauVisa.id, occurredAt: d(back, 4), description: 'Uber', merchant: 'Uber' });
  await tx({ amount: v(3410), categoryId: cat.Transporte, creditCardId: itauVisa.id, occurredAt: d(back, 17), description: 'Uber', merchant: 'Uber' });
  await tx({ amount: 25000, categoryId: cat.Transporte, accountId: nubank.id, occurredAt: d(back, 14), description: 'Combustível', merchant: 'Posto Ipiranga' });

  // Lazer, saúde, educação, pets
  await tx({ amount: 6400, categoryId: cat.Lazer, accountId: carteira.id, occurredAt: d(back, 21), description: 'Cinema' });
  await tx({ amount: v(8790), categoryId: cat['Saúde'], accountId: picpay.id, occurredAt: d(back, 9), description: 'Farmácia', merchant: 'Panvel' });
  await tx({ amount: 32000, categoryId: cat['Educação'], accountId: nubank.id, occurredAt: d(back, 7), description: 'Curso de inglês' });
  await tx({ amount: 18900, categoryId: cat.Pets, accountId: picpay.id, occurredAt: d(back, 16), description: 'Ração', merchant: 'Petz' });

  // Sem categoria
  await tx({ amount: 15000, accountId: nubank.id, occurredAt: d(back, 22), description: 'Pix para Ana' });

  // Transferências entre contas (não são gasto)
  await tx({ kind: 'transfer', amount: 100000, accountId: itau.id, transferAccountId: poupanca.id, occurredAt: d(back, 6), description: 'Guardar na poupança' });
  await tx({ kind: 'transfer', amount: 150000, accountId: itau.id, transferAccountId: nubank.id, occurredAt: d(back, 7), description: 'Transferência para o Nubank' });

  // Assinaturas e academia dos meses anteriores (no mês atual quem lança é a recorrência)
  if (back > 0) {
    await tx({ amount: 5590, categoryId: cat.Assinaturas, creditCardId: roxinho.id, occurredAt: d(back, 15), description: 'Netflix' });
    await tx({ amount: 2190, categoryId: cat.Assinaturas, creditCardId: itauVisa.id, occurredAt: d(back, 20), description: 'Spotify' });
    await tx({ amount: 11990, categoryId: cat['Saúde'], accountId: nubank.id, occurredAt: d(back, 5), description: 'Academia' });
  }
}

// Avulsos de cada mês
await tx({ amount: 25990, categoryId: cat.Compras, creditCardId: itauVisa.id, occurredAt: d(2, 19), description: 'Roupas', merchant: 'Renner' });
await tx({ amount: 18000, categoryId: cat.Lazer, creditCardId: itauVisa.id, occurredAt: d(1, 27), description: 'Show' });
await tx({ amount: 12000, accountId: carteira.id, occurredAt: d(1, 26), description: 'Presente de aniversário' }); // sem categoria
await tx({ amount: 39990, categoryId: cat.Compras, creditCardId: itauVisa.id, occurredAt: d(0, 11), description: 'Tênis', merchant: 'Centauro' });
await tx({ amount: 1800, accountId: carteira.id, occurredAt: d(0, 3), description: 'Estacionamento' }); // sem categoria
await tx({ kind: 'transfer', amount: 20000, accountId: nubank.id, transferAccountId: carteira.id, occurredAt: d(0, 1), description: 'Saque para a carteira' });

// Parcelados (a API fatia em N lançamentos mensais)
await tx({ amount: 360000, categoryId: cat.Compras, creditCardId: itauVisa.id, occurredAt: d(2, 12), description: 'Geladeira', merchant: 'Magazine Luiza', installments: 6 });
await tx({ amount: 59900, categoryId: cat.Compras, creditCardId: roxinho.id, occurredAt: d(1, 9), description: 'Fone de ouvido', installments: 3 });

// ---- pagamento das faturas já vencidas (total que falta, no vencimento) --------
let invoicesPaid = 0;
for (const [card, payer] of [[roxinho, nubank], [itauVisa, itau]]) {
  const { invoices } = await call('GET', `/credit-cards/${card.id}/invoices`);
  for (const inv of invoices) {
    if (inv.status !== 'closed' || inv.remaining <= 0 || inv.dueDate > today) continue;
    await call('POST', `/credit-cards/${card.id}/invoices/${inv.month}/payments`, { accountId: payer.id, amount: inv.remaining, paidAt: inv.dueDate }, 201);
    invoicesPaid += 1;
    created += 1;
  }
}

// ---- recorrentes (GET /recurring lança as do mês atual que já venceram) ----------
await call('POST', '/recurring', { name: 'Netflix', amount: 5590, dueDay: 15, categoryId: cat.Assinaturas, creditCardId: roxinho.id, color: '#e50914' }, 201);
await call('POST', '/recurring', { name: 'Spotify', amount: 2190, dueDay: 20, categoryId: cat.Assinaturas, creditCardId: itauVisa.id, color: '#1db954' }, 201);
await call('POST', '/recurring', { name: 'Academia', amount: 11990, dueDay: 5, categoryId: cat['Saúde'], accountId: nubank.id, color: '#f59e0b' }, 201);
await call('GET', '/recurring');

// ---- empréstimo: 1 parcela recebida, 1 atrasada, as demais a vencer --------------
// 1ª parcela venceu há ~45 dias (recebida), a 2ª há ~15 (atrasada), a 3ª vence em ~15.
const firstDue = addDays(today, -45);
const loan = await call('POST', '/loans', {
  borrowerName: 'Carlos Souza',
  description: 'Empréstimo para a moto',
  principal: 300000,
  lentAt: addDays(today, -60),
  sourceAccountId: itau.id,
  receiveAccountId: nubank.id,
  schedule: { count: 6, amount: 55000, firstDueDate: firstDue },
}, 201);
const received = await call('POST', `/loans/${loan.id}/installments/${loan.installments[0].id}/receive`, { receivedAt: firstDue });

// ---- resumo ------------------------------------------------------------------
const accounts = await call('GET', '/accounts');
const txs = await call('GET', '/transactions?limit=1');
const report = await call('GET', `/reports/sources?from=${M0}-01&to=${M0}-${String(lastDayOf(M0)).padStart(2, '0')}`);
const statusCount = received.installments.reduce((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});

console.log('✅ Demo semeada pela API local');
console.log(`   contas: ${accounts.data.length} · saldo total ${brl(accounts.totals.balance)}`);
console.log(`   cartões: 2 · faturas pagas: ${invoicesPaid}`);
console.log(`   lançamentos: ${txs.pagination.total} (criados direto: ${created}; o resto = parcelas, recorrências e empréstimo)`);
console.log(`   mês atual (${M0}): gasto ${brl(report.totals.expense)} em ${report.byCategory.length} categorias · entrou ${brl(report.totals.income)}`);
console.log(`   empréstimo "${received.borrowerName}": ${JSON.stringify(statusCount)}`);
