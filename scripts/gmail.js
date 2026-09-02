/* Leitor do codigo de acesso do Sicredi que chega por e-mail.
 *
 * O portal, depois do login, manda um codigo de 6 digitos para o e-mail da
 * loja. Este modulo entra nesse e-mail (com a autorizacao que voce deu uma vez
 * pelo Google) e pega o codigo mais recente, para o robo digitar sozinho.
 *
 * Nao usa a SUA senha do Gmail: usa um "refresh token", uma chave que so
 * serve para LER e-mail e que voce pode cancelar quando quiser, sem mexer na
 * conta. Por isso e' seguro guardar essa chave como segredo. */

import { google } from 'googleapis';

/* De onde vem a autorizacao do e-mail: das variaveis de ambiente (no GitHub)
 * ou do arquivo token-email.json (no seu PC). O que existir primeiro vale. */
async function clienteGmail() {
  const id = process.env.GMAIL_CLIENT_ID;
  const segredo = process.env.GMAIL_CLIENT_SECRET;
  let refresh = process.env.GMAIL_REFRESH_TOKEN;

  let id2 = id, segredo2 = segredo;
  if (!refresh || !id2 || !segredo2) {
    // no PC: le do arquivo salvo pela autorizacao
    try {
      const fs = await import('node:fs');
      const url = new URL('../credenciais-google.json', import.meta.url);
      const j = JSON.parse(fs.readFileSync(url, 'utf8'));
      refresh = refresh || j.refresh_token;
      id2 = id2 || j.client_id;
      segredo2 = segredo2 || j.client_secret;
    } catch { /* segue: o erro abaixo explica */ }
  }
  if (!id2 || !segredo2 || !refresh) {
    throw new Error(
      'Falta a autorizacao do e-mail. No seu PC, rode uma vez o AUTORIZAR-EMAIL-WINDOWS.bat. '
      + 'No GitHub, cadastre GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REFRESH_TOKEN.');
  }

  const oauth = new google.auth.OAuth2(id2, segredo2, 'http://localhost:3000/auth/callback');
  oauth.setCredentials({ refresh_token: refresh });
  return google.gmail({ version: 'v1', auth: oauth });
}

/* Extrai o primeiro numero de 4 a 8 digitos que parecer um codigo de acesso.
 * O corpo do e-mail costuma trazer "seu codigo e 123456"; pegamos esse numero.*/
function achaCodigo(texto) {
  if (!texto) return null;
  // tira tags HTML e, principalmente, as cores hex (#666666) que enganam a
  // busca — foi uma cor de texto que virou "codigo 666666" por engano
  let t = texto.replace(/<[^>]+>/g, ' ')
    .replace(/#[0-9a-fA-F]{3,8}\b/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  // 1) numero de 6 digitos logo depois de "codigo"/"verifica"/"token"
  const perto = t.match(/(?:c[oó]digo|verifica|token)[^0-9]{0,80}(\d{6})(?!\d)/i);
  if (perto) return perto[1];
  // 2) qualquer numero isolado de 6 digitos (nao colado em mais digitos)
  const seis = t.match(/(?<!\d)(\d{6})(?!\d)/);
  if (seis) return seis[1];
  const q = t.match(/(?<!\d)(\d{4,8})(?!\d)/);
  return q ? q[1] : null;
}

function corpoDoEmail(payload) {
  if (!payload) return '';
  const dec = (d) => Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  // guarda texto puro e HTML separados: o texto puro nao tem cores para enganar
  let plano = '', html = '';
  const anda = (p) => {
    const mt = p.mimeType || '';
    if (p.body && p.body.data) {
      if (mt.includes('text/plain')) plano += ' ' + dec(p.body.data);
      else if (mt.includes('text/html')) html += ' ' + dec(p.body.data);
      else plano += ' ' + dec(p.body.data);
    }
    (p.parts || []).forEach(anda);
  };
  anda(payload);
  return plano.trim() ? plano : html; // prefere o texto puro
}

/* Espera chegar um e-mail NOVO com o codigo. "Novo" = recebido depois de
 * `desde` (momento em que o robo pediu o codigo), para nao pegar o codigo de
 * um login anterior. Fica tentando por ate `timeoutSeg` segundos. */
export async function pegarCodigo({ desde, remetente = 'fiserv.com', timeoutSeg = 120 } = {}) {
  const gmail = await clienteGmail();
  const inicio = Date.now();
  const limite = timeoutSeg * 1000;
  const marca = Math.floor((desde || (Date.now() - 5 * 60000)) / 1000); // epoch em segundos

  while (Date.now() - inicio < limite) {
    const lista = await gmail.users.messages.list({
      userId: 'me',
      q: `from:${remetente} newer_than:1d`,
      maxResults: 5,
    });
    const msgs = lista.data.messages || [];
    for (const m of msgs) {
      const cheio = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const dataMsg = Number(cheio.data.internalDate || 0) / 1000;
      if (dataMsg < marca) continue; // e-mail antigo, de outro login
      const assunto = (cheio.data.payload.headers || [])
        .find(h => h.name.toLowerCase() === 'subject')?.value || '';
      const cod = achaCodigo(corpoDoEmail(cheio.data.payload)) || achaCodigo(assunto);
      if (cod) return cod;
    }
    await new Promise(r => setTimeout(r, 4000)); // espera e tenta de novo
  }
  throw new Error(`Nao chegou o codigo por e-mail em ${timeoutSeg}s (remetente "${remetente}").`);
}
