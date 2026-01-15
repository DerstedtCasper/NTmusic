const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const { createNtaBridge } = require('./services/ntaBridge');

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

function getAppRoot() {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
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

function resolveEngineBinary() {
    const executable = process.platform === 'win32' ? 'vmusic_engine.exe' : 'vmusic_engine';
    const appRoot = getAppRoot();
    const candidates = app.isPackaged
        ? [path.join(process.resourcesPath, 'engine', executable)]
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
            reject(new Error('Audio Engine timed out.'));
        }, 15000);

        audioEngineProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output.includes('VMUSIC_ENGINE_READY')) {
                clearTimeout(readyTimeout);
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
        });

        audioEngineProcess.on('error', (err) => {
            clearTimeout(readyTimeout);
            reject(err);
        });
    });
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

async function bootstrap() {
    await ensureAppDataDirs();
    registerWindowControls();
    ntaBridge = createNtaBridge({
        appRoot: getAppRoot(),
        resourcesPath: process.resourcesPath,
        isPackaged: app.isPackaged,
        spectrumDir: getNtaDir()
    });
    registerNtaBridgeIpc();

    musicHandlers.initialize({
        mainWindow,
        openChildWindows,
        APP_DATA_ROOT_IN_PROJECT: getAppDataRoot(),
        startAudioEngine,
        stopAudioEngine
    });

    mainWindow = await musicHandlers.openMusicWindow();
    openChildWindows.push(mainWindow);
    musicHandlers.initialize({ mainWindow });
}

app.whenReady().then(bootstrap);

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
