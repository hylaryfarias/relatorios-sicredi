#!/bin/bash
# ============================================================
#  Baixar EXTRATO do DIA UTIL ANTERIOR (Sicredi) — clique 2 vezes
# ============================================================
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo " Falta instalar o Node.js uma unica vez."
  echo " Abra:  https://nodejs.org  e instale a versao \"LTS\"."
  echo " Depois clique aqui de novo."
  echo ""
  read -p "Aperte Enter para fechar."
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "Preparando pela primeira vez, pode demorar alguns minutos..."
  npm install
  npx playwright install chromium
fi

if [ ! -f banco.json ]; then
  echo ""
  echo " Falta o arquivo \"banco.json\" com o acesso do Sicredi."
  echo " Copie o \"banco-EXEMPLO.json\", renomeie para \"banco.json\""
  echo " e preencha cnpj, login e senha. Ele fica so neste PC."
  echo ""
  read -p "Aperte Enter para fechar."
  exit 0
fi

node scripts/extrato-dia-anterior.js

echo ""
echo " Terminou. O extrato do dia util anterior esta na pasta \"extratos\"."
echo ""
read -p "Aperte Enter para fechar."
