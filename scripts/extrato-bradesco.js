/* Robo do EXTRATO — Bradesco Net Empresa (PJ). SO CONSULTA.
 *
 * Login em um passo + validacao humana:
 *   1) Usuario + Senha  -> Avancar
 *   2) "Nao sou um robo" (reCAPTCHA)  -> VOCE clica na tela; o robo espera
 *      voce resolver e entrar. Nao burlamos o reCAPTCHA — so a parte chata
 *      (trocar de empresa e baixar) e automatica.
 *
 * Depois, para CADA empresa (menu "Acessar outras empresas"):
 *   - troca de empresa (clica na empresa no modal, dispensa a "nuvem")
 *   - abre "Saldos e Extratos" -> Extrato (Ultimos Lancamentos)
 *   - escolhe o periodo (padrao 5 dias)
 *   - "Salvar como arquivo" -> XLS (Microsoft Excel) -> baixa
 * Um arquivo por empresa em extratos-bradesco/.
 *
 * Seguranca Topaz do Bradesco (equivalente ao Warsaw do Sicredi): usamos o
 * Chrome de verdade (channel:'chrome') com um PERFIL FIXO (perfil-bradesco),
 * para o dispositivo ficar confiavel entre execucoes.
 *
 * Rodar so algumas empresas (teste): passe parte do nome ou o CNPJ na linha de
 * comando. Ex.:  node scripts\extrato-bradesco.js adrimafe
 *                node scripts\extrato-bradesco.js 057.894.794/0001-00 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASTA = path.join(RAIZ, 'extratos-bradesco');
const PERFIL = path.join(RAIZ, 'perfil-bradesco');
const URL_BANCO = process.env.BRADESCO_URL
  || 'https://www.ne12.bradesconetempresa.b.br/ibpjlogin/login.jsf';
const PERIODO = process.env.BRADESCO_PERIODO || '5'; // 2, 5, 30, 60 ou 90 dias
const VERSAO = 'bradesco v3.6 (nao mexe na tela logo apos baixar; limpa no inicio da proxima)';
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const hoje = () => new Date().toLocaleDateString('sv-SE');
const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const limpo = (s) => String(s || 'empresa').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function carregarBanco() {
  if (process.env.BRADESCO_CONTA) return JSON.parse(process.env.BRADESCO_CONTA);
  const arq = path.join(RAIZ, 'banco-bradesco.json');
  if (fs.existsSync(arq)) return JSON.parse(fs.readFileSync(arq, 'utf8'));
  throw new Error('Crie o arquivo banco-bradesco.json com { "usuario": "...", "senha": "..." }.');
}

async function digitarReal(campo, valor) {
  await campo.waitFor({ state: 'visible', timeout: 20000 });
  await campo.click();
  await campo.fill('');
  await campo.pressSequentially(String(valor), { delay: 60 });
}

/* O Bradesco Net Empresa usa muitos frames/iframes: o conteudo (extrato,
   periodo, "Salvar como arquivo", lista de empresas) costuma estar DENTRO de um
   frame, nao na pagina principal. Por isso clicar/procurar varre TODOS os frames. */
const todosCtx = (page) => [page, ...page.frames()];

/* clica o primeiro alvo visivel que casa qualquer um dos textos/regex, em
   qualquer frame */
async function clicar(page, textos, { timeout = 15000, force = false } = {}) {
  const lista = Array.isArray(textos) ? textos : [textos];
  const ini = Date.now();
  while (Date.now() - ini < timeout) {
    for (const ctx of todosCtx(page)) {
      for (const t of lista) {
        const re = t instanceof RegExp ? t : new RegExp(`^\\s*${t}\\s*$`, 'i');
        const tentativas = [
          ctx.getByRole('button', { name: t }).first(),
          ctx.getByRole('link', { name: t }).first(),
          ctx.locator('button, a, [role=button], input[type=submit], input[type=button]')
            .filter({ hasText: re }).first(),
          ctx.getByText(re).first(),
        ];
        for (const alvo of tentativas) {
          try { if (await alvo.isVisible({ timeout: 200 })) { await alvo.click({ timeout: 5000, force }); return true; } }
          catch { /* segue */ }
        }
      }
    }
    await espera(400);
  }
  throw new Error(`Nao achei para clicar: ${lista.map(String).join(' / ')}`);
}

