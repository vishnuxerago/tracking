# Free public URL — no payment, no credit card
# Runs Cloudflare Quick Tunnel → https://….trycloudflare.com
# Requires: app already listening on http://127.0.0.1:3847
# Usage (from repo root):  powershell -ExecutionPolicy Bypass -File deploy/free/share.ps1

$ErrorActionPreference = "Stop"
$Port = if ($env:PORT) { $env:PORT } else { "3847" }
$Cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue

if (-not $Cloudflared) {
  Write-Host "Installing cloudflared (free Cloudflare tunnel CLI)..."
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path", "User")
  $Cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
}

if (-not $Cloudflared) {
  Write-Host "cloudflared not found. Install from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/ then re-run."
  exit 1
}

Write-Host ""
Write-Host "Publishing http://127.0.0.1:$Port with a FREE Cloudflare tunnel..."
Write-Host "Keep this window open. Share the https://….trycloudflare.com URL with your team."
Write-Host ""
& cloudflared tunnel --url "http://127.0.0.1:$Port"
