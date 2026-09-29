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

const VERSAO = 'v11.2 (acha os 2 campos de data pelo valor + print de diagnostico)';
const espera = (ms) => new Promise(r => setTimeout(r, ms));

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
  await campo.waitFor({ state: 'visible', timeout: 8000 });
  const tipo = (await campo.getAttribute('type').catch(() => '') || '').toLowerCase();
  if (tipo === 'date' && iso) {
    await campo.fill(iso); // input type=date: seta direto em ISO, sem digitar
  } else {
    await campo.click();
    await campo.fill('');
    await campo.pressSequentially(br, { delay: 60 });
  }
  await campo.evaluate(el => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }).catch(() => {});
  await espera(400);
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
async function definirPeriodo(page, conta, opt) {
  await clicar(page, [/outro per[ií]odo/i], { timeout: 10000 });
  await espera(1500);
  const [ini, fim] = await acharCamposData(page);
  await preencherData(ini, opt.deISO, opt.de);
  await preencherData(fim, opt.ateISO, opt.ate);
  /* print de diagnostico ANTES de aplicar, para conferir se as duas datas
     entraram nos campos certos */
  try {
    fs.mkdirSync(PASTA_ERROS, { recursive: true });
    await page.screenshot({ path: path.join(PASTA_ERROS, `periodo_${limpo(conta.nome)}_${hoje()}.png`), fullPage: true });
    const vi = await ini.inputValue().catch(() => '?'); const vf = await fim.inputValue().catch(() => '?');
    console.log(`  ${conta.nome}: periodo preenchido -> inicial="${vi}" final="${vf}"`);
  } catch { /* */ }
  await clicar(page, [/aplicar/i], { timeout: 8000 });
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

    // VENDAS — Relatorio simplificado. Periodo: custom (ex. agosto) ou 7 dias.
    await clicar(page, ['Vendas', /^vendas/i], { timeout: 20000 });
    await espera(1500);
    await clicar(page, [/relat[oó]rio de vendas/i], { timeout: 8000 }).catch(() => {});
    await espera(1500);
    if (periodoCustom) await definirPeriodo(page, conta, opt);
    const sufixo = periodoCustom ? `_${opt.de.replace(/\//g, '')}-${opt.ate.replace(/\//g, '')}` : '';
    feitos.push(await baixar(page, conta, {
      titulo: periodoCustom ? `Vendas (${opt.de} a ${opt.ate}, simplificado)` : 'Vendas (7 dias, simplificado)',
      arquivoBase: `vendas_${limpo(conta.nome)}${sufixo}`,
      etapas: [
        ...(periodoCustom ? [] : [{ textos: [/ltimos 7 dias/i], espera: 1500 }]),
        { textos: [/exportar relat[oó]rio|exportar/i], espera: 1500 },
        { textos: [/relat[oó]rio simplificado/i], espera: 800 },
      ],
    }));

    /* --so-vendas: para por aqui, sem os relatorios de antecipacao */
    if (opt.soVendas) { await ctx.close(); return { conta: conta.nome, ok: true, faltouAntecip: false, arquivos: feitos }; }

    // ANTECIPACAO — DOIS relatorios da mesma tela: detalhado por arranjo e
    // simplificado por antecipacao. Todas as lojas tem. As vezes a pagina
    // demora a carregar; tenta de novo uma vez. Se nao vier completa, marca
    // para refazer (o Vendas ja esta salvo) — nao some sem avisar.
    let faltouAntecip = false;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        await clicar(page, ['Antecipação', /antecipa/i], { timeout: 15000 });
        await espera(2000);
        await clicar(page, [/relat[oó]rio de antecipa/i], { timeout: 12000 });
        await espera(1800);
        await clicar(page, [/ltimos 7 dias/i], { timeout: 8000 }); // periodo, uma vez so
        await espera(1500);
        // 1) detalhado por arranjo
        feitos.push(await baixar(page, conta, {
          titulo: 'Antecipacao detalhado (por arranjo)',
          arquivoBase: `antecipacao_detalhado_${limpo(conta.nome)}`,
          etapas: [
            { textos: [/exportar/i], espera: 1500 },
            { textos: [/relat[oó]rio detalhado/i], espera: 800 },
          ],
        }));
        // 2) simplificado por antecipacao
        feitos.push(await baixar(page, conta, {
          titulo: 'Antecipacao simplificado (por antecipacao)',
          arquivoBase: `antecipacao_simplificado_${limpo(conta.nome)}`,
          etapas: [
            { textos: [/exportar/i], espera: 1500 },
            { textos: [/relat[oó]rio simplificado/i], espera: 800 },
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
