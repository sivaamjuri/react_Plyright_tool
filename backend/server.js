const express = require('express');
const cors = require('cors');
const multer = require('multer');
const AdmZip = require('adm-zip');
const path = require('path');
const fs = require('fs-extra');
const { chromium } = require('playwright');
const PNG = require('pngjs').PNG;
const pixelmatch = require('pixelmatch');
const { spawn } = require('child_process');
const xlsx = require('xlsx');
const axios = require('axios');
const { performance } = require('perf_hooks');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

// Explicitly handle preflight requests
app.options('*', cors());

const server = app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on http://localhost:${PORT}`);
});

// Increase timeout to 2 hours for large student batches
server.timeout = 7200000;
server.keepAliveTimeout = 7200000;
server.headersTimeout = 7200000;
app.use(express.json());

// Log all requests
app.use((req, res, next) => {
    log(`${req.method} ${req.url}`);
    next();
});

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);

const upload = multer({ dest: UPLOADS_DIR });

// Helper: Logging
function log(msg) {
    const logMsg = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(msg);
    try {
        fs.appendFileSync(path.join(__dirname, 'server.log'), logMsg);
    } catch (e) {
        console.error("Failed to write to log file:", e);
    }
}

// Helper: Kill Process Safely
function killProcess(proc) {
    if (!proc || !proc.pid) return;
    try {
        if (os.platform() === 'win32') {
            const killer = spawn("taskkill", ["/pid", proc.pid.toString(), '/f', '/t'], { shell: true });
            killer.on('error', (err) => log(`Failed to spawn taskkill for PID ${proc.pid}: ${err.message}`));
        } else {
            // Linux/macOS
            const killer = spawn("pkill", ["-P", proc.pid.toString()]);
            killer.on('close', () => {
                try {
                    process.kill(proc.pid, 'SIGKILL');
                } catch (e) { }
            });
        }
    } catch (e) {
        log(`Error calling process kill for PID ${proc.pid}: ${e.message}`);
    }
}

// Helper: Download GitHub Repo as ZIP
async function downloadRepoAsZip(repoUrl, outputPath) {
    // Basic format: https://github.com/USER/REPO
    // Normalize: remove .git if present, remove trailing slash
    let normalizedUrl = repoUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');

    // Try main branch first, then master
    const tryDownload = async (branch) => {
        const zipUrl = `${normalizedUrl}/archive/refs/heads/${branch}.zip`;
        log(`Downloading from ${zipUrl}...`);
        const response = await axios({
            method: 'get',
            url: zipUrl,
            headers: { 'ngrok-skip-browser-warning': 'true' },
            responseType: 'stream',
            timeout: 30000,
            validateStatus: (status) => status === 200
        });
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    };

    try {
        await tryDownload('main');
    } catch (e) {
        log(`Failed to download main branch, trying master...`);
        try {
            await tryDownload('master');
        } catch (e2) {
            throw new Error(`Failed to download ZIP from GitHub repo: ${repoUrl}`);
        }
    }
}

// Helper: Parse Excel for GitHub links
function parseExcelForLinks(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Get all rows as arrays to detect if the first row is data or header
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    if (rows.length === 0) return [];

    const results = [];
    const firstRowHasUrl = rows[0].some(cell => typeof cell === 'string' && cell.toLowerCase().includes('github.com'));

    if (firstRowHasUrl) {
        // No header row, or first row IS a repository link. Process all rows.
        rows.forEach(row => {
            const githubUrl = row.find(cell => typeof cell === 'string' && cell.toLowerCase().includes('github.com'));
            if (githubUrl) {
                const name = row.find(cell =>
                    cell && typeof cell === 'string' && cell !== githubUrl && !cell.toLowerCase().includes('github.com')
                ) || githubUrl.split('/').pop() || 'Student';
                results.push({ url: githubUrl, name });
            }
        });
    } else {
        // First row looks like headers (no github link). Use standard object-based parsing.
        const data = xlsx.utils.sheet_to_json(sheet);
        data.forEach(row => {
            for (const [key, value] of Object.entries(row)) {
                if (typeof value === 'string' && value.toLowerCase().includes('github.com')) {
                    results.push({
                        url: value,
                        name: row['Name'] || row['Student Name'] || row['student_name'] || row['Username'] || value.split('/').pop() || 'Student'
                    });
                    break;
                }
            }
        });
    }
    return results;
}

