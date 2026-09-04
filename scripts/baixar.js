/* Robo que baixa os relatorios do portal Sicredi maquininhas.
 *
 * Para cada loja: entra com login e senha, pede o codigo por e-mail, le o
 * codigo sozinho, e baixa dois relatorios dos ultimos 7 dias — Vendas
 * (simplificado) e Antecipacao (detalhado por arranjo). Guarda tudo na pasta
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

const VERSAO = 'v8 (senha unica)';
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

/* -------- uma loja, inteira -------- */
async function processarConta(browser, conta) {
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const feitos = [];
  try {
    await entrar(page, conta);

    // VENDAS — Relatorio simplificado, ultimos 7 dias
    await clicar(page, ['Vendas', /^vendas/i], { timeout: 20000 });
    await espera(1500);
    await clicar(page, [/relat[oó]rio de vendas/i], { timeout: 8000 }).catch(() => {});
    await espera(1500);
    feitos.push(await baixar(page, conta, {
      titulo: 'Vendas (7 dias, simplificado)',
      arquivoBase: `vendas_${limpo(conta.nome)}`,
      etapas: [
        { textos: [/ltimos 7 dias/i], espera: 1500 },
        { textos: [/exportar relat[oó]rio|exportar/i], espera: 1500 },
        { textos: [/relat[oó]rio simplificado/i], espera: 800 },
      ],
    }));

    // ANTECIPACAO — Relatorio detalhado por arranjo, ultimos 7 dias
    await clicar(page, ['Antecipação', /antecipa/i], { timeout: 20000 });
    await espera(1500);
    await clicar(page, [/relat[oó]rio de antecipa/i], { timeout: 10000 });
    await espera(1500);
    feitos.push(await baixar(page, conta, {
      titulo: 'Antecipacao (7 dias, detalhado)',
      arquivoBase: `antecipacao_${limpo(conta.nome)}`,
      etapas: [
        { textos: [/ltimos 7 dias/i], espera: 1200 },
        { textos: [/exportar/i], espera: 1500 },
        { textos: [/relat[oó]rio detalhado/i], espera: 800 },
      ],
    }));

    await ctx.close();
    return { conta: conta.nome, ok: true, arquivos: feitos };
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
  const contas = carregarContas();
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Sicredi ${VERSAO} ===`);
  console.log(`Modo: ${MODO} | Lojas: ${contas.length}\n`);

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
    resultados.push(await processarConta(browser, conta));
    await espera(2500 + Math.random() * 2500); // pausa entre lojas, sem pressa
  }
  await browser.close();

  // resumo final
  const ok = resultados.filter(r => r.ok);
  const captcha = resultados.filter(r => !r.ok && r.captcha);
  const falhou = resultados.filter(r => !r.ok && !r.captcha);
  console.log('\n=================== RESUMO ===================');
  console.log(`Baixaram certo: ${ok.length} de ${resultados.length}`);
  if (captcha.length) console.log(`Faltaram (CAPTCHA, complete voce): ${captcha.map(r => r.conta).join(', ')}`);
  if (falhou.length) falhou.forEach(r => console.log(`Erro em ${r.conta}: ${r.erro}`));
  console.log('=============================================\n');

  fs.writeFileSync(path.join(PASTA, '_ultima-execucao.json'),
    JSON.stringify({ quando: new Date().toISOString(), modo: MODO, resultados }, null, 2));

  // no GitHub, falha o passo so se NINGUEM baixou (para aparecer o aviso)
  if (MODO === 'ci' && ok.length === 0) process.exit(1);
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
