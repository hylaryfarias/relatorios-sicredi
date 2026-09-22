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
const VERSAO = 'extrato v18 (seleciona pela URL selconta, sem digitar em campo)';
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const hoje = () => new Date().toLocaleDateString('sv-SE');
/* duracao amigavel: "42s" ou "3m 07s" */
const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

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

/* ---------- lista COMPLETA de contas (janela "Pesquisar Contas") ----------
   O seletor do topo mostra so as 5 favoritas + "Ver Mais". O "Ver Mais" abre a
   janela "Pesquisar Contas", com TODAS as contas em paginas. Aqui a gente abre
   essa janela, le a tabela inteira e depois seleciona cada conta clicando na
   Razao social. */
async function abrirPesquisarContas(page) {
  const jaAberto = async () => {
    /* sinal CONFIAVEL: os links de conta "selconta" so existem na janela
       "Pesquisar Contas". (Antes eu contava linhas com cara de conta, mas as
       linhas de lancamento do proprio Extrato davam falso positivo.) */
    const nSel = await page.locator('a[onclick*="selconta"]').count().catch(() => 0);
    if (nSel > 0) return true;
    return await page.getByText(/pesquisar contas/i).first().isVisible({ timeout: 600 }).catch(() => false);
  };
  if (await jaAberto()) return true;

  /* O "Ver Mais" e um <option onclick="urlVerMais();"> dentro do <select
     id=opcoesCombo>. onclick em <option> nao dispara de forma confiavel, entao
     chamamos a funcao do proprio site direto. Logo apos o login a funcao pode
     ainda nao existir, entao insiste: espera a funcao aparecer, chama, e da
     tempo da janela "Pesquisar Contas" carregar. */
  for (let i = 0; i < 6; i++) {
    if (await jaAberto()) return true;
    /* chamar urlVerMais() pode navegar a pagina e "quebrar" o evaluate — por
       isso NAO confio no retorno; sempre reconfiro com jaAberto() depois. */
    await page.evaluate(() => { if (typeof urlVerMais === 'function') urlVerMais(); }).catch(() => {});
    for (let w = 0; w < 6; w++) { await espera(1000); if (await jaAberto()) return true; }
  }

  const clicarVerMais = async () => {
    const l = page.getByText(/^\s*ver mais\s*$/i).first();
    if (await l.isVisible({ timeout: 1200 }).catch(() => false)) { await l.click(); await espera(1500); return await jaAberto(); }
    return false;
  };

  /* A) "Ver Mais" pode ser uma OPCAO de um <select> nativo — seleciona ela */
  const selects = page.locator('select');
  const ns = await selects.count();
  for (let i = 0; i < ns; i++) {
    const s = selects.nth(i);
    const opts = s.locator('option');
    const m = await opts.count();
    for (let j = 0; j < m; j++) {
      const t = ((await opts.nth(j).textContent().catch(() => '')) || '').trim();
      if (/ver mais/i.test(t)) {
        const val = await opts.nth(j).getAttribute('value');
        try { await s.selectOption(val != null && val !== '' ? { value: val } : { label: t }); } catch { /* */ }
        await espera(1500);
        if (await jaAberto()) return true;
      }
    }
  }

  /* B) seletor custom: clica o GATILHO visivel (a caixa com a conta atual) e
        depois o "Ver Mais" que aparece na lista aberta */
  const gatilhos = [
    page.getByRole('combobox').first(),
    page.getByText(PAR_CONTA).first(),
    page.locator('[class*=conta i], [class*=account i], [role=button]').filter({ hasText: PAR_CONTA }).first(),
    page.locator('select').first(),
  ];
  for (const g of gatilhos) {
    try { await g.click({ timeout: 1500 }); await espera(700); if (await clicarVerMais()) return true; } catch { /* proximo */ }
  }
  if (await clicarVerMais()) return true;
  return false;
}

