/* eslint-disable */
// Aplica o db/schema.sql no banco definido em .env (DATABASE_URL).
// Uso: node db/migrate.js
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL ausente no .env');

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // A parte que cria trigger em auth.users pode exigir permissão especial —
  // roda separada e best-effort, para não derrubar o schema principal.
  const marker = 'create or replace function public.handle_new_user';
  const idx = sql.indexOf(marker);
  const core = idx >= 0 ? sql.slice(0, idx) : sql;
  const authPart = idx >= 0 ? sql.slice(idx) : '';

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('✅ Conectado ao Postgres');

  await client.query(core);
  console.log('✅ Schema principal aplicado (tabelas + seed + RLS)');

  if (authPart) {
    try {
      await client.query(authPart);
      console.log('✅ Trigger de auto-criação de profile aplicado');
    } catch (e) {
      console.warn('⚠️  Trigger em auth.users não aplicado (seguimos sem ele):', e.message);
    }
  }

  const tables = await client.query(
    `select table_name from information_schema.tables where table_schema='public' order by table_name`,
  );
  const cats = await client.query(`select count(*)::int as n from public.categories`);
  const users = await client.query(`select id, email from auth.users order by created_at limit 5`);

  console.log('— Tabelas public:', tables.rows.map((r) => r.table_name).join(', '));
  console.log('— Categorias (seed):', cats.rows[0].n);
  console.log('— Usuários em auth.users (até 5):', JSON.stringify(users.rows));

  await client.end();
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
