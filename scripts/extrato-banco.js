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
const VERSAO = 'extrato v34 (GAMEL: seleciona pelo seletor nativo do Sicredi, nao por URL adivinhada)';
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

/* Normaliza o banco.json para uma LISTA de acessos. Aceita tres formatos:
     1) um acesso so:   { "cnpj": "...", "login": "...", "senha": "..." }
     2) uma lista:      [ { "cnpj": "...", "login": "...", "senha": "..." }, ... ]
     3) login/senha comuns + varios CNPJs (o caso da Hyly):
        { "login": "...", "senha": "...", "periodo": "...",
          "acessos": [ { "cnpj": "CNPJ_1" }, { "cnpj": "CNPJ_2" } ] }
   No formato 3, cada acesso herda login/senha/periodo do topo — voce so repete
   o que muda (o CNPJ). */
function carregarAcessos() {
  const raw = carregarBanco();
  const topo = Array.isArray(raw) ? {} : raw;
  const lista = Array.isArray(raw) ? raw : (Array.isArray(raw.acessos) ? raw.acessos : [raw]);
  const acessos = lista.map(a => ({
    cnpj: a.cnpj,
    login: a.login || topo.login,
    senha: a.senha || topo.senha,
    periodo: a.periodo || topo.periodo,
  })).filter(a => a.cnpj && a.login && a.senha);
  if (!acessos.length) throw new Error('banco.json sem acesso valido: cada acesso precisa de cnpj, login e senha.');
  return acessos;
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
  for (let t = 1; t <= 5; t++) {
    try {
      await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await espera(2500);
      /* as vezes o preauth cai na home publica (sicredi.com.br) — re-navega
         direto pra tela de acesso ate 3x */
      for (let r = 0; r < 3 && !/preauth|loginpj|ib-view/i.test(page.url()); r++) {
        await clicar(page, [/acessar sua conta/i, /acesse sua conta/i, /^acessar$/i], { timeout: 4000 }).catch(() => {});
        await espera(1500);
        if (!/preauth|loginpj|ib-view/i.test(page.url())) { await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded' }).catch(() => {}); await espera(2000); }
      }
      console.log(`Login (tentativa ${t}) 1/2: CNPJ`);
      const cnpj = campoTexto(page);
      await cnpj.waitFor({ state: 'visible', timeout: 12000 });
      await digitarReal(cnpj, b.cnpj);
      await clicar(page, [/acessar/i], { timeout: 12000 });
      await espera(4000);
      if (naOferta(page)) { console.log('  -> Dispositivo de Seguranca. Nao instalo nada; tento de novo.'); await espera(2000); continue; }
      console.log('Login 2/2: usuario e senha (teclado da tela)');
      await digitarReal(campoTexto(page), b.login);
      await espera(600);
      await senhaPeloTeclado(page, b.senha);
      await espera(500);
      await clicar(page, [/acessar/i], { timeout: 12000 });
      await espera(6000);
      if (naOferta(page)) { console.log('  -> Dispositivo de Seguranca depois da senha. Tento de novo.'); await espera(2000); continue; }
      return true; // entrou
    } catch (e) {
      console.log(`  tentativa ${t} nao completou (${String(e.message).split('\n')[0]}); tentando de novo...`);
      await espera(2500);
    }
  }
  throw new Error('O Sicredi ficou preso na tela do "Dispositivo de Seguranca" '
    + '(ofertaWarsaw.html) e nao deixou passar para a conta. Esse e o anti-fraude '
    + 'do banco. Tente: (1) rodar de novo — as vezes passa na 2a; (2) abrir o site '
    + 'do banco no seu Chrome normal UMA vez, logar e deixar o dispositivo instalado, '
    + 'depois fechar o Chrome e rodar o robo (ele usa o mesmo Chrome).');
}

/* sai da sessao atual pela propria tela (mantem o dispositivo confiavel, pra nao
   re-disparar o "Dispositivo de Seguranca" no proximo login). Best-effort. */
async function deslogar(page) {
  try {
    await clicar(page, [/^\s*sair\s*$/i, /encerrar sess/i, /sair com seguran/i, /^\s*logout\s*$/i], { timeout: 6000 });
    await espera(2500);
    return true;
  } catch { return false; }
}

async function abrirExtrato(page) {
  /* a tela da conta as vezes trava carregando (so o logo do Sicredi + a bolinha),
     entao o menu "Extrato" nem aparece. Espera carregar; se nao achar, recarrega
     e tenta mais uma vez antes de desistir. */
  for (let i = 0; i < 2; i++) {
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    try {
      await clicar(page, [/^extrato$/i, /extrato/i], { timeout: 20000 });
      await espera(3000);
      return;
    } catch (e) {
      if (i >= 1) throw e;
      console.log('  (a tela demorou/travou carregando — recarregando e tentando o Extrato de novo...)');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await espera(4000);
    }
  }
}

async function preencherDataSic(campo, valor) {
  try {
    await campo.click({ timeout: 4000 });
    await campo.fill('');
    await campo.pressSequentially(valor, { delay: 60 });
  } catch { await campo.fill(valor).catch(() => {}); }
  await campo.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});
  await espera(400);
}
async function ajustarPeriodo(page, periodo, de, ate) {
  try {
    if (de && ate) {
      /* periodo por DATAS: escolhe uma opcao de "personalizar" no seletor (se
         houver), preenche De/Ate (os dois campos com cara de data) e Pesquisa. */
      const selPers = page.locator('select')
        .filter({ has: page.locator('option', { hasText: /personaliz|outro per[ií]odo|escolher per|especif/i }) }).first();
      if (await selPers.count().catch(() => 0)) {
        const txt = await selPers.locator('option', { hasText: /personaliz|outro per[ií]odo|escolher|especif/i })
          .first().textContent().catch(() => null);
        if (txt) await selPers.selectOption({ label: txt.trim() }).catch(() => {});
        await espera(800);
      }
      /* acha os dois campos com cara de data (De e Ate) e preenche */
      const all = page.locator('input');
      const n = await all.count().catch(() => 0);
      const campos = [];
      for (let i = 0; i < n && campos.length < 2; i++) {
        const v = await all.nth(i).inputValue().catch(() => '');
        if (/\d{2}\/\d{2}\/\d{4}/.test(v)) campos.push(all.nth(i));
      }
      if (campos.length >= 2) {
        await preencherDataSic(campos[0], de);
        await preencherDataSic(campos[1], ate);
        console.log(`  periodo -> De="${await campos[0].inputValue().catch(() => '?')}" Ate="${await campos[1].inputValue().catch(() => '?')}"`);
      } else {
        console.log('  (nao achei os campos De/Ate — conferir a tela do extrato)');
      }
      await clicar(page, [/pesquisar/i, /consultar/i, /buscar/i], { timeout: 8000 }).catch(() => {});
      await espera(2000);
    } else {
      const sel = page.locator('select')
        .filter({ has: page.locator('option', { hasText: new RegExp(periodo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }) })
        .first();
      await sel.selectOption({ label: periodo });
      await espera(600);
    }
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

  /* Fallback para acessos com POUCAS contas (5 ou menos): o Sicredi nao mostra o
     "Ver Mais" e a tabela nao traz os links "selconta". A(s) conta(s) ficam no
     <select id=opcoesCombo>, com o ID da conta no value da <option> — que e o
     mesmo ID usado em /ib-view/selconta/<ID>.html. Le dali. */
  if (!contas.length) {
    const opts = page.locator('#opcoesCombo option, select option');
    const m = await opts.count().catch(() => 0);
    for (let j = 0; j < m; j++) {
      const o = opts.nth(j);
      const texto = ((await o.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!texto || /ver mais/i.test(texto)) continue;
      const mc = texto.match(/(\d{4,6}-\d)/);
      if (!mc) continue; // so linhas que tem cara de conta
      const conta = mc[1];
      const val = ((await o.getAttribute('value').catch(() => '')) || '').trim();
      const id = /^\d+$/.test(val) ? val : null;
      /* razao: tira "<coop> <conta> - " da frente ("0718 66274-4 - GAMEL..." -> "GAMEL...") */
      const razao = texto.replace(/^\s*\d+\s+\d{4,6}-\d\s*[-–]?\s*/, '').trim() || texto;
      const chave = id || (conta + '|' + razao);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      /* comboValue: marca que esta conta veio do <select> do topo — assim a
         selecao usa o seletor NATIVO (trocaConta), nao uma URL adivinhada. */
      contas.push({ conta, razao, id, pagina: 1, comboValue: val || null, label: conta ? `${conta} - ${razao}` : razao });
    }
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
  /* Conta vinda do <select> do topo (acesso de conta unica, ex.: GAMEL): usa o
     seletor NATIVO do Sicredi (dispara o trocaConta do site), em vez de montar a
     URL /selconta/ na mao — a URL adivinhada abre uma tela "meio torta" que
     quebra na hora de baixar. O seletor nativo leva para a tela certa. */
  if (c.comboValue) {
    try {
      const combo = page.locator('#opcoesCombo').first();
      if (await combo.count().catch(() => 0)) {
        await combo.selectOption(c.comboValue);
        await espera(3000);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        return;
      }
    } catch { /* cai para o goto por ID abaixo */ }
  }
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

async function baixarPlanilha(page, conta, ofx) {
  const extPref = ofx ? '.ofx' : '.xls';
  const destino = path.join(PASTA, `extrato_${limpo(conta.label)}_${hoje()}${extPref}`);
  /* escuta o download no CONTEXTO (pega tambem se abrir em outra aba/popup) */
  const dlPromise = page.context().waitForEvent('download', { timeout: 60000 });
  /* OFX = botao "Gerar OFX"; padrao = "Gerar Planilha" (Excel) */
  const botoes = ofx ? [/gerar ofx/i, /\bofx\b/i] : [/gerar planilha/i, /planilha/i, /exportar/i];
  await clicar(page, botoes, { timeout: 15000 });
  const download = await dlPromise;
  const ext = path.extname(download.suggestedFilename() || '') || extPref;
  const dest = destino.replace(new RegExp(extPref.replace('.', '\\.') + '$', 'i'), ext);
  try { await download.saveAs(dest); }
  catch (e) {
    const tmp = await download.path().catch(() => null);
    if (tmp) fs.copyFileSync(tmp, dest); else throw e;
  }
  return path.basename(dest);
}

async function main() {
  const acessos = carregarAcessos();
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato ${VERSAO} ===`);
  if (acessos.length > 1) console.log(`Logins a processar: ${acessos.length} (${acessos.map(a => a.cnpj).join(', ')})`);
  const t0 = Date.now();

  /* Perfil FIXO do Chrome instalado (channel:'chrome'): o Dispositivo de
     Seguranca do Sicredi reconhece melhor o Chrome de verdade, e a "confianca"
     do dispositivo fica salva no perfil entre execucoes, reduzindo a tela do
     ofertaWarsaw. --disable-http2 evita o ERR_HTTP2_PROTOCOL_ERROR no login. */
  const args = ['--disable-http2', '--disable-blink-features=AutomationControlled'];
  const opts = { headless: false, slowMo: 120, acceptDownloads: true, viewport: null, args };
  const morreu = (e) => /closed|crash|Target|Session closed|context or browser|has been closed/i.test(String((e && e.message) || e));

  /* rodar so algumas contas: passe os numeros na linha de comando (vale para
     todos os logins). Ha contas com o MESMO numero e digito diferente
     (63923-4 e 63923-8), entao:
       - com digito casa EXATO so aquela conta:  node ...\\extrato-banco.js 63923-4
       - sem digito casa todas com aquele numero: node ...\\extrato-banco.js 63923 */
  /* flags pontuais: --ofx (baixa OFX em vez de Excel), --de/--ate ou --mes
     (periodo por datas). O resto dos argumentos sao numeros de conta (filtro). */
  const rawArgs = process.argv.slice(2);
  const OPT = { ofx: false, de: null, ate: null };
  const contaArgs = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i].toLowerCase();
    if (a === '--ofx') OPT.ofx = true;
    else if (a === '--de') OPT.de = rawArgs[++i];
    else if (a === '--ate' || a === '--até') OPT.ate = rawArgs[++i];
    else if (a === '--mes' || a === '--mês') OPT.mes = rawArgs[++i];
    else if (a.startsWith('--')) { /* flag desconhecida: ignora */ }
    else contaArgs.push(rawArgs[i]);
  }
  const dd2 = n => String(n).padStart(2, '0');
  if (OPT.mes) {
    const m = String(OPT.mes).match(/(\d{4})[-/.](\d{1,2})/) || String(OPT.mes).match(/^(\d{1,2})$/);
    let ano, mes;
    if (m && m.length === 3) { ano = +m[1]; mes = +m[2]; } else if (m) { ano = new Date().getFullYear(); mes = +m[1]; }
    if (ano && mes >= 1 && mes <= 12) { const u = new Date(ano, mes, 0).getDate(); OPT.de = `${dd2(1)}/${dd2(mes)}/${ano}`; OPT.ate = `${dd2(u)}/${dd2(mes)}/${ano}`; }
  }
  if (OPT.ofx) console.log('Formato: OFX');
  if (OPT.de && OPT.ate) console.log(`Periodo (datas): ${OPT.de} a ${OPT.ate}`);
  const filtros = contaArgs.map(s => s.replace(/\D/g, '')).filter(Boolean);

  /* acesso ATUAL (login de agora): novoNavegador() reloga nele ao reabrir apos
     uma queda do Chrome. So abrir o navegador (sem logar) fica em abrirNavegador. */
  let acesso = acessos[0];
  const abrirNavegador = async () => {
    let c;
    try { c = await chromium.launchPersistentContext(PERFIL, { channel: 'chrome', ...opts }); }
    catch { console.log('(Chrome nao encontrado — usando o navegador embutido)'); c = await chromium.launchPersistentContext(PERFIL, opts); }
    const p = c.pages()[0] || await c.newPage();
    return { c, p };
  };
  const novoNavegador = async () => { const { c, p } = await abrirNavegador(); await fazerLogin(p, acesso); return { c, p }; };

  let ctx, page;
  ({ c: ctx, p: page } = await novoNavegador());
  const ok = [], falhou = [];
  /* Reabrir o navegador exige re-logar. Para NAO ficar re-logando em cascata
     (ex.: OFX, que o Warsaw derruba de vez em quando), limitamos o total de
     reaberturas no run inteiro; passou do limite, PARA e lista o que faltou. */
  const MAX_REAB = 4;
  let reaberturas = 0, pararTudo = false;

  for (let ia = 0; ia < acessos.length && !pararTudo; ia++) {
    acesso = acessos[ia];
    const periodo = process.env.BANCO_PERIODO || acesso.periodo || 'Últimos 7 dias';
    if (acessos.length > 1) console.log(`\n===== Login ${ia + 1}/${acessos.length} — CNPJ ${acesso.cnpj} =====`);
    console.log(`Periodo: ${periodo}`);

    /* troca de login: sai da sessao anterior e entra no novo CNPJ. Tenta sair
       pela tela (mantem o dispositivo confiavel); se nao der, limpa cookies.
       Se ainda assim travar, reabre o navegador limpo. */
    if (ia > 0) {
      try {
        const saiu = await deslogar(page).catch(() => false);
        if (!saiu) await ctx.clearCookies().catch(() => {});
        await fazerLogin(page, acesso);
      } catch {
        console.log('  reabrindo o navegador para trocar de login...');
        try { await ctx.close(); } catch { /* */ }
        ({ c: ctx, p: page } = await abrirNavegador());
        try { await ctx.clearCookies(); } catch { /* */ }
        await fazerLogin(page, acesso);
      }
    }

    try {
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

      if (filtros.length) {
        const full = c => String(c.conta || c.label || '').replace(/\D/g, '');   // 639234 (com digito)
        const base = c => String(c.conta || c.label || '').split('-')[0].replace(/\D/g, ''); // 63923
        /* casa EXATO: pelo numero completo (com digito) OU, se voce passou so o
           numero sem digito, pela base — nunca "contém", pra nao pegar conta parecida */
        contas = contas.filter(c => filtros.some(f => f === full(c) || f === base(c)));
        if (!contas.length) {
          console.log(`Nenhuma das contas pedidas (${filtros.join(', ')}) esta neste login${modo === 'todas' ? '' : ' (so favoritas)'}.`);
        } else {
          console.log(`Filtrando para ${contas.length} conta(s): ${contas.map(c => c.label).join(', ')}`);
        }
      }
      console.log('');
      /* log EXPLICITO do que vai rodar — assim da pra ver na hora se o filtro pegou */
      if (contas.length) console.log(`Vou baixar ${contas.length} conta(s): ${contas.map(c => c.label).join(', ')}\n`);

      for (const conta of contas) {
        if (pararTudo) { falhou.push(conta.label); continue; }
        const tc = Date.now();
        let feito = false;
        for (let tent = 1; tent <= 2 && !feito; tent++) {
          try {
            if (page.isClosed()) page = await ctx.newPage();
            console.log(`Conta ${conta.label} — selecionando...`);
            if (modo === 'todas') await selecionarContaModal(page, conta);
            else await selecionarConta(page, sw, conta);
            /* trocar de conta volta para a Pagina Inicial: reabre o Extrato dela */
            await espera(1500);
            await abrirExtrato(page);
            await ajustarPeriodo(page, periodo, OPT.de, OPT.ate);
            /* Pesquisar/Consultar e opcional: em algumas telas o extrato ja aparece */
            try { await clicar(page, [/pesquisar/i, /consultar/i, /buscar/i, /filtrar/i, /aplicar/i, /visualizar/i], { timeout: 6000 }); }
            catch { /* extrato ja carregado */ }
            await espera(3000);
            const nome = await baixarPlanilha(page, conta, OPT.ofx);
            console.log(`  ok: ${nome} (${dur(Date.now() - tc)})`);
            ok.push(conta.label); feito = true;
          } catch (e) {
            /* o Chrome caiu (banco fechou na hora da planilha): reabre, re-loga e
               RETENTA esta mesma conta uma vez — MAS com limite global, pra nao
               ficar re-logando sem parar. */
            if (morreu(e)) {
              if (reaberturas >= MAX_REAB) {
                console.error(`  o navegador caiu e ja reabri ${reaberturas}x — PARANDO aqui pra nao ficar re-logando em cascata. Rode de novo so as que faltaram.`);
                falhou.push(conta.label); feito = true; pararTudo = true; continue;
              }
              reaberturas++;
              console.log(`  o navegador fechou em ${conta.label} — reabrindo (${reaberturas}/${MAX_REAB})...`);
              try { await ctx.close(); } catch { /* */ }
              try { ({ c: ctx, p: page } = await novoNavegador()); feito = (tent >= 2); if (tent >= 2) falhou.push(conta.label); }
              catch (e2) { console.error(`  nao consegui reabrir: ${e2.message.split('\n')[0]}`); falhou.push(conta.label); feito = true; pararTudo = true; }
              continue;
            }
            console.error(`  FALHOU ${conta.label}: ${e.message.split('\n')[0]}`);
            try { await page.screenshot({ path: path.join(PASTA, `erro_${limpo(conta.label)}_${hoje()}.png`), fullPage: true }); } catch { /* */ }
            falhou.push(conta.label); feito = true;
          }
        }
      }
    } catch (e) {
      try {
        await page.screenshot({ path: path.join(PASTA, `erro_${hoje()}.png`), fullPage: true });
        console.log('(salvei um print do erro em extratos\\erro_...png)');
      } catch { /* sem print */ }
      console.error(`\nLogin ${acesso.cnpj} parou: ${e.message.split('\n')[0]}\n`);
      /* se o navegador morreu, reabre (sem logar) pra o proximo login conseguir entrar */
      if (morreu(e)) { try { await ctx.close(); } catch { /* */ } try { ({ c: ctx, p: page } = await abrirNavegador()); } catch { /* */ } }
    }
  }
  try { await ctx.close(); } catch { /* */ }

  console.log('\n=== Resumo ===');
  console.log(`Baixadas: ${ok.length}${ok.length ? ' (' + ok.join(', ') + ')' : ''}`);
  if (falhou.length) console.log(`Falharam: ${falhou.length} (${falhou.join(', ')}) — veja os prints erro_*.png em extratos\\`);
  const seg = ok.length ? ` (~${dur((Date.now() - t0) / Math.max(ok.length, 1))} por conta)` : '';
  console.log(`Tempo total: ${dur(Date.now() - t0)}${seg}`);
  console.log('');
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
