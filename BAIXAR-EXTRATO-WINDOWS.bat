@echo off
REM ============================================================
REM  Baixar EXTRATO Sicredi (Internet Banking) — clique 2 vezes
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

if not exist banco.json (
  echo.
  echo  Falta o arquivo "banco.json" com o acesso do Sicredi.
  echo  Copie o "banco-EXEMPLO.json", renomeie para "banco.json"
  echo  e preencha cnpj, login e senha. Ele fica so neste PC.
  echo.
  pause
  exit /b
)

node scripts\extrato-banco.js

echo.
echo  Terminou. Os extratos estao na pasta "extratos".
echo.
pause
