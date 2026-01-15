const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

const musicHandlers = require('./ipc/musicHandlers');

const APP_ROOT = path.join(__dirname, '..', '..', '..');
const APP_DATA_ROOT = path.join(APP_ROOT, 'AppData');
const RESAMPLE_CACHE_DIR = path.join(APP_DATA_ROOT, 'ResampleCache');
const ENGINE_ROOT = path.join(APP_ROOT, 'engine', 'python');
const ENGINE_SCRIPT = path.join(ENGINE_ROOT, 'main.py');
const ENGINE_PORT = (() => {
    if (process.env.VMUSIC_ENGINE_PORT) {
        const port = parseInt(process.env.VMUSIC_ENGINE_PORT, 10);
        return Number.isFinite(port) ? port : 55554;
    }
    if (process.env.VMUSIC_ENGINE_URL) {
        try {
            const parsed = new URL(process.env.VMUSIC_ENGINE_URL);
            if (parsed.port) {
                return parseInt(parsed.port, 10);
            }
        } catch (_err) {
            return 55554;
        }
    }
    return 55554;
})();

let audioEngineProcess = null;
let mainWindow = null;
let openChildWindows = [];

async function ensureAppDataDirs() {
    await fs.ensureDir(APP_DATA_ROOT);
    await fs.ensureDir(RESAMPLE_CACHE_DIR);
}

function startAudioEngine() {
    return new Promise((resolve, reject) => {
        if (audioEngineProcess && !audioEngineProcess.killed) {
            resolve();
            return;
        }

        const args = [
            '-u',
            ENGINE_SCRIPT,
            '--resample-cache-dir',
            RESAMPLE_CACHE_DIR,
            '--port',
            String(ENGINE_PORT)
        ];
        audioEngineProcess = spawn('python', args, { cwd: ENGINE_ROOT });

        const readyTimeout = setTimeout(() => {
            reject(new Error('Audio Engine timed out.'));
        }, 15000);

        audioEngineProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output.includes('FLASK_SERVER_READY')) {
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

async function bootstrap() {
    await ensureAppDataDirs();
    registerWindowControls();

    musicHandlers.initialize({
        mainWindow,
        openChildWindows,
        APP_DATA_ROOT_IN_PROJECT: APP_DATA_ROOT,
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
