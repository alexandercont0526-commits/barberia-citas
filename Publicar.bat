@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
chcp 65001 >nul

echo ==========================================================
echo   Publicar "Barberia citas" en internet (GitHub + Railway)
echo ==========================================================
echo.
echo  Te pedira iniciar sesion en GitHub y en Railway (una vez).
echo.

where gh >nul 2>nul
if errorlevel 1 (
  echo  ERROR: falta GitHub CLI. Instala con:  winget install GitHub.cli
  pause & exit /b 1
)
where railway >nul 2>nul
if errorlevel 1 (
  echo  ERROR: falta Railway CLI. Instala con:  npm install -g @railway/cli
  pause & exit /b 1
)

echo --- Paso 1/4: sesion en GitHub ---
gh auth status >nul 2>nul
if errorlevel 1 (
  gh auth login
)

echo.
echo --- Paso 2/4: subir el proyecto a GitHub ---
set REPO=barberia-citas
gh repo view %REPO% >nul 2>nul
if errorlevel 1 (
  gh repo create %REPO% --public --source . --remote origin --push
) else (
  git remote get-url origin >nul 2>nul
  if errorlevel 1 git remote add origin https://github.com/%USERNAME%/%REPO%.git
  git push -u origin main
)

echo.
echo --- Datos de tu barberia ---
set /p SHOPNAME="Nombre de la barberia: "
set /p SHOPWA="WhatsApp con codigo de pais (ej 584121234567, Enter para omitir): "
set /p ADMINPW="Contrasena del panel (Enter para no cambiarla): "

echo.
echo --- Paso 3/4: sesion en Railway ---
railway login

echo.
echo --- Paso 4/4: crear proyecto y desplegar ---
railway init -n %REPO%
if not "%SHOPNAME%"=="" railway variables --set "SHOP_NAME=%SHOPNAME%" >nul
if not "%SHOPWA%"=="" railway variables --set "SHOP_WHATSAPP=%SHOPWA%" >nul
if not "%ADMINPW%"=="" railway variables --set "ADMIN_PASSWORD=%ADMINPW%" >nul
railway variables --set "NODE_VERSION=24" >nul
railway up --detach
railway domain

echo.
echo ==========================================================
echo   LISTO. El dominio de arriba (https://...) es tu app.
echo   - Clientes:  https://TU-DOMINIO
echo   - Tu panel:  https://TU-DOMINIO/panel
echo ==========================================================
pause
