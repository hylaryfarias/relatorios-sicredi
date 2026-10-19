/* Robo que baixa os relatorios do portal Sicredi maquininhas.
 *
 * Para cada loja: entra com login e senha, pede o codigo por e-mail, le o
 * codigo sozinho, e baixa tres relatorios dos ultimos 7 dias — Vendas
 * (simplificado), Antecipacao detalhada e Antecipacao simplificada. Guarda na pasta
 * relatorios/.
 *
 * Dois modos:
 *   MODO=local  -> abre o navegador na sua frente. Se aparecer o "prove que
 *                  voce e humano" (CAPTCHA), ele PARA e espera VOCE resolver;
 *                  depois segue sozinho.
 *   MODO=ci     -> roda escondido no GitHub, sem ninguem. Se uma loja cair no
 *                  CAPTCHA, ele pula essa loja e anota na lista "faltaram
 *                  estas", para voce completar so as que faltaram.
 *
 * O robo NUNCA tenta resolver o CAPTCHA. Ou voce resolve (modo local), ou a
 * loja fica para depois (modo ci). */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { pegarCodigo } from './gmail.js';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASTA = path.join(RAIZ, 'relatorios');
const PASTA_ERROS = path.join(RAIZ, 'erros');
const MODO = (process.env.MODO || 'local').toLowerCase();
const PORTAL = process.env.SICREDI_URL || 'https://www.maquinasicredi.com.br/Login';

/* -------- de onde vem a lista das lojas --------
   Aceita dois formatos:
   1) uma lista: [{nome, login, senha, email}, ...]
   2) senha/e-mail uma vez so (quando sao iguais em todas as lojas):
      { "senha": "...", "email": "...", "lojas": [{nome, login}, ...] }
   No formato 2, cada loja herda a senha e o e-mail comuns (mas pode ter os
   seus proprios, se um dia precisar). */
function normalizaContas(parsed) {
  if (Array.isArray(parsed)) return parsed;
  const { senha, email, lojas } = parsed || {};
  if (!Array.isArray(lojas)) {
    throw new Error('formato invalido: esperado uma lista, ou { senha, email, lojas: [...] }');
  }
  return lojas.map(l => ({ ...l, senha: l.senha || senha, email: l.email || email }));
}
function carregarContas() {
  if (process.env.SICREDI_CONTAS) {
    try { return normalizaContas(JSON.parse(process.env.SICREDI_CONTAS)); }
    catch (e) { throw new Error('SICREDI_CONTAS invalido: ' + e.message); }
  }
  const arq = path.join(RAIZ, 'contas.json');
  if (fs.existsSync(arq)) return normalizaContas(JSON.parse(fs.readFileSync(arq, 'utf8')));
  throw new Error(
    'Nao achei as lojas. No seu PC, crie o arquivo contas.json (veja o README). '
    + 'No GitHub, cadastre o segredo SICREDI_CONTAS.');
}

const VERSAO = 'v11.41 (so relatorios DETALHADOS: vendas detalhado + antecipacao detalhado) + diagnostico abridor';
const espera = (ms) => new Promise(r => setTimeout(r, ms));

/* Corre uma promessa contra um relogio: se passar de `ms`, rejeita com timeout.
   Serve pra blindar operacoes que podem travar numa pagina congelada do portal
   (page.evaluate/page.content nao tem timeout proprio e penduram pra sempre). */
function comTimeout(promise, ms, label = 'operacao') {
  let t;
  const relogio = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), relogio]);
}

/* Digita LETRA POR LETRA e ainda reforca com os eventos nativos que os portais
 * feitos em framework (React/OutSystems) escutam para habilitar o botao. So
 * "colar" o valor nao dispara esses eventos e o botao continua cinza. */
async function digitarReal(campo, valor) {
  await campo.click();
  await campo.fill('');
  await campo.pressSequentially(valor, { delay: 55 });
  await campo.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, valor);
}
const hoje = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD

/* nome de arquivo seguro a partir do nome da loja */
const limpo = (s) => String(s || 'loja').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/* -------- deteccao do CAPTCHA -------- */
async function temCaptcha(page) {
  // o "prove que voce e humano" da Radware traz um h-captcha e o texto abaixo
  const marcas = ['.h-captcha', 'iframe[src*="hcaptcha"]', 'text=/make sure you.?re human/i',
                  'text=/prove que voc/i'];
  for (const m of marcas) {
    try { if (await page.locator(m).first().isVisible({ timeout: 800 })) return true; }
    catch { /* segue */ }
  }
  return false;
}

/* espera o humano resolver o CAPTCHA (so no modo local) */
async function esperarHumano(page, loja) {
  console.log(`\n  >>> ${loja}: apareceu o "prove que voce e humano".`);
  console.log('  >>> Resolva o quebra-cabeca na janela do navegador. Eu espero.\n');
  const ate = Date.now() + 5 * 60000; // 5 min
  while (Date.now() < ate) {
    if (!(await temCaptcha(page))) { console.log(`  >>> ${loja}: obrigado, segui.\n`); return true; }
    await espera(2000);
  }
  throw new Error('CAPTCHA nao resolvido em 5 minutos.');
}

async function lidarCaptcha(page, loja) {
  if (!(await temCaptcha(page))) return true;
  if (MODO === 'local') return esperarHumano(page, loja);
  throw new Error('CAPTCHA (modo automatico nao resolve — fica para voce completar).');
}