/* devolve o frame (ou page) onde um texto esta visivel, ou null */
async function frameComTexto(page, re, timeout = 1500) {
  for (const ctx of todosCtx(page)) {
    if (await ctx.getByText(re).first().isVisible({ timeout }).catch(() => false)) return ctx;
  }
  return null;
}

/* sinal de que ja entrou (pagina inicial logada) — procura em qualquer frame */
async function estaLogado(page) {
  for (const re of [/acessar outras empresas/i, /posi[çc][aã]o financeira/i, /saldos e extratos/i]) {
    if (await frameComTexto(page, re, 600)) return true;
  }
  return false;
}

/* Depois de uma queda, o Bradesco mostra "Sessao encerrada. Por motivo de
   seguranca, acesse novamente." — um aviso que trava o login. Dispensa (Cancelar
   acesso) e recarrega a tela de login, ate 3x. */
async function limparSessaoEncerrada(page) {
  for (let i = 0; i < 3; i++) {
    const tem = await page.getByText(/sess[aã]o encerrada|acesse novamente o bradesco|encerrado incorretamente/i)
      .first().isVisible({ timeout: 1500 }).catch(() => false);
    if (!tem) return;
    console.log('  (aviso "Sessao encerrada" — dispensando e recarregando o login...)');
    await clicar(page, [/cancelar acesso/i, /^\s*ok\s*$/i, /fechar/i], { timeout: 4000 }).catch(() => {});
    await espera(1500);
    await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await espera(3000);
  }
}

async function fazerLogin(page, b) {
  await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await espera(2500);
  await limparSessaoEncerrada(page);
  if (await estaLogado(page)) { console.log('Ja estava logado (sessao do perfil).'); return; }

  console.log('Login: usuario e senha');
  const user = page.locator('input[type=text]:not([type=hidden]):visible').first();
  await digitarReal(user, b.usuario);
  const pass = page.locator('input[type=password]:visible').first();
  await digitarReal(pass, b.senha);
  await clicar(page, [/avan[çc]ar/i, /entrar/i, /acessar/i], { timeout: 15000 });
  await espera(3500);

  console.log('\n===================================================================');
  console.log('>>> AGORA E COM VOCE: clique em "Nao sou um robo" na tela do Bradesco.');
  console.log('    (se aparecer quebra-cabeca de imagem, resolva.) O robo espera ate 4 min.');
  console.log('===================================================================\n');
  const ini = Date.now();
  while (Date.now() - ini < 240000) {
    if (await estaLogado(page)) { console.log('Entrou! Continuando...'); await espera(1500); return; }
    await espera(1500);
  }
  throw new Error('Nao detectei a pagina inicial apos o login. O "Nao sou um robo" foi resolvido?');
}

/* O Bradesco Net Empresa usa varios frames/iframes. Acha em QUAL frame (ou na
   propria page) estao as linhas de empresa (linhas de tabela com CNPJ). */
async function frameComEmpresas(page) {
  const conta = ctx => ctx.evaluate(() => {
    const re = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
    return Array.from(document.querySelectorAll('tr')).filter(tr => re.test(tr.textContent || '')).length;
  }).catch(() => 0);
  let best = page, bestN = await conta(page);
  for (const fr of page.frames()) { const n = await conta(fr); if (n > bestN) { bestN = n; best = fr; } }
  return { ctx: best, n: bestN };
}

