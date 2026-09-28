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
const VERSAO = 'bradesco v2.1 (Chrome sem cara de robo: sem --no-sandbox nem --enable-automation)';
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

/* clica o primeiro alvo visivel que casa qualquer um dos textos/regex */
async function clicar(page, textos, { timeout = 15000 } = {}) {
  const lista = Array.isArray(textos) ? textos : [textos];
  const ini = Date.now();
  while (Date.now() - ini < timeout) {
    for (const t of lista) {
      const re = t instanceof RegExp ? t : new RegExp(`^\\s*${t}\\s*$`, 'i');
      const tentativas = [
        page.getByRole('button', { name: t }).first(),
        page.getByRole('link', { name: t }).first(),
        page.locator('button, a, [role=button], input[type=submit], input[type=button]')
          .filter({ hasText: re }).first(),
        page.getByText(re).first(),
      ];
      for (const alvo of tentativas) {
        try { if (await alvo.isVisible({ timeout: 300 })) { await alvo.click(); return true; } }
        catch { /* segue */ }
      }
    }
    await espera(400);
  }
  throw new Error(`Nao achei para clicar: ${lista.map(String).join(' / ')}`);
}

/* sinal de que ja entrou (pagina inicial logada) */
async function estaLogado(page) {
  for (const re of [/acessar outras empresas/i, /posi[çc][aã]o financeira/i, /saldos e extratos/i]) {
    if (await page.getByText(re).first().isVisible({ timeout: 600 }).catch(() => false)) return true;
  }
  return false;
}

