/* Robo do EXTRATO bancario — Sicredi Internet Banking PJ.
 *
 * SO CONSULTA: entra com CNPJ + usuario + senha (teclado da tela), abre o
 * Extrato e baixa a Planilha (Excel) de CADA conta do acesso — todas as contas
 * ficam dentro do mesmo login, num seletor de contas. Guarda em extratos/, um
 * arquivo por conta. O formato e o mesmo que o painel de conciliacao ja le.
 *
 * Login em dois passos, sem CAPTCHA/2FA:
 *   1) CNPJ  -> Acessar
 *   2) usuario + senha pelo teclado embaralhado -> Acessar
 *
 * A senha e digitada CLICANDO nos botoes do teclado da tela. Cada botao tem
 * dois numeros ("4 ou 1"); para cada digito da senha, acha o botao que o
 * contem e clica. A posicao muda a cada login, entao rele a cada digito.
 *
 * Roda so no PC, com o navegador visivel (headless=false), devagar.
 *
 * Periodo: padrao "Ultimos 7 dias". Da para trocar em banco.json
 *   ("periodo": "Ultimos 30 dias") ou pela variavel BANCO_PERIODO. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASTA = path.join(RAIZ, 'extratos');
const PERFIL = path.join(RAIZ, 'perfil-chrome'); // perfil fixo do navegador (fica so no PC)
const URL_BANCO = process.env.BANCO_URL
  || 'https://ibpj.sicredi.com.br/ib-view/loginpj/preauth.html';
const VERSAO = 'extrato v6 (Chrome fixo, passa o Dispositivo de Seguranca)';
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const hoje = () => new Date().toLocaleDateString('sv-SE');

const limpo = (s) => String(s || 'conta').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/* uma string parece "conta" quando tem o desenho de agencia/conta:
   3-5 digitos, separador opcional, mais digitos e um digito verificador */
const PAR_CONTA = /\d{2,5}\s*[.\/-]?\s*\d{3,}-?\s*\d/;

function carregarBanco() {
  if (process.env.BANCO_CONTA) return JSON.parse(process.env.BANCO_CONTA);
  const arq = path.join(RAIZ, 'banco.json');
  if (fs.existsSync(arq)) return JSON.parse(fs.readFileSync(arq, 'utf8'));
  throw new Error('Crie o arquivo banco.json com { "cnpj": "...", "login": "...", "senha": "..." }.');
}

async function digitarReal(campo, valor) {
  await campo.waitFor({ state: 'visible', timeout: 15000 });
  await campo.click();
  await campo.fill('');
  await campo.pressSequentially(valor, { delay: 60 });
}

/* primeiro campo de texto VISIVEL — a tela tem inputs escondidos (ex.:
   <input type=hidden id=infoValue>) que vinham na frente e travavam o login */
function campoTexto(page) {
  return page.locator('input:not([type=password]):not([type=hidden]):visible').first();
}

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

/* senha pelo teclado embaralhado do Sicredi: cada tecla cobre DOIS numeros
   ("1 ou 3", "9 ou 0", ...). Para cada digito da senha, clica a tecla que o
   contem. Busca pelo TEXTO (qualquer tag — as teclas sao <div>/<a>, nao
   <button>), casando so a tecla cujo texto inteiro e "X ou Y". */
async function senhaPeloTeclado(page, senha) {
  for (const d of senha) {
    const re = new RegExp(`^\\s*(\\d\\s*ou\\s*${d}|${d}\\s*ou\\s*\\d)\\s*$`, 'i');
    const tecla = page.getByText(re).first();
    await tecla.click({ timeout: 8000 });
    await espera(400);
  }
}

const naOferta = (page) => /oferta|warsaw|diagnostico/i.test(page.url());

/* login com retentativa: o Sicredi as vezes intercala a tela do "Dispositivo
   de Seguranca" (ofertaWarsaw.html) antes/depois do login. Nao instalamos nada
   — voltamos para a tela de acesso e tentamos de novo. Com o perfil fixo do
   Chrome, a confianca do dispositivo tende a ficar salva e a passar. */