/* -------- clicar por texto, tolerante a variacoes -------- */
async function clicar(page, textos, { timeout = 15000 } = {}) {
  const lista = Array.isArray(textos) ? textos : [textos];
  const inicio = Date.now();
  while (Date.now() - inicio < timeout) {
    for (const t of lista) {
      const re = t instanceof RegExp ? t : new RegExp(`^\\s*${t}\\s*$`, 'i');
      // 1) botao pelo nome acessivel
      try { const b = page.getByRole('button', { name: t }).first();
            if (await b.isVisible({ timeout: 350 })) { await b.click(); return true; } } catch { /* segue */ }
      // 2) link pelo nome acessivel (menus do portal costumam ser links)
      try { const l = page.getByRole('link', { name: t }).first();
            if (await l.isVisible({ timeout: 350 })) { await l.click(); return true; } } catch { /* segue */ }
      // 3) qualquer elemento clicavel que contenha o texto (botao/link/div com papel)
      try {
        const c = page.locator('button, a, [role=button], input[type=submit], input[type=button]')
          .filter({ hasText: re }).first();
        if (await c.isVisible({ timeout: 350 })) { await c.click(); return true; }
      } catch { /* segue */ }
      // 4) ultimo recurso: o texto puro na tela
      try { const e = page.getByText(re).first();
            if (await e.isVisible({ timeout: 350 })) { await e.click(); return true; } } catch { /* segue */ }
    }
    await espera(500);
  }
  throw new Error(`Nao achei para clicar: ${lista.map(String).join(' / ')}`);
}

/* -------- login + codigo por e-mail -------- */
async function entrar(page, conta) {
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' });
  await espera(2500);
  await lidarCaptcha(page, conta.nome);

  // Digitar LETRA POR LETRA. O botao Entrar fica cinza (desabilitado) ate o
  // portal registrar a digitacao de verdade; um "colar" de uma vez nao liga o
  // botao. Por isso usamos pressSequentially (teclas reais), nao fill.
  const usuario = page.getByLabel(/CNPJ|CPF|usu/i).first();
  const senha = page.getByLabel(/senha/i).first();
  const campoUser = await usuario.isVisible({ timeout: 8000 }).catch(() => false)
    ? usuario : page.locator('input:not([type=password])').first();
  const campoSenha = await senha.isVisible({ timeout: 3000 }).catch(() => false)
    ? senha : page.locator('input[type=password]').first();

  await digitarReal(campoUser, conta.login);
  await digitarReal(campoSenha, conta.senha);
  await campoSenha.press('Tab'); // dispara a validacao que libera o botao
  await espera(800);

  const marcaTempo = Date.now(); // para so pegar o e-mail que chegar depois daqui
  // clicar Entrar. O click do Playwright ESPERA o botao ficar habilitado (verde)
  // antes de clicar; se por algum motivo nao achar, tenta os outros jeitos.
  const btnEntrar = page.getByRole('button', { name: /entrar/i }).first();
  try { await btnEntrar.click({ timeout: 12000 }); }
  catch { await clicar(page, ['Entrar', /^entrar$/i], { timeout: 8000 }); }
  await espera(2500);
  await lidarCaptcha(page, conta.nome);

  // escolher receber por e-mail
  await clicar(page, [/receber por e.?mail/i, /e.?mail/i], { timeout: 20000 });
  console.log(`  ${conta.nome}: pedi o codigo por e-mail, lendo a caixa...`);

  // ler o codigo e digitar
  const codigo = await pegarCodigo({ desde: marcaTempo, remetente: 'fiserv.com', timeoutSeg: 150 });
  console.log(`  ${conta.nome}: codigo ${codigo} recebido, preenchendo.`);
  // campo do token: seis quadradinhos (um digito cada) ou, as vezes, um so.
  // digitar com TECLAS REAIS, senao o botao Confirmar continua cinza.
  const boxes = page.locator('input[maxlength="1"], input[inputmode="numeric"], input[type="tel"]');
  const nb = await boxes.count();
  if (nb > 1) {
    for (let i = 0; i < Math.min(nb, codigo.length); i++) {
      await boxes.nth(i).click();
      await page.keyboard.type(codigo[i], { delay: 70 });
    }
  } else {
    const uni = page.getByLabel(/c[oó]digo|token/i).first();
    const campo = await uni.isVisible({ timeout: 2000 }).catch(() => false) ? uni : page.locator('input').last();
    await digitarReal(campo, codigo);
  }
  await espera(700);
  // Confirmar: o click espera o botao habilitar (ficar verde)
  const btnConf = page.getByRole('button', { name: /confirmar/i }).first();
  try { await btnConf.click({ timeout: 12000 }); }
  catch { await clicar(page, [/confirmar|continuar|acessar|validar/i], { timeout: 8000 }).catch(() => {}); }
  await espera(3500);
  await lidarCaptcha(page, conta.nome);
}

/* -------- baixar um relatorio (recebe as etapas de clique) -------- */
async function baixar(page, conta, { titulo, etapas, arquivoBase }) {
  console.log(`  ${conta.nome}: baixando ${titulo}...`);
  for (const etapa of etapas) {
    await clicar(page, etapa.textos, { timeout: etapa.timeout || 15000 });
    await espera(etapa.espera || 1200);
    await lidarCaptcha(page, conta.nome);
  }
  // o "Gerar arquivo" dispara o download
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    clicar(page, [/gerar arquivo/i], { timeout: 15000 }),
  ]);
  const sugerido = download.suggestedFilename() || `${arquivoBase}.xlsx`;
  const ext = path.extname(sugerido) || '.xlsx';
  const destino = path.join(PASTA, `${arquivoBase}_${hoje()}${ext}`);
  await download.saveAs(destino);
  console.log(`  ${conta.nome}: salvo ${path.basename(destino)}`);
  return destino;
}