/* despeja num txt como sao o seletor de contas e o "Ver Mais" no HTML, para
   ajustar o clique quando a abertura automatica falha */
async function dumpSeletor(page) {
  try {
    const info = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('select').forEach((s, i) => {
        out.push(`SELECT#${i}: ` + s.outerHTML.replace(/\s+/g, ' ').slice(0, 600));
      });
      const todos = Array.from(document.querySelectorAll('*'));
      todos.forEach(el => {
        if (el.children.length === 0 && /ver\s*mais/i.test(el.textContent || '')) {
          out.push(`VERMAIS: <${el.tagName.toLowerCase()} class="${el.className}" role="${el.getAttribute('role') || ''}" href="${el.getAttribute('href') || ''}"> ${(el.textContent || '').trim().slice(0, 40)}`);
        }
      });
      todos.forEach(el => {
        const t = (el.textContent || '').trim();
        if (el.children.length <= 2 && /\d{4,6}-\d/.test(t) && t.length < 70) {
          out.push(`CONTA-EL: <${el.tagName.toLowerCase()} class="${el.className}" role="${el.getAttribute('role') || ''}"> ${t.slice(0, 60)}`);
        }
      });
      return out.join('\n');
    });
    fs.writeFileSync(path.join(PASTA, 'ver_mais_debug.txt'), info || '(vazio)', 'utf8');
  } catch (e) { /* sem debug */ }
}

/* grava a estrutura da janela "Pesquisar Contas" (campos de busca, botoes,
   paginador) para ajustar os seletores se a selecao falhar */
async function dumpModal(page) {
  try {
    const info = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('input').forEach((el, i) => {
        if (el.offsetParent === null) return;
        out.push(`INPUT#${i}: type=${el.type} id=${el.id} name=${el.name} placeholder="${el.placeholder}" aria-label="${el.getAttribute('aria-label') || ''}"`);
      });
      document.querySelectorAll('button, a').forEach(el => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 25 && /pesquisar|limpar|^\d+$|proxim|anterior|»|«|>|</i.test(t))
          out.push(`BTN/A: <${el.tagName.toLowerCase()} class="${el.className}"> ${t}`);
      });
      return out.join('\n');
    });
    fs.writeFileSync(path.join(PASTA, 'pesquisar_contas_debug.txt'), info || '(vazio)', 'utf8');
  } catch { /* sem debug */ }
}

