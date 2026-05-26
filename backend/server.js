const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fsp = require('fs/promises');
const fs = require('fs-extra');
const { chromium } = require('playwright');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const { performance } = require('perf_hooks');
const ExcelJS = require('exceljs');
const unzipper = require('unzipper');
const os = require('os');
const xlsx = require('xlsx');
const AdmZip = require('adm-zip');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

/** Per-file cap for multipart (solution + each student zip + excel). Raise in .env if needed. */
const MAX_UPLOAD_MB = Math.min(
    2048,
    Math.max(32, Number.parseInt(process.env.MAX_UPLOAD_MB || '500', 10) || 500)
);

/** Axios timeout for each GET probe to the student dev server (CRA first compile is slow). */
const SERVER_READY_TIMEOUT_MS = Math.min(
    120000,
    Math.max(5000, Number.parseInt(process.env.SERVER_READY_TIMEOUT_MS || '25000', 10) || 25000)
);
/** Max seconds to poll before failing (720s default ≈ 12 min for small EC2 + react-scripts). */
const SERVER_READY_MAX_WAIT_SEC = Math.min(
    1200,
    Math.max(120, Number.parseInt(process.env.SERVER_READY_MAX_WAIT_SEC || '720', 10) || 720)
);

/** Playwright page.goto timeout (heavy Vite/CRA apps can exceed 30s on first load). */
const PLAYWRIGHT_GOTO_TIMEOUT_MS = Math.min(
    300000,
    Math.max(15000, Number.parseInt(process.env.PLAYWRIGHT_GOTO_TIMEOUT_MS || '90000', 10) || 90000)
);

/**
 * V8 heap cap (MB) for the Node process spawned for `npm install` in temp project dirs.
 * Default 1024 is safer on 2–4 GB RAM hosts; raise if npm fails with JavaScript heap out of memory.
 */
const NPM_INSTALL_HEAP_MB = Math.min(
    8192,
    Math.max(256, Number.parseInt(process.env.NPM_INSTALL_HEAP_MB || '1024', 10) || 1024)
);

/**
 * When true (default), temp-project `npm install` uses `--omit=optional` to save RAM/disk.
 * Never applied to `master_project` installs — Vite/Rollup need optional `@rollup/rollup-*` native bindings.
 */
const NPM_INSTALL_OMIT_OPTIONAL = !/^(0|false|no)$/i.test(String(process.env.NPM_INSTALL_OMIT_OPTIONAL ?? '1'));

/**
 * When true (default), project `npm install` runs one-at-a-time. Parallel installs on small EC2
 * often trigger exit 137 (SIGKILL from Linux OOM killer).
 */
const NPM_INSTALL_SERIALIZE = !/^(0|false|no)$/i.test(String(process.env.NPM_INSTALL_SERIALIZE ?? '1'));

/** @type {Promise<void>} */
let npmInstallQueueTail = Promise.resolve();

function buildNpmInstallChildEnv() {
    const env = { ...process.env, CI: 'true' };
    env.NPM_CONFIG_MAXSOCKETS = process.env.NPM_CONFIG_MAXSOCKETS || '1';
    if (process.env.NPM_CONFIG_FOREGROUND_SCRIPTS === undefined) {
        env.NPM_CONFIG_FOREGROUND_SCRIPTS = 'true';
    }
    const prev = (env.NODE_OPTIONS || '').trim();
    const cap = `--max-old-space-size=${NPM_INSTALL_HEAP_MB}`;
    env.NODE_OPTIONS = prev ? `${prev} ${cap}` : cap;
    return env;
}

/**
 * argv for `npm install`.
 * @param {boolean|undefined} omitOptionalDeps - if `false`, never add `--omit=optional` (required for `master_project` / Rollup natives). If `undefined`, use env `NPM_INSTALL_OMIT_OPTIONAL` (temp CRA installs).
 */
function getNpmInstallArgv(omitOptionalDeps, ...extra) {
    const omit =
        omitOptionalDeps === undefined ? NPM_INSTALL_OMIT_OPTIONAL : Boolean(omitOptionalDeps);
    const argv = [
        'install',
        '--no-audit',
        '--no-fund',
        '--no-progress',
        '--legacy-peer-deps',
        '--prefer-offline',
        ...(omit ? ['--omit=optional'] : []),
        ...String(process.env.NPM_INSTALL_EXTRA_FLAGS || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean),
        ...extra,
    ];
    return argv;
}

/**
 * Run `npm` with argv; append stdout/stderr to logFile. Resolves with exit code.
 */
function runNpmWithArgv(cwd, logFile, argv) {
    return new Promise((resolve, reject) => {
        const inst = spawn('npm', argv, {
            cwd,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildNpmInstallChildEnv(),
        });
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });
        inst.stdout?.pipe(logStream);
        inst.stderr?.pipe(logStream);
        inst.on('close', (code) => {
            logStream.end();
            resolve(code);
        });
        inst.on('error', (err) => {
            logStream.end();
            reject(err);
        });
    });
}

/** Run a heavy `npm install`; by default serializes with other installs to reduce OOM (exit 137). */
function enqueueNpmInstallSerialized(fn) {
    if (!NPM_INSTALL_SERIALIZE) return fn();
    const run = npmInstallQueueTail.then(() => fn(), () => fn());
    npmInstallQueueTail = run.catch(() => {});
    return run;
}

const parseAllowedOrigins = () => {
    const raw = process.env.CORS_ORIGINS;
    if (!raw) return ['http://localhost:5173'];
    return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
};

const ALLOWED_ORIGINS = parseAllowedOrigins();

const log = (msg) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
};

/**
 * Extract only inside destDir (blocks ../ and absolute paths — prevents overwriting sibling dirs like solution/).
 */
