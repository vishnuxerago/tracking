# Xerago IoT Command Center

Open-source shared project management for Xerago’s IoT / hardware / PCB / 3D / embedded team.

Enter a **project name** → **AI (or rule engine)** generates work by **designation** → **admin/manager** verifies → **teammates see tasks live** → files land in the **Cloud Document Vault**.

## Open-source stack

| Layer | Tech |
|-------|------|
| Server | Node.js + Express (MIT) |
| Auth | JWT + bcryptjs |
| Database | JSON file store (zero native deps) |
| Realtime | Socket.io |
| AI planner | [Ollama](https://ollama.com) local LLM (optional) + open rule fallback |
| Files | Cloud Document Vault (`data/cloud-vault`) |
| UI | Static HTML/CSS/JS |

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3847**

### Logins

| Login | Password | Role | Email |
|------|----------|------|-------|
| `dinesh` | `admin123` | **Admin / Manager** | `r.dinesh@xerago.com` |
| `vishnu` | `team123` | PCB Designer | `singamalavishnu@xerago.com` |
| `arun` | `team123` | 3D Designer | `arunkumar.s@xerago.com` |
| `daniel` | `team123` | Electronic Operator | `danielamirtharaj@xerago.com` |

## Live alerts

| Who acts | Who sees the toast |
|----------|--------------------|
| **Manager** (publish plan, verify/reject, vault upload, blockers) | **All teammates** |
| **Teammate** (submit work, vault upload, report blocker) | **Admin / manager only** |

## Email (SMTP on the server)

When admin **assigns / publishes a plan**, or **shares a vault file**, the server emails each recipient (uses team emails in Team Database).

```bash
set SMTP_HOST=smtp.office365.com
set SMTP_PORT=587
set SMTP_USER=your.name@xerago.com
set SMTP_PASS=your-app-or-mailbox-password
set SMTP_FROM=your.name@xerago.com
set APP_URL=http://localhost:3847
set VAULT_MAX_MB=5120
```

Without SMTP vars the server still runs and logs emails to the console (`mail: console-fallback`) — **real inbox mail needs SMTP**.

## Passwords

Click **Password** in the header (or you are prompted on first login). The new password is **bcrypt-hashed in `data/xerago-db.json`** on the server — not stored in localStorage (only the JWT session token is).

## Cloud vault size

- Default quota: **5 GB (5120 MB)** — soft limit on the server disk (`VAULT_MAX_MB`)
- Per file: ~**12 MB**
- Need more? Set `VAULT_MAX_MB=10240` (10 GB) or higher — limited only by free disk on the machine/host
- Footer shows live used / max

## Keep the server running

| Where | How |
|-------|-----|
| **Your PC (dev)** | `npm start` — stops when you close the terminal |
| **Your PC (always on)** | `npm run pm2:start` (PM2) — restarts if it crashes; machine must stay on |
| **Cloud (free forever)** | **Oracle Cloud Always Free** VM — see below |

## Host on Oracle Cloud Always Free (recommended)

Closest option to **set-and-forget free forever** for Express + Socket.io + disk vault.

### 1. Create the free VM (Oracle Console)

1. Sign up: [cloud.oracle.com](https://cloud.oracle.com) (Always Free)
2. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 22.04**
   - Shape: **VM.Standard.A1.Flex** (Ampere) — 1–2 OCPU, 6–12 GB RAM (Always Free)
   - Add your SSH public key
3. **Networking → VCN → Security List → Ingress rules** — allow:
   - TCP **22** (SSH)
   - TCP **80** (HTTP)
   - TCP **443** (HTTPS, optional later)
4. Note the instance **Public IP**

### 2. Deploy the app (SSH into the VM)

```bash
ssh ubuntu@YOUR_PUBLIC_IP
# If Oracle image uses opc:  ssh opc@YOUR_PUBLIC_IP

git clone https://github.com/vishnuxerago/tracking.git ~/xerago-engineering-dashboard
cd ~/xerago-engineering-dashboard
bash deploy/oracle/setup.sh
```

Open **http://YOUR_PUBLIC_IP**

PM2 keeps the process up across reboots. Nginx proxies port 80 → app `3847` (incl. Socket.io). Vault/DB stay on the VM disk under `data/`.

```bash
pm2 logs xerago-iot
nano ~/xerago-engineering-dashboard/.env   # SMTP, APP_URL, JWT_SECRET
pm2 restart xerago-iot --update-env
```

## Where else to host

| Platform | Can host this app? |
|----------|--------------------|
| **Oracle Always Free** | **Yes** — best free forever fit |
| **Netlify / Vercel** | **No** — no long-running Express / Socket.io / disk vault |
| **Render / Railway / Fly** | **Yes** — easy, but free tiers sleep or use credits |

Env vars: `JWT_SECRET`, `PORT`, `APP_URL`, `SMTP_*` (optional), `VAULT_MAX_MB` (optional).

`.gitignore` already excludes `node_modules/`, `data/`, and `.env`.

## Cloud Document Vault

- Grouped **by project**
- Task progress submissions land here under that project (`sharedWith: project`)
- Admin upload can share with **entire team**, **project team**, **specific people**, or **private**
- Admin can **Share** an existing file anytime (in-app toast + email)

## How it works

1. **Admin** creates a project (name + type + description).
2. **AI analyzes** which designations are needed (not everyone every time) and proposes tasks.
3. Manager reviews, then **confirms** — only then are tasks assigned.
4. Teammate attaches documents and **submits**; manager **verifies** to complete.
5. Live progress + directed toasts keep the right people informed.

## AI engines

1. **Ollama** (preferred) — `ollama pull llama3.2 && ollama serve`
2. **Groq** optional — set `GROQ_API_KEY`
3. **Smart analyzer** fallback — role selection by project text

```bash
set OLLAMA_URL=http://127.0.0.1:11434
set OLLAMA_MODEL=llama3.2
set GROQ_API_KEY=optional_groq_key
set PORT=3847
set JWT_SECRET=change-me-in-production
```

## Project layout

```
server/          Express API, AI planner, cloud vault, JSON DB
public/          UI (index.html + client.js)
data/            Runtime DB + cloud-vault files
```

## License

MIT — use and modify freely inside Xerago.
