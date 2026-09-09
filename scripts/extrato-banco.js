/* Robo do EXTRATO bancario — Sicredi Internet Banking PJ.
 *
 * SO CONSULTA: entra com CNPJ + usuario + senha (teclado da tela), vai em
 * Consultas > Extrato, escolhe "Ultimos 7 dias", Pesquisar, e baixa a Planilha
 * (Excel) — o mesmo formato que o painel de conciliacao ja le. Guarda em
 * extratos/.
 *
 * Login em dois passos e sem CAPTCHA/2FA:
 *   1) CNPJ  -> Acessar
 *   2) usuario + senha pelo teclado embaralhado -> Acessar
 *
 * A senha e digitada CLICANDO nos botoes do teclado da tela. Cada botao tem
 * dois numeros ("4 ou 1"); para cada digito da senha, acha o botao que o
 * contem e clica. A posicao muda a cada login, entao rele a cada digito.
 *
 * Roda so no PC, com o navegador visivel (headless=false), devagar.
 * Por enquanto baixa a CONTA ATUAL; trocar de conta vem depois. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PASTA = path.join(RAIZ, 'extratos');
const URL_BANCO = process.env.BANCO_URL
  || 'https://ibpj.sicredi.com.br/ib-view/loginpj/preauth.html';
const VERSAO = 'extrato v1';
const espera = (ms) => new Promise(r => setTimeout(r, ms));
const hoje = () => new Date().toLocaleDateString('sv-SE');

const limpo = (s) => String(s || 'conta').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function carregarBanco() {
  if (process.env.BANCO_CONTA) return JSON.parse(process.env.BANCO_CONTA);
  const arq = path.join(RAIZ, 'banco.json');
  if (fs.existsSync(arq)) return JSON.parse(fs.readFileSync(arq, 'utf8'));
  throw new Error('Crie o arquivo banco.json com { "cnpj": "...", "login": "...", "senha": "..." }.');
}

async function digitarReal(campo, valor) {
  await campo.click();
  await campo.fill('');
  await campo.pressSequentially(valor, { delay: 60 });
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

/* senha pelo teclado embaralhado: para cada digito, clica o botao que o contem.
   Rele a cada digito porque a posicao pode mudar. */
async function senhaPeloTeclado(page, senha) {
  for (const d of senha) {
    const botao = page.locator('button, a, [role=button], input[type=button]')
      .filter({ hasText: /\d\s*ou\s*\d/i })
      .filter({ hasText: new RegExp(`(^|\\D)${d}(\\D|$)`) })
      .first();
    await botao.click({ timeout: 8000 });
    await espera(400);
  }
}

/* nome da conta selecionada (para o nome do arquivo), lido do seletor do topo */
async function contaAtual(page) {
  try {
    const opt = page.locator('select option:checked, select option[selected]')
      .filter({ hasText: /\d{3,4}\s*\d+-?\d/ }).first();
    const t = await opt.textContent({ timeout: 2000 });
    if (t && t.trim()) return t.trim();
  } catch { /* segue */ }
  return 'conta';
}

async function main() {
  const b = carregarBanco();
  fs.mkdirSync(PASTA, { recursive: true });
  console.log(`\n=== Robo Extrato ${VERSAO} ===\n`);

  const browser = await chromium.launch({ headless: false, slowMo: 120 });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  try {
    await page.goto(URL_BANCO, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await espera(2500);

    // passo 1 — CNPJ
    console.log('Login 1/2: CNPJ');
    await digitarReal(page.locator('input').first(), b.cnpj);
    await clicar(page, [/acessar/i], { timeout: 12000 });
    await espera(3500);

    // passo 2 — usuario + senha pelo teclado
    console.log('Login 2/2: usuario e senha (teclado da tela)');
    await digitarReal(page.locator('input:not([type=password])').first(), b.login);
    await espera(600);
    await senhaPeloTeclado(page, b.senha);
    await espera(500);
    await clicar(page, [/acessar/i], { timeout: 12000 });
    await espera(6000);

    // dentro do banco — ir para o Extrato
    console.log('Abrindo o Extrato...');
    await clicar(page, [/^extrato$/i, /extrato/i], { timeout: 20000 });
    await espera(3000);

    // periodo: Ultimos 7 dias (ja e o padrao; reforca so por seguranca)
    try {
      const sel = page.locator('select').filter({ has: page.locator('option', { hasText: /ltimos 7 dias/i }) }).first();
      await sel.selectOption({ label: 'Últimos 7 dias' });
    } catch { /* ja deve estar em 7 dias */ }
    await espera(800);
    await clicar(page, [/pesquisar/i], { timeout: 12000 });
    await espera(3500);

    // baixar a Planilha (Excel)
    const conta = await contaAtual(page);
    console.log(`Conta: ${conta} — baixando a planilha...`);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60000 }),
      clicar(page, [/gerar planilha/i], { timeout: 15000 }),
    ]);
    const sugerido = download.suggestedFilename() || 'extrato.xls';
    const ext = path.extname(sugerido) || '.xls';
    const destino = path.join(PASTA, `extrato_${limpo(conta)}_${hoje()}${ext}`);
    await download.saveAs(destino);
    console.log(`\nSalvo: ${path.basename(destino)}\n`);

    await ctx.close();
  } catch (e) {
    try {
      await page.screenshot({ path: path.join(PASTA, `erro_${hoje()}.png`), fullPage: true });
      console.log('(salvei um print do erro em extratos\\erro_...png)');
    } catch { /* sem print */ }
    await ctx.close();
    console.error('\nParou:', e.message, '\n');
  }
  await browser.close();
}

main().catch(e => { console.error('\nParou:', e.message, '\n'); process.exit(1); });