/* Define o periodo "Outro periodo": preenche Data Inicial e Data Final e clica
   Aplicar. As datas sao <input type=date> (icone de calendario nativo), que o
   Playwright preenche em formato ISO (AAAA-MM-DD); se forem texto, usa DD/MM/AAAA. */
async function preencherData(campo, iso, br) {
  // 1) jeito normal: clicar e digitar (funciona no vendas). Se o campo estiver
  //    COBERTO por um overlay (caso da antecipacao), o clique falha — e ai cai
  //    pro modo 2.
  try {
    await campo.waitFor({ state: 'visible', timeout: 5000 });
    const tipo = (await campo.getAttribute('type').catch(() => '') || '').toLowerCase();
    if (tipo === 'date' && iso) {
      await campo.fill(iso); // input type=date: seta direto em ISO, sem digitar
    } else {
      await campo.click({ timeout: 4000 });
      await campo.fill('');
      await campo.pressSequentially(br, { delay: 60 });
    }
    await campo.evaluate(el => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }).catch(() => {});
    await espera(400);
    return;
  } catch { /* cai pro modo 2 */ }

  // 2) modo a prova de overlay: seta a data DIRETO no motor do calendario
  //    (flatpickr.setDate) ou no valor do input, disparando os eventos nativos —
  //    nao depende de clicar no campo.
  await campo.evaluate((el, { iso, br }) => {
    const d = iso ? new Date(iso + 'T00:00:00') : null;
    const fp = el._flatpickr
      || (el.closest && el.closest('.flatpickr-wrapper') && el.closest('.flatpickr-wrapper')._flatpickr)
      || (el.parentElement && el.parentElement._flatpickr);
    if (fp && typeof fp.setDate === 'function') { fp.setDate(d || br, true); return; }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, br);
    for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
  }, { iso, br }).catch(() => {});
  await espera(400);
}
/* Salva a PAGINA INTEIRA (pra eu ver tudo: campos, overlay e Aplicar no estado
   real). Guarda em erros/antecipacao_pagina_completa.html. */
async function dumpPaginaCompleta(page) {
  try {
    const html = await comTimeout(page.content(), 6000, 'dumpPaginaCompleta');
    fs.mkdirSync(PASTA_ERROS, { recursive: true });
    fs.writeFileSync(path.join(PASTA_ERROS, 'antecipacao_pagina_completa.html'), html);
    console.log('  (salvei a pagina inteira em erros\\antecipacao_pagina_completa.html)');
  } catch { /* */ }
}
/* acha os DOIS campos de data do popup (inicial e final), como elementos
   DISTINTOS. Tenta: 1) input[type=date]; 2) inputs cujo VALOR ja tem cara de
   data (os dois mostram "29/09/2026"); 3) por rotulo. */
async function acharCamposData(page) {
  const dd = page.locator('input[type="date"]');
  if (await dd.count().catch(() => 0) >= 2) return [dd.nth(0), dd.nth(1)];
  const all = page.locator('input');
  const n = await all.count().catch(() => 0);
  const idx = [];
  for (let i = 0; i < n && idx.length < 2; i++) {
    const v = await all.nth(i).inputValue().catch(() => '');
    if (/\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) idx.push(i);
  }
  if (idx.length >= 2) return [all.nth(idx[0]), all.nth(idx[1])];
  return [page.getByLabel(/data inicial/i).first(), page.getByLabel(/data final/i).first()];
}
/* Antecipacao: o periodo fica num CARD no canto ("Período / Últimos 7 Dias" +
   icone de calendario). Clicar no TEXTO do card nao abre nada — o onclick esta
   no card (ou no botao do calendario). Aqui acho o rotulo "Período", subo ate o
   ancestral clicavel e clico nele; se nao der, clico no icone de calendario. */
/* O tooltip (osui-tooltip custom-range-picker) tem o conteudo VAZIO quando
   fechado e so o preenche (campos + Aplicar) ao abrir. Entao "conteudo com
   filhos" e o sinal certeiro de que abriu. */
async function popupPeriodoAberto(page) {
  // sinal DEFINITIVO (visto no HTML): o tooltip ganha a classe osui-tooltip--is-open.
  if (await page.locator('.osui-tooltip--is-open .flatpickr-calendar, .osui-tooltip.custom-range-picker.osui-tooltip--is-open').count().catch(() => 0) >= 1) return true;
  // reforcos
  if (await page.getByText(/^\s*aplicar\s*$/i).first().isVisible({ timeout: 300 }).catch(() => false)) return true;
  if (await page.locator('.flatpickr-calendar .flatpickr-day').first().isVisible({ timeout: 300 }).catch(() => false)) return true;
  return false;
}
async function esperaPopup(page, ms = 5000) {
  const ate = Date.now() + ms;
  while (Date.now() < ate) {
    if (await popupPeriodoAberto(page)) return true;
    await espera(350);
  }
  return false;
}
/* Salva o HTML da regiao do periodo (pra eu ver a estrutura exata e acertar o
   clique sem chutar). Guarda em erros/antecipacao_periodo_dom.html. */