/* diagnostico: despeja o que cada frame tem, para achar onde esta a lista */
async function dumpFrames(page) {
  try {
    const linhas = [];
    for (const fr of [page, ...page.frames()]) {
      const url = (fr.url && fr.url()) || '(page)';
      const info = await fr.evaluate(() => {
        const re = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
        const b = document.body ? document.body.innerText.replace(/\s+/g, ' ') : '';
        return {
          trs: document.querySelectorAll('tr').length,
          cnpjTrs: Array.from(document.querySelectorAll('tr')).filter(t => re.test(t.textContent || '')).length,
          temEmpresas: /acessar outras empresas|grupo de empresas/i.test(b),
          amostra: b.slice(0, 220),
        };
      }).catch(() => null);
      linhas.push(`FRAME: ${url}\n  ${info ? JSON.stringify(info) : '(sem acesso)'}`);
    }
    fs.writeFileSync(path.join(PASTA, 'bradesco_frames_debug.txt'), linhas.join('\n\n'), 'utf8');
    await page.screenshot({ path: path.join(PASTA, `bradesco_frames_${hoje()}.png`), fullPage: true }).catch(() => {});
    console.log('(despejei o diagnostico dos frames em extratos-bradesco\\bradesco_frames_debug.txt)');
  } catch { /* */ }
}

/* le a lista completa de empresas do modal "Acessar outras empresas".
   O Bradesco renderiza as linhas no DOM (a barra e so rolagem CSS), possivelmente
   dentro de um iframe — por isso procura em todos os frames. Retorna [{nome, cnpj}]. */
async function lerEmpresas(page) {
  await dispensarNuvem(page); // a nuvem pos-login some so com um clique
  await clicar(page, [/acessar outras empresas/i], { timeout: 15000 });
  await espera(3500);
  const { ctx, n } = await frameComEmpresas(page);
  if (!n) { await dumpFrames(page); return []; }
  const empresas = await ctx.evaluate(() => {
    const reCnpj = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
    const map = new Map();
    for (const tr of Array.from(document.querySelectorAll('tr'))) {
      const txt = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      if (!reCnpj.test(txt)) continue;
      const cnpj = (txt.match(reCnpj) || [''])[0];
      /* o nome e tudo que vem ANTES do CNPJ (evita o "0" do radio "Tornar padrao") */
      const nome = txt.slice(0, txt.indexOf(cnpj)).replace(/[?]/g, '').replace(/\s*\d+\s*$/, '').trim();
      if (cnpj && nome && !map.has(cnpj)) map.set(cnpj, nome);
    }
    return [...map.entries()].map(([cnpj, nome]) => ({ nome, cnpj }));
  });
  /* DEIXA a caixinha ABERTA de proposito: o "Fechar" fica dentro do frame e a
     troca de empresa e feita clicando na linha aqui mesmo. Fechar/reabrir so
     dava problema (a caixinha cobria o link "Acessar outras empresas"). */
  return empresas;
}

/* Dispensa a "nuvem" (overlay que o Bradesco poe na tela depois do login e a
   cada troca de empresa) — ela so some com um CLIQUE. Clicamos num TEXTO
   inofensivo (nao-link) e com force:true: se a nuvem estiver por cima, o clique
   cai nela e a dispensa; se nao houver nuvem, cai no texto, sem efeito. Assim
   nunca disparamos um link por engano. */
async function dispensarNuvem(page) {
  await page.keyboard.press('Escape').catch(() => {});
  for (const re of [/boa (tarde|noite|dia)/i, /n[ºo]?\.?\s*de acesso/i, /perfil:/i, /posi[çc][aã]o financeira/i]) {
    const ctx = await frameComTexto(page, re, 500);
    if (ctx) {
      await ctx.getByText(re).first().click({ timeout: 2500, force: true }).catch(() => {});
      break;
    }
  }
  await espera(1300);
}

