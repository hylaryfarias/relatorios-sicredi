/* Robo do EXTRATO do DIA UTIL ANTERIOR — Sicredi Internet Banking PJ.
 *
 * Igual ao robo do extrato (extrato-banco.js), mas baixa SO o dia util
 * anterior a hoje. Ex.: rodando na segunda, baixa a sexta; rodando na terca
 * depois de um feriado na segunda, baixa a sexta tambem.
 *
 * Como funciona: calcula a data e chama o extrato-banco.js com
 * --de DATA --ate DATA. Login, contas, "pular", download — tudo igual.
 *
 * Dia util = segunda a sexta, fora os feriados nacionais em que os bancos
 * fecham (fixos + Carnaval, Sexta-feira Santa e Corpus Christi, calculados
 * pela Pascoa). Feriado local (municipal/estadual): ponha no banco.json
 *     "feriados": ["2026-01-20", "20/01/2026"]
 *
 * Uso:
 *   node scripts/extrato-dia-anterior.js              -> dia util anterior a hoje
 *   node scripts/extrato-dia-anterior.js --data 13/11/2026   -> essa data
 *   node scripts/extrato-dia-anterior.js --mostrar    -> so mostra a data, nao baixa
 *   (--ofx e numeros de conta funcionam igual ao robo normal) */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dd2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${dd2(d.getMonth() + 1)}-${dd2(d.getDate())}`;
const br = (d) => `${dd2(d.getDate())}/${dd2(d.getMonth() + 1)}/${d.getFullYear()}`;
const somaDias = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/* Domingo de Pascoa (algoritmo de Meeus/Jones/Butcher) */
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

/* feriados bancarios nacionais do ano, como 'AAAA-MM-DD' */
function feriadosNacionais(ano) {
  const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
  if (ano >= 2024) fixos.push('11-20'); // Consciencia Negra (nacional desde 2024)
  const p = pascoa(ano);
  const moveis = [-48, -47, -2, 60].map(n => iso(somaDias(p, n))); // Carnaval seg/ter, Sexta Santa, Corpus Christi
  return new Set([...fixos.map(f => `${ano}-${f}`), ...moveis]);
}

/* aceita "2026-11-20" ou "20/11/2026" */
function lerData(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

function feriadosLocais() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(RAIZ, 'banco.json'), 'utf8'));
    const lista = !Array.isArray(raw) && Array.isArray(raw.feriados) ? raw.feriados : [];
    return new Set(lista.map(lerData).filter(Boolean).map(iso));
  } catch { return new Set(); }
}

export function ehDiaUtil(d, extras = new Set()) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  const k = iso(d);
  return !feriadosNacionais(d.getFullYear()).has(k) && !extras.has(k);
}

export function diaUtilAnterior(hoje = new Date(), extras = new Set()) {
  let d = somaDias(hoje, -1);
  while (!ehDiaUtil(d, extras)) d = somaDias(d, -1);
  return d;
}

function main() {
  const args = process.argv.slice(2);
  const repassar = [];
  let dataFixa = null, soMostrar = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === '--data') dataFixa = lerData(args[++i] || '');
    else if (a === '--mostrar') soMostrar = true;
    else if (['--de', '--ate', '--até', '--mes', '--mês'].includes(a)) { i++; /* periodo e definido aqui */ }
    else repassar.push(args[i]);
  }
  if (args.some(a => a.toLowerCase() === '--data') && !dataFixa) {
    console.error('Data invalida em --data. Use 13/11/2026 ou 2026-11-13.');
    process.exit(1);
  }

  const dia = dataFixa || diaUtilAnterior(new Date(), feriadosLocais());
  console.log(`\n=== Extrato do dia util anterior: ${br(dia)} ===`);
  if (soMostrar) return;

  const filho = spawn(process.execPath,
    [path.join(RAIZ, 'scripts', 'extrato-banco.js'), '--de', br(dia), '--ate', br(dia), ...repassar],
    { stdio: 'inherit', cwd: RAIZ });
  filho.on('exit', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