async function dumpPeriodoDOM(page) {
  try {
    const html = await comTimeout(page.evaluate(() => {
      const base = document.querySelector('[data-testid="generic-calendar-periodo-calendar"]')
        || document.querySelector('input[id$="FilterDateInit"]');
      let node = base;
      for (let i = 0; i < 7 && node && node.parentElement; i++) node = node.parentElement;
      return (node || document.body).outerHTML;
    }), 6000, 'dumpPeriodoDOM');
    fs.mkdirSync(PASTA_ERROS, { recursive: true });
    fs.writeFileSync(path.join(PASTA_ERROS, 'antecipacao_periodo_dom.html'), html);
    console.log('  (salvei o HTML da area de periodo em erros\\antecipacao_periodo_dom.html)');
  } catch { /* */ }
}
async function abrirPeriodoAntecipacao(page) {
  /* Mesmo calendario do vendas; so muda a abertura (no vendas e o botao "Outro
     período", aqui e o ICONE de calendario que abre um osui-tooltip). Esse tooltip
     ALTERNA a cada clique — se eu clicar varias vezes rapido, abro e FECHO. Entao:
     UM metodo por vez, e depois ESPERO com paciencia (ate 6s) o tooltip abrir
     (classe osui-tooltip--is-open), sem clicar por cima. */
  /* Espera LEVE (sem estourar tempo): fim das requisicoes e o icone visivel.
     Esperas longas demais estouravam o limite e sobrava pouco pro clique. */
  console.log('    (abrindo o calendario da antecipacao...)');
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await page.locator('[data-testid="calendar-trigger-icon"]').first()
    .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await espera(1800);
  if (await popupPeriodoAberto(page)) return true;

  const centroIcone = async () => {
    const b = await page.locator('[data-testid="calendar-trigger-icon"]').first().boundingBox();
    if (!b) throw new Error('sem box da imagem do icone');
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const metodos = [
    // 1) MOUSE HUMANO: chega de fora, passa POR CIMA do icone (hover real) e clica
    //    com pressionar-e-soltar. Esse calendario pode precisar do mouse em cima
    //    antes do clique (o clique "teleportado" do robo nao dispara o hover).
    async () => {
      const { x, y } = await centroIcone();
      await page.mouse.move(x - 50, y - 50);
      await espera(120);
      await page.mouse.move(x, y, { steps: 8 }); // movimento real ate o icone
      await espera(300);
      await page.mouse.down(); await espera(80); await page.mouse.up();
    },
    // 2) hover (locator) + clique no centro exato da imagem
    async () => {
      await page.locator('[data-testid="calendar-trigger-icon"]').first().hover({ timeout: 2500 });
      await espera(250);
      const { x, y } = await centroIcone();
      await page.mouse.click(x, y);
    },
    // 3) clique real na propria imagem (Playwright mira no centro dela)
    async () => page.locator('[data-testid="calendar-trigger-icon"]').first().click({ timeout: 3000 }),
    // 4) teclado: focar o link do icone e Enter (aciona o handler do <a>)
    async () => { const a = page.locator('[data-testid="generic-calendar-icon-calendar"] a').first(); await a.focus({ timeout: 2000 }); await a.press('Enter'); },
    // 5) API da propria OutSystems + eventos de mouse via JS no icone (blindado
    //    com tempo limite: em pagina ocupada o evaluate pode pendurar).
    async () => comTimeout(page.evaluate(() => {
      const w = document.querySelector('.osui-tooltip.custom-range-picker');
      try {
        const O = window.OutSystems;
        const api = (O && O.OSUI && O.OSUI.Patterns && O.OSUI.Patterns.TooltipAPI)
                 || (O && O.OSUI && O.OSUI.patterns && O.OSUI.patterns.TooltipAPI);
        if (api && api.Open && w) { try { api.Open(w.id); } catch { /* */ } try { api.Open(w.getAttribute('name')); } catch { /* */ } }
      } catch { /* */ }
      const t = document.querySelector('[data-testid="calendar-trigger-icon"]') || document.querySelector('[data-testid="generic-calendar-icon-calendar"] a');
      if (t) { try { t.scrollIntoView({ block: 'center' }); } catch { /* */ } for (const e of ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click']) t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true, view: window })); }
    }), 3000, 'abrir via JS'),
  ];
  // DUAS voltas pelas formas de clicar (timing varia por loja), cada metodo
  // seguido de espera paciente (3.5s) por is-open, sem clicar por cima.
  for (let volta = 0; volta < 2; volta++) {
    for (const faz of metodos) {
      if (await popupPeriodoAberto(page)) return true;
      try { await faz(); } catch { /* tenta o proximo */ }
      if (await esperaPopup(page, 2500)) { await espera(250); if (await popupPeriodoAberto(page)) return true; }
    }
  }
  return false;
}
/* Rede de seguranca: se o robo nao abrir o calendario da antecipacao sozinho,
   pede pra pessoa clicar (modo local) e detecta quando abrir — dai segue sozinho. */
async function esperarHumanoAbrirPeriodo(page, loja) {
  console.log(`\n  >>> ${loja}: nao consegui abrir o calendario da antecipacao sozinho.`);
  console.log('  >>> CLIQUE no icone de calendario do "Período" (canto direito da tela).');
  console.log('  >>> Assim que abrir, eu sigo sozinho (preencho as datas e baixo). Esperando ate 90s...\n');
  const ate = Date.now() + 90000;
  while (Date.now() < ate) {
    if (await popupPeriodoAberto(page)) { console.log(`  >>> ${loja}: abriu, obrigado! seguindo.\n`); return true; }
    await espera(1000);
  }
  return false;
}
/* Clica no "Aplicar" do seletor de periodo. O botao real (visto no HTML) e:
   <button class="btn-apply" data-testid="generic-calendar-button-aplicar">Aplicar</button>
   e fica no calendario flatpickr (fora do tooltip). Miro nele direto; se nao der
   por clique normal, aciono o clique no proprio motor (ignora overlay). */
async function aplicarPeriodo(page) {
  const btn = page.locator('[data-testid="generic-calendar-button-aplicar"], button.btn-apply').first();
  // O card invisivel (.data-range-picker-btn) pode ficar NA FRENTE do botao
  // Aplicar: um clique forcado "sem desligar" cai no card (nao no botao) e o
  // OutSystems ignora. Entao desligo o card, clico FORCADO no Aplicar (clique
  // real que cai no botao) e religo.
  const desliga = () => page.evaluate(() => {
    document.querySelectorAll('.data-range-picker-btn, [id$="data_range_picker_btn"]').forEach(b => { b.style.pointerEvents = 'none'; });
    document.querySelectorAll('.flatpickr-calendar').forEach(c => { c.style.pointerEvents = 'auto'; });
  }).catch(() => {});
  const religa = () => page.evaluate(() => {
    document.querySelectorAll('.data-range-picker-btn, [id$="data_range_picker_btn"]').forEach(b => { b.style.pointerEvents = ''; });
  }).catch(() => {});

  await btn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await desliga();
  await espera(150);
  let ok = false;
  try { await btn.click({ force: true, timeout: 4000 }); ok = true; } catch { /* */ }
  await religa();
  if (ok) return;
  // ultimo recurso (menos confiavel): clique no motor e por texto
  const okJs = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="generic-calendar-button-aplicar"]') || document.querySelector('button.btn-apply');
    if (b) { b.click(); return true; }
    return false;
  }).catch(() => false);
  if (okJs) return;
  const porTexto = await clicar(page, [/^\s*aplicar\s*$/i, /aplicar/i], { timeout: 4000 }).then(() => true).catch(() => false);
  if (porTexto) return;
  await dumpPaginaCompleta(page);
  throw new Error('nao achei o botao Aplicar do periodo');
}
/* -------- selecao de dia no calendario flatpickr (jeito que o motor respeita) --
   Digitar no campo NAO muda a selecao interna do flatpickr; o Aplicar usa a
   selecao do calendario. Entao a gente CLICA no dia certo. aria-label e tipo
   "Outubro 1, 2026" (dia sem zero a esquerda). */
