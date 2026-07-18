/* eslint-disable */
// Roda um SQL avulso contra o banco do .env. Uso: node db/query.js "select 1"
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const sql = process.argv[2];
  if (!sql) throw new Error('Passe o SQL como argumento');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const res = await client.query(sql);
  console.log(JSON.stringify(res.rows.length ? res.rows : { rowCount: res.rowCount }, null, 2));
  await client.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
