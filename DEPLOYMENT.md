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

## Part 1 — Backend on AWS EC2

### 1.1 Create the EC2 instance

1. In **AWS Console** → **EC2** → **Launch instance**.
2. **OS:** Ubuntu Server 22.04 LTS (or newer).
3. **Instance type:** `t3.small` or larger recommended (Playwright + npm installs need RAM).
4. **Key pair:** Create or choose an `.pem` key; download it.
5. **Network:** Create or use a security group with inbound rules:
   - **SSH:** TCP **22** — source *My IP* (your home IP).
   - **HTTP API:** TCP **3000** — source *My IP* for testing; later **0.0.0.0/0** only if you accept the world hitting port 3000 (better: use Nginx on 80/443 only).
6. **Storage:** 20–30 GB gp3 is a reasonable minimum.
7. Launch and wait until the instance is **running**. Note the **Public IPv4 address** or DNS (e.g. `ec2-xx-xx-xx-xx.compute.amazonaws.com`).

### 1.2 SSH into the server

From your PC (Git Bash, WSL, or macOS/Linux terminal; adjust path to your key):

```bash
chmod 400 /path/to/your-key.pem
ssh -i /path/to/your-key.pem ubuntu@YOUR_EC2_PUBLIC_DNS
```

### 1.3 Install Node.js 20+ on the server

Example using NodeSource (run on EC2):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential git
node -v   # should show v20.x or higher
```

### 1.4 Clone your project on the server

Use **HTTPS** or **SSH** clone URL from GitHub:

```bash
sudo mkdir -p /opt && sudo chown ubuntu:ubuntu /opt
cd /opt
git clone https://github.com/YOUR_GITHUB_USER/react_Plyright_tool.git ui-similarity
cd ui-similarity/backend
```

*(Avoid storing the app only inside synced folders like OneDrive on Windows; on EC2 this is not an issue.)*

### 1.5 Install backend dependencies

Still in `backend` on EC2:

```bash
npm install
npx playwright install --with-deps chromium
```

### 1.6 Install shared `master_project` dependencies (required for Vite uploads)

```bash
cd master_project
npm install --no-audit --no-fund --legacy-peer-deps
cd ..
```

### 1.7 Create production `backend/.env` on the server

```bash
cp .env.example .env
nano .env
```

Set **at least** these (edit the Vercel URL after you create the app in Part 2, or add it later):

```env
PORT=3000
CORS_ORIGINS=https://YOUR-PROJECT.vercel.app,http://localhost:5173
```

- After Vercel gives you a URL like `https://visual-ui-checker-xxx.vercel.app`, put that **full origin** in `CORS_ORIGINS` (no path after the host).
- If you use a **custom domain** on Vercel, add that origin too, comma-separated.

Save: in nano, `Ctrl+O`, Enter, `Ctrl+X`.

### 1.8 Run the API with PM2 (keeps it running after disconnect)

```bash
cd /opt/ui-similarity/backend
sudo npm install -g pm2
pm2 start server.js --name ui-similarity-api
pm2 save
pm2 startup
```

Run the command `pm2 startup` prints (often a `sudo` line), then:

```bash
pm2 save
```

### 1.9 Test the API from your PC

In a browser or terminal (replace with your EC2 public IP):

```text
http://YOUR_EC2_PUBLIC_IP:3000
```

You may not see a nice page (Express might 404 on `/`); that is OK if the server does not crash. Your app uses **`POST /compare`** from the frontend.

**Security note:** Opening port **3000** to `0.0.0.0/0` exposes the API to everyone. For production, put **Nginx** + **HTTPS** (Let’s Encrypt) in front and only expose **443**.

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