const MESES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
function ariaDia(br) {
  const [d, m, y] = String(br).split('/').map(n => parseInt(n, 10));
  return `${MESES_PT[m - 1]} ${d}, ${y}`;
}
/* navega o calendario (setas prev/next) ate o mes/ano do 'br' aparecer */
async function navegarCalendario(page, br) {
  const [, m, y] = String(br).split('/').map(n => parseInt(n, 10));
  const alvo = y * 12 + (m - 1);
  for (let i = 0; i < 24; i++) {
    const atual = await comTimeout(page.evaluate(() => {
      const cal = document.querySelector('.flatpickr-calendar.open') || document.querySelector('.flatpickr-calendar');
      if (!cal) return null;
      const sel = cal.querySelector('.flatpickr-monthDropdown-months');
      const ano = cal.querySelector('input.cur-year');
      if (!sel || !ano) return null;
      return parseInt(ano.value, 10) * 12 + sel.selectedIndex;
    }), 2500, 'navegar mes').catch(() => null);
    if (atual === null || atual === alvo) return;
    const btn = atual < alvo ? '.flatpickr-calendar .flatpickr-next-month' : '.flatpickr-calendar .flatpickr-prev-month';
    await page.locator(btn).first().click({ timeout: 2000 }).catch(() => {});
    await espera(250);
  }
}
async function clicarDiaCalendario(page, br) {
  await navegarCalendario(page, br);
  const lbl = ariaDia(br);
  // O card do periodo (.data-range-picker-btn) fica NA FRENTE do calendario e
  // rouba o clique do dia. Desligo o pointer-events do card SO durante o clique e
  // RELIGO logo em seguida — senao o icone que abre o calendario (que fica dentro
  // do card) fica desligado e a proxima tentativa nao abre (foi o que travou).
  const desliga = () => page.evaluate(() => {
    document.querySelectorAll('.data-range-picker-btn, [id$="data_range_picker_btn"]').forEach(b => { b.style.pointerEvents = 'none'; });
    document.querySelectorAll('.flatpickr-calendar').forEach(c => { c.style.pointerEvents = 'auto'; });
  }).catch(() => {});
  const religa = () => page.evaluate(() => {
    document.querySelectorAll('.data-range-picker-btn, [id$="data_range_picker_btn"]').forEach(b => { b.style.pointerEvents = ''; });
  }).catch(() => {});

  await desliga();
  await espera(150); // deixa o pointer-events aplicar antes de clicar
  const dia = page.locator(`.flatpickr-day[aria-label="${lbl}"]:not(.prevMonthDay):not(.nextMonthDay):not(.flatpickr-disabled)`).first();
  await dia.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  try {
    // FORCE: pula a checagem de interceptacao do Playwright, mas o clique CONTINUA
    // sendo um clique de mouse REAL (confiavel) — com o card desligado, cai no dia,
    // e so assim o OutSystems registra a selecao.
    await dia.click({ force: true, timeout: 3500 });
  } catch {
    await dia.evaluate(el => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }).catch(() => {});
  }
  await religa();   // IMPORTANTE: religa o card pra nao travar o abrir na proxima
  await espera(400);
}
/* Seta a faixa [de, ate] direto na instancia do flatpickr (modo range), que e o
   que o Aplicar usa. Procura a instancia em qualquer elemento (._flatpickr). */
