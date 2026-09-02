#!/bin/bash
# ============================================================
#  Baixar relatorios Sicredi — clique duas vezes neste arquivo
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

export MODO=local
node scripts/baixar.js

echo ""
echo " Terminou. Os arquivos estao na pasta \"relatorios\"."
echo ""
read -p "Aperte Enter para fechar."