// Helper: Generate Remarks based on score
function getRemarks(score, status, errorMsg) {
    if (status === 'error') return `Error: ${errorMsg}`;
    const s = parseFloat(score);
    if (s >= 100) return "Perfect match with the solution UI.";
    if (s >= 90) return "Very high similarity, minor pixel differences.";
    if (s >= 70) return "Good similarity, but some layout or style deviations detected.";
    if (s >= 40) return "Moderate similarity, significant differences in UI components.";
    if (s > 0) return "Low similarity, UI does not match the reference design.";
    return "No similarity or error during rendering.";
}

// Helper: Find project root (contains package.json or index.html)
async function findProjectRoot(baseDir, depth = 0) {
    if (depth > 5) return null; // Prevent infinite depth

    // Check current level
    if (await fs.pathExists(path.join(baseDir, 'package.json'))) return { path: baseDir, type: 'react' };
    if (await fs.pathExists(path.join(baseDir, 'index.html'))) return { path: baseDir, type: 'static' };

    // Scan all subdirectories
    const items = await fs.readdir(baseDir, { withFileTypes: true });
    const dirs = items.filter(item => item.isDirectory() &&
        item.name !== 'node_modules' &&
        item.name !== '.git' &&
        item.name !== 'dist');

    for (const dir of dirs) {
        const subDir = path.join(baseDir, dir.name);
        const result = await findProjectRoot(subDir, depth + 1);
        if (result) return result;
    }

    if (depth === 0) {
        throw new Error(`No project root (package.json or index.html) found in ${baseDir}`);
    }
    return null;
}