async function selecionarRangeFlatpickr(page, de, ate) {
  return await page.evaluate(({ de, ate }) => {
    const toDate = (s) => { const [d, m, y] = String(s).split('/').map(n => parseInt(n, 10)); return new Date(y, m - 1, d); };
    const inicio = toDate(de), fim = toDate(ate);
    let inst = null, instRange = null;
    for (const el of document.querySelectorAll('*')) {
      if (el._flatpickr) {
        inst = el._flatpickr;
        if (el._flatpickr.config && el._flatpickr.config.mode === 'range') { instRange = el._flatpickr; break; }
      }
    }
    const fp = instRange || inst;
    if (!fp || typeof fp.setDate !== 'function') return false;
    try { fp.setDate([inicio, fim], true); return true; } catch { return false; }
  }, { de, ate }).catch(() => false);
}
/* Le o periodo que ficou aplicado no card ("Período / 01/10/2026 - 07/10/2026"
   ou "Últimos 7 Dias"). Serve pra CONFERIR antes de exportar. */
async function lerPeriodoAplicado(page) {
  const sels = [
    '[data-testid="generic-calendar-periodo-calendar"]',
    '[id$="data_range_picker_btn_labels_label"]',
    '[id$="data_range_picker_btn_labels"]',
  ];
  for (const s of sels) {
    const t = await page.locator(s).first().innerText({ timeout: 1500 }).catch(() => '');
    if (t && t.trim()) return t.replace(/\s+/g, ' ').trim();
  }
  return '';
}
/* tipo: 'vendas' (tem botao "Outro período") ou 'antecipacao' (abre pelo icone
   de calendario). Decidido por QUEM chama — nao por adivinhacao de tela. */
async function definirPeriodo(page, conta, opt, tipo = 'vendas') {
  if (tipo === 'antecipacao') {
    /* Portal instavel: as vezes o dia nao seleciona, as vezes o Aplicar nao cola.
       Entao CONFERE cada passo e repete so o que faltou:
       1) abre; 2) clica os dias e confere que os CAMPOS viraram de/ate (re-clica
       ate 3x); 3) Aplica e confere o CARD (re-aplica ate 4x, reabrindo se fechou).
       So baixa quando o card mostra o periodo pedido. */
    const valInit = () => page.locator('input[id$="FilterDateInit"]').first().inputValue().catch(() => '');
    const valEnd = () => page.locator('input[id$="FilterDateEnd"]').first().inputValue().catch(() => '');
    const camposOk = async () => (await valInit()) === opt.de && (await valEnd()) === opt.ate;
    const selecionar = async () => {
      for (let s = 1; s <= 3 && !(await camposOk()); s++) {
        try { await clicarDiaCalendario(page, opt.de); await clicarDiaCalendario(page, opt.ate); }
        catch (e) { console.log(`  ${conta.nome}: clique nos dias falhou (${e.message})`); }
        await espera(400);
      }
      return camposOk();
    };

    const aberto = await abrirPeriodoAntecipacao(page);
    console.log(`  ${conta.nome}: calendario ${aberto ? 'ABRIU' : 'NAO abriu'}.`);
    if (!aberto) { await dumpPaginaCompleta(page); throw new Error('nao abriu o calendario da antecipacao'); }
    console.log(`  ${conta.nome}: selecionando os dias...`);
    await espera(500);
    if (!(await selecionar())) {
      await dumpPaginaCompleta(page);
      throw new Error(`os dias nao ficaram ${opt.de}-${opt.ate} (ficou ${await valInit()}-${await valEnd()})`);
    }
    console.log(`  ${conta.nome}: dias selecionados -> ${await valInit()} a ${await valEnd()}`);

    let aplicado = false;
    for (let a = 1; a <= 4 && !aplicado; a++) {
      await aplicarPeriodo(page);
      await espera(2200);
      const lbl = await lerPeriodoAplicado(page);
      if (lbl.includes(opt.de) && lbl.includes(opt.ate)) { aplicado = true; break; }
      console.log(`  ${conta.nome}: Aplicar nao colou (card="${lbl}"), re-tentando ${a}/4`);
      if (!(await popupPeriodoAberto(page))) {      // tooltip fechou: reabre e re-seleciona
        if (!(await abrirPeriodoAntecipacao(page))) break;
        await espera(400);
        await selecionar();
      }
    }
    try {
      fs.mkdirSync(PASTA_ERROS, { recursive: true });
      await page.screenshot({ path: path.join(PASTA_ERROS, `periodo_${limpo(conta.nome)}_${hoje()}.png`), fullPage: true });
    } catch { /* */ }
    console.log(`  ${conta.nome}: periodo aplicado na tela -> "${await lerPeriodoAplicado(page)}"`);
    if (!aplicado) {
      await dumpPaginaCompleta(page);
      throw new Error(`o periodo aplicado nao ficou ${opt.de} a ${opt.ate} (nao vou baixar arquivo errado)`);
    }
    return;
  }

  // ===== VENDAS: o botao "Outro período" revela os campos (input type=date). =====
  await clicar(page, [/outro per[ií]odo/i], { timeout: 8000 }).catch(() => {});
  await espera(1500);
  const [ini, fim] = await acharCamposData(page);
  await preencherData(ini, opt.deISO, opt.de);
  await preencherData(fim, opt.ateISO, opt.ate);
  try {
    fs.mkdirSync(PASTA_ERROS, { recursive: true });
    await page.screenshot({ path: path.join(PASTA_ERROS, `periodo_${limpo(conta.nome)}_${hoje()}.png`), fullPage: true });
    const vi = await ini.inputValue().catch(() => '?'); const vf = await fim.inputValue().catch(() => '?');
    console.log(`  ${conta.nome}: periodo preenchido -> inicial="${vi}" final="${vf}"`);
  } catch { /* */ }
  await aplicarPeriodo(page);
  await espera(2000);
}

