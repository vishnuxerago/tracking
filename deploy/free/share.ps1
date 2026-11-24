# Free public URL — no payment, no credit card
# Runs Cloudflare Quick Tunnel → https://….trycloudflare.com
# Requires: app already listening on http://127.0.0.1:3847
# Usage (from repo root):  powershell -ExecutionPolicy Bypass -File deploy/free/share.ps1

$ErrorActionPreference = "Continue"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$LocalBin = Join-Path $Root "tools\cloudflared.exe"
$CloudflaredCmd = $null

if (Test-Path $LocalBin) {
  $CloudflaredCmd = $LocalBin
} else {
  $found = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($found) { $CloudflaredCmd = $found.Source }
}

if (-not $CloudflaredCmd) {
  Write-Host "Downloading portable cloudflared into tools\ (no installer / no admin)..."
  New-Item -ItemType Directory -Force -Path (Join-Path $Root "tools") | Out-Null
  Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-windows-amd64.exe" -OutFile $LocalBin -UseBasicParsing
  $CloudflaredCmd = $LocalBin
}

Write-Host ""
Write-Host "Publishing http://127.0.0.1:$Port with a FREE Cloudflare tunnel..."
Write-Host "Keep this window open. Share the https://….trycloudflare.com URL with your team."
Write-Host ""
& $CloudflaredCmd tunnel --url "http://127.0.0.1:$Port"
