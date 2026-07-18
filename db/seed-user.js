/* eslint-disable */
// Cria um usuário de teste em auth.users (o trigger cria o profile).
// Uso: node db/seed-user.js
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const USER_ID = 'c6f69a91-c719-4bee-86e1-3681116eb2c1';

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(
    `insert into auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, email_change_token_new, email_change
     ) values (
        '00000000-0000-0000-0000-000000000000',
        $1, 'authenticated', 'authenticated', 'teste@financas.app',
        crypt('financas123', gen_salt('bf')), now(), now(), now(),
        '{"provider":"email","providers":["email"]}',
        '{"full_name":"Usuário Teste"}',
        '', '', '', ''
     )
     on conflict (id) do nothing`,
    [USER_ID],
  );
  console.log('✅ Usuário de teste garantido em auth.users');

  // Rede de segurança: garante o profile mesmo se o trigger não rodar.
  await client.query(
    `insert into public.profiles (id, full_name)
       values ($1, 'Usuário Teste')
       on conflict (id) do nothing`,
    [USER_ID],
  );

  const prof = await client.query('select id, full_name from public.profiles where id = $1', [USER_ID]);
  console.log('— profile:', JSON.stringify(prof.rows));
  console.log('— USER_ID:', USER_ID);

  await client.end();
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