/* -------- uma loja, inteira -------- */
async function processarConta(browser, conta, opt = {}) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const feitos = [];
  const periodoCustom = !!(opt.de && opt.ate);
  try {
    await entrar(page, conta);

    // VENDAS — Relatorio DETALHADO. Periodo: custom (ex. agosto) ou 7 dias.
    await clicar(page, ['Vendas', /^vendas/i], { timeout: 20000 });
    await espera(1500);
    await clicar(page, [/relat[oó]rio de vendas/i], { timeout: 8000 }).catch(() => {});
    await espera(1500);
    if (periodoCustom) await definirPeriodo(page, conta, opt, 'vendas');
    const sufixo = periodoCustom ? `_${opt.de.replace(/\//g, '')}-${opt.ate.replace(/\//g, '')}` : '';
    feitos.push(await baixar(page, conta, {
      titulo: periodoCustom ? `Vendas detalhado (${opt.de} a ${opt.ate})` : 'Vendas detalhado (7 dias)',
      arquivoBase: `vendas_detalhado_${limpo(conta.nome)}${sufixo}`,
      etapas: [
        ...(periodoCustom ? [] : [{ textos: [/ltimos 7 dias/i], espera: 1500 }]),
        { textos: [/exportar relat[oó]rio|exportar/i], espera: 1500 },
        { textos: [/relat[oó]rio detalhado/i], espera: 800 },
      ],
    }));

    /* --so-vendas: para por aqui, sem os relatorios de antecipacao */
    if (opt.soVendas) { await ctx.close(); return { conta: conta.nome, ok: true, faltouAntecip: false, arquivos: feitos }; }

    // ANTECIPACAO — Relatorio DETALHADO (so esse). As vezes a pagina demora a
    // carregar; tenta de novo uma vez. Se nao vier, marca para refazer (o Vendas
    // ja esta salvo) — nao some sem avisar.
    let faltouAntecip = false;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        console.log(`  ${conta.nome}: abrindo a tela de antecipacao... (tentativa ${tentativa})`);
        await clicar(page, ['Antecipação', /antecipa/i], { timeout: 15000 });
        await espera(2000);
        await clicar(page, [/relat[oó]rio de antecipa/i], { timeout: 12000 });
        await espera(1800);
        /* periodo: mesmo do vendas (datas) quando --de/--ate; senao, Ultimos 7 dias.
           A tela de antecipacao pode ter o seletor DIFERENTE do vendas; se o periodo
           por datas nao for aceito, NAO trava — baixa em 7 dias e avisa. */
        if (periodoCustom) {
          try { await comTimeout(definirPeriodo(page, conta, opt, 'antecipacao'), 90000, 'definir periodo antecipacao'); }
          catch (e) {
            try {
              fs.mkdirSync(PASTA_ERROS, { recursive: true });
              await page.screenshot({ path: path.join(PASTA_ERROS, `antecipacao_periodo_${limpo(conta.nome)}_${hoje()}.png`), fullPage: true });
            } catch { /* */ }
            console.log(`  ${conta.nome}: a antecipacao NAO aceitou o periodo ${opt.de} a ${opt.ate} (${e.message}). NAO vou baixar com periodo errado — marcada para refazer.`);
            throw e; // joga pro catch de fora: nao baixa arquivo mislabeled; marca faltouAntecip
          }
        } else await clicar(page, [/ltimos 7 dias/i], { timeout: 8000 });
        await espera(1500);
        // antecipacao DETALHADO (so esse)
        feitos.push(await baixar(page, conta, {
          titulo: periodoCustom ? `Antecipacao detalhado (${opt.de} a ${opt.ate})` : 'Antecipacao detalhado (por arranjo)',
          arquivoBase: `antecipacao_detalhado_${limpo(conta.nome)}${sufixo}`,
          etapas: [
            { textos: [/exportar/i], espera: 1500 },
            { textos: [/relat[oó]rio detalhado/i], espera: 800 },
          ],
        }));
        faltouAntecip = false;
        break;
      } catch (e) {
        faltouAntecip = true;
        if (tentativa === 1) {
          console.log(`  ${conta.nome}: antecipacao nao veio completa, tentando de novo...`);
          await espera(1500);
        } else {
          console.log(`  ${conta.nome}: faltou algum relatorio de antecipacao — marcada para refazer.`);
        }
      }
    }

    await ctx.close();
    return { conta: conta.nome, ok: true, faltouAntecip, arquivos: feitos };
  } catch (e) {
    // print da tela para entender o que travou
    try {
      fs.mkdirSync(PASTA_ERROS, { recursive: true });
      await page.screenshot({ path: path.join(PASTA_ERROS, `${limpo(conta.nome)}_${hoje()}.png`), fullPage: true });
    } catch { /* sem print */ }
    await ctx.close();
    const captcha = /CAPTCHA/i.test(e.message);
    return { conta: conta.nome, ok: false, captcha, erro: e.message, arquivos: feitos };
  }
}

