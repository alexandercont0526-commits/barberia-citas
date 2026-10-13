# ============================================================
#  Barbería citas - arranque público (GRATIS, sin cuentas)
#  Levanta el servidor + un túnel de Cloudflare y muestra
#  el link que abren tus clientes y el de tu panel.
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Write-Host "=== Barberia citas - modo publico gratis ===" -ForegroundColor Cyan

# 1) Dependencias
if (-not (Test-Path 'node_modules')) {
  Write-Host "Instalando dependencias (primera vez)..." -ForegroundColor Yellow
  npm install --no-audit --no-fund | Out-Null
}

# 2) Cloudflare Tunnel (se descarga una vez)
$cf = Join-Path $PSScriptRoot 'tools\cloudflared.exe'
if (-not (Test-Path $cf)) {
  Write-Host "Descargando Cloudflare Tunnel..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'tools') | Out-Null
  Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
}

# 3) Servidor (si ya está corriendo en el 3000, no lo duplicamos)
$enUso = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $enUso) {
  Write-Host "Arrancando servidor..." -ForegroundColor Yellow
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Minimized
  Start-Sleep -Seconds 3
} else {
  Write-Host "El servidor ya estaba corriendo en el puerto 3000." -ForegroundColor DarkGray
}

# 4) Túnel público
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$log = Join-Path $env:TEMP 'barberia-tunnel.log'
$out = Join-Path $env:TEMP 'barberia-tunnel.out.log'
Remove-Item $log, $out -Force -ErrorAction SilentlyContinue

Write-Host "Abriendo el tunel publico..." -ForegroundColor Yellow
Start-Process -FilePath $cf `
  -ArgumentList 'tunnel','--no-autoupdate','--edge-ip-version','4','--protocol','http2','--url','http://localhost:3000' `
  -WindowStyle Minimized `
  -RedirectStandardError $log `
  -RedirectStandardOutput $out

# 5) Leer la URL
$url = $null
for ($i = 0; $i -lt 45 -and -not $url; $i++) {
  Start-Sleep -Seconds 1
  foreach ($f in @($log, $out)) {
    if (Test-Path $f) {
      $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($m) { $url = $m.Matches.Value; break }
    }
  }
}

Write-Host ""
if ($url) {
  Write-Host "================================================" -ForegroundColor Green
  Write-Host "  LINK PARA TUS CLIENTES:" -ForegroundColor Green
  Write-Host "   $url" -ForegroundColor White
  Write-Host ""
  Write-Host "  TU PANEL DE ADMINISTRADOR:" -ForegroundColor Green
  Write-Host "   $url/panel" -ForegroundColor White
  Write-Host "================================================" -ForegroundColor Green
  Start-Process $url/panel | Out-Null
} else {
  Write-Host "No pude leer el link automaticamente." -ForegroundColor Yellow
  Write-Host "Busca la ventana minimizada de 'cloudflared' y copia el link https://....trycloudflare.com" -ForegroundColor Yellow
}

Write-Host ""
Read-Host "Presiona Enter para cerrar esta ventana (la app sigue corriendo)"