function extractAdmZipSafe(zipPath, destDir) {
    const zip = new AdmZip(zipPath);
    const canonicalDest = path.resolve(destDir);
    const canonicalPrefix = canonicalDest.endsWith(path.sep) ? canonicalDest : canonicalDest + path.sep;
    let skipped = 0;
    for (const entry of zip.getEntries()) {
        const rawName = String(entry.entryName || '').replace(/\\/g, '/').replace(/^\uFEFF/, '');
        if (!rawName || rawName.endsWith('/')) {
            if (entry.isDirectory) {
                const dirPath = path.resolve(path.join(destDir, rawName.replace(/\/$/, '')));
                if (dirPath === canonicalDest || dirPath.startsWith(canonicalPrefix)) {
                    fs.ensureDirSync(dirPath);
                }
            }
            continue;
        }
        if (rawName.startsWith('/') || /^[A-Za-z]:\//.test(rawName)) {
            skipped++;
            continue;
        }
        const destPath = path.resolve(path.join(destDir, rawName));
        if (destPath !== canonicalDest && !destPath.startsWith(canonicalPrefix)) {
            log(`Zip blocked (path escapes extract dir): ${rawName}`);
            skipped++;
            continue;
        }
        if (entry.isDirectory) {
            fs.ensureDirSync(destPath);
            continue;
        }
        fs.ensureDirSync(path.dirname(destPath));
        fs.writeFileSync(destPath, entry.getData());
    }
    if (skipped > 0) {
        log(`extractAdmZipSafe: skipped ${skipped} unsafe path(s) in ${path.basename(zipPath)}`);
    }
}

// MUST BE FIRST: CORS for local + deployed frontend
app.use(cors({
    origin(origin, callback) {
        // Allow non-browser requests (no Origin header)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
    preflightContinue: false,
    optionsSuccessStatus: 204
}));

// Express 5 no longer accepts "*" here; regex works for all routes.
app.options(/.*/, cors());

const server = app.listen(PORT, '0.0.0.0', () => {
    log(`Server running on http://localhost:${PORT} (max ${MAX_UPLOAD_MB}MB/file; dev probe ${SERVER_READY_TIMEOUT_MS}ms / ${SERVER_READY_MAX_WAIT_SEC}s; Playwright goto ${PLAYWRIGHT_GOTO_TIMEOUT_MS}ms)`);
});

// Increase timeout to 2 hours
server.timeout = 7200000;
server.keepAliveTimeout = 7200000;
server.headersTimeout = 7200000;
// Node 18+: default requestTimeout (e.g. 5 min) can drop long-running /compare while npm/webpack runs with no writes.
if (typeof server.requestTimeout !== 'undefined') {
    server.requestTimeout = 0;
}

app.use(express.json());

// Log all requests
app.use((req, res, next) => {
    log(`${req.method} ${req.url}`);
    next();
});

/** Liveness for curl / browser checks (GET / returns 404 from Express default). */
app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, uptimeSec: Math.round(process.uptime()) });
});

// Setup directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TEMP_DIR = path.join(__dirname, 'temp');

fs.ensureDirSync(UPLOADS_DIR);
fs.ensureDirSync(TEMP_DIR);

const upload = multer({
    dest: UPLOADS_DIR,
    limits: {
        fileSize: MAX_UPLOAD_MB * 1024 * 1024,
        files: 20,
        fields: 24,
    },
});

function compareUpload(req, res, next) {
    upload.fields([
        { name: 'solution', maxCount: 1 },
        { name: 'student', maxCount: 15 },
        { name: 'studentExcel', maxCount: 1 },
    ])(req, res, (err) => {
        if (err) {
            log(`Multipart upload error: ${err.code || 'ERR'} ${err.message}`);
            if (!res.headersSent) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({
                        error: `A file exceeded the server limit of ${MAX_UPLOAD_MB} MB per file. Compress ZIPs, split the batch, or set MAX_UPLOAD_MB in backend/.env (then restart PM2).`,
                    });
                }
                if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                    return res.status(400).json({
                        error: 'Too many files in this request. Use at most one solution, one Excel, and up to 10 student ZIPs per run.',
                    });
                }
                return res.status(400).json({ error: err.message || 'Upload failed' });
            }
        }
        next();
    });
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

const MASTER_DIR = path.join(__dirname, 'master_project');
const MASTER_MODULES = path.join(MASTER_DIR, 'node_modules');

/**
 * Shared node_modules for uploaded Vite apps (junction from student dir → master_project/node_modules).
 * CRA/react-scripts projects skip the junction (see studentProjectNeedsLocalNodeModules) because
 * webpack resolves symlinked packages to real paths under master_project/, which CRA's ModuleScopePlugin rejects.
 * Without this install, junctions point at an empty folder and Vite fails with ERR_MODULE_NOT_FOUND for @vitejs/plugin-react.
 */
async function ensureMasterProjectNodeModules(portLabel = '') {
    const marker = path.join(MASTER_MODULES, '@vitejs', 'plugin-react', 'package.json');
    if (await fs.pathExists(marker)) return;

    if (global.masterProjectInstallLock === undefined) global.masterProjectInstallLock = false;
    while (global.masterProjectInstallLock) {
        await new Promise((r) => setTimeout(r, 500));
    }
    if (await fs.pathExists(marker)) return;

    global.masterProjectInstallLock = true;
    const tag = portLabel ? `[${portLabel}] ` : '';
    try {
        log(`${tag}master_project/node_modules missing — running npm install in master_project (first run may take several minutes)...`);
        const logFile = path.join(MASTER_DIR, 'npm-install.log');
        await fs.ensureFile(logFile);
        await enqueueNpmInstallSerialized(async () => {
            try {
                const argv = getNpmInstallArgv(false);
                let code = await runNpmWithArgv(MASTER_DIR, logFile, argv);
                if (code === 137) {
                    log(`${tag}master_project npm install exited 137 — retrying once after 8s...`);
                    await new Promise((r) => setTimeout(r, 8000));
                    await fs.appendFile(logFile, `\n\n--- retry after exit 137 ${new Date().toISOString()} ---\n\n`);
                    code = await runNpmWithArgv(MASTER_DIR, logFile, argv);
                }
                if (code !== 0) {
                    log(`${tag}master_project npm install exited with code ${code} — see master_project/npm-install.log`);
                } else {
                    log(`${tag}master_project npm install finished successfully.`);
                }
            } catch (err) {
                log(`${tag}master_project npm install error: ${err.message}`);
            }
        });
    } finally {
        global.masterProjectInstallLock = false;
    }
}