// Helper: Run server (React/Static)
function startServer(projectInfo, port) {
    const { path: projectDir, type } = projectInfo;

    return new Promise((resolve, reject) => {
        try {
            if (type === 'static') {
                log(`[${port}] Starting static server in ${projectDir}...`);
                const out = fs.openSync(path.join(projectDir, 'static-server.log'), 'a');
                const err = fs.openSync(path.join(projectDir, 'static-server.log'), 'a');

                // npx serve . -p <port>
                const serve = spawn('npx', ['-y', 'serve', '.', '-p', port.toString()], {
                    cwd: projectDir,
                    detached: true,
                    shell: true,
                    stdio: ['ignore', out, err]
                });

                serve.unref();
                checkServerReady(port, '', serve, resolve, reject);
                return;
            }

            // React/Vite/CRA logic
            const masterDir = path.join(__dirname, 'master_project');
            const masterModules = path.join(masterDir, 'node_modules');
            const targetModules = path.join(projectDir, 'node_modules');

            // Read package.json to find the right script and identify missing deps
            let studentPkg = {};
            let masterPkg = {};
            try {
                studentPkg = fs.readJsonSync(path.join(projectDir, 'package.json'));
            } catch (e) {
                log(`[${port}] Failed to read package.json files`);
            }

            // Global lock for learning to prevent race conditions
            if (global.isLearning === undefined) global.isLearning = false;

            const runStart = async () => {
                // Determine missing dependencies or version mismatches
                const studentDeps = { ...(studentPkg.dependencies || {}), ...(studentPkg.devDependencies || {}) };
                const masterDir = path.join(__dirname, 'master_project');
                const masterPkg = fs.readJsonSync(path.join(masterDir, 'package.json'));
                const masterDeps = { ...(masterPkg.dependencies || {}), ...(masterPkg.devDependencies || {}) };

                const stillMissing = [];
                for (const [dep, ver] of Object.entries(studentDeps)) {
                    const masterVer = masterDeps[dep];
                    const cleanVer = ver.replace(/[\^~]/g, '');

                    if (!masterVer) {
                        stillMissing.push(`${dep}@${cleanVer}`);
                        continue;
                    }

                    // Check for major version mismatch (e.g., v5 vs v6)
                    const sMajor = cleanVer.split('.')[0];
                    const mMajor = masterVer.replace(/[\^~]/g, '').split('.')[0];

                    if (sMajor !== mMajor && !isNaN(parseInt(sMajor)) && !isNaN(parseInt(mMajor))) {
                        log(`[${port}] Major version mismatch for ${dep}: Master (${mMajor}) vs Student (${sMajor}). Upgrading...`);
                        stillMissing.push(`${dep}@${cleanVer}`);
                    }
                }

                if (stillMissing.length > 0) {
                    // Wait if another process is learning
                    while (global.isLearning) {
                        await new Promise(r => setTimeout(r, 1000));
                    }

                    global.isLearning = true;
                    log(`[${port}] Learning/Upgrading dependencies: ${stillMissing.join(', ')}...`);
                    try {
                        const installResult = await new Promise((res) => {
                            const inst = spawn('npm', ['install', '--save', ...stillMissing, '--no-audit', '--no-fund', '--no-progress', '--legacy-peer-deps'], {
                                cwd: masterDir,
                                shell: true
                            });

                            let errOutput = '';
                            inst.stderr?.on('data', (data) => errOutput += data.toString());

                            inst.on('close', (code) => {
                                if (code !== 0) log(`[${port}] npm install warning/error: ${errOutput}`);
                                res(code);
                            });
                        });
                        log(`[${port}] Update complete. Result code: ${installResult}`);
                    } catch (e) {
                        log(`[${port}] Update failed: ${e.message}`);
                    } finally {
                        global.isLearning = false;
                    }
                }

                log(`[${port}] Using shared node_modules for speed...`);
                try {
                    const masterModules = path.join(masterDir, 'node_modules');
                    const targetModules = path.join(projectDir, 'node_modules');

                    // If node_modules exists and is NOT a junction/symlink, remove it
                    if (await fs.pathExists(targetModules)) {
                        const lstat = await fs.lstat(targetModules);
                        if (!lstat.isSymbolicLink()) {
                            log(`[${port}] Removing existing student node_modules...`);
                            await fs.remove(targetModules);
                        }
                    }

                    await fs.ensureSymlink(masterModules, targetModules, 'junction');
                } catch (e) {
                    log(`[${port}] Symlink failed: ${e.message}`);
                }

                // NEW: Start json-server if db.json or server.js exists
                const dbPath = path.join(projectDir, 'db.json');
                const customServerPath = path.join(projectDir, 'server.js');
                if (await fs.pathExists(dbPath)) {
                    log(`[${port}] Starting mockup backend on port 8000...`);
                    const jsLogStream = fs.createWriteStream(path.join(projectDir, 'json-server.log'), { flags: 'a' });

                    let jsProc;
                    if (await fs.pathExists(customServerPath)) {
                        // Run the custom server.js if it exists
                        jsProc = spawn('node', ['server.js'], {
                            cwd: projectDir,
                            shell: true
                        });
                    } else {
                        // Fallback to basic json-server
                        jsProc = spawn('npx', ['json-server', '--watch', 'db.json', '--port', '8000'], {
                            cwd: projectDir,
                            shell: true
                        });
                    }

                    jsProc.stdout.on('data', (data) => jsLogStream.write(data));
                    jsProc.stderr.on('data', (data) => jsLogStream.write(data));
                    // Give it a moment to start
                    await new Promise(r => setTimeout(r, 2000));
                }

                log(`[${port}] Starting server...`);
                const logPath = path.join(projectDir, 'dev-server.log');
                const logStream = fs.createWriteStream(logPath, { flags: 'a' });

                // Determine command
                let cmd = 'dev';
                if (!studentPkg.scripts?.dev && studentPkg.scripts?.start) {
                    cmd = 'start';
                }

                // Determine base path from homepage if it exists
                let basePath = '';
                if (studentPkg.homepage && studentPkg.homepage.startsWith('http')) {
                    try {
                        const url = new URL(studentPkg.homepage);
                        basePath = url.pathname === '/' ? '' : url.pathname;
                        if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
                    } catch (e) {
                        log(`[${port}] Failed to parse homepage URL: ${studentPkg.homepage}`);
                    }
                } else if (studentPkg.homepage && studentPkg.homepage.startsWith('/')) {
                    basePath = studentPkg.homepage;
                    if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
                }

                let serverProc;
                let finalBasePath = basePath;

                // Browser-related envs to prevent opening browser windows
                const env = {
                    ...process.env,
                    PORT: port.toString(),
                    BROWSER: 'none',
                    HOST: '127.0.0.1',
                    CI: 'true',
                    WDS_SOCKET_PORT: port.toString(),
                    SKIP_PREFLIGHT_CHECK: 'true',
                    NODE_OPTIONS: '--openssl-legacy-provider'
                };

                const args = ['run', cmd];
                if (cmd === 'dev') {
                    args.push('--', '--port', port.toString(), '--host', '127.0.0.1');
                }

                serverProc = spawn('npm', args, {
                    cwd: projectDir,
                    shell: true,
                    env: env
                });

                serverProc.stdout.on('data', (data) => logStream.write(data));
                serverProc.stderr.on('data', (data) => logStream.write(data));

                serverProc.on('close', () => {
                    // No global.activeServers counter needed here
                });

                checkServerReady(port, finalBasePath, serverProc, resolve, reject, logPath);
            };

            runStart();

        } catch (e) {
            log(`[${port}] Setup failed: ${e.message}`);
            reject(e);
        }
    });
}

