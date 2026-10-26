/* eslint-disable */
// Roda SQL avulso no Postgres LOCAL (127.0.0.1:54329) — nunca em produção.
// Imprime as linhas em JSON (ou { rowCount }). Vários comandos: mostra o último.
// Uso: node sql.mjs "<SQL>"            (banco financas_test)
//      node sql.mjs --db=postgres "<SQL>"
import { DB_NAME, withLocalClient } from './lib.mjs';

let db = DB_NAME;
const args = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--db=')) db = a.slice('--db='.length);
  else args.push(a);
}
const sql = args.join(' ').trim();
if (!sql) {
  console.error('Uso: node sql.mjs [--db=<banco>] "<SQL>"');
  process.exit(1);
}

try {
  await withLocalClient(db, async (client) => {
    const res = await client.query(sql);
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    console.log(JSON.stringify(last.rows?.length ? last.rows : { rowCount: last.rowCount }, null, 2));
  });
} catch (e) {
  console.error('ERR', e.message);
  process.exit(1);
}
