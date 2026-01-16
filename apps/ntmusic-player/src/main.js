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
let audioCore = null;
let audioEngine = null;
let engineEmbedded = false;
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

function getCoverDir() {
    return path.join(getAppDataRoot(), 'covers');
}

function resolveNativeAddon() {
    const appRoot = getAppRoot();
    const candidates = app.isPackaged
        ? [path.join(process.resourcesPath, 'native', 'ntmusic_core.node')]
        : [
              path.join(appRoot, 'packages', 'audio-core', 'ntmusic_core', 'dist', 'ntmusic_core.node'),
              path.join(
                  appRoot,
                  'packages',
                  'audio-core',
                  'ntmusic_core',
                  'target',
                  'release',
                  'ntmusic_core.node'
              )
          ];

    for (const candidate of candidates) {
        if (fs.pathExistsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function loadAudioCore() {
    if (audioCore) return audioCore;
    const addonPath = resolveNativeAddon();
    if (!addonPath) return null;
    try {
        audioCore = require(addonPath);
        return audioCore;
    } catch (_err) {
        return null;
    }
}

function ensureAudioEngine() {
    if (audioEngine) return audioEngine;
    const native = loadAudioCore();
    if (!native || typeof native.AudioEngine !== 'function') return null;
    try {
        audioEngine = new native.AudioEngine(ENGINE_URL);
        return audioEngine;
    } catch (_err) {
        return null;
    }
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
    const executable = process.platform === 'win32' ? 'ntmusic_engine.exe' : 'ntmusic_engine';
    const appRoot = getAppRoot();
    const installRoot = getInstallRoot();
    const candidates = app.isPackaged
        ? [
              path.join(installRoot, 'engine', executable),
              path.join(process.resourcesPath, 'engine', executable)
          ]
        : [
              path.join(appRoot, 'packages', 'audio-core', 'bin', executable),
              path.join(
                  appRoot,
                  'packages',
                  'audio-core',
                  'ntmusic_engine',
                  'target',
                  'release',
                  executable
              ),
              path.join(
                  appRoot,
                  'packages',
                  'audio-core',
                  'ntmusic_engine',
                  'target',
                  'debug',
                  executable
              )
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
    await fs.ensureDir(getCoverDir());
}

function startAudioEngine() {
    return new Promise((resolve, reject) => {
        if (audioEngineProcess && !audioEngineProcess.killed) {
            resolve();
            return;
        }

        const soxrDir = process.env.VMUSIC_SOXR_DIR || getSoxrDir();
        const assetDir = app.isPackaged
            ? path.join(getInstallRoot(), 'engine')
            : path.join(getAppRoot(), 'packages', 'audio-core', 'bin');
        const spectrumSpec = ntaBridge ? ntaBridge.getSpectrumSpec() : null;
        process.env.VMUSIC_ENGINE_PORT = String(ENGINE_PORT);
        process.env.VMUSIC_ENGINE_URL = ENGINE_URL;
        process.env.VMUSIC_SOXR_DIR = soxrDir;
        process.env.VMUSIC_ASSET_DIR = assetDir;
        process.env.NTMUSIC_COVER_DIR = getCoverDir();
        const controlSpec = ntaBridge ? ntaBridge.getControlSpec() : null;
        if (spectrumSpec && spectrumSpec.path) {
            process.env.NTMUSIC_SPECTRUM_SHM = spectrumSpec.path;
            process.env.NTMUSIC_SPECTRUM_BINS = String(spectrumSpec.bins || 0);
        }
        if (controlSpec && controlSpec.path) {
            process.env.NTMUSIC_CONTROL_SHM = controlSpec.path;
            process.env.NTMUSIC_CONTROL_CAPACITY = String(controlSpec.capacity || 0);
        }

        const embedded = ensureAudioEngine();
        if (embedded && typeof embedded.startServer === 'function') {
            const result = embedded.startServer(ENGINE_PORT);
            if (result && result.status === 'error') {
                broadcastEngineStatus(false, result.message || 'engine embedded start failed');
            } else {
                engineEmbedded = true;
                broadcastEngineStatus(true, 'engine embedded');
                resolve();
                return;
            }
        }

        const enginePath = resolveEngineBinary();
        if (!enginePath) {
            broadcastEngineStatus(false, 'engine binary not found');
            reject(new Error('Rust audio engine not found. Please build ntmusic_engine.exe.'));
            return;
        }
        const engineDir = path.dirname(enginePath);
        const env = {
            ...process.env,
            VMUSIC_ENGINE_PORT: String(ENGINE_PORT),
            VMUSIC_ENGINE_URL: ENGINE_URL,
            VMUSIC_ASSET_DIR: engineDir,
            VMUSIC_SOXR_DIR: soxrDir,
            NTMUSIC_COVER_DIR: getCoverDir()
        };
        if (spectrumSpec && spectrumSpec.path) {
            env.NTMUSIC_SPECTRUM_SHM = spectrumSpec.path;
            env.NTMUSIC_SPECTRUM_BINS = String(spectrumSpec.bins || 0);
        }
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
    if (engineEmbedded) return;
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
    if (engineEmbedded && audioEngine && typeof audioEngine.stop === 'function') {
        try {
            audioEngine.stop();
        } catch (_err) {
            // ignore stop errors during shutdown
        }
    }
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

function registerPlayerIpc() {
    ipcMain.handle('player:load', async (_event, { path: filePath } = {}) => {
        const engine = ensureAudioEngine();
        if (!engine || !filePath) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.load(filePath);
    });

    ipcMain.handle('player:play', async (_event, { path: filePath } = {}) => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        if (filePath) {
            return engine.play(filePath);
        }
        return engine.resume();
    });

    ipcMain.handle('player:pause', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.pause();
    });

    ipcMain.handle('player:resume', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.resume();
    });

    ipcMain.handle('player:stop', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.stop();
    });

    ipcMain.handle('player:set-device', async (_event, { deviceId, exclusive } = {}) => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.setDevice(deviceId ?? null, exclusive ?? null);
    });

    ipcMain.handle('player:get-devices', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { status: 'error', message: 'AudioEngine not ready.', devices: [] };
        }
        return engine.getDevices();
    });

    ipcMain.handle('player:get-track', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return {
                path: null,
                title: null,
                duration: 0,
                sample_rate: 0,
                channels: 0,
                bit_depth: null
            };
        }
        return engine.currentTrack();
    });

    ipcMain.handle('player:get-position', async () => {
        const engine = ensureAudioEngine();
        if (!engine) {
            return { current: 0, duration: 0, percent: 0 };
        }
        return engine.currentPosition();
    });

    ipcMain.handle('player:queueAdd', async (_event, { tracks, replace } = {}) => {
        const engine = ensureAudioEngine();
        if (!engine || typeof engine.queueAdd !== 'function') {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.queueAdd(Array.isArray(tracks) ? tracks : [], replace ?? false);
    });

    ipcMain.handle('player:next', async () => {
        const engine = ensureAudioEngine();
        if (!engine || typeof engine.nextTrack !== 'function') {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.nextTrack();
    });

    ipcMain.handle(
        'player:captureStart',
        async (_event, { device_id, deviceId, samplerate, channels } = {}) => {
            const engine = ensureAudioEngine();
            if (!engine || typeof engine.captureStart !== 'function') {
                return { status: 'error', message: 'AudioEngine not ready.' };
            }
            return engine.captureStart(
                device_id ?? deviceId ?? null,
                samplerate ?? null,
                channels ?? null
            );
        }
    );

    ipcMain.handle('player:captureStop', async () => {
        const engine = ensureAudioEngine();
        if (!engine || typeof engine.captureStop !== 'function') {
            return { status: 'error', message: 'AudioEngine not ready.' };
        }
        return engine.captureStop();
    });
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
    registerPlayerIpc();
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