/** Optional native packages esbuild + Rollup need on Linux under master_project/node_modules (shared Vite installs). */
function getLinuxNativeToolingPackages() {
    if (process.platform !== 'linux') return [];
    switch (process.arch) {
        case 'x64':
            return ['@esbuild/linux-x64', '@rollup/rollup-linux-x64-gnu'];
        case 'arm64':
            return ['@esbuild/linux-arm64', '@rollup/rollup-linux-arm64-gnu'];
        default:
            return [];
    }
}

/**
 * Ensure platform esbuild / Rollup binaries exist in master_project after install or "learning" upgrades.
 * Avoids: "The package \"@esbuild/linux-x64\" could not be found" when optional deps were omitted or pruned.
 */
async function ensureMasterNativeTooling(portLabel = '') {
    const pkgs = getLinuxNativeToolingPackages();
    if (!pkgs.length) return;
    const tag = portLabel ? `[${portLabel}] ` : '';
    const missing = [];
    for (const pkg of pkgs) {
        const marker = path.join(MASTER_MODULES, ...pkg.split('/'), 'package.json');
        if (!(await fs.pathExists(marker))) missing.push(pkg);
    }
    if (!missing.length) return;
    log(`${tag}Installing missing native tooling in master_project: ${missing.join(', ')}...`);
    await enqueueNpmInstallSerialized(async () => {
        const logFile = path.join(MASTER_DIR, 'npm-install-native.log');
        await fs.ensureFile(logFile);
        const argv = [
            'install',
            '--no-save',
            '--no-audit',
            '--no-fund',
            '--no-progress',
            '--legacy-peer-deps',
            ...missing,
        ];
        const code = await runNpmWithArgv(MASTER_DIR, logFile, argv);
        if (code !== 0) {
            log(`${tag}master_project native tooling npm exited ${code} — see master_project/npm-install-native.log`);
        }
    });
}

/**
 * Delete a directory tree (student temp dirs). fs-extra.remove can fail with ENOTEMPTY on webpack/babel caches;
 * use fs.rm retries then rm -rf on POSIX.
 */
async function removeTreeAggressive(dirPath, contextLabel = '') {
    if (!(await fs.pathExists(dirPath))) return;
    const label = contextLabel ? ` (${contextLabel})` : '';
    try {
        await fsp.rm(dirPath, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
    } catch (e1) {
        log(`removeTreeAggressive fs.rm failed${label}: ${e1.message}`);
        if (process.platform === 'win32') throw e1;
        await new Promise((resolve, reject) => {
            const child = spawn('rm', ['-rf', dirPath], { shell: false });
            child.on('error', reject);
            child.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`rm -rf exited ${code}`))
            );
        });
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

// --- Excel: GitHub repo links (supports .xlsx / .xls, plain text + hyperlink cells) ---

function stringifyCellDisplay(cell) {
    if (!cell) return '';
    if (cell.w != null) return String(cell.w).trim();
    if (cell.v == null) return '';
    if (cell.t === 'n' && typeof cell.v === 'number') return String(cell.v);
    return String(cell.v).trim();
}

function cellHyperlinkTarget(cell) {
    if (!cell || !cell.l) return null;
    const l = cell.l;
    const t = l.Target || l.target || l.href;
    return typeof t === 'string' ? t.trim() : null;
}

