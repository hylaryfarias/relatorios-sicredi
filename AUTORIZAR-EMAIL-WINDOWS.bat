@echo off
REM ============================================================
REM  Autorizar leitura do e-mail — rode UMA vez (clique duplo)
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta instalar o Node.js primeiro. Abra https://nodejs.org e instale a versao LTS.
  echo.
  pause
  exit /b
)

if not exist node_modules (
  echo Preparando pela primeira vez, pode demorar alguns minutos...
  call npm install
)

node scripts\autorizar-gmail.js

echo.
pause
