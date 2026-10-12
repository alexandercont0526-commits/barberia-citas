@echo off
rem ==========================================================
rem  Barbería citas - lanzador para Windows
rem  Instala dependencias la primera vez y arranca el servidor.
rem  La app queda en  http://localhost:3000
rem ==========================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ERROR: No se encontró Node.js.
  echo  Instálalo en  https://nodejs.org  y vuelve a intentar.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando dependencias (solo la primera vez)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  Falló la instalación. Revisa tu conexión a internet.
    pause
    exit /b 1
  )
)

echo.
echo  Iniciando Barbería...
echo  Cliente:  http://localhost:3000
echo  Panel:    http://localhost:3000/panel
echo  Para detener: cierra esta ventana o presiona Ctrl+C
echo.
call npm start

echo.
pause