/** Normalize to https GitHub repo root for downloadRepoAsZip */
function normalizeRepoTaskUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    if (/^git@github\.com:/i.test(u)) {
        u = u.replace(/^git@github\.com:/i, 'https://github.com/').replace(/\.git$/i, '');
    }
    if (!/^https?:\/\//i.test(u)) {
        if (/^github\.com\//i.test(u)) u = `https://${u}`;
        else if (/^www\.github\.com\//i.test(u)) u = `https://${u.replace(/^www\./i, '')}`;
        else return null;
    }
    u = u.replace(/\/$/, '').replace(/\.git$/i, '');
    let host;
    try {
        host = new URL(u).hostname.toLowerCase();
    } catch {
        return null;
    }
    if (host !== 'github.com' && host !== 'www.github.com') return null;
    return u;
}

function pickGithubUrlFromCell(cell) {
    if (!cell) return null;
    const fromLink = normalizeRepoTaskUrl(cellHyperlinkTarget(cell));
    if (fromLink) return fromLink;
    const text = stringifyCellDisplay(cell);
    if (text && text.toLowerCase().includes('github.com')) {
        return normalizeRepoTaskUrl(text);
    }
    return null;
}

function repoDisplayNameFromUrl(url, rowLabel) {
    const label = rowLabel && String(rowLabel).trim();
    if (label && !/^https?:\/\//i.test(label) && !/^git@/i.test(label) && label.length <= 200) {
        return label;
    }
    try {
        const pathPart = url.replace(/^https?:\/\/github\.com\//i, '');
        const seg = pathPart.split('/').filter(Boolean);
        if (seg.length >= 2) return `${seg[0]}_${seg[1]}`;
        return seg[0] || 'Student';
    } catch {
        return 'Student';
    }
}

/**
 * Parse first sheet: one repo per row. URL may be plain text or Excel hyperlink (display text can omit "github.com").
 */
function parseExcelForLinks(filePath) {
    const buf = fs.readFileSync(filePath);
    let workbook;
    try {
        workbook = xlsx.read(buf, { type: 'buffer', cellDates: true });
    } catch (e) {
        throw new Error(`Could not read workbook: ${e.message}. Try saving as .xlsx.`);
    }
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        return [];
    }
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet || !sheet['!ref']) {
        return [];
    }

    const range = xlsx.utils.decode_range(sheet['!ref']);
    const results = [];
    const seenUrls = new Set();

    for (let R = range.s.r; R <= range.e.r; R++) {
        let urlForRow = null;
        let nameForRow = null;

        for (let C = range.s.c; C <= range.e.c; C++) {
            const addr = xlsx.utils.encode_cell({ r: R, c: C });
            const cell = sheet[addr];
            if (!cell) continue;

            const url = pickGithubUrlFromCell(cell);
            if (url) {
                urlForRow = urlForRow || url;
                continue;
            }
            const text = stringifyCellDisplay(cell);
            if (
                text &&
                !/^https?:\/\//i.test(text) &&
                !/^git@/i.test(text) &&
                text.length <= 200 &&
                !/^[=+\-@]/.test(text)
            ) {
                nameForRow = nameForRow || text;
            }
        }

        if (urlForRow && !seenUrls.has(urlForRow)) {
            seenUrls.add(urlForRow);
            results.push({
                url: urlForRow,
                name: repoDisplayNameFromUrl(urlForRow, nameForRow),
            });
        }
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
    if (typeof baseDir !== 'string' || !baseDir.length) {
        throw new Error(`findProjectRoot: baseDir must be a non-empty string, got ${typeof baseDir}`);
    }
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

/**
 * Ensures we always pass { path: string, type } into startServer / path.basename.
 * Guards against accidental double-wrapping or legacy callers passing a bare object.
 */
function asProjectInfo(root) {
    if (typeof root === 'string') {
        return { path: root, type: 'react' };
    }
    if (!root || typeof root !== 'object') {
        throw new Error(`Invalid project root: expected string or { path, type }, got ${typeof root}`);
    }
    let dir = root.path;
    const type = root.type || 'react';
    if (dir && typeof dir === 'object' && typeof dir.path === 'string') {
        dir = dir.path;
    }
    if (typeof dir !== 'string' || !dir.length) {
        throw new Error(
            `Invalid project root.path (must be a non-empty string). Got: ${typeof dir === 'object' ? JSON.stringify(dir).slice(0, 120) : String(dir)}`
        );
    }
    return { path: dir, type };
}


/** First usable script to run a local dev server (Vite/CRA/webpack/etc.) */
function pickNpmDevScript(scripts) {
    if (!scripts || typeof scripts !== 'object') return null;
    const order = ['dev', 'start', 'serve', 'develop', 'start:dev'];
    for (const name of order) {
        const body = scripts[name];
        if (typeof body === 'string' && body.trim()) return name;
    }
    return null;
}

/**
 * Whether to append `-- --port … --host …` after `npm run <cmd>`.
 * CRA/react-scripts should rely on PORT env only; Vite/webpack-dev-server need flags.
 */
function npmScriptNeedsPortFlag(scriptCmd, cmdName) {
    const s = (scriptCmd || '').toLowerCase();
    if (/react-scripts|craco|react-app-rewired/.test(s)) return false;
    if (/next\s/.test(s)) return false;
    if (/vite\s+preview|\bpreview\b/.test(s)) return false;
    if (/vite|webpack-dev-server|parcel\s/.test(s)) return true;
    if (cmdName === 'dev') return true;
    return false;
}

/**
 * Create React App resolves symlinked node_modules to their real path (e.g. master_project/...).
 * ModuleScopePlugin then rejects react-refresh and similar as "outside src/". Vite does not
 * have this restriction, so we keep the shared master_project junction only for non-CRA flows.
 */
function studentProjectNeedsLocalNodeModules(pkg) {
    if (!pkg || typeof pkg !== 'object') return false;
    const scripts = pkg.scripts || {};
    const scriptBodies = Object.values(scripts)
        .filter((s) => typeof s === 'string')
        .join(' ');
    if (/react-scripts|craco|react-app-rewired/.test(scriptBodies)) return true;
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps['react-scripts'] || deps.craco || deps['react-app-rewired']) return true;
    return false;
}

async function readTextFileTail(filePath, maxLines = 28) {
    try {
        if (!(await fs.pathExists(filePath))) return '';
        const st = await fs.stat(filePath);
        if (!st.size) return '';
        const chunk = Math.min(st.size, 98304);
        const fh = await fsp.open(filePath, 'r');
        try {
            const buf = Buffer.alloc(chunk);
            await fh.read(buf, 0, chunk, st.size - chunk, null);
            const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
            return lines.slice(-maxLines).join('\n').trim();
        } finally {
            await fh.close();
        }
    } catch {
        return '';
    }
}

function npmInstallLooksLikeNetworkError(tail) {
    return /EAI_AGAIN|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ENETUNREACH|getaddrinfo|socket hang up|fetch failed|NetworkError|npm ERR.*network|code\s*ENOTFOUND|code\s*ETIMEDOUT/i.test(
        tail || ''
    );
}

function npmIsCompleteLogPointerLine(L) {
    return /A complete log of this run can be found in/i.test(L);
}

/**
 * Prefer real failure lines (`npm ERR!`, `npm error`, ERESOLVE, engine errors).
 * Ignores npm's "complete log in ~/.npm/_logs/…" pointer here — use {@link tryReadNpmDebugLogExcerpt} for that file.
 */
function extractNpmInstallErrorSnippet(text, maxLen = 900) {
    if (!text || !String(text).trim()) return '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    const errLine = (L) => {
        if (npmIsCompleteLogPointerLine(L)) return false;
        return (
            /^\s*npm ERR!/i.test(L) ||
            /^\s*npm error\b/i.test(L) ||
            /\bERESOLVE\b|peer dependency|Unsupported engine|EBADENGINE|ENOTEMPTY|EACCES|syscall connect|ENOSPC|no space left on device|TAR_ENTRY_ERROR/i.test(
                L
            ) ||
            /\b404 Not Found\b|code E404/i.test(L)
        );
    };
    let lastErr = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (errLine(lines[i])) {
            lastErr = i;
            break;
        }
    }
    let pick;
    if (lastErr >= 0) {
        const start = Math.max(0, lastErr - 3);
        pick = lines.slice(start).join('\n').trim();
    } else {
        const nonWarn = lines.filter((L) => {
            const t = L.trim();
            return t && !/^\s*npm warn /i.test(L) && !npmIsCompleteLogPointerLine(L);
        });
        pick = nonWarn.slice(-30).join('\n').trim() || lines.slice(-20).join('\n').trim();
    }
    const one = pick.replace(/\s+/g, ' ').trim();
    return one.length <= maxLen ? one : `${one.slice(0, maxLen)}…`;
}

/**
 * npm 7+ often prints only "npm error A complete log of this run can be found in: …/.npm/_logs/…-debug-0.log"
 * to stdout/stderr; real errors are in that debug file. Read its tail when the path appears in project output.
 */
