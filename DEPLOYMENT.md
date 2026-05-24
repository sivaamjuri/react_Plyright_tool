# Step-by-step: deploy backend (AWS EC2) + frontend (Vercel)

## Automated steps (this repo)

**On your Windows PC** (from the `react_Plyright_tool` folder):

```powershell
powershell -ExecutionPolicy Bypass -File deploy\preflight.ps1
```

That script: creates `backend/.env` and `frontend/.env` from `.env.example` if missing, runs `npm install` in `backend`, `backend/master_project`, and `frontend`, then installs Playwright Chromium in `backend`.

**On Ubuntu EC2** (after `git clone` and `cd` into the repo root):

```bash
bash deploy/ec2-bootstrap.sh
```

That script: creates `backend/.env` from the example if missing, installs backend + `master_project` deps, installs Playwright with system deps, installs PM2 if missing. You still edit `.env` for CORS and run `pm2 start` (commands print at the end).

**Architecture, CORS, networking, and why cloud steps are manual:** see **[DEPLOYMENT-DEEP-DIVE.md](./DEPLOYMENT-DEEP-DIVE.md)**.

---

Follow the steps in order. Replace placeholders like `YOUR_GITHUB_USER` and `your-app` with your real values.

---

## What you will create (files and cloud settings)

| Location | File / setting | Purpose |
|----------|----------------|--------|
| **Your laptop (repo)** | `backend/.env` | **Do not commit.** Server port + CORS. Only on EC2 in production (create there). |
| **Your laptop (repo)** | `frontend/.env` | **Do not commit.** Optional for local dev; uses `VITE_API_URL`. |
| **Repo (committed)** | `backend/.env.example` | Template — safe to commit. |
| **Repo (committed)** | `frontend/.env.example` | Template — safe to commit. |
| **EC2 server** | `backend/.env` | Real `PORT` + `CORS_ORIGINS` for production. |
| **Vercel dashboard** | Environment variable `VITE_API_URL` | Tells the built frontend where the API is (no `frontend/.env` on Vercel unless you use their file-based env). |

**Rules**

- Never put secrets in committed files. This app mainly needs **URLs and CORS origins**, not API keys.
- **No trailing slash** on `VITE_API_URL` (example: `https://api.example.com` not `https://api.example.com/`).
- **CORS_ORIGINS** must list the **exact** browser origin(s) of your frontend (scheme + host + port if any), comma-separated.

---

## Part 1 — Backend on AWS EC2 (step by step)

Do these in order. Replace placeholders (`YOUR_KEY.pem`, `YOUR_GITHUB_USER`, IPs, URLs) with your values.

---

### Step A — Create an AWS account and open EC2 (one-time)

