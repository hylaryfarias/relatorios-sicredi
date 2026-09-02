/* Autorizacao do e-mail — roda UMA vez, no seu PC.
 *
 * Abre uma pagina do Google pedindo permissao para LER o e-mail que recebe os
 * codigos do Sicredi. Voce aprova, e este programa guarda uma chave
 * (refresh token) no arquivo token-email.json. A partir dai o robo le os
 * codigos sozinho, sem pedir a sua senha do Gmail nunca.
 *
 * Como usar:
 *   1) tenha GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET no arquivo .env (o mesmo
 *      Client ID e Client Secret que voce gerou no Google Cloud)
 *   2) rode: npm run autorizar-email
 *   3) abra o link que aparecer, aprove, e cole de volta o codigo. */

import http from 'node:http';
import fs from 'node:fs';
import { google } from 'googleapis';

function lerEnv() {
  try {
    const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const linha of txt.split('\n')) {
      const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env, tenta variaveis do sistema */ }
}
lerEnv();

const id = process.env.GMAIL_CLIENT_ID;
const segredo = process.env.GMAIL_CLIENT_SECRET;
if (!id || !segredo) {
  console.error('\nFalta GMAIL_CLIENT_ID e/ou GMAIL_CLIENT_SECRET no arquivo .env.\n');
  process.exit(1);
}

const REDIRECT = 'http://localhost:3000/auth/callback';
const oauth = new google.auth.OAuth2(id, segredo, REDIRECT);
const url = oauth.generateAuthUrl({
  access_type: 'offline',        // para receber o refresh token
  prompt: 'consent',             // forca vir o refresh token mesmo se ja autorizou antes
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

console.log('\n=== Autorizar leitura do e-mail ===\n');
console.log('1) Abra este link no navegador (logado no e-mail que recebe os codigos):\n');
console.log(url + '\n');
console.log('2) Aprove. O navegador vai voltar para uma pagina que pode dizer "nao foi possivel'
          + ' acessar" — tudo bem, e' + ' so' + ' o robo capturando a resposta.\n');
console.log('Aguardando a aprovacao...\n');

/* Um servidorzinho local so para receber a resposta do Google. */
const servidor = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/auth/callback')) { res.end('ok'); return; }
  const codigo = new URL(req.url, REDIRECT).searchParams.get('code');
  try {
    const { tokens } = await oauth.getToken(codigo);
    if (!tokens.refresh_token) throw new Error('Google nao devolveu refresh_token. Tente de novo.');
    fs.writeFileSync(new URL('../token-email.json', import.meta.url),
      JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2));
    res.end('Pronto! Pode fechar esta aba e voltar para o programa.');
    console.log('Autorizacao guardada em token-email.json. Terminado.\n');
    console.log('Para o GitHub, o valor do GMAIL_REFRESH_TOKEN e:\n');
    console.log('  ' + tokens.refresh_token + '\n');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.end('Erro: ' + e.message);
    console.error(e.message);
    setTimeout(() => process.exit(1), 500);
  }
});
servidor.listen(3000);