async function tryReadNpmDebugLogExcerpt(projectLogTail, maxLen = 1200) {
    const re = /(\/[\w./~-]+\/\.npm\/_logs\/\S+\.log)/g;
    const paths = [];
    let m;
    while ((m = re.exec(String(projectLogTail || '')))) paths.push(m[1]);
    if (!paths.length) return '';
    for (let i = paths.length - 1; i >= 0; i--) {
        const p = paths[i];
        try {
            if (!(await fs.pathExists(p))) continue;
            const dt = await readTextFileTail(p, 140);
            const snip = extractNpmInstallErrorSnippet(dt, maxLen);
            if (snip) return snip;
        } catch {
            /* ignore */
        }
    }
    return '';
}

async function npmInstallInProject(projectDir, port) {
    return enqueueNpmInstallSerialized(async () => {
        const logFile = path.join(projectDir, 'npm-install.log');
        await fs.ensureFile(logFile);
        log(
            `[${port}] Running npm install in project${NPM_INSTALL_SERIALIZE ? ' (queued, one at a time)' : ''} — see npm-install.log`
        );
        const argv = getNpmInstallArgv();
        let code = await runNpmWithArgv(projectDir, logFile, argv);
        if (code === 137) {
            log(`[${port}] npm install exited 137 — waiting 8s and retrying once (transient OOM)...`);
            await new Promise((r) => setTimeout(r, 8000));
            await fs.appendFile(logFile, `\n\n--- npm install retry (previous exit 137) ${new Date().toISOString()} ---\n\n`);
            code = await runNpmWithArgv(projectDir, logFile, argv);
        }
        if (code !== 0) {
            let tail = await readTextFileTail(logFile, 120);
            if (tail) {
                log(`[${port}] npm-install.log (tail):\n${tail}`);
            }
            if (code === 1 && npmInstallLooksLikeNetworkError(tail)) {
                log(`[${port}] npm install exit 1 looks network-related — retrying once in 10s...`);
                await new Promise((r) => setTimeout(r, 10000));
                await fs.appendFile(logFile, `\n\n--- npm install retry (network) ${new Date().toISOString()} ---\n\n`);
                code = await runNpmWithArgv(projectDir, logFile, argv);
                if (code === 0) return;
                tail = await readTextFileTail(logFile, 120);
                if (tail) log(`[${port}] npm-install.log (tail after retry):\n${tail}`);
            }
        }
        if (code !== 0) {
            const tail = await readTextFileTail(logFile, 120);
            let excerpt = extractNpmInstallErrorSnippet(tail);
            const fromDebug = await tryReadNpmDebugLogExcerpt(tail);
            if (fromDebug) excerpt = fromDebug;
            else if (/complete log of this run/i.test(tail) && excerpt && npmIsCompleteLogPointerLine(excerpt)) {
                excerpt =
                    `${excerpt} (Could not read ~/.npm/_logs debug file from API process — on the server run: tail -80 on the path printed above.)`;
            }
            let hint = '';
            if (code === 137) {
                hint =
                    ' Exit 137 = Linux OOM killer (out of RAM). Add swap or use a larger EC2 instance; try NPM_INSTALL_HEAP_MB=512, keep NPM_INSTALL_SERIALIZE=1 (default), and see DEPLOYMENT.md → “Adding swap (exit 137)”.';
            } else if (code === 1) {
                const diskFull =
                    /\bENOSPC\b|no space left on device/i.test(`${tail || ''}\n${excerpt || ''}`);
                const diskHint = diskFull
                    ? ' DISK FULL (ENOSPC): run df -h; clear backend/temp, /var/lib/nginx/body, npm cache clean --force; grow EBS if needed. '
                    : '';
                hint = ` npm exited 1.${diskHint}(See Snippet for ERESOLVE / engine / audit / ENOSPC — trailing "npm warn deprecated" is usually harmless.)${excerpt ? ` Snippet: ${excerpt}` : ''}`;
            } else {
                hint = excerpt ? ` Snippet: ${excerpt}` : '';
            }
            throw new Error(`npm install in project exited with code ${code}. See ${logFile}.${hint}`);
        }
    });
}