async function fazerLogin(page, b) {
  for (let t = 1; t <= 4; t++) {
    await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await espera(2500);
    console.log(`Login (tentativa ${t}) 1/2: CNPJ`);
    await digitarReal(campoTexto(page), b.cnpj);
    await clicar(page, [/acessar/i], { timeout: 12000 });
    await espera(4000);
    if (naOferta(page)) {
      console.log('  -> caiu na tela do Dispositivo de Seguranca. Nao instalo nada; tento de novo.');
      await espera(2000);
      continue;
    }
    console.log('Login 2/2: usuario e senha (teclado da tela)');
    await digitarReal(campoTexto(page), b.login);
    await espera(600);
    await senhaPeloTeclado(page, b.senha);
    await espera(500);
    await clicar(page, [/acessar/i], { timeout: 12000 });
    await espera(6000);
    if (naOferta(page)) {
      console.log('  -> Dispositivo de Seguranca depois da senha. Tento de novo.');
      await espera(2000);
      continue;
    }
    return true; // entrou
  }
  throw new Error('O Sicredi ficou preso na tela do "Dispositivo de Seguranca" '
    + '(ofertaWarsaw.html) e nao deixou passar para a conta. Esse e o anti-fraude '
    + 'do banco. Tente: (1) rodar de novo — as vezes passa na 2a; (2) abrir o site '
    + 'do banco no seu Chrome normal UMA vez, logar e deixar o dispositivo instalado, '
    + 'depois fechar o Chrome e rodar o robo (ele usa o mesmo Chrome).');
}

async function abrirExtrato(page) {
  await clicar(page, [/^extrato$/i, /extrato/i], { timeout: 20000 });
  await espera(3000);
}

async function ajustarPeriodo(page, periodo) {
  try {
    const sel = page.locator('select')
      .filter({ has: page.locator('option', { hasText: new RegExp(periodo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }) })
      .first();
    await sel.selectOption({ label: periodo });
    await espera(600);
  } catch { /* ja deve estar no periodo certo */ }
}

/* Descobre o seletor de contas. Primeiro procura um <select> cujas opcoes tem
   cara de conta; se nao houver, tenta um menu/dropdown com itens de conta.
   Retorna { tipo, contas:[{label, value, idx}] } ou null. */
async function descobrirContas(page) {
  const selects = page.locator('select');
  const ns = await selects.count();
  for (let i = 0; i < ns; i++) {
    const s = selects.nth(i);
    const opts = s.locator('option');
    const m = await opts.count();
    const contas = [];
    for (let j = 0; j < m; j++) {
      const o = opts.nth(j);
      const label = ((await o.textContent()) || '').trim();
      const value = await o.getAttribute('value');
      if (PAR_CONTA.test(label) || /conta\s*\d/i.test(label)) contas.push({ label, value, idx: j });
    }
    if (contas.length >= 1) return { tipo: 'select', seletor: s, contas };
  }
  /* fallback: um botao/dropdown que mostra a conta atual e abre uma lista */
  try {
    const gatilho = page.locator('button, [role=button], [role=combobox], .conta, [class*=conta]')
      .filter({ hasText: PAR_CONTA }).first();
    if (await gatilho.isVisible({ timeout: 1500 })) {
      await gatilho.click();
      await espera(800);
      const itens = page.locator('[role=option], li, a, button').filter({ hasText: PAR_CONTA });
      const m = await itens.count();
      const contas = [];
      for (let j = 0; j < m; j++) {
        const label = ((await itens.nth(j).textContent()) || '').trim();
        if (PAR_CONTA.test(label)) contas.push({ label, idx: j });
      }
      /* fecha o dropdown de novo (Esc) para nao atrapalhar */
      await page.keyboard.press('Escape').catch(() => {});
      if (contas.length) return { tipo: 'menu', gatilho, contas };
    }
  } catch { /* sem menu */ }
  return null;
}

async function selecionarConta(page, sw, conta) {
  if (sw.tipo === 'select') {
    if (conta.value != null && conta.value !== '') await sw.seletor.selectOption({ value: conta.value });
    else await sw.seletor.selectOption({ label: conta.label });
  } else {
    await sw.gatilho.click();
    await espera(700);
    await page.locator('[role=option], li, a, button')
      .filter({ hasText: conta.label.slice(0, 20) }).first().click({ timeout: 8000 });
  }
  await espera(2500);
}

async function baixarPlanilha(page, conta) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    clicar(page, [/gerar planilha/i, /planilha/i, /exportar/i], { timeout: 15000 }),
  ]);
  const sugerido = download.suggestedFilename() || 'extrato.xls';
  const ext = path.extname(sugerido) || '.xls';
  const destino = path.join(PASTA, `extrato_${limpo(conta.label)}_${hoje()}${ext}`);
  await download.saveAs(destino);
  return path.basename(destino);
}

