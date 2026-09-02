/* Autorizacao do e-mail — roda UMA vez, no seu PC.
 *
 * Abre uma pagina do Google pedindo permissao para LER o e-mail que recebe os
 * codigos do Sicredi. Voce aprova, e este programa guarda as chaves no arquivo
 * credenciais-google.json. A partir dai o robo le os codigos sozinho, sem
 * pedir a sua senha do Gmail nunca.
 *
 * Como usar: dois cliques em AUTORIZAR-EMAIL-WINDOWS.bat (ou rode
 * "npm run autorizar-email"). O programa PERGUNTA o Client ID e o Client
 * Secret na tela — voce so cola. Nao precisa criar arquivo de configuracao. */

import http from 'node:http';
import fs from 'node:fs';
import readline from 'node:readline';
import { google } from 'googleapis';

const ARQ_CRED = new URL('../credenciais-google.json', import.meta.url);

/* le uma resposta digitada/colada na tela */
function perguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(texto, r => { rl.close(); res(r.trim()); }));
}

/* de onde vem o Client ID e o Client Secret: do .env, ou de credenciais ja
 * salvas, ou perguntando na tela */
async function obterChaves() {
  // 1) variaveis de ambiente / .env
  let id = process.env.GMAIL_CLIENT_ID;
  let seg = process.env.GMAIL_CLIENT_SECRET;
  try {
    const txt = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const linha of txt.split('\n')) {
      const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) { if (m[1] === 'GMAIL_CLIENT_ID') id = id || m[2]; if (m[1] === 'GMAIL_CLIENT_SECRET') seg = seg || m[2]; }
    }
  } catch { /* sem .env, tudo bem */ }
  // 2) credenciais ja salvas de uma vez anterior
  if ((!id || !seg) && fs.existsSync(ARQ_CRED)) {
    try { const j = JSON.parse(fs.readFileSync(ARQ_CRED, 'utf8')); id = id || j.client_id; seg = seg || j.client_secret; } catch { /* segue */ }
  }
  // 3) perguntar na tela
  console.log('\n=== Autorizar leitura do e-mail ===\n');
  if (!id)  id  = await perguntar('Cole aqui o ID do cliente (Google) e aperte Enter:\n> ');
  if (!seg) seg = await perguntar('\nCole aqui a Chave secreta do cliente (Google) e aperte Enter:\n> ');
  id = (id || '').replace(/^["']|["']$/g, '').trim();
  seg = (seg || '').replace(/^["']|["']$/g, '').trim();
  if (!id || !seg) { console.error('\nFaltou o ID ou a Chave. Rode de novo.\n'); process.exit(1); }
  return { id, seg };
}

const REDIRECT = 'http://localhost:3000/auth/callback';

const { id, seg } = await obterChaves();
const oauth = new google.auth.OAuth2(id, seg, REDIRECT);
const url = oauth.generateAuthUrl({
  access_type: 'offline',   // para receber o refresh token
  prompt: 'consent',        // forca vir o refresh token mesmo se ja autorizou antes
  scope: ['https://www.googleapis.com/auth/gmail.readonly'],
});

console.log('\n1) Abra este link no navegador (logado no e-mail que recebe os codigos):\n');
console.log(url + '\n');
console.log('2) Clique em Permitir. Se aparecer "app nao verificado", clique em');
console.log('   Avancado -> Acessar (nao seguro). E o SEU app, feito por voce.\n');
console.log('Aguardando a aprovacao...\n');

/* Um servidorzinho local so para receber a resposta do Google. */
const servidor = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/auth/callback')) { res.end('ok'); return; }
  const codigo = new URL(req.url, REDIRECT).searchParams.get('code');
  try {
    const { tokens } = await oauth.getToken(codigo);
    if (!tokens.refresh_token) throw new Error('Google nao devolveu a chave. Tente de novo.');
    fs.writeFileSync(ARQ_CRED, JSON.stringify({
      client_id: id, client_secret: seg, refresh_token: tokens.refresh_token,
    }, null, 2));
    res.end('Pronto! Pode fechar esta aba e voltar para o programa.');
    console.log('\nAutorizacao guardada. Terminado.\n');
    console.log('Para o robo das 7h no GitHub, o valor do segredo GMAIL_REFRESH_TOKEN e:\n');
    console.log('  ' + tokens.refresh_token + '\n');
    console.log('(copie essa linha e cadastre no GitHub como GMAIL_REFRESH_TOKEN)\n');
    setTimeout(() => process.exit(0), 500);
  } catch (e) {
    res.end('Erro: ' + e.message);
    console.error('\nDeu erro:', e.message, '\n');
    setTimeout(() => process.exit(1), 500);
  }
});
servidor.listen(3000);
