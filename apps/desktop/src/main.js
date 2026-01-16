const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { createNtaBridge } = require('./services/ntaBridge');
const { EngineGateway } = require('./main/engineGateway');
const { registerEngineIpc } = require('./main/ipc');

const DEFAULT_ENGINE_PORT = 55554;
const ENGINE_PORT = (() => {
    if (process.env.VMUSIC_ENGINE_PORT) {
        const port = parseInt(process.env.VMUSIC_ENGINE_PORT, 10);
        return Number.isFinite(port) ? port : DEFAULT_ENGINE_PORT;
    }
    if (process.env.VMUSIC_ENGINE_URL) {
        try {
            const parsed = new URL(process.env.VMUSIC_ENGINE_URL);
            if (parsed.port) {
                return parseInt(parsed.port, 10);
            }
        } catch (_err) {
            return DEFAULT_ENGINE_PORT;
        }
    }
    return DEFAULT_ENGINE_PORT;
})();
const ENGINE_URL = process.env.VMUSIC_ENGINE_URL || `http://127.0.0.1:${ENGINE_PORT}`;
process.env.VMUSIC_ENGINE_URL = ENGINE_URL;
process.env.VMUSIC_ENGINE_PORT = String(ENGINE_PORT);

const musicHandlers = require('./ipc/musicHandlers');

let audioEngineProcess = null;
let mainWindow = null;
let openChildWindows = [];
let ntaBridge = null;
let engineGateway = null;
let restartAttempts = 0;
let restartTimer = null;
let appQuitting = false;
let lastEngineStatus = null;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_MS = [0, 1000, 2000, 5000, 10000, 15000];

function broadcastEngineStatus(connected, message) {
    const payload = { type: 'engine.status', connected: Boolean(connected), message };
    lastEngineStatus = payload;
    broadcastEngineEvent(payload);
}

function getAppRoot() {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
}

function getInstallRoot() {
    if (!app.isPackaged) return getAppRoot();
    return path.dirname(process.execPath);
}

function getAppDataRoot() {
    return app.isPackaged ? app.getPath('userData') : path.join(getAppRoot(), 'AppData');
}

function getSoxrDir() {
    return path.join(getAppDataRoot(), 'deps', 'soxr');
}

function getNtaDir() {
    return path.join(getAppDataRoot(), 'nta');
}

function resolveRendererTarget() {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
        return { type: 'url', value: devUrl };
    }
    const appPath = app.isPackaged ? app.getAppPath() : getAppRoot();
    const rendererIndex = path.join(appPath, 'renderer-dist', 'index.html');
    if (fs.pathExistsSync(rendererIndex)) {
        return { type: 'file', value: rendererIndex };
    }
    return { type: 'file', value: path.join(__dirname, 'ui', 'music.html') };
}

function resolveEngineBinary() {
    const executable = process.platform === 'win32' ? 'vmusic_engine.exe' : 'vmusic_engine';
    const appRoot = getAppRoot();
    const installRoot = getInstallRoot();
    const candidates = app.isPackaged
        ? [
              path.join(installRoot, 'engine', executable),
              path.join(process.resourcesPath, 'engine', executable)
          ]
        : [
              path.join(appRoot, 'engine', 'bin', executable),
              path.join(appRoot, 'engine', 'rust', 'vmusic_engine', 'target', 'release', executable),
              path.join(appRoot, 'engine', 'rust', 'vmusic_engine', 'target', 'debug', executable)
          ];

    for (const candidate of candidates) {
        if (fs.pathExistsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

async function ensureAppDataDirs() {
    const appDataRoot = getAppDataRoot();
    await fs.ensureDir(appDataRoot);
    await fs.ensureDir(getSoxrDir());
    await fs.ensureDir(getNtaDir());
}

function startAudioEngine() {
    return new Promise((resolve, reject) => {
        if (audioEngineProcess && !audioEngineProcess.killed) {
            resolve();
            return;
        }

        const enginePath = resolveEngineBinary();
        if (!enginePath) {
            broadcastEngineStatus(false, 'engine binary not found');
            reject(new Error('Rust audio engine not found. Please build vmusic_engine.exe.'));
            return;
        }
        const engineDir = path.dirname(enginePath);
        const soxrDir = process.env.VMUSIC_SOXR_DIR || getSoxrDir();
        const spectrumSpec = ntaBridge ? ntaBridge.getSpectrumSpec() : null;
        const env = {
            ...process.env,
            VMUSIC_ENGINE_PORT: String(ENGINE_PORT),
            VMUSIC_ENGINE_URL: ENGINE_URL,
            VMUSIC_ASSET_DIR: engineDir,
            VMUSIC_SOXR_DIR: soxrDir
        };
        if (spectrumSpec && spectrumSpec.path) {
            env.NTMUSIC_SPECTRUM_SHM = spectrumSpec.path;
            env.NTMUSIC_SPECTRUM_BINS = String(spectrumSpec.bins || 0);
        }
        const controlSpec = ntaBridge ? ntaBridge.getControlSpec() : null;
        if (controlSpec && controlSpec.path) {
            env.NTMUSIC_CONTROL_SHM = controlSpec.path;
            env.NTMUSIC_CONTROL_CAPACITY = String(controlSpec.capacity || 0);
        }

        audioEngineProcess = spawn(enginePath, [], { cwd: engineDir, env });

        const readyTimeout = setTimeout(() => {
            broadcastEngineStatus(false, 'engine startup timeout');
            reject(new Error('Audio Engine timed out.'));
        }, 15000);

        audioEngineProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output.includes('VMUSIC_ENGINE_READY')) {
                clearTimeout(readyTimeout);
                restartAttempts = 0;
                broadcastEngineStatus(true, 'engine ready');
                resolve();
            }
        });

        audioEngineProcess.stderr.on('data', (data) => {
            const logLine = data.toString().trim();
            if (logLine && !logLine.includes('GET /state HTTP/1.1')) {
                console.error(`[AudioEngine STDERR]: ${logLine}`);
            }
        });

        audioEngineProcess.on('close', () => {
            audioEngineProcess = null;
            scheduleEngineRestart('engine-closed');
        });

        audioEngineProcess.on('error', (err) => {
            clearTimeout(readyTimeout);
            broadcastEngineStatus(false, `engine error: ${err.message}`);
            reject(err);
        });
    });
}