function checkServerReady(port, basePath, serverProcess, resolve, reject, logPath) {
    let attempts = 0;
    const maxAttempts = 180; // 3 minutes

    const check = async () => {
        // Check if the process has exited
        if (serverProcess.exitCode !== null) {
            let logDetails = '';
            try {
                if (logPath && await fs.pathExists(logPath)) {
                    const content = await fs.readFile(logPath, 'utf8');
                    const lines = content.split('\n');
                    logDetails = lines.slice(-20).join('\n');
                }
            } catch (e) {
                logDetails = `(Failed to read log: ${e.message})`;
            }

            log(`[${port}] Server process exited early with code ${serverProcess.exitCode}`);
            return reject(new Error(`Server process on port ${port} exited early with code ${serverProcess.exitCode}.\nLast 20 lines of log:\n${logDetails}`));
        }

        if (attempts >= maxAttempts) {
            log(`[${port}] Server startup timed out after ${maxAttempts}s`);
            return reject(new Error(`Timeout waiting for server on port ${port}. Check dev-server.log for details.`));
        }
        attempts++;

        if (attempts % 10 === 0) {
            log(`[${port}] Still waiting for server... (${attempts}s)`);
        }

        try {
            const url = `http://127.0.0.1:${port}${basePath}`;
            // Use axios for better control over timeouts and errors, bypassing any proxies
            await axios.get(url, {
                timeout: 2000,
                headers: { 'Accept': 'text/html', 'ngrok-skip-browser-warning': 'true' },
                validateStatus: (status) => status >= 200 && status < 500,
                proxy: false // Avoid proxy issues on local connections
            });
            log(`[${port}] Server ready at ${url}`);
            resolve({ process: serverProcess, baseUrl: url });
        } catch (e) {
            // Fallback: try 'localhost' if 127.0.0.1 fails once
            if (attempts === 5) {
                try {
                    const localUrl = `http://localhost:${port}${basePath}`;
                    await axios.get(localUrl, { timeout: 1000, proxy: false, headers: { 'ngrok-skip-browser-warning': 'true' } });
                    log(`[${port}] Server ready at ${localUrl}`);
                    return resolve({ process: serverProcess, baseUrl: `http://127.0.0.1:${port}${basePath}` });
                } catch (err) { }
            }
            // Log connection errors occasionally to debug
            if (attempts % 30 === 0) {
                log(`[${port}] Connection attempt error for http://127.0.0.1:${port}${basePath}: ${e.message}`);
            }
            setTimeout(check, 1000);
        }
    };
    check();
}

// Helper: Capture Screenshots
async function captureScreenshots(baseUrl, routes, outputDir) {
    await fs.ensureDir(outputDir);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    for (const route of routes) {
        const url = `${baseUrl}${route}`;
        // Handle route name for file (remove slashes)
        const fileName = route === '/' ? 'index.png' : `${route.replace(/\//g, '')}.png`;
        const savePath = path.join(outputDir, fileName);

        try {
            log(`Navigating to ${url}...`);
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto(url, { waitUntil: 'networkidle' });

            // Inject CSS to disable animations/transitions
            await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });

            // Wait a moment for any dynamic layout to settle
            await page.waitForTimeout(1000);

            await page.screenshot({ path: savePath, fullPage: true });
        } catch (e) {
            log(`Failed to capture ${url}: ${e.message}`);
        }
    }

    await browser.close();
}