/* troca para a empresa `emp` pelo modal "Acessar outras empresas" */
async function trocarEmpresa(page, emp) {
  /* Limpeza da tela ANTES de trocar (feita aqui, longe do momento do download):
     fecha a caixinha "Salvar como Arquivo" que ficou aberta e dispensa a nuvem.
     Esc + um clique num texto inofensivo, com pausas. */
  await espera(800);
  await page.keyboard.press('Escape').catch(() => {});
  await espera(600);
  await dispensarNuvem(page).catch(() => {});
  /* garante a caixinha de empresas aberta. Na 1a empresa ela ja vem aberta do
     lerEmpresas; nas seguintes, reabre. n>=2 linhas com CNPJ = caixinha aberta. */
  let alvo = await frameComEmpresas(page);
  if (alvo.n < 2) {
    await dispensarNuvem(page);
    await clicar(page, [/acessar outras empresas/i], { timeout: 15000 });
    await espera(3000);
    alvo = await frameComEmpresas(page);
  }
  const ctx = alvo.ctx;
  /* a linha e unica pelo CNPJ; clica o nome (1a celula) dela */
  const row = ctx.locator('tr').filter({ hasText: emp.cnpj }).first();
  await row.scrollIntoViewIfNeeded().catch(() => {});
  const link = row.locator('a').first();
  if (await link.count().catch(() => 0)) await link.click({ timeout: 8000 });
  else await row.locator('td').first().click({ timeout: 8000 });
  await espera(3500);
  await dispensarNuvem(page);
  /* confirma que trocou: o nome da empresa aparece na tela */
  await page.waitForFunction(
    n => document.body.innerText.toUpperCase().includes(n),
    emp.nome.toUpperCase().slice(0, 12), { timeout: 20000 }
  ).catch(() => {});
}

async function abrirExtrato(page) {
  /* Pode exigir 2 cliques: "Saldos e Extratos" abre um MENU, e o extrato de
     verdade e o link "Extrato (Ultimos Lancamentos)" (Conta-Corrente). Clica
     nele ate aparecerem os botoes de periodo (2/5/30/60/90 DIAS).
     ATENCAO ao acento: o link e "Extrato (Últimos Lançamentos)" — regex nao
     ignora acento, entao uso [^)]* no lugar de "ultimos". */
  const rePeriodo = new RegExp(`${PERIODO}\\s*dias`, 'i');
  const reExtrato = /extrato\s*\([^)]*lan[çc]amentos\)/i;
  for (let i = 0; i < 3; i++) {
    if (await frameComTexto(page, rePeriodo, 1500)) break; // ja no extrato (em algum frame)
    const clicou = await clicar(page, [reExtrato], { timeout: 6000 }).then(() => true).catch(() => false);
    if (!clicou) await clicar(page, [/saldos e extratos/i], { timeout: 8000 }).catch(() => {});
    await espera(3000);
  }
  /* periodo: 2 / 5 / 30 / 60 / 90 DIAS. A nuvem intercepta o clique, entao
     dispensa antes e clica com force, no frame certo. Tenta ate 2x. */
  const reExato = new RegExp(`^\\s*${PERIODO}\\s*dias\\s*$`, 'i');
  for (let i = 0; i < 2; i++) {
    await dispensarNuvem(page).catch(() => {});
    const ctx = await frameComTexto(page, reExato, 2500) || await frameComTexto(page, rePeriodo, 1500);
    if (ctx) await ctx.getByText(reExato).first().click({ force: true, timeout: 6000 }).catch(() => {});
    else await clicar(page, [reExato, rePeriodo], { timeout: 6000, force: true }).catch(() => {});
    await espera(2500);
  }
}

