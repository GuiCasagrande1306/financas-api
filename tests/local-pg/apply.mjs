/* eslint-disable */
// Aplica um arquivo .sql no banco LOCAL financas_test (127.0.0.1:54329).
// Mesma regra do db/migrate.js do backend: se o arquivo tem o marcador do trigger
// em auth.users, o NÚCLEO (antes do marcador) roda numa chamada só e precisa
// passar; o RESTO roda best-effort (falha vira aviso). Sem marcador: tudo de uma vez.
// Uso: node apply.mjs <arquivo.sql>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DB_NAME, withLocalClient } from './lib.mjs';

const MARKER = 'create or replace function public.handle_new_user';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node apply.mjs <arquivo.sql>');
  process.exit(1);
}

const sql = readFileSync(file, 'utf8');
const idx = sql.indexOf(MARKER);
const core = idx >= 0 ? sql.slice(0, idx) : sql;
const rest = idx >= 0 ? sql.slice(idx) : '';
const name = path.basename(file);

try {
  await withLocalClient(DB_NAME, async (client) => {
    await client.query(core);
    console.log(`✅ ${name}: ${rest ? 'núcleo aplicado' : 'aplicado'}`);
    if (rest) {
      try {
        await client.query(rest);
        console.log(`✅ ${name}: resto (trigger em auth.users) aplicado`);
      } catch (e) {
        console.warn(`⚠️  ${name}: resto não aplicado (seguimos sem ele): ${e.message}`);
      }
    }
  });
} catch (e) {
  console.error(`❌ ${name}: ${e.message}`);
  process.exit(1);
}