1. Go to [https://aws.amazon.com](https://aws.amazon.com) and sign in (or create an account).
2. In the top search bar, type **EC2** and open **EC2**.

---

### Step B — Create a key pair (one-time, if you do not have one)

1. In the left menu: **Network & Security** → **Key pairs**.
2. **Create key pair**.
3. Name: e.g. `ui-similarity-ec2`.
4. Type: **RSA** (or default).
5. Format: **`.pem`** (for Mac/Linux/Git Bash/WSL on Windows).
6. **Create key pair** — your browser downloads `ui-similarity-ec2.pem`.
7. **Store it safely** (Downloads folder is OK short-term). You cannot download it again from AWS.

---

### Step C — Create a security group (firewall rules)

1. Left menu: **Security Groups** → **Create security group**.
2. **Name:** e.g. `ui-similarity-sg`.
3. **VPC:** leave default (same VPC you will use for the instance).
4. **Inbound rules** — add:

| Type | Port | Source | Purpose |
|------|------|--------|---------|
| SSH | 22 | **My IP** | You SSH into the server |
| Custom TCP | 3000 | **My IP** first (testing) | Your API (`server.js`) |

5. For a **public** API later you may change **3000** to **0.0.0.0/0** (anyone) — only if you understand the risk. Better long-term: **HTTPS on 443** via Nginx and do **not** expose 3000 publicly.
6. **Outbound rules:** keep default (allow all outbound).
7. **Create security group**.

---

### Step D — Launch the EC2 instance

1. **EC2** → **Instances** → **Launch instances**.
2. **Name:** e.g. `ui-similarity-api`.
3. **AMI:** **Ubuntu Server 22.04 LTS** (64-bit x86).
4. **Instance type:** **t3.small** (recommended) or at least **t3.micro** for light tests.
5. **Key pair:** select the `.pem` key you created (Step B).
6. **Network settings:**
   - **Edit** → select your **security group** from Step C.
   - **Auto-assign public IP:** **Enable** (needed to reach the server from the internet unless you use a VPN/bastion).
7. **Configure storage:** **20–30 GiB** **gp3** is reasonable (Playwright + `node_modules` need space).
8. **Launch instance** → wait until **Instance state** = **Running**.
9. Select the instance → copy **Public IPv4 address** (e.g. `3.14.159.26`) and/or **Public IPv4 DNS** (e.g. `ec2-3-14-159-26.compute-1.amazonaws.com`).

---

### Step E — SSH into the server (from your computer)

**Linux / macOS / WSL / Git Bash:**

```bash
chmod 400 /path/to/ui-similarity-ec2.pem
ssh -i /path/to/ui-similarity-ec2.pem ubuntu@YOUR_EC2_PUBLIC_DNS
```

**Windows (PowerShell)** — use full path to `.pem` and the correct user (`ubuntu` for Ubuntu AMI):

```powershell
cd $env:USERPROFILE\Downloads
icacls .\ui-similarity-ec2.pem /inheritance:r
icacls .\ui-similarity-ec2.pem /grant:r "$($env:USERNAME):(R)"
ssh -i .\ui-similarity-ec2.pem ubuntu@ec2-xx-xx-xx-xx.compute-1.amazonaws.com
```

- First connection: type **`yes`** when asked to trust the host fingerprint.
- If **Permission denied (publickey)**:** wrong `.pem`, wrong username, or wrong DNS/IP.

You should see a shell prompt like `ubuntu@ip-...:~$`.

---

### Step F — Install Node.js 20 and Git (on the server)

Run on EC2:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get update
sudo apt-get install -y nodejs build-essential git
node -v
```

You want **`v20.x.x`** (or newer LTS).

---

### Step G — Clone this repository (on the server)

Use your real GitHub URL (HTTPS is simplest if you have not set up deploy keys):

```bash
sudo mkdir -p /opt && sudo chown ubuntu:ubuntu /opt
cd /opt
git clone https://github.com/YOUR_GITHUB_USER/react_Plyright_tool.git ui-similarity
cd ui-similarity
```

If the repo is **private**, use a **Personal Access Token** (GitHub → Settings → Developer settings) as the password when `git` prompts, or configure [SSH deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh).

---

### Step H — Run the automated backend bootstrap (on the server)

From the **repo root** (`/opt/ui-similarity`):

```bash
bash deploy/ec2-bootstrap.sh
```

This installs:

- `backend` npm packages  
- Playwright **Chromium** + common **Linux** dependencies (`--with-deps`)  
- `backend/master_project` npm packages (needed for **Vite** ZIP uploads)  
- **PM2** globally (if not already installed)

If anything fails, read the terminal output; re-run `bash deploy/ec2-bootstrap.sh` after fixing (e.g. network).

**Manual equivalent** (if you prefer not to use the script) — from repo root:

```bash
cd backend
npm install
npx playwright install --with-deps chromium
cd master_project
npm install --no-audit --no-fund --legacy-peer-deps
cd ..
```

---

### Step I — Create and edit `backend/.env` (on the server)

```bash
cd /opt/ui-similarity/backend
cp .env.example .env
nano .env
```

Set at least:

```env
PORT=3000
CORS_ORIGINS=http://localhost:5173
```

- **After** you deploy the frontend (Vercel), add its origin on a **new line** in the same variable (comma-separated, **no spaces** after commas), for example:

```env
PORT=3000
CORS_ORIGINS=https://your-app.vercel.app,http://localhost:5173
```

Save in **nano:** `Ctrl+O`, **Enter**, `Ctrl+X`.

---

### Step J — Start the API with PM2 (on the server)

```bash
cd /opt/ui-similarity/backend
pm2 start server.js --name ui-similarity-api
pm2 save
pm2 startup
```

`pm2 startup` prints a **`sudo env PATH=... pm2 ...`** command — **copy and run that exact line**, then:

```bash
pm2 save
```

Check status:

```bash
pm2 status
pm2 logs ui-similarity-api --lines 50
```

You should see a log line like **Server running on http://localhost:3000** (inside the VM, Express binds to `0.0.0.0` per `server.js`).

---

### Step K — Verify from your PC

1. **Security group** must allow **TCP 3000** from **your current public IP** (or `0.0.0.0/0` while testing).
2. In a browser: `http://YOUR_EC2_PUBLIC_IP:3000`  
   - A **404** on `/` is normal (no route defined).  
   - If the page **loads** or you get a JSON/HTML error from Express, the server is **reachable**.
3. Optional — from your PC terminal:

```bash
curl -i http://YOUR_EC2_PUBLIC_IP:3000/
```

You want **HTTP response** (even 404), not timeout.

The real workload is **`POST /compare`** (multipart); the UI uses that after you set **`VITE_API_URL`** on Vercel (Part 2).

---

### Step L — After you have a Vercel URL (do not skip)

1. Edit `CORS_ORIGINS` again to include **`https://....vercel.app`** (exact origin).
2. Restart:

```bash
pm2 restart ui-similarity-api
```

---

### Quick reference — paths on the server

| Path | Role |
|------|------|
| `/opt/ui-similarity/backend/server.js` | API entry |
| `/opt/ui-similarity/backend/.env` | `PORT`, `CORS_ORIGINS` |
| `/opt/ui-similarity/backend/master_project/node_modules` | Shared deps for uploaded Vite projects |
| `/opt/ui-similarity/backend/temp/` | Extracted uploads (transient) |

---

### Ubuntu 26.04 + Playwright (if `playwright install` failed)

Playwright **1.58** does not ship Chromium for **ubuntu26.04-x64** yet. You can either:

**Option A — Recommended:** Launch a **new** EC2 instance using **Ubuntu Server 24.04 LTS** (or **22.04 LTS**) instead of 26.04, then clone and run `bash deploy/ec2-bootstrap.sh` again.

**Option B — Workaround on Ubuntu 26.04** (uses Ubuntu 24.04 browser binaries; [Playwright community workaround](https://github.com/microsoft/playwright/issues/40117)):

```bash
export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64
cd /opt/ui-similarity/backend
npx playwright install --with-deps chromium
```

If `--with-deps` still errors, run:

```bash
npx playwright install chromium
```

Finish **`master_project`** if the script stopped before it:

```bash
cd /opt/ui-similarity/backend/master_project
npm install --no-audit --no-fund --legacy-peer-deps
```

Start the API **with the same env var** so Playwright works at runtime:

```bash
cd /opt/ui-similarity
```

Create `deploy/pm2.ecosystem.cjs` (adjust `cwd` if your path is different):

```bash
cat > /opt/ui-similarity/deploy/pm2.ecosystem.cjs <<'EOF'
module.exports = {
  apps: [{
    name: 'ui-similarity-api',
    cwd: '/opt/ui-similarity/backend',
    script: 'server.js',
    env: { PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu24.04-x64' },
  }],
};
EOF
pm2 start /opt/ui-similarity/deploy/pm2.ecosystem.cjs
pm2 save
```

After you **git pull** the latest repo, `deploy/ec2-bootstrap.sh` applies this automatically on Ubuntu 26.x and writes the PM2 config for you.

---

### Security reminder

- Do **not** leave **SSH (22)** open to `0.0.0.0/0` if you can avoid it.
- **`POST /compare`** is heavy and **unauthenticated** in the default app — lock down **who can reach port 3000** (IP allowlist, VPN, or Nginx + auth/TLS) before going wide public.

---

## Part 2 — Frontend on Vercel

### 2.1 Push your code to GitHub

Ensure the latest `frontend/` and `backend/` are on the branch Vercel will deploy (usually `main`).

### 2.2 Create a Vercel project

1. Go to [vercel.com](https://vercel.com) → **Add New…** → **Project**.
2. **Import** your GitHub repository.
3. **Root Directory:** set to **`frontend`** (important — not the repo root).
4. **Framework Preset:** Vite (auto-detected).
5. **Build Command:** `npm run build` (default).
6. **Output Directory:** `dist` (default for Vite).

### 2.3 Add the environment variable on Vercel

Before the first production deploy (or in **Settings → Environment Variables**):

| Name | Value | Environments |
|------|--------|----------------|
| `VITE_API_URL` | `http://YOUR_EC2_PUBLIC_IP:3000` or `https://api.yourdomain.com` | Production, Preview (optional) |

- Use **`http://`** only if you have not set up TLS on the API yet; mixed content rules may block **https** Vercel site from calling **http** API — prefer **HTTPS** on the API when possible.
- **No trailing slash.**

### 2.4 Deploy

Click **Deploy**. When it finishes, open the **`.vercel.app`** URL Vercel shows.

### 2.5 Finish CORS on the backend

Copy the **exact** production URL (e.g. `https://something.vercel.app`).

On EC2, edit `backend/.env`:

```bash
nano /opt/ui-similarity/backend/.env
```

Example:

```env
PORT=3000
CORS_ORIGINS=https://something.vercel.app,http://localhost:5173
```

Then restart PM2:

```bash
pm2 restart ui-similarity-api
```

---

## Part 3 — What to do on your own PC (local repo)

These files are usually **gitignored**; create them locally for development.

### 3.1 Backend (local)

```bash
cd backend
copy .env.example .env
```

On macOS/Linux: `cp .env.example .env`.

Edit `backend/.env`:

```env
PORT=3000
CORS_ORIGINS=http://localhost:5173
```

Add your future Vercel URL if you test a deployed frontend against local API:

```env
CORS_ORIGINS=http://localhost:5173,https://something.vercel.app
```

### 3.2 Frontend (local)

```bash
cd frontend
copy .env.example .env
```

Edit `frontend/.env`:

```env
VITE_API_URL=http://localhost:3000
```

To point the local UI at the **EC2** API instead:

```env
VITE_API_URL=http://YOUR_EC2_PUBLIC_IP:3000
```

Restart `npm run dev` after changing `.env`.

---

## Part 4 — Order checklist (quick reference)

1. EC2 up → SSH → Node → clone repo.  
2. `backend`: `npm install` → Playwright chromium → `master_project`: `npm install`.  
3. Create **`backend/.env`** on server with `PORT` + `CORS_ORIGINS` (localhost optional).  
4. `pm2 start` + `pm2 save` + `pm2 startup`.  
5. Vercel: new project, root = **`frontend`**, set **`VITE_API_URL`**.  
6. Deploy Vercel → copy site URL → add URL to **`CORS_ORIGINS`** on server → **`pm2 restart`**.  
7. Locally: optional **`frontend/.env`** and **`backend/.env`** for dev (see Part 3).

---

## If something fails

| Symptom | What to check |
|--------|----------------|
| Browser: “Failed to fetch” / CORS error | `CORS_ORIGINS` includes the **exact** Vercel origin; restart PM2. |
| Vercel site loads but compare fails | `VITE_API_URL` correct; EC2 security group allows your IP (or 0.0.0.0 for 3000); API reachable from internet. |
| `ERR_MODULE_NOT_FOUND` / Vite on uploads | On the server, `master_project/node_modules` exists — run `cd backend/master_project && npm install`. |

---

## Optional: custom domain

1. Point **`api.yourdomain.com`** to EC2 (A record) or load balancer.  
2. Use Nginx + Certbot for HTTPS on the API.  
3. Set **`VITE_API_URL=https://api.yourdomain.com`** on Vercel.  
4. Set **`CORS_ORIGINS=https://checker.yourdomain.com`** (or your Vercel URL) in **`backend/.env`**.
