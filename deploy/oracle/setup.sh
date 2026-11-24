#!/usr/bin/env bash
# Xerago IoT — Oracle Cloud Always Free bootstrap (Ubuntu 22.04 / 24.04)
# Run on the VM as ubuntu (or opc) with sudo:
#   curl -fsSL … | bash   OR   bash deploy/oracle/setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/xerago-engineering-dashboard}"
REPO_URL="${REPO_URL:-https://github.com/vishnuxerago/tracking.git}"
BRANCH="${BRANCH:-main}"

echo "==> Installing Node 20, nginx, git, ufw helpers"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get update -y
sudo apt-get install -y nodejs git nginx ufw

echo "==> Node $(node -v) / npm $(npm -v)"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "==> Cloning $REPO_URL → $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  echo "==> Repo exists — pulling latest"
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi

cd "$APP_DIR"
npm install --omit=dev
sudo npm install -g pm2

if [[ ! -f .env ]]; then
  echo "==> Creating .env from example (EDIT JWT_SECRET + APP_URL)"
  cp .env.example .env
  # Random JWT secret
  SECRET=$(openssl rand -hex 32)
  if grep -q '^JWT_SECRET=' .env; then
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
  else
    echo "JWT_SECRET=$SECRET" >> .env
  fi
fi

mkdir -p data/cloud-vault

echo "==> Starting with PM2"
pm2 delete xerago-iot 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save
sudo env PATH=$PATH pm2 startup systemd -u "$USER" --hp "$HOME" | tail -n 1 | bash || true

PUBLIC_IP="$(curl -fsSL -m 5 https://ifconfig.me || curl -fsSL -m 5 https://api.ipify.org || echo YOUR_PUBLIC_IP)"
sed "s/YOUR_PUBLIC_IP_OR_DOMAIN/$PUBLIC_IP/g" deploy/oracle/nginx-xerago.conf | sudo tee /etc/nginx/sites-available/xerago >/dev/null
sudo ln -sf /etc/nginx/sites-available/xerago /etc/nginx/sites-enabled/xerago
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

echo "==> Opening firewall (UFW) — also open these in Oracle VCN Security List"
sudo ufw allow OpenSSH || true
sudo ufw allow 80/tcp || true
sudo ufw allow 443/tcp || true
sudo ufw --force enable || true

# Load APP_URL into .env
if grep -q '^APP_URL=' .env; then
  sed -i "s|^APP_URL=.*|APP_URL=http://$PUBLIC_IP|" .env
else
  echo "APP_URL=http://$PUBLIC_IP" >> .env
fi
pm2 restart xerago-iot --update-env

echo ""
echo "============================================"
echo "  Xerago IoT is up (Oracle Always Free)"
echo "  → http://$PUBLIC_IP"
echo ""
echo "  Next:"
echo "  1. Oracle Console → VCN → Security List → Ingress:"
echo "     TCP 22, 80, 443 (source 0.0.0.0/0)"
echo "  2. Edit $APP_DIR/.env (SMTP, JWT already set)"
echo "  3. pm2 logs xerago-iot"
echo "============================================"
