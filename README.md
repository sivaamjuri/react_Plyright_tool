# 🚀 Visual UI Similarity Checker (Pro)

A high-performance visual regression tool designed to automate the assessment of React frontend assignments. It compares a **Solution** implementation against a **Student** submission using pixel-perfect image analysis and returns a similarity percentage.

---

## ✨ Key Features

### 🏎️ Ultra-Fast Startup (Proprietary Speed-Hack)
- **Shared `node_modules`**: Uses a `master_project` template with symlinks (Directory Junctions) to avoid running `npm install` for every single upload.
- **Lazy Dependency Learning**: Automatically identifies missing libraries in student projects, installs them into the master folder, and remembers them for future runs.
- **Parallel Bootup**: Launches both solution and student servers simultaneously using `Promise.all`.

### 🛡️ Robust Compatibility
- **Vite & CRA Support**: Automatically detects the build tool and uses the appropriate start scripts.
- **Legacy OpenSSL Support**: Injects `--openssl-legacy-provider` to support older Create React App (CRA v4) projects on modern Node.js versions.
- **Homepage Aware**: Correctly handles projects with custom `homepage` subpaths in `package.json`.
- **Pre-flight Bypass**: Sets `SKIP_PREFLIGHT_CHECK=true` and `CI=true` to prevent interactive prompts or environment mismatches.

### 🌐 Integrated Mock Backend
- **Auto-JSON-Server**: If a `db.json` is detected, the tool automatically launches a mockup backend on port 8000.
- **Custom Logic Support**: If the project contains a custom `server.js`, the tool runs it automatically to support authentication and specialized API logic.

### 📸 Precision Analysis
- **Full-Page Screenshots**: Uses **Playwright (Chromium)** to capture the entire vertical length of the page, not just the viewport.
- **Pixel-by-Pixel Comparison**: Leverages `pixelmatch` to generate transparency-aware similarity scores.
- **Network Idle Detection**: Ensures screenshots are only taken after all assets and API data have finished loading.

### 📊 Bulk Evaluation & Reporting
- **Excel Ingestion**: Upload an Excel sheet with student GitHub repo links for automatic batch processing.
- **Auto-Downloader**: Automatically clones/downloads GitHub repositories (main or master branches) as ZIPs for analysis.
- **Downloadable Reports**: Generate summary Excel reports containing Student Names, Repo Links, Similarity Scores, and automated Remarks.

---

## 🛠️ Tech Stack

- **Frontend**: React, Vite, Framer Motion (for smooth UI transitions).
- **Backend**: Node.js, Express, Playwright, Pixelmatch, JSZip, fs-extra.

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: Version 18 or higher recommended.
- **Permissions**: Administrative/Elevated privileges may be required on Windows to create directory junctions (symlinks).

### 2. Installation
```bash
# Clone the repository
git clone <your-repo-url>
cd VR_PROJECT

# Setup Backend
cd backend
npm install

# Setup Frontend
cd ../frontend
npm install
```

### 3. Execution
1. **Start Backend**: `cd backend && npm start` (Runs on port 3000)
2. **Start Frontend**: `cd frontend && npm run dev` (Runs on port 5173)

---

## 📖 Usage Guide

1. **Upload Solution**: Provide the reference React project ZIP.
2. **Student Submission**: Upload student projects as individual ZIPs **OR** upload an Excel sheet containing GitHub repository links.
3. **Wait for Boot**: The tool will:
   - Dowload GitHub repos (if Excel used).
   - Extract files and link dependencies.
   - Start development servers (and mock APIs).
4. **View & Export**: Get side-by-side comparisons, performance breakdowns, and **download the final results as an Excel report**.

---

## 🏗️ Project Structure

```text
VR_PROJECT/
├── backend/
│   ├── master_project/   # The shared dependency template
│   ├── temp/             # Transient storage for unzipped projects
│   └── server.js         # Core automation logic
├── frontend/
│   ├── src/
│   └── index.html        # Modern UI for analysis management
└── README.md
```

---

## ⚠️ Known Behaviors
- **Initial Learning**: The *very first* time a project with new libraries is uploaded, it may take 1-2 minutes to "learn" the new packages. Subsequent uploads of similar projects will be **instant**.
- **Port Conflict**: The tool dynamically assigns ports to dev servers, but assumes port `8000` is available for `json-server`.

---

## Deploy (Backend AWS + Frontend Vercel)

### 1) Deploy backend to AWS (EC2)
1. Launch an Ubuntu EC2 instance and open inbound rules for:
   - `22` (SSH) from your IP
   - `3000` (or `80/443` via reverse proxy)
2. SSH into EC2 and install Node.js 20+.
3. Copy backend code to server and run:
```bash
cd backend
npm install
npx playwright install chromium
cp .env.example .env
```
4. Edit `.env`:
```env
PORT=3000
CORS_ORIGINS=https://your-frontend.vercel.app,http://localhost:5173
```
5. Start backend with PM2:
```bash
npm i -g pm2
pm2 start server.js --name ui-checker-backend
pm2 save
pm2 startup
```

### 2) Deploy frontend to Vercel
1. Import the `frontend` folder as a Vercel project.
2. Framework preset: **Vite**.
3. Set environment variable in Vercel:
   - `VITE_API_URL=https://your-backend-domain-or-ip:3000`
4. Deploy.

### 3) If you use a domain (recommended)
- Put Nginx in front of backend and enable HTTPS with Certbot.
- Then set:
  - Backend `.env` `CORS_ORIGINS=https://your-frontend.vercel.app`
  - Vercel `VITE_API_URL=https://api.yourdomain.com`

---

Developed as an advanced agentic coding solution. 🚀