// Helper: Normalize image size by padding with transparency
function normalizeImage(img, width, height) {
    if (!img || !img.data || typeof img.bitblt !== 'function') {
        log('normalizeImage error: Invalid image object');
        return new PNG({ width, height });
    }
    if (img.width === width && img.height === height) return img;
    const newImg = new PNG({ width, height });
    img.bitblt(newImg, 0, 0, img.width, img.height, 0, 0);
    return newImg;
}

// Helper: Compare Images
function compareImages(img1Path, img2Path, diffOutputPath) {
    try {
        if (!fs.existsSync(img1Path) || !fs.existsSync(img2Path)) {
            log(`Image missing: ${img1Path} or ${img2Path}`);
            return "0.00";
        }

        const raw1 = PNG.sync.read(fs.readFileSync(img1Path));
        const raw2 = PNG.sync.read(fs.readFileSync(img2Path));

        // Recreate PNG instances to ensure 'bitblt' method is available
        const img1 = new PNG({ width: raw1.width, height: raw1.height });
        img1.data = raw1.data;

        const img2 = new PNG({ width: raw2.width, height: raw2.height });
        img2.data = raw2.data;

        const width = Math.max(img1.width, img2.width);
        const height = Math.max(img1.height, img2.height);

        // Normalize images to the same size
        const normImg1 = normalizeImage(img1, width, height);
        const normImg2 = normalizeImage(img2, width, height);

        const diff = new PNG({ width, height });

        const numDiffPixels = pixelmatch(
            normImg1.data,
            normImg2.data,
            diff.data,
            width,
            height,
            { threshold: 0.01, includeAA: true, alpha: 0, diffMask: true }
        );

        // Save diff image
        fs.writeFileSync(diffOutputPath, PNG.sync.write(diff));

        const totalPixels = width * height;
        let similarity = (1 - (numDiffPixels / totalPixels)) * 100;

        // Ensure range is strictly 0-100
        similarity = Math.max(0, Math.min(100, similarity));

        log(`Similarity calculated: ${similarity.toFixed(2)}% (Dimensions: ${width}x${height})`);
        return Math.round(similarity).toFixed(0);
    } catch (e) {
        log(`compareImages error: ${e.message}`);
        // Ensure we create a dummy diff image so the UI doesn't break
        try {
            if (fs.existsSync(img1Path)) {
                fs.copyFileSync(img1Path, diffOutputPath);
            } else if (fs.existsSync(img2Path)) {
                fs.copyFileSync(img2Path, diffOutputPath);
            }
        } catch (copyErr) { console.error('Failed to create fallback diff image', copyErr); }

        return "0";
    }
}


// Serve static files from temp to show screenshots
app.use('/temp', express.static(TEMP_DIR));

