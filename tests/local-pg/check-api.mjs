/* eslint-disable */
// Confere que a API na porta 3333 é a que o start-api.sh subiu e que a ÚNICA
// conexão de banco dela é com o Postgres local 127.0.0.1:54329. Não escreve nada.
// Uso: node check-api.mjs   (sai com 1 se algo estiver errado)
import { assertLocalApi } from './lib.mjs';

try {
  await assertLocalApi();
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
