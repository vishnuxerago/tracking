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

## Free public hosting (no payment / no credit card)

**Recommended free path:** run on your PC + **Cloudflare Quick Tunnel**.

- No card, no paid cloud account
- Works with Express, Socket.io, and the disk vault
- HTTPS public URL like `https://….trycloudflare.com`
- Your machine must stay on while the team uses it

```bash
npm install
npm run free:start
```

Or in two terminals:

```bash
npm run pm2:start
npm run share
```

Copy the `https://….trycloudflare.com` URL from the tunnel window and share it with the team.  
Set `APP_URL` in `.env` to that URL (then `npm run pm2:restart`) so emails/links point at the public address.

| Where | How |
|-------|-----|
| **Your PC (dev)** | `npm start` → http://localhost:3847 |
| **Free + public (no payment)** | `npm run free:start` (PM2 + Cloudflare tunnel) |
| **Paid / card-required clouds** | Oracle / many “Always Free” VMs ask for a card — skip if you want zero payment |

## Other hosts

| Platform | Fit |
|----------|-----|
| **Cloudflare Tunnel (this repo)** | **Best free, no payment** |
| **Netlify / Vercel** | **No** — not for Express + Socket.io + disk vault |
| **Render / Railway free** | Possible, but sleep / credits; not true forever-free |
| **Oracle Always Free** | Real VM free tier, but signup usually asks for a payment card |

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