async function main() {
  const b = carregarBanco();
  const periodo = process.env.BANCO_PERIODO || b.periodo || 'Últimos 7 dias';
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato ${VERSAO} ===`);
  console.log(`Periodo: ${periodo}\n`);

  /* Perfil FIXO do Chrome instalado (channel:'chrome'): o Dispositivo de
     Seguranca do Sicredi reconhece melhor o Chrome de verdade, e a "confianca"
     do dispositivo fica salva no perfil entre execucoes, reduzindo a tela do
     ofertaWarsaw. --disable-http2 evita o ERR_HTTP2_PROTOCOL_ERROR no login. */
  const args = ['--disable-http2', '--disable-blink-features=AutomationControlled'];
  const opts = { headless: false, slowMo: 120, acceptDownloads: true, viewport: null, args };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PERFIL, { channel: 'chrome', ...opts });
  } catch (e) {
    console.log('(Chrome nao encontrado — usando o navegador embutido)');
    ctx = await chromium.launchPersistentContext(PERFIL, opts);
  }
  const page = ctx.pages()[0] || await ctx.newPage();
  const ok = [], falhou = [];
  try {
    await fazerLogin(page, b);
    await abrirExtrato(page);

    const sw = await descobrirContas(page);
    if (!sw || !sw.contas.length) {
      await page.screenshot({ path: path.join(PASTA, `contas_nao_achei_${hoje()}.png`), fullPage: true });
      throw new Error('Nao achei o seletor de contas. Salvei um print em '
        + 'extratos\\contas_nao_achei_...png — me mande esse print para eu acertar o seletor.');
    }
    console.log(`Contas encontradas (${sw.contas.length}):`);
    sw.contas.forEach(c => console.log(`  - ${c.label}`));
    console.log('');

    for (const conta of sw.contas) {
      try {
        console.log(`Conta ${conta.label} — selecionando...`);
        await selecionarConta(page, sw, conta);
        /* algumas telas exigem reabrir o Extrato/refazer a pesquisa apos trocar */
        await ajustarPeriodo(page, periodo);
        await clicar(page, [/pesquisar/i], { timeout: 12000 });
        await espera(3500);
        const nome = await baixarPlanilha(page, conta);
        console.log(`  ok: ${nome}`);
        ok.push(conta.label);
      } catch (e) {
        console.error(`  FALHOU ${conta.label}: ${e.message}`);
        try { await page.screenshot({ path: path.join(PASTA, `erro_${limpo(conta.label)}_${hoje()}.png`), fullPage: true }); } catch { /* */ }
        falhou.push(conta.label);
        /* tenta reabrir o extrato para a proxima conta nao herdar o estado ruim */
        try { await abrirExtrato(page); } catch { /* */ }
      }
    }
    await ctx.close();
  } catch (e) {
    try {
      await page.screenshot({ path: path.join(PASTA, `erro_${hoje()}.png`), fullPage: true });
      console.log('(salvei um print do erro em extratos\\erro_...png)');
    } catch { /* sem print */ }
    await ctx.close();
    console.error('\nParou:', e.message, '\n');
  }

  console.log('\n=== Resumo ===');
  console.log(`Baixadas: ${ok.length}${ok.length ? ' (' + ok.join(', ') + ')' : ''}`);
  if (falhou.length) console.log(`Falharam: ${falhou.length} (${falhou.join(', ')}) — veja os prints erro_*.png em extratos\\`);
  console.log('');
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
