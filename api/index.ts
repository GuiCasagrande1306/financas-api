// Função serverless da Vercel: TODAS as rotas (/health, /api/*) caem aqui pelo
// rewrite do vercel.json. O app fica em src/vercel.ts (compilado e checado pelo tsc);
// este arquivo só existe porque a Vercel cria uma função para cada arquivo de api/.
export { default } from '../src/vercel';
