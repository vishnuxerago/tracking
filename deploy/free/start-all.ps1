# Free forever (no payment): start app with PM2 + open a Cloudflare public URL
# Usage: powershell -ExecutionPolicy Bypass -File deploy/free/start-all.ps1

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $Root

if (-not (Test-Path "node_modules")) {
  Write-Host "Installing npm dependencies..."
  npm install
}

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example — set JWT_SECRET / SMTP when you can."
}

Write-Host "Starting Xerago IoT with PM2..."
npx pm2 delete xerago-iot 2>$null
npx pm2 start ecosystem.config.cjs
npx pm2 save

Write-Host ""
Write-Host "App local: http://localhost:3847"
Write-Host "Opening free public tunnel..."
Write-Host ""

& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "share.ps1")