async function baixarXLS(page, emp) {
  const destino = path.join(PASTA, `extrato_bradesco_${limpo(emp.nome)}_${hoje()}.xls`);
  await dispensarNuvem(page).catch(() => {}); // nuvem tambem cobre o "Salvar"
  await clicar(page, [/salvar como arquivo/i], { timeout: 12000 });
  await espera(2000); // abre o modal de formatos
  /* so agora escuto o download (o arquivo vem ao clicar no XLS). O .catch evita
     que a promessa fique pendurada e derrube o processo se algo falhar antes. */
  const dlPromise = page.context().waitForEvent('download', { timeout: 60000 }).catch(() => null);
  /* clica exatamente o XLS (Microsoft Excel) — nao confundir com XMLS/XMLD */
  await clicar(page, [/XLS \(Microsoft Excel\)/i, /^\s*XLS\b(?!\s*\()/i], { timeout: 10000 });
  const download = await dlPromise;
  if (!download) throw new Error('o download nao veio depois de clicar no XLS');
  const ext = path.extname(download.suggestedFilename() || '') || '.xls';
  const dest = destino.replace(/\.xls$/i, ext);
  try { await download.saveAs(dest); }
  catch (e) {
    const tmp = await download.path().catch(() => null);
    if (tmp) fs.copyFileSync(tmp, dest); else throw e;
  }
  /* NAO mexe na tela logo apos o download — qualquer clique/tecla aqui parece
     irritar o Topaz e derrubar o navegador. So deixa o download assentar; a
     limpeza da tela (fechar a caixinha "Salvar") e feita no inicio da proxima
     empresa, ja com distancia do momento do download. */
  await espera(2000);
  return path.basename(dest);
}

/* Sai da conta (botao SAIR no topo). Importante: o Bradesco nao deixa duas
   sessoes abertas, entao sem deslogar a proxima execucao da erro de sessao
   presa. Best-effort — se nao achar o SAIR, so avisa. */
async function deslogar(page) {
  try {
    if (page.isClosed()) return;
    await dispensarNuvem(page).catch(() => {});
    await clicar(page, [/^\s*sair\s*$/i, /sair com seguran/i, /encerrar sess/i, /^\s*logout\s*$/i], { timeout: 8000 });
    await espera(2500);
    console.log('Desconectado da conta (SAIR).');
  } catch {
    console.log('(nao achei o SAIR para deslogar — se a proxima entrada reclamar de sessao, desconecte manual uma vez.)');
  }
}

async function main() {
  const b = carregarBanco();
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato Bradesco ${VERSAO} ===`);
  console.log(`Periodo: ${PERIODO} dias\n`);
  const t0 = Date.now();

  /* Fazer o Chrome do robo parecer o mais normal possivel para o Topaz, SEM os
     flags que disparam o banner amarelo "linha de comando nao suportada" (o
     banner denuncia a automacao):
     - chromiumSandbox:true evita o --no-sandbox;
     - ignoreDefaultArgs remove o --enable-automation;
     - NAO uso --disable-blink-features (dispara o banner); em vez disso, escondo
       o navigator.webdriver por script (mesmo efeito, sem banner);
     - sem --disable-http2 (era so um remendo do Sicredi). */
  /* Opcao "usar o MEU Chrome": em vez do perfil separado do robo, usa o SEU
     perfil normal do Chrome — que ja tem a extensao de seguranca do Bradesco e o
     dispositivo confiavel. Ligue no banco-bradesco.json com "usarMeuChrome": true
     (e, se seu perfil nao for o "Default", "chromeProfile": "Profile 1"). Tem que
     FECHAR o Chrome normal antes de rodar (todas as janelas), senao da conflito. */
  const argv = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
  const setup = argv.some(a => /^setup$/i.test(a));
  /* usarMeuChrome exige fechar o Chrome normal — nao serve pro dia a dia; o
     caminho e o MODO SETUP (abaixo), que instala a extensao no perfil do robo. */
  const usarMeuChrome = !setup && (!!b.usarMeuChrome || process.env.BRADESCO_MEU_CHROME === '1');
  const extraArgs = [];
  let userDataDir = PERFIL;
  if (usarMeuChrome) {
    userDataDir = b.chromeUserData
      || path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
    extraArgs.push(`--profile-directory=${b.chromeProfile || 'Default'}`);
    console.log(`Usando o SEU perfil do Chrome: ${userDataDir} (perfil "${b.chromeProfile || 'Default'}")`);
    console.log('>>> FECHE o Chrome normal (todas as janelas) antes, senao vai dar conflito de perfil.\n');
  }
  const args = ['--start-maximized', ...extraArgs];
  const opts = {
    headless: false, slowMo: 120, acceptDownloads: true, viewport: null, args,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  /* abre o navegador (perfil fixo do robo, com a extensao de seguranca ja
     instalada no setup). Reutilizavel para REABRIR se o download derrubar o
     navegador no meio. */
  const abrir = async () => {
    let c;
    try { c = await chromium.launchPersistentContext(userDataDir, { channel: 'chrome', ...opts }); }
    catch (e) {
      if (usarMeuChrome) throw new Error('Nao consegui abrir o seu perfil do Chrome. FECHE o Chrome normal '
        + '(todas as janelas e o icone da bandeja) e rode de novo. Detalhe: ' + e.message.split('\n')[0]);
      console.log('(Chrome nao encontrado — usando o navegador embutido)'); c = await chromium.launchPersistentContext(userDataDir, opts);
    }
    /* esconde a automacao por dentro (sem flag, sem banner) */
    await c.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch { /* */ }
    });
    const p = c.pages()[0] || await c.newPage();
    return { c, p };
  };
  const morreu = (e) => /closed|crash|Target|Session closed|context or browser|has been closed/i.test(String((e && e.message) || e));
  let ctx, page;
  ({ c: ctx, p: page } = await abrir());
  /* reabre o navegador e re-loga. Como a sessao fica salva no perfil, o
     fazerLogin costuma so detectar que ja esta logado e seguir (sem reCAPTCHA). */
  const reabrir = async () => {
    try { await ctx.close(); } catch { /* */ }
    ({ c: ctx, p: page } = await abrir());
    await fazerLogin(page, b);
  };
  const ok = [], falhou = [];

  /* MODO SETUP: abre a janela do robo na tela do Bradesco e espera VOCE fazer,
     manualmente, uma unica vez: instalar a extensao de seguranca e logar. Isso
     salva a extensao + dispositivo confiavel no perfil do robo. Seu Chrome normal
     pode ficar aberto do lado — sao janelas/perfis diferentes, sem conflito.
     Depois disso, rode SEM "setup" e ele baixa sozinho. */
  if (setup) {
    console.log('=== MODO CONFIGURACAO (uma vez so) ===');
    console.log('Abri a janela do ROBO na tela do Bradesco. Seu Chrome normal pode ficar aberto.');
    console.log('NESTA janela do robo, faca:');
    console.log('  1) Se pedir o componente/extensao de seguranca, instale (Baixar componente e siga,');
    console.log('     ou adicione a extensao do Bradesco se abrir a loja do Chrome).');
    console.log('  2) Faca login (usuario, senha, "nao sou um robo").');
    console.log('  3) Quando ENTRAR na conta (aparecer a Pagina Inicial), FECHE esta janela do robo.');
    console.log('Aguardando voce terminar (ate 30 min)...\n');
    await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForEvent('close', { timeout: 30 * 60 * 1000 }).catch(() => {});
    console.log('\nConfiguracao encerrada. Agora rode:  node scripts\\extrato-bradesco.js adrimafe');
    try { await ctx.close(); } catch { /* */ }
    return;
  }

  try {
    await fazerLogin(page, b);
    await dispensarNuvem(page); // logo apos entrar o Bradesco poe a "nuvem"

    let empresas = await lerEmpresas(page);
    if (!empresas.length) {
      await page.screenshot({ path: path.join(PASTA, `bradesco_sem_empresas_${hoje()}.png`), fullPage: true }).catch(() => {});
      throw new Error('Nao li nenhuma empresa no "Acessar outras empresas". Salvei um print.');
    }
    console.log(`Empresas encontradas (${empresas.length}):`);
    empresas.forEach(e => console.log(`  - ${e.nome} (${e.cnpj})`));

    /* filtro opcional pela linha de comando (parte do nome ou CNPJ); ignora "setup" */
    const filtros = argv.map(s => s.toLowerCase()).filter(s => s && s !== 'setup');
    if (filtros.length) {
      const dig = s => String(s).replace(/\D/g, '');
      empresas = empresas.filter(e => filtros.some(f =>
        e.nome.toLowerCase().includes(f) || (dig(f) && dig(e.cnpj).includes(dig(f)))));
      console.log(`\nFiltrando para ${empresas.length}: ${empresas.map(e => e.nome).join(', ') || '(nenhuma casou)'}`);
    }

    /* empresas a PULAR (lista "pular" no banco-bradesco.json: nomes ou CNPJs) */
    const pular = (Array.isArray(b.pular) ? b.pular : []).map(s => String(s).toLowerCase());
    if (pular.length) {
      const dig = s => String(s).replace(/\D/g, '');
      const antes = empresas.length;
      empresas = empresas.filter(e => !pular.some(p =>
        e.nome.toLowerCase().includes(p) || (dig(p) && dig(e.cnpj).includes(dig(p)))));
      if (empresas.length < antes) console.log(`Pulando ${antes - empresas.length} empresa(s) da lista "pular": ${pular.join(', ')}`);
    }
    console.log('');

    /* Reabrir o navegador exige re-logar, e re-logar demais pode BLOQUEAR o
       acesso. Por isso limitamos a reabertura no run inteiro; passou do limite,
       paramos e avisamos o que faltou (voce roda o resto depois). */
    const MAX_REABERTURAS = 2;
    let reaberturas = 0, pararTudo = false;
    for (const emp of empresas) {
      if (pararTudo) { falhou.push(emp.nome); continue; }
      const tc = Date.now();
      let feito = false;
      for (let tent = 1; tent <= 2 && !feito; tent++) {
        try {
          if (page.isClosed()) page = await ctx.newPage();
          console.log(`Empresa ${emp.nome} — trocando...${tent > 1 ? ' (de novo)' : ''}`);
          await trocarEmpresa(page, emp);
          await abrirExtrato(page);
          const nome = await baixarXLS(page, emp);
          console.log(`  ok: ${nome} (${dur(Date.now() - tc)})`);
          ok.push(emp.nome); feito = true;
        } catch (e) {
          const msg = e.message.split('\n')[0];
          if (morreu(e)) {
            if (reaberturas >= MAX_REABERTURAS) {
              console.error(`  o navegador caiu de novo e ja reabri ${reaberturas}x — PARANDO aqui para nao arriscar bloquear seu acesso.`);
              falhou.push(emp.nome); feito = true; pararTudo = true; continue;
            }
            reaberturas++;
            console.log(`  ${emp.nome}: o navegador caiu — reabrindo (${reaberturas}/${MAX_REABERTURAS})...`);
            try { await reabrir(); feito = (tent >= 2); if (tent >= 2) falhou.push(emp.nome); }
            catch (e2) { console.error(`  nao consegui reabrir: ${e2.message.split('\n')[0]}`); falhou.push(emp.nome); feito = true; pararTudo = true; }
            continue;
          }
          /* falha "normal" (nao foi queda): marca e segue, limpando a tela */
          console.error(`  FALHOU ${emp.nome}: ${msg}`);
          try { await page.screenshot({ path: path.join(PASTA, `erro_${limpo(emp.nome)}_${hoje()}.png`), fullPage: true }); } catch { /* */ }
          falhou.push(emp.nome); feito = true;
          await dispensarNuvem(page).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('\nParou:', e.message, '\n');
  } finally {
    await deslogar(page); // SAIR sempre, pra nao deixar a sessao presa
    console.log('\n=== Resumo ===');
    console.log(`Baixadas: ${ok.length}${ok.length ? ' (' + ok.join(', ') + ')' : ''}`);
    if (falhou.length) console.log(`Falharam: ${falhou.length} (${falhou.join(', ')}) — veja os prints erro_*.png em extratos-bradesco\\`);
    const seg = ok.length ? ` (~${dur((Date.now() - t0) / Math.max(ok.length, 1))} por empresa)` : '';
    console.log(`Tempo total: ${dur(Date.now() - t0)}${seg}\n`);
    try { await ctx.close(); } catch { /* */ }
  }
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