function scheduleEngineRestart(reason) {
    if (appQuitting) return;
    if (restartTimer) return;
    if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
        console.error(`[AudioEngine] restart attempts exceeded (${MAX_RESTART_ATTEMPTS}). Last reason: ${reason}`);
        broadcastEngineStatus(false, `engine restart failed (${reason})`);
        return;
    }
    const index = Math.min(restartAttempts, RESTART_BACKOFF_MS.length - 1);
    const delay = RESTART_BACKOFF_MS[index];
    restartAttempts += 1;
    broadcastEngineStatus(false, `engine restarting (${restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
    restartTimer = setTimeout(async () => {
        restartTimer = null;
        try {
            await startAudioEngine();
        } catch (err) {
            console.error('[AudioEngine] restart failed:', err);
            scheduleEngineRestart('restart-failed');
        }
    }, delay);
}

function stopAudioEngine() {
    if (audioEngineProcess && !audioEngineProcess.killed) {
        audioEngineProcess.kill();
    }
    audioEngineProcess = null;
}

function registerWindowControls() {
    ipcMain.handle('window-minimize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.minimize();
    });

    ipcMain.handle('window-maximize', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    });

    ipcMain.handle('window-close', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.close();
    });

    ipcMain.handle('get-current-theme', () =>
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    );

    nativeTheme.on('updated', () => {
        const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('theme-updated', theme);
        }
    });
}

function registerNtaBridgeIpc() {
    if (!ntaBridge) return;
    ipcMain.handle('nta-get-spectrum-spec', () => ntaBridge.getSpectrumSpec());
    ipcMain.handle('nta-get-spectrum-length', () => ntaBridge.getSpectrumLength());
    ipcMain.handle('nta-get-status', () => ntaBridge.getStatus());
    ipcMain.handle('nta-get-control-spec', () => ntaBridge.getControlSpec());
}

function broadcastEngineEvent(event) {
    if (event && event.type === 'engine.status') {
        lastEngineStatus = event;
    }
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('engine:event', event);
    }
}

function sendEngineStatusToWebContents(webContents) {
    if (!lastEngineStatus || !webContents || webContents.isDestroyed()) return;
    webContents.send('engine:event', lastEngineStatus);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEngineHttpReady(maxAttempts = 12, intervalMs = 500) {
    if (!engineGateway) return false;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const ok = await engineGateway.refreshState();
        if (ok) return true;
        await delay(intervalMs);
    }
    return false;
}

async function bootstrap() {
    await ensureAppDataDirs();
    registerWindowControls();
    ipcMain.on('music-renderer-ready', (event) => {
        sendEngineStatusToWebContents(event.sender);
    });
    ntaBridge = createNtaBridge({
        appRoot: getAppRoot(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        spectrumDir: getNtaDir()
    });
    registerNtaBridgeIpc();
    engineGateway = new EngineGateway({
        engineUrl: ENGINE_URL,
        emitEvent: broadcastEngineEvent
    });
    try {
        await startAudioEngine();
    } catch (err) {
        const message = err && err.message ? err.message : 'engine start failed';
        broadcastEngineStatus(false, `engine error: ${message}`);
    }
    const httpReady = await waitForEngineHttpReady();
    if (!httpReady) {
        broadcastEngineStatus(false, 'engine http timeout');
    }
    engineGateway.connectWs();
    registerEngineIpc(engineGateway);

    musicHandlers.initialize({
        mainWindow,
        openChildWindows,
        APP_DATA_ROOT_IN_PROJECT: getAppDataRoot(),
        startAudioEngine,
        stopAudioEngine,
        rendererTarget: resolveRendererTarget()
    });

    mainWindow = await musicHandlers.openMusicWindow();
    openChildWindows.push(mainWindow);
    musicHandlers.initialize({ mainWindow });
    sendEngineStatusToWebContents(mainWindow.webContents);
}

app.whenReady().then(bootstrap);

app.on('before-quit', () => {
    appQuitting = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
});

app.on('window-all-closed', () => {
    stopAudioEngine();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await musicHandlers.openMusicWindow();
    }
});