// Helper: Run server (React/Static)
function startServer(projectInfo, port) {
    const { path: projectDir, type } = asProjectInfo(projectInfo);

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

            // React/Vite/CRA logic (masterDir used for shared node_modules + learning installs)
            const masterDir = path.join(__dirname, 'master_project');

            // Read package.json to find the right script and identify missing deps
            let studentPkg = {};
            try {
                studentPkg = fs.readJsonSync(path.join(projectDir, 'package.json'));
            } catch (e) {
                log(`[${port}] Failed to read package.json files`);
            }

            // Global lock for learning to prevent race conditions
            if (global.isLearning === undefined) global.isLearning = false;

            const runStart = async () => {
                await ensureMasterProjectNodeModules(port);
                const vitePluginMarker = path.join(
                    MASTER_MODULES,
                    '@vitejs',
                    'plugin-react',
                    'package.json'
                );
                if (!(await fs.pathExists(vitePluginMarker))) {
                    throw new Error(
                        'master_project is missing Vite dependencies. Run: cd backend/master_project && npm install (see master_project/npm-install.log if auto-install ran).'
                    );
                }

                const useLocalNodeModules =
                    /^(1|true|yes)$/i.test(String(process.env.DISABLE_SHARED_NODE_MODULES || '')) ||
                    studentProjectNeedsLocalNodeModules(studentPkg);

                if (useLocalNodeModules) {
                    log(
                        `[${port}] Using project-local node_modules (CRA/react-scripts cannot use a symlink to master_project — ModuleScope blocks paths outside src/).`
                    );
                    const targetModules = path.join(projectDir, 'node_modules');
                    if (await fs.pathExists(targetModules)) {
                        log(`[${port}] Removing existing node_modules for local install...`);
                        await fs.remove(targetModules);
                    }
                    await npmInstallInProject(projectDir, port);
                } else {
                    // Determine missing dependencies or version mismatches
                    const studentDeps = { ...(studentPkg.dependencies || {}), ...(studentPkg.devDependencies || {}) };
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
                                const inst = spawn(
                                    'npm',
                                    [
                                        'install',
                                        '--save',
                                        ...stillMissing,
                                        '--no-audit',
                                        '--no-fund',
                                        '--no-progress',
                                        '--legacy-peer-deps',
                                        '--prefer-offline',
                                    ],
                                    {
                                        cwd: masterDir,
                                        shell: true,
                                        env: buildNpmInstallChildEnv(),
                                    }
                                );

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

                await ensureMasterNativeTooling(port);

                log(`[${port}] Starting server...`);
                const logPath = path.join(projectDir, 'dev-server.log');
                const logStream = fs.createWriteStream(logPath, { flags: 'a' });

                const scripts = studentPkg.scripts || {};
                const cmd = pickNpmDevScript(scripts);
                if (!cmd) {
                    throw new Error(
                        'package.json has no dev server script. Add one of: "dev", "start", or "serve" (e.g. "dev": "vite" or "start": "react-scripts start").'
                    );
                }
                log(`[${port}] Using npm run ${cmd}`);

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
                const scriptBody = (scripts[cmd] || '').toLowerCase();
                // CRA/webpack dev server is memory-heavy; reduce RAM + optional Node heap cap (see WEBPACK_DEV_HEAP_MB)
                const env = {
                    ...process.env,
                    PORT: port.toString(),
                    BROWSER: 'none',
                    HOST: '127.0.0.1',
                    CI: 'true',
                    WDS_SOCKET_PORT: port.toString(),
                    SKIP_PREFLIGHT_CHECK: 'true',
                    GENERATE_SOURCEMAP: 'false',
                    DISABLE_ESLINT_PLUGIN: 'true',
                    INLINE_RUNTIME_CHUNK: 'false',
                    NODE_OPTIONS: '--openssl-legacy-provider',
                };
                if (/react-scripts|craco|react-app-rewired/.test(scriptBody)) {
                    const heapMb = Math.max(
                        512,
                        parseInt(process.env.WEBPACK_DEV_HEAP_MB || '1024', 10) || 1024
                    );
                    env.NODE_OPTIONS = `--openssl-legacy-provider --max-old-space-size=${heapMb}`;
                }

                const args = ['run', cmd];
                if (npmScriptNeedsPortFlag(scripts[cmd], cmd)) {
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

            runStart().catch((err) => {
                log(`[${port}] runStart failed: ${err.message}`);
                reject(err);
            });

        } catch (e) {
            log(`[${port}] Setup failed: ${e.message}`);
            reject(e);
        }
    });
}