app.post('/compare', upload.fields([{ name: 'solution' }, { name: 'student' }, { name: 'studentExcel' }]), async (req, res) => {
    const solutionFile = req.files['solution']?.[0];
    const studentFiles = req.files['student'] || [];
    const studentExcel = req.files['studentExcel']?.[0];

    if (!solutionFile || (studentFiles.length === 0 && !studentExcel)) {
        return res.status(400).json({ error: 'Both solution and either student ZIP files or student Excel sheet are required.' });
    }

    // Set up streaming response
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');

    const sendProgress = (data) => {
        res.write(JSON.stringify(data) + '\n');
    };

    const runId = Date.now().toString();
    const runDir = path.join(TEMP_DIR, runId);
    const solExtractDir = path.join(runDir, 'solution_raw');

    // Performance tracking
    const startOverall = performance.now();

    let solServer; // Declare solServer here to be accessible in finally block

    try {
        // 1. Prepare Solution (Once)
        sendProgress({ type: 'status', message: 'Extracting Solution ZIP...' });
        await fs.ensureDir(solExtractDir);
        new AdmZip(solutionFile.path).extractAllTo(solExtractDir, true);

        const solRoot = await findProjectRoot(solExtractDir);
        const solPort = 14000 + Math.floor(Math.random() * 500);
        sendProgress({ type: 'status', message: 'Starting Solution Server...' });
        solServer = await startServer(solRoot, solPort); // Assign to solServer

        const solScreenshotDir = path.join(runDir, 'solution', 'screenshots');
        await fs.ensureDir(solScreenshotDir);

        sendProgress({ type: 'status', message: 'Capturing Solution Screenshots...' });
        const routes = ['/'];
        await captureScreenshots(solServer.baseUrl, routes, solScreenshotDir);

        // FREE UP RAM FOR AWS t3.micro: Kill the solution server immediately after screenshots!
        if (solServer?.process) {
            killProcess(solServer.process);
            solServer = null;
        }

        // 2. Prepare Student Task List
        const studentTasks = [];

        // Add files
        studentFiles.forEach(file => {
            studentTasks.push({ type: 'file', path: file.path, name: file.originalname });
        });

        // Add Excel links
        if (studentExcel) {
            try {
                const links = parseExcelForLinks(studentExcel.path);
                links.forEach(link => {
                    studentTasks.push({ type: 'repo', path: link.url, name: link.name });
                });
                // Optional: remove excel file after parsing
                await fs.remove(studentExcel.path);
            } catch (e) {
                log(`Failed to parse Excel: ${e.message}`);
            }
        }

        // 3. Process Students in Batches
        const allResults = [];
        const BATCH_SIZE = 1; // SAFE MODE: Only 1 at a time for AWS Free Tier/Small servers!

        sendProgress({ type: 'start', total: studentTasks.length });

        for (let i = 0; i < studentTasks.length; i += BATCH_SIZE) {
            const batch = studentTasks.slice(i, i + BATCH_SIZE);
            sendProgress({ type: 'progress', current: i, total: studentTasks.length, message: `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...` });
            const batchPromises = batch.map(async (task, index) => {
                let stuServer; // Declare stuServer for cleanup within the batch item
                const stuId = `student_${i + index}`;
                const stuExtractDir = path.join(runDir, stuId, 'raw');
                const stuScreenshotDir = path.join(runDir, stuId, 'screenshots');
                const diffScreenshotDir = path.join(runDir, stuId, 'diffs');

                const tStart = performance.now();
                let tUnzip = 0, tSetup = 0, tScreenshot = 0, tCompare = 0;

                try {
                    await fs.ensureDir(stuScreenshotDir);
                    await fs.ensureDir(diffScreenshotDir);

                    log(`Processing ${task.name}...`);

                    const tUnzipStart = performance.now();
                    let zipPath = task.path;

                    if (task.type === 'repo') {
                        zipPath = path.join(runDir, `${stuId}_repo.zip`);
                        await downloadRepoAsZip(task.path, zipPath);
                    }

                    new AdmZip(zipPath).extractAllTo(stuExtractDir, true);
                    tUnzip = performance.now() - tUnzipStart;

                    // Clean up downloaded zip if it's a repo
                    if (task.type === 'repo') {
                        await fs.remove(zipPath).catch(() => { });
                    }

                    const t0 = performance.now();
                    const stuRoot = await findProjectRoot(stuExtractDir);
                    const stuPort = 15000 + (i * 10) + (index + Math.floor(Math.random() * 100));

                    stuServer = await startServer(stuRoot, stuPort); // Assign to stuServer
                    tSetup = performance.now() - t0;

                    const t1 = performance.now();
                    await captureScreenshots(stuServer.baseUrl, routes, stuScreenshotDir);
                    tScreenshot = performance.now() - t1;

                    // Compare
                    const pageResults = {};
                    let totalScore = 0;

                    const t2 = performance.now();
                    const solutionBase64Cache = {}; // Cache to avoid redundant encoding

                    for (const route of routes) {
                        const fileName = route === '/' ? 'index.png' : `${route.replace(/\//g, '')}.png`;
                        const solImg = path.join(solScreenshotDir, fileName);
                        const stuImg = path.join(stuScreenshotDir, fileName);
                        const diffImg = path.join(diffScreenshotDir, fileName);

                        const score = compareImages(solImg, stuImg, diffImg);
                        const name = route === '/' ? 'Home Page' : route;

                        // Convert images to Base64 with logging
                        const toBase64 = (filePath, tag) => {
                            if (fs.existsSync(filePath)) {
                                const base64 = fs.readFileSync(filePath).toString('base64');
                                log(`[Base64] Encoded ${tag} (${filePath}): ${Math.round(base64.length / 1024)}KB`);
                                return `data:image/png;base64,${base64}`;
                            }
                            log(`[Base64] WARNING: File NOT found: ${filePath}`);
                            return null;
                        };

                        if (!solutionBase64Cache[fileName]) {
                            solutionBase64Cache[fileName] = toBase64(solImg, 'Solution');
                        }

                        pageResults[name] = {
                            score: `${score}%`,
                            diffImage: toBase64(diffImg, 'Diff'),
                            studentImage: toBase64(stuImg, 'Student'),
                            solutionImage: solutionBase64Cache[fileName]
                        };
                        totalScore += parseFloat(score);
                    }
                    tCompare = performance.now() - t2;

                    let finalOverall = (totalScore / routes.length);
                    finalOverall = Math.max(0, Math.min(100, finalOverall));

                    const totalTimeNum = performance.now() - tStart;

                    const scoreNum = Math.round(finalOverall).toFixed(0);
                    return {
                        studentName: task.name,
                        repoUrl: task.type === 'repo' ? task.path : 'N/A (Uploaded ZIP)',
                        status: 'success',
                        overallScore: scoreNum,
                        remarks: getRemarks(scoreNum, 'success'),
                        pages: pageResults,
                        timings: {
                            unzip: (tUnzip / 1000).toFixed(2) + 's',
                            setup: (tSetup / 1000).toFixed(2) + 's',
                            screenshot: (tScreenshot / 1000).toFixed(2) + 's',
                            comparison: (tCompare / 1000).toFixed(2) + 's',
                            total: (totalTimeNum / 1000).toFixed(2) + 's'
                        }
                    };
                } catch (err) {
                    log(`Failed to process ${task.name}: ${err.message}`);
                    return {
                        studentName: task.name,
                        repoUrl: task.type === 'repo' ? task.path : 'N/A (Uploaded ZIP)',
                        status: 'error',
                        remarks: getRemarks(0, 'error', err.message),
                        error: err.message
                    };
                } finally {
                    // Cleanup student server for this batch item
                    if (stuServer?.process) {
                        killProcess(stuServer.process);
                    }
                    // DISK CLEANUP: Delete the extracted project to avoid filling up AWS disk
                    const stuWorkDir = path.join(runDir, stuId);
                    await fs.remove(stuWorkDir).catch(e => log(`Cleanup error for ${stuId}: ${e.message}`));
                    log(`[Cleanup] Deleted ${stuId} to free up disk space.`);
                }
            });

            const batchResults = await Promise.all(batchPromises);
            allResults.push(...batchResults);

            // Send partial progress for the completed batch
            batchResults.forEach(res => {
                sendProgress({
                    type: 'student_complete',
                    studentName: res.studentName,
                    status: res.status,
                    error: res.error,
                    remarks: res.remarks
                });
            });
        }

        const overallTime = ((performance.now() - startOverall) / 1000).toFixed(2) + 's';
        sendProgress({
            type: 'result',
            data: {
                runId,
                results: allResults,
                timings: { overall: overallTime }
            }
        });
        res.end();
    }
    catch (error) {
        log(`Fatal error in /compare: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.write(JSON.stringify({ type: 'error', message: error.message }) + '\n');
            res.end();
        }
    } finally {
        // Delete the entire run directory after the request ends (success or error)
        if (runDir) {
            await fs.remove(runDir).catch(e => log(`Crucial Cleanup Error: ${e.message}`));
            log(`[Final Cleanup] Wiped ${runDir}`);
        }

        // Cleanup any surviving solution server processes
        if (solServer?.process) {
            killProcess(solServer.process);
        }

        // Cleanup raw upload files
        if (solutionFile?.path) await fs.remove(solutionFile.path).catch(() => { });
        if (studentFiles) {
            for (const file of studentFiles) {
                await fs.remove(file.path).catch(() => { });
            }
        }
        if (studentExcel?.path) await fs.remove(studentExcel.path).catch(() => { });
    }
});