async function lerTabelaContas(page) {
  await dumpModal(page);
  const contas = [], vistos = new Set();
  for (let pag = 1; pag <= 20; pag++) {
    await espera(800);
    /* cada conta e um link "selconta/<ID>.html" — guardo o ID para selecionar
       depois indo direto na URL (sem reabrir janela nem digitar em campo) */
    const links = page.locator('a[onclick*="selconta"]');
    const n = await links.count();
    for (let i = 0; i < n; i++) {
      const lk = links.nth(i);
      const razao = ((await lk.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      const onclick = (await lk.getAttribute('onclick').catch(() => '')) || '';
      const mid = onclick.match(/selconta\/(\d+)\.html/i);
      const id = mid ? mid[1] : null;
      const rowtxt = ((await lk.locator('xpath=ancestor::tr[1]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
      const mc = rowtxt.match(/(\d{4,6}-\d)/);
      const conta = mc ? mc[1] : '';
      const chave = id || (conta + '|' + razao);
      if (!razao || vistos.has(chave)) continue;
      vistos.add(chave);
      contas.push({ conta, razao, id, pagina: pag, label: conta ? `${conta} - ${razao}` : razao });
    }
    const prox = page.getByText(new RegExp(`^\\s*${pag + 1}\\s*$`)).last();
    if (!(await prox.isVisible({ timeout: 1000 }).catch(() => false))) break;
    await prox.click().catch(() => {});
  }
  return contas;
}

/* vai para a pagina N do paginador da janela "Pesquisar Contas" */
async function irPaginaContas(page, n) {
  for (const cand of [
    page.getByRole('link', { name: String(n), exact: true }),
    page.getByRole('button', { name: String(n), exact: true }),
    page.getByText(new RegExp(`^\\s*${n}\\s*$`)),
  ]) {
    const el = cand.last();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) { await el.click().catch(() => {}); await espera(1200); return true; }
  }
  return false;
}

/* filtra a janela pelo NUMERO da conta (campo "Conta" + Pesquisar), deixando
   so aquela conta na tabela — mais confiavel que virar pagina */
async function filtrarPorConta(page, conta) {
  const num = String(conta).split('-')[0].replace(/\D/g, '');
  const campos = [
    page.getByLabel(/^\s*conta\s*$/i),
    page.getByPlaceholder(/conta/i),
    /* 2o input de texto visivel da janela costuma ser o "Conta"
       (ordem: Cooperativa, Conta, Razao social) */
    page.locator('input[type=text]:visible, input:not([type]):visible').nth(1),
  ];
  for (const c of campos) {
    const el = c.first();
    if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
      try {
        await el.fill('');
        await el.fill(num);
        await clicar(page, [/pesquisar/i], { timeout: 5000 });
        await espera(1800);
        return true;
      } catch { /* tenta o proximo campo */ }
    }
  }
  return false;
}

async function selecionarContaModal(page, c) {
  /* caminho principal: ir DIRETO para /ib-view/selconta/<ID>.html (o destino do
     link da conta, capturado na listagem). Nao reabre janela nem digita em
     campo nenhum — imune ao problema de digitar no campo errado. */
  if (c.id) {
    await page.goto(new URL(`/ib-view/selconta/${c.id}.html`, page.url()).href,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await espera(2000);
    return;
  }
  /* reserva (raro: sem ID): reabre a janela e clica na razao social */
  await abrirPesquisarContas(page);
  await espera(700);
  if (!(await filtrarPorConta(page, c.conta))) await irPaginaContas(page, c.pagina);
  const reRazao = new RegExp('^\\s*' + c.razao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
  let alvo = page.getByRole('link', { name: reRazao }).first();
  if (!(await alvo.isVisible({ timeout: 1500 }).catch(() => false))) alvo = page.getByText(reRazao).first();
  const onclick = await alvo.getAttribute('onclick').catch(() => null);
  const m = onclick && onclick.match(/selconta\/(\d+)\.html/i);
  if (m) await page.goto(new URL(`/ib-view/selconta/${m[1]}.html`, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  else { await alvo.scrollIntoViewIfNeeded().catch(() => {}); await alvo.click({ timeout: 8000, force: true }); }
  await espera(2500);
}

async function baixarPlanilha(page, conta) {
  /* escuta o download no CONTEXTO (pega tambem se abrir em outra aba/popup) */
  const dlPromise = page.context().waitForEvent('download', { timeout: 60000 });
  await clicar(page, [/gerar planilha/i, /planilha/i, /exportar/i], { timeout: 15000 });
  const download = await dlPromise;
  const sugerido = download.suggestedFilename() || 'extrato.xls';
  const ext = path.extname(sugerido) || '.xls';
  const destino = path.join(PASTA, `extrato_${limpo(conta.label)}_${hoje()}${ext}`);
  try {
    await download.saveAs(destino);
  } catch (e) {
    /* se a pagina/aba fechou durante o saveAs, o arquivo ja pode estar no
       diretorio temporario de downloads — copia de la */
    const tmp = await download.path().catch(() => null);
    if (tmp) fs.copyFileSync(tmp, destino);
    else throw e;
  }
  return path.basename(destino);
}

async function main() {
  const b = carregarBanco();
  const periodo = process.env.BANCO_PERIODO || b.periodo || 'Últimos 7 dias';
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato ${VERSAO} ===`);
  console.log(`Periodo: ${periodo}\n`);
  const t0 = Date.now();

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

    /* lista COMPLETA de contas pela janela "Pesquisar Contas" (Ver Mais).
       Se nao conseguir abrir, cai para o seletor do topo (so as favoritas). */
    let contas = [], sw = null, modo = 'todas';
    if (await abrirPesquisarContas(page)) contas = await lerTabelaContas(page);
    if (!contas.length) {
      /* nao abriu a lista completa: guarda print + despejo do HTML para ajustar */
      try { await page.screenshot({ path: path.join(PASTA, `ver_mais_${hoje()}.png`), fullPage: true }); } catch { /* */ }
      await dumpSeletor(page);
      console.log('(nao consegui abrir o "Ver Mais"; usando so as favoritas.');
      console.log(' Me mande o arquivo extratos\\ver_mais_debug.txt para eu acertar o clique.)');
      modo = 'favoritas';
      await abrirExtrato(page).catch(() => {});
      sw = await descobrirContas(page);
      if (sw) contas = sw.contas;
    }
    if (!contas.length) {
      await page.screenshot({ path: path.join(PASTA, `contas_nao_achei_${hoje()}.png`), fullPage: true });
      throw new Error('Nao achei a lista de contas. Salvei um print em '
        + 'extratos\\contas_nao_achei_...png — me mande esse print para eu acertar o seletor.');
    }
    console.log(`Contas encontradas (${contas.length}) [${modo === 'todas' ? 'lista completa' : 'so favoritas'}]:`);
    contas.forEach(c => console.log(`  - ${c.label}`));

    /* rodar so algumas contas: passe os numeros na linha de comando, ex.:
       node scripts\\extrato-banco.js 71532  (baixa so a 71532-6)
       node scripts\\extrato-banco.js 71532 63896  (essas duas) */
    const filtros = process.argv.slice(2).map(s => s.replace(/\D/g, '')).filter(Boolean);
    if (filtros.length) {
      /* casa pelo numero da conta — usa label quando nao ha campo "conta"
         (modo favoritas), sem quebrar */
      const digitos = c => String(c.conta || c.label || '').replace(/\D/g, '');
      contas = contas.filter(c => filtros.some(f => digitos(c).includes(f)));
      if (!contas.length) {
        console.log(`Nenhuma das contas pedidas (${filtros.join(', ')}) esta na lista${modo === 'todas' ? '' : ' de favoritas'}.`
          + (modo === 'todas' ? '' : ' O "Ver Mais" nao abriu, entao so as 5 favoritas foram lidas — rode de novo para pegar a lista completa.'));
      } else {
        console.log(`Filtrando para ${contas.length} conta(s): ${contas.map(c => c.label).join(', ')}`);
      }
    }
    console.log('');

    for (const conta of contas) {
      const tc = Date.now();
      try {
        console.log(`Conta ${conta.label} — selecionando...`);
        if (modo === 'todas') await selecionarContaModal(page, conta);
        else await selecionarConta(page, sw, conta);
        /* trocar de conta volta para a Pagina Inicial: reabre o Extrato dela */
        await espera(1500);
        await abrirExtrato(page);
        await ajustarPeriodo(page, periodo);
        /* Pesquisar/Consultar e opcional: em algumas telas o extrato ja aparece */
        try { await clicar(page, [/pesquisar/i, /consultar/i, /buscar/i, /filtrar/i, /aplicar/i, /visualizar/i], { timeout: 6000 }); }
        catch { /* extrato ja carregado */ }
        await espera(3000);
        const nome = await baixarPlanilha(page, conta);
        console.log(`  ok: ${nome} (${dur(Date.now() - tc)})`);
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
  const seg = ok.length ? ` (~${dur((Date.now() - t0) / Math.max(ok.length, 1))} por conta)` : '';
  console.log(`Tempo total: ${dur(Date.now() - t0)}${seg}`);
  console.log('');
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