/* -------- roda tudo -------- */
async function main() {
  let contas = carregarContas();
  /* Argumentos da linha de comando:
       --so-vendas            baixa SO o relatorio de vendas (pula antecipacao)
       --mes 2026-08 (ou 08)  periodo = o mes inteiro (ex.: agosto)
       --de 01/08/2026 --ate 31/08/2026   periodo por datas
       nomes/logins soltos    roda SO essas lojas (ex.: 02 isa02)
     Sem nada: comportamento de sempre (7 dias, vendas + 2 antecipacoes, todas). */
  const rawArgs = process.argv.slice(2);
  const opt = { soVendas: false, de: null, ate: null, deISO: null, ateISO: null };
  const filtro = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i].toLowerCase();
    if (a === '--so-vendas' || a === '--somente-vendas' || a === '--vendas') opt.soVendas = true;
    else if (a === '--de') opt.de = rawArgs[++i];
    else if (a === '--ate' || a === '--até') opt.ate = rawArgs[++i];
    else if (a === '--mes' || a === '--mês') opt.mes = rawArgs[++i];
    else if (a.startsWith('--')) { /* flag desconhecida: ignora */ }
    else filtro.push(a);
  }
  const dd = n => String(n).padStart(2, '0');
  if (opt.mes) {
    const m = String(opt.mes).match(/(\d{4})[-/.](\d{1,2})/) || String(opt.mes).match(/^(\d{1,2})$/);
    let ano, mes;
    if (m && m.length === 3) { ano = +m[1]; mes = +m[2]; } else if (m) { ano = new Date().getFullYear(); mes = +m[1]; }
    if (ano && mes >= 1 && mes <= 12) {
      const ultimo = new Date(ano, mes, 0).getDate();
      opt.de = `${dd(1)}/${dd(mes)}/${ano}`; opt.ate = `${dd(ultimo)}/${dd(mes)}/${ano}`;
    }
  }
  /* versao ISO (AAAA-MM-DD) para preencher <input type=date> */
  const paraISO = (br) => { const p = String(br).match(/(\d{2})\/(\d{2})\/(\d{4})/); return p ? `${p[3]}-${p[2]}-${p[1]}` : null; };
  if (opt.de && opt.ate) { opt.deISO = paraISO(opt.de); opt.ateISO = paraISO(opt.ate); }

  if (filtro.length) {
    contas = contas.filter(c => filtro.includes(String(c.nome).toLowerCase())
                             || filtro.includes(String(c.login).toLowerCase()));
    if (!contas.length) { console.error(`\nNenhuma loja bateu com: ${filtro.join(', ')}\n`); process.exit(1); }
  }
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Sicredi ${VERSAO} ===`);
  console.log(`Modo: ${MODO} | Lojas: ${contas.length}`
    + (filtro.length ? ` (so: ${contas.map(c => c.nome).join(', ')})` : ''));
  console.log(`Relatorios: ${opt.soVendas ? 'SO vendas' : 'vendas + 2 antecipacoes'}`
    + ` | Periodo: ${opt.de && opt.ate ? `${opt.de} a ${opt.ate}` : 'Ultimos 7 dias'}\n`);

  const browser = await chromium.launch({
    headless: MODO === 'ci',
    slowMo: MODO === 'local' ? 120 : 0,
  });

  const resultados = [];
  for (const conta of contas) {
    if (!conta.login || !conta.senha) {
      resultados.push({ conta: conta.nome || '(sem nome)', ok: false, erro: 'faltou login ou senha' });
      continue;
    }
    console.log(`\n== ${conta.nome} ==`);
    resultados.push(await processarConta(browser, conta, opt));
    await espera(2500 + Math.random() * 2500); // pausa entre lojas, sem pressa
  }
  await browser.close();

  // resumo final
  const ok = resultados.filter(r => r.ok);
  const captcha = resultados.filter(r => !r.ok && r.captcha);
  const falhou = resultados.filter(r => !r.ok && !r.captcha);
  const faltaAntecip = resultados.filter(r => r.ok && r.faltouAntecip);
  console.log('\n=================== RESUMO ===================');
  console.log(`Baixaram certo: ${ok.length} de ${resultados.length}`);
  if (faltaAntecip.length) console.log(`Vendas OK mas faltou antecipacao (rode de novo so essas): ${faltaAntecip.map(r => r.conta).join(', ')}`);
  if (captcha.length) console.log(`Faltaram (CAPTCHA, complete voce): ${captcha.map(r => r.conta).join(', ')}`);
  if (falhou.length) falhou.forEach(r => console.log(`Erro em ${r.conta}: ${r.erro}`));
  console.log('=============================================\n');

  fs.writeFileSync(path.join(PASTA, '_ultima-execucao.json'),
    JSON.stringify({ quando: new Date().toISOString(), modo: MODO, resultados }, null, 2));

  // no GitHub, falha o passo so se NINGUEM baixou (para aparecer o aviso)
  if (MODO === 'ci' && ok.length === 0) process.exit(1);
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