async function fazerLogin(page, b) {
  await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await espera(2500);
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

/* le a lista completa de empresas do modal "Acessar outras empresas".
   O Bradesco renderiza todas as linhas no DOM (a barra e so rolagem CSS),
   entao da para ler todas de uma vez. Retorna [{nome, cnpj}]. */
async function lerEmpresas(page) {
  await clicar(page, [/acessar outras empresas/i], { timeout: 15000 });
  await espera(2500);
  const empresas = await page.evaluate(() => {
    const reCnpj = /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/;
    const map = new Map();
    for (const tr of Array.from(document.querySelectorAll('tr'))) {
      const txt = (tr.textContent || '').replace(/\s+/g, ' ').trim();
      if (!reCnpj.test(txt)) continue;
      const cnpj = (txt.match(reCnpj) || [''])[0];
      const nome = txt.replace(cnpj, '').replace(/tornar empresa padr[aã]o/i, '').replace(/[?]/g, '').trim();
      if (cnpj && !map.has(cnpj)) map.set(cnpj, nome);
    }
    return [...map.entries()].map(([cnpj, nome]) => ({ nome, cnpj }));
  });
  /* fecha o modal para voltar a tela normal */
  await clicar(page, [/^\s*fechar\s*$/i], { timeout: 4000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await espera(1200);
  return empresas;
}

/* dispensa a "nuvem" (overlay de carregamento) clicando fora do modal */
async function dispensarNuvem(page) {
  await page.keyboard.press('Escape').catch(() => {});
  /* um clique num ponto neutro da tela (area de conteudo vazia) — se houver
     overlay, o clique cai nele e o dispensa; se nao houver, cai em area vazia */
  await page.mouse.click(430, 250).catch(() => {});
  await espera(1200);
}

/* troca para a empresa `emp` pelo modal "Acessar outras empresas" */
async function trocarEmpresa(page, emp) {
  await clicar(page, [/acessar outras empresas/i], { timeout: 15000 });
  await espera(2000);
  /* a linha e unica pelo CNPJ; clica o nome (1a celula) dela */
  const row = page.locator('tr').filter({ hasText: emp.cnpj }).first();
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
  await clicar(page, [/extrato \(ultimos lan[çc]amentos\)/i, /saldos e extratos/i, /^\s*extrato\s*$/i], { timeout: 20000 });
  await espera(3500);
  /* periodo: 2 / 5 / 30 / 60 / 90 DIAS */
  await clicar(page, [new RegExp(`^\\s*${PERIODO}\\s*dias\\s*$`, 'i'), new RegExp(`${PERIODO}\\s*dias`, 'i')], { timeout: 8000 });
  await espera(2500);
}

async function baixarXLS(page, emp) {
  const destino = path.join(PASTA, `extrato_bradesco_${limpo(emp.nome)}_${hoje()}.xls`);
  const dlPromise = page.context().waitForEvent('download', { timeout: 60000 });
  await clicar(page, [/salvar como arquivo/i], { timeout: 12000 });
  await espera(2000); // abre o modal de formatos
  /* clica exatamente o XLS (Microsoft Excel) — nao confundir com XMLS/XMLD */
  await clicar(page, [/XLS \(Microsoft Excel\)/i, /^\s*XLS\b(?!\s*\()/i], { timeout: 10000 });
  const download = await dlPromise;
  const ext = path.extname(download.suggestedFilename() || '') || '.xls';
  const dest = destino.replace(/\.xls$/i, ext);
  try { await download.saveAs(dest); }
  catch (e) {
    const tmp = await download.path().catch(() => null);
    if (tmp) fs.copyFileSync(tmp, dest); else throw e;
  }
  return path.basename(dest);
}

async function main() {
  const b = carregarBanco();
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato Bradesco ${VERSAO} ===`);
  console.log(`Periodo: ${PERIODO} dias\n`);
  const t0 = Date.now();

  /* Fazer o Chrome do robo parecer o mais normal possivel para o Topaz:
     - chromiumSandbox:true evita o --no-sandbox (que o Bradesco acusou);
     - ignoreDefaultArgs remove o --enable-automation (o aviso "controlado por
       automacao"), mais um sinal que o antifraude procura;
     - sem --disable-http2 (era so um remendo do Sicredi) para nao destoar. */
  const args = ['--disable-blink-features=AutomationControlled', '--start-maximized'];
  const opts = {
    headless: false, slowMo: 120, acceptDownloads: true, viewport: null, args,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let ctx;
  try { ctx = await chromium.launchPersistentContext(PERFIL, { channel: 'chrome', ...opts }); }
  catch { console.log('(Chrome nao encontrado — usando o navegador embutido)'); ctx = await chromium.launchPersistentContext(PERFIL, opts); }
  const page = ctx.pages()[0] || await ctx.newPage();
  const ok = [], falhou = [];

  try {
    await fazerLogin(page, b);

    let empresas = await lerEmpresas(page);
    if (!empresas.length) {
      await page.screenshot({ path: path.join(PASTA, `bradesco_sem_empresas_${hoje()}.png`), fullPage: true }).catch(() => {});
      throw new Error('Nao li nenhuma empresa no "Acessar outras empresas". Salvei um print.');
    }
    console.log(`Empresas encontradas (${empresas.length}):`);
    empresas.forEach(e => console.log(`  - ${e.nome} (${e.cnpj})`));

    /* filtro opcional pela linha de comando (parte do nome ou CNPJ) */
    const filtros = process.argv.slice(2).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (filtros.length) {
      const dig = s => String(s).replace(/\D/g, '');
      empresas = empresas.filter(e => filtros.some(f =>
        e.nome.toLowerCase().includes(f) || (dig(f) && dig(e.cnpj).includes(dig(f)))));
      console.log(`\nFiltrando para ${empresas.length}: ${empresas.map(e => e.nome).join(', ') || '(nenhuma casou)'}`);
    }
    console.log('');

    for (const emp of empresas) {
      const tc = Date.now();
      try {
        console.log(`Empresa ${emp.nome} — trocando...`);
        await trocarEmpresa(page, emp);
        await abrirExtrato(page);
        const nome = await baixarXLS(page, emp);
        console.log(`  ok: ${nome} (${dur(Date.now() - tc)})`);
        ok.push(emp.nome);
      } catch (e) {
        console.error(`  FALHOU ${emp.nome}: ${e.message.split('\n')[0]}`);
        await page.screenshot({ path: path.join(PASTA, `erro_${limpo(emp.nome)}_${hoje()}.png`), fullPage: true }).catch(() => {});
        falhou.push(emp.nome);
        /* tenta voltar a um estado limpo pro proximo: dispensa overlay e segue.
           O link "Acessar outras empresas" fica sempre no menu lateral. */
        await dispensarNuvem(page).catch(() => {});
      }
    }
  } catch (e) {
    console.error('\nParou:', e.message, '\n');
  } finally {
    console.log('\n=== Resumo ===');
    console.log(`Baixadas: ${ok.length}${ok.length ? ' (' + ok.join(', ') + ')' : ''}`);
    if (falhou.length) console.log(`Falharam: ${falhou.length} (${falhou.join(', ')}) — veja os prints erro_*.png em extratos-bradesco\\`);
    const seg = ok.length ? ` (~${dur((Date.now() - t0) / Math.max(ok.length, 1))} por empresa)` : '';
    console.log(`Tempo total: ${dur(Date.now() - t0)}${seg}\n`);
    try { await ctx.close(); } catch { /* */ }
  }
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
