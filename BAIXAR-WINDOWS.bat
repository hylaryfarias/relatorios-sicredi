@echo off
REM ============================================================
REM  Baixar relatorios Sicredi — clique duas vezes neste arquivo
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta instalar o Node.js uma unica vez.
  echo  Abra:  https://nodejs.org  e instale a versao "LTS".
  echo  Depois clique aqui de novo.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo Preparando pela primeira vez, pode demorar alguns minutos...
  call npm install
  call npx playwright install chromium
)

set MODO=local
node scripts\baixar.js

echo.
echo  Terminou. Os arquivos estao na pasta "relatorios".
echo.
pause