function checkServerReady(port, basePath, serverProcess, resolve, reject, logPath) {
    let attempts = 0;
    const maxAttempts = SERVER_READY_MAX_WAIT_SEC;

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
            log(`[${port}] Server startup timed out after ${maxAttempts}s (raise SERVER_READY_MAX_WAIT_SEC / SERVER_READY_TIMEOUT_MS or use a larger EC2)`);
            return reject(new Error(`Timeout waiting for server on port ${port} after ${maxAttempts}s. CRA/webpack may still be compiling — see dev-server.log in the project folder, or increase SERVER_READY_MAX_WAIT_SEC in backend/.env.`));
        }
        attempts++;

        if (attempts % 10 === 0) {
            log(`[${port}] Still waiting for server... (${attempts}s / ${maxAttempts}s)`);
        }

        if (attempts % 60 === 0 && attempts > 0 && logPath && await fs.pathExists(logPath)) {
            try {
                const content = await fs.readFile(logPath, 'utf8');
                const tail = content.split('\n').filter(Boolean).slice(-10).join('\n');
                if (tail) log(`[${port}] dev-server.log (last lines):\n${tail}`);
            } catch {
                /* ignore */
            }
        }

        try {
            const url = `http://127.0.0.1:${port}${basePath}`;
            // Use axios for better control over timeouts and errors, bypassing any proxies
            await axios.get(url, {
                timeout: SERVER_READY_TIMEOUT_MS,
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
                    await axios.get(localUrl, {
                        timeout: SERVER_READY_TIMEOUT_MS,
                        proxy: false,
                        headers: { 'Accept': 'text/html', 'ngrok-skip-browser-warning': 'true' },
                        validateStatus: (status) => status >= 200 && status < 500,
                    });
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
// onRouteProgress: optional ({ kind: 'start'|'done', route, pageLabel, fileName, ok?, error? }) => void
async function captureScreenshots(baseUrl, routes, outputDir, sharedBrowser = null, onRouteProgress = null) {
    await fs.ensureDir(outputDir);
    const ownBrowser = !sharedBrowser;
    const browser = sharedBrowser || await chromium.launch();
    const page = await browser.newPage();

    for (const route of routes) {
        const url = `${baseUrl}${route}`;
        // Handle route name for file (remove slashes)
        const fileName = route === '/' ? 'index.png' : `${route.replace(/\//g, '')}.png`;
        const pageLabel = route === '/' ? 'Home Page' : route;
        const savePath = path.join(outputDir, fileName);

        try {
            if (onRouteProgress) {
                onRouteProgress({ kind: 'start', route, pageLabel, fileName });
            }
            log(`Navigating to ${url}...`);
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto(url, { waitUntil: 'load', timeout: PLAYWRIGHT_GOTO_TIMEOUT_MS });

            // Inject CSS to disable animations/transitions
            await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' });

            // Small settle delay for dynamic layout without adding too much latency
            await page.waitForTimeout(300);

            await page.screenshot({ path: savePath, fullPage: true });
            if (onRouteProgress) {
                onRouteProgress({ kind: 'done', route, pageLabel, fileName, ok: true });
            }
        } catch (e) {
            log(`Failed to capture ${url}: ${e.message}`);
            if (onRouteProgress) {
                onRouteProgress({ kind: 'done', route, pageLabel, fileName, ok: false, error: e.message });
            }
        }
    }

    await page.close();
    if (ownBrowser) {
        await browser.close();
    }
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

app.post('/compare', compareUpload, async (req, res) => {
    const solutionFile = req.files['solution']?.[0];
    const studentFiles = req.files['student'] || [];
    const studentExcel = req.files['studentExcel']?.[0];

    if (!solutionFile || (studentFiles.length === 0 && !studentExcel)) {
        return res.status(400).json({ error: 'Both solution and either student ZIP files or student Excel sheet are required.' });
    }

    const uploadBytes = (f) => (f && typeof f.size === 'number' ? f.size : 0);
    const kb = (n) => `${Math.round(n / 1024)}KB`;
    log(
        `POST /compare: limit ${MAX_UPLOAD_MB}MB/file | solution ${kb(uploadBytes(solutionFile))} | ` +
            `${studentFiles.length} student ZIP(s): ${studentFiles.map((f) => `${f.originalname || 'file'}(${kb(uploadBytes(f))})`).join(', ')}` +
            (studentExcel ? ` | excel ${kb(uploadBytes(studentExcel))}` : '')
    );

    // Set up streaming response (chunked NDJSON; avoid proxy buffering where possible)
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendProgress = (data) => {
        res.write(JSON.stringify(data) + '\n');
        if (typeof res.flush === 'function') {
            res.flush();
        }
    };

    const runId = Date.now().toString();
    const runDir = path.join(TEMP_DIR, runId);
    const solExtractDir = path.join(runDir, 'solution_raw');

    // Performance tracking
    const startOverall = performance.now();

    let solServer; // Declare solServer here to be accessible in finally block
    let sharedBrowser; // Reuse one Playwright browser per compare run
    let heartbeatInterval = null;

    try {
        heartbeatInterval = setInterval(() => {
            try {
                if (res.writableEnded) return;
                res.write(JSON.stringify({ type: 'heartbeat', message: 'Still processing…' }) + '\n');
                if (typeof res.flush === 'function') {
                    res.flush();
                }
            } catch {
                /* client disconnected or socket closed */
            }
        }, 20000);

        sharedBrowser = await chromium.launch();

        // 1. Prepare Solution (Once)
        sendProgress({ type: 'status', message: 'Extracting Solution ZIP...' });
        await fs.ensureDir(solExtractDir);
        extractAdmZipSafe(solutionFile.path, solExtractDir);

        const solRoot = asProjectInfo(await findProjectRoot(solExtractDir));
        const solPort = 14000 + Math.floor(Math.random() * 500);
        sendProgress({ type: 'status', message: 'Starting Solution Server...' });
        solServer = await startServer(solRoot, solPort); // Assign to solServer

        const solScreenshotDir = path.join(runDir, 'solution', 'screenshots');
        await fs.ensureDir(solScreenshotDir);

        sendProgress({ type: 'status', message: 'Capturing Solution Screenshots...' });
        const routes = ['/'];
        await captureScreenshots(solServer.baseUrl, routes, solScreenshotDir, sharedBrowser, (evt) => {
            if (evt.kind === 'start') {
                sendProgress({
                    type: 'pipeline',
                    scope: 'reference',
                    projectIndex: 0,
                    projectTotal: 0,
                    studentName: 'Reference solution',
                    phase: 'screenshot_capture',
                    message: `Capturing ${evt.pageLabel} (${evt.route}) → ${evt.fileName}…`
                });
            } else if (evt.ok) {
                sendProgress({
                    type: 'pipeline',
                    scope: 'reference',
                    projectIndex: 0,
                    projectTotal: 0,
                    studentName: 'Reference solution',
                    phase: 'screenshot_saved',
                    message: `Screenshot saved — ${evt.fileName} (${evt.pageLabel})`
                });
            } else {
                sendProgress({
                    type: 'pipeline',
                    scope: 'reference',
                    projectIndex: 0,
                    projectTotal: 0,
                    studentName: 'Reference solution',
                    phase: 'screenshot_failed',
                    message: `Screenshot failed — ${evt.fileName}: ${evt.error || 'unknown error'}`
                });
            }
        });

        // FREE UP RAM FOR AWS t3.micro: Kill the solution server immediately after screenshots!
        if (solServer?.process) {
            killProcess(solServer.process);
            solServer = null;
        }

        // Isolate reference screenshots so a malicious student zip cannot overwrite ../solution via zip-slip
        const solScreenshotReadDir = path.join(runDir, '_reference_solution', 'screenshots');
        await fs.ensureDir(solScreenshotReadDir);
        await fs.copy(solScreenshotDir, solScreenshotReadDir, { overwrite: true });
        log(`Reference screenshots copied to ${solScreenshotReadDir}`);

        // 2. Prepare Student Task List
        const studentTasks = [];

        // Add files
        studentFiles.forEach(file => {
            studentTasks.push({ type: 'file', path: file.path, name: file.originalname });
        });

        // Add Excel links
        if (studentExcel) {
            let excelParseError = null;
            try {
                const links = parseExcelForLinks(studentExcel.path);
                if (links.length === 0) {
                    log('Excel: no GitHub repository URLs found in the first sheet.');
                    sendProgress({
                        type: 'status',
                        message:
                            'Excel had no usable GitHub links. Put https://github.com/user/repo in a cell or as a hyperlink (one repo per row).',
                    });
                } else {
                    log(`Excel: parsed ${links.length} GitHub repo link(s).`);
                    links.forEach((link) => {
                        studentTasks.push({ type: 'repo', path: link.url, name: link.name });
                    });
                }
            } catch (e) {
                excelParseError = e;
                log(`Failed to parse Excel: ${e.message}`);
                sendProgress({
                    type: 'error',
                    message: `Excel could not be read: ${e.message}`,
                });
            } finally {
                await fs.remove(studentExcel.path).catch(() => {});
            }
            if (excelParseError && studentFiles.length === 0) {
                res.end();
                return;
            }
        }

        if (studentTasks.length === 0) {
            const msg =
                'No student projects to process. Upload ZIP file(s) and/or add GitHub repository URLs to your Excel sheet.';
            sendProgress({ type: 'error', message: msg });
            res.end();
            return;
        }

        // 3. Process Students in Batches
        const allResults = [];
        const BATCH_SIZE = 1; // SAFE MODE: Only 1 at a time for AWS Free Tier/Small servers!

        sendProgress({ type: 'start', total: studentTasks.length });
        sendProgress({
            type: 'status',
            message: `Queued ${studentTasks.length} project(s) — processing sequentially (one at a time).`
        });

        for (let i = 0; i < studentTasks.length; i += BATCH_SIZE) {
            const batch = studentTasks.slice(i, i + BATCH_SIZE);
            sendProgress({ type: 'progress', current: i, total: studentTasks.length, message: `Processing batch ${Math.floor(i / BATCH_SIZE) + 1}...` });
            const batchPromises = batch.map(async (task, index) => {
                let stuServer; // Declare stuServer for cleanup within the batch item
                const stuId = `student_${i + index}`;
                const stuExtractDir = path.join(runDir, stuId, 'raw');
                const stuScreenshotDir = path.join(runDir, stuId, 'screenshots');
                const diffScreenshotDir = path.join(runDir, stuId, 'diffs');
                const projectNum = i + index + 1;
                const projectTotal = studentTasks.length;

                const tStart = performance.now();
                let tUnzip = 0, tSetup = 0, tScreenshot = 0, tCompare = 0;

                try {
                    await fs.ensureDir(stuScreenshotDir);
                    await fs.ensureDir(diffScreenshotDir);

                    log(`Processing ${task.name}...`);

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'extract',
                        message: 'Extracting archive and preparing workspace…'
                    });

                    const tUnzipStart = performance.now();
                    let zipPath = task.path;

                    if (task.type === 'repo') {
                        sendProgress({
                            type: 'pipeline',
                            projectIndex: projectNum,
                            projectTotal,
                            studentName: task.name,
                            phase: 'fetch',
                            message: 'Downloading repository as .zip…'
                        });
                        zipPath = path.join(runDir, `${stuId}_repo.zip`);
                        await downloadRepoAsZip(task.path, zipPath);
                        sendProgress({
                            type: 'pipeline',
                            projectIndex: projectNum,
                            projectTotal,
                            studentName: task.name,
                            phase: 'fetch_done',
                            message: 'Repository .zip downloaded — extracting…'
                        });
                    }

                    extractAdmZipSafe(zipPath, stuExtractDir);
                    tUnzip = performance.now() - tUnzipStart;

                    try {
                        const rootEntries = await fs.readdir(stuExtractDir);
                        sendProgress({
                            type: 'pipeline',
                            projectIndex: projectNum,
                            projectTotal,
                            studentName: task.name,
                            phase: 'extract_detail',
                            message: `Archive extracted — ${rootEntries.length} item(s) at workspace root.`
                        });
                    } catch {
                        /* ignore */
                    }

                    // Clean up downloaded zip if it's a repo
                    if (task.type === 'repo') {
                        await fs.remove(zipPath).catch(() => { });
                    }

                    const t0 = performance.now();
                    const stuProjectRoot = asProjectInfo(await findProjectRoot(stuExtractDir));
                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'workspace',
                        message: `Project root: ${path.basename(stuProjectRoot.path)}`
                    });
                    const stuPort = 15000 + (i * 10) + (index + Math.floor(Math.random() * 100));

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'server',
                        message: 'Starting local dev server (Vite/React)…'
                    });

                    stuServer = await startServer(stuProjectRoot, stuPort); // Assign to stuServer
                    tSetup = performance.now() - t0;

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'server_ready',
                        message: `Dev server ready — ${stuServer.baseUrl}`
                    });

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'screenshots',
                        message: 'Taking UI screenshots (Playwright)…'
                    });

                    const t1 = performance.now();
                    await captureScreenshots(stuServer.baseUrl, routes, stuScreenshotDir, sharedBrowser, (evt) => {
                        if (evt.kind === 'start') {
                            sendProgress({
                                type: 'pipeline',
                                projectIndex: projectNum,
                                projectTotal,
                                studentName: task.name,
                                phase: 'screenshot_capture',
                                message: `Capturing ${evt.pageLabel} (${evt.route}) → ${evt.fileName}…`
                            });
                        } else if (evt.ok) {
                            sendProgress({
                                type: 'pipeline',
                                projectIndex: projectNum,
                                projectTotal,
                                studentName: task.name,
                                phase: 'screenshot_saved',
                                message: `Screenshot saved — ${evt.fileName} (${evt.pageLabel})`
                            });
                        } else {
                            sendProgress({
                                type: 'pipeline',
                                projectIndex: projectNum,
                                projectTotal,
                                studentName: task.name,
                                phase: 'screenshot_failed',
                                message: `Screenshot failed — ${evt.fileName}: ${evt.error || 'unknown error'}`
                            });
                        }
                    });
                    tScreenshot = performance.now() - t1;

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'compare',
                        message: 'Comparing pixels against reference screenshots…'
                    });

                    // Compare
                    const pageResults = {};
                    let totalScore = 0;

                    const t2 = performance.now();
                    const solutionBase64Cache = {}; // Cache to avoid redundant encoding

                    for (const route of routes) {
                        const fileName = route === '/' ? 'index.png' : `${route.replace(/\//g, '')}.png`;
                        const solImg = path.join(solScreenshotReadDir, fileName);
                        const stuImg = path.join(stuScreenshotDir, fileName);
                        const diffImg = path.join(diffScreenshotDir, fileName);

                        const score = compareImages(solImg, stuImg, diffImg);
                        const name = route === '/' ? 'Home Page' : route;

                        sendProgress({
                            type: 'pipeline',
                            projectIndex: projectNum,
                            projectTotal,
                            studentName: task.name,
                            phase: 'compare_page',
                            message: `Compare ${name} (${fileName}): ${score}% pixel match`
                        });

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

                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'complete',
                        message: `Validation complete — overall match ${scoreNum}%.`
                    });

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
                    sendProgress({
                        type: 'pipeline',
                        projectIndex: projectNum,
                        projectTotal,
                        studentName: task.name,
                        phase: 'error',
                        message: `Stopped: ${err.message}`
                    });
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
                    try {
                        await removeTreeAggressive(stuWorkDir, stuId);
                    } catch (e) {
                        log(`Cleanup error for ${stuId}: ${e.message}`);
                    }
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
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
        // Delete the entire run directory after the request ends (success or error)
        if (runDir) {
            await fs.remove(runDir).catch(e => log(`Crucial Cleanup Error: ${e.message}`));
            log(`[Final Cleanup] Wiped ${runDir}`);
        }

        // Cleanup any surviving solution server processes
        if (solServer?.process) {
            killProcess(solServer.process);
        }

        if (sharedBrowser) {
            await sharedBrowser.close().catch(() => { });
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


