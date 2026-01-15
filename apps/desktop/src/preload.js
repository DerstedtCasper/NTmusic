const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

const sendChannels = [
    'open-music-folder',
    'open-music-window',
    'save-music-playlist',
    'music-track-changed',
    'music-renderer-ready',
    'share-file-to-main'
];

const invokeChannels = [
    'get-music-playlist',
    'music-load',
    'music-play',
    'music-pause',
    'music-stop',
    'music-seek',
    'music-get-state',
    'music-set-volume',
    'music-get-devices',
    'music-configure-output',
    'music-set-eq',
    'music-set-eq-type',
    'music-configure-optimizations',
    'music-configure-upsampling',
    'music-load-stream',
    'music-capture-start',
    'music-capture-stop',
    'music-get-capture-devices',
    'music-get-engine-url',
    'nta-get-spectrum-length',
    'nta-get-spectrum-spec',
    'nta-get-status',
    'music-get-lyrics',
    'music-fetch-lyrics',
    'window-minimize',
    'window-maximize',
    'get-current-theme'
];

const onChannels = [
    'music-files',
    'scan-started',
    'scan-progress',
    'scan-finished',
    'audio-engine-error',
    'music-set-track',
    'theme-updated'
];

const DEFAULT_SPECTRUM_POLL_MS = 50;

function getAppRoot() {
    const isPackaged = !process.defaultApp;
    return isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
}

function resolveNativeAddon() {
    const isPackaged = !process.defaultApp;
    const appRoot = getAppRoot();
    const candidates = isPackaged
        ? [path.join(process.resourcesPath, 'native', 'ntmusic_core.node')]
        : [
              path.join(appRoot, 'engine', 'rust', 'ntmusic_core', 'dist', 'ntmusic_core.node'),
              path.join(appRoot, 'engine', 'rust', 'ntmusic_core', 'target', 'release', 'ntmusic_core.node')
          ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function loadNativeAddon() {
    const addonPath = resolveNativeAddon();
    if (!addonPath) return null;
    try {
        return require(addonPath);
    } catch (_err) {
        return null;
    }
}

let spectrumSpecPromise = null;
let spectrumSharedBuffer = null;
let spectrumReader = null;
let spectrumTimer = null;
let spectrumBins = 0;
let nativeAddon = null;

async function getSpectrumSpec() {
    if (!spectrumSpecPromise) {
        spectrumSpecPromise = ipcRenderer.invoke('nta-get-spectrum-spec').catch(() => null);
    }
    return spectrumSpecPromise;
}

function ensureNativeAddon() {
    if (!nativeAddon) {
        nativeAddon = loadNativeAddon();
    }
    return nativeAddon;
}

async function initSpectrumBuffer() {
    if (spectrumSharedBuffer) return spectrumSharedBuffer;
    const spec = await getSpectrumSpec();
    if (!spec || !spec.path || !spec.bins) return null;
    const native = ensureNativeAddon();
    if (!native || typeof native.SpectrumReader !== 'function') return null;

    try {
        spectrumReader = new native.SpectrumReader(spec.path, spec.bins);
    } catch (_err) {
        spectrumReader = null;
        return null;
    }

    if (typeof SharedArrayBuffer === 'undefined') return null;
    spectrumBins = spec.bins;
    const byteLength = spec.byteLength || spec.bins * Float32Array.BYTES_PER_ELEMENT;
    spectrumSharedBuffer = new SharedArrayBuffer(byteLength);
    const spectrumView = new Float32Array(spectrumSharedBuffer);

    spectrumTimer = setInterval(() => {
        if (!spectrumReader) return;
        try {
            spectrumReader.readInto(spectrumView);
        } catch (_err) {
            // Keep last buffer if sync fails.
        }
    }, DEFAULT_SPECTRUM_POLL_MS);

    return spectrumSharedBuffer;
}

contextBridge.exposeInMainWorld('electron', {
    send: (channel, data) => {
        if (sendChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },
    invoke: (channel, data) => {
        if (invokeChannels.includes(channel)) {
            return ipcRenderer.invoke(channel, data);
        }
    },
    on: (channel, func) => {
        if (onChannels.includes(channel)) {
            ipcRenderer.on(channel, (_event, ...args) => func(...args));
        }
    }
});

contextBridge.exposeInMainWorld('electronAPI', {
    minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
    maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
    getCurrentTheme: () => ipcRenderer.invoke('get-current-theme'),
    onThemeUpdated: (callback) => {
        const handler = (_event, theme) => callback(theme);
        ipcRenderer.on('theme-updated', handler);
        return () => ipcRenderer.removeListener('theme-updated', handler);
    }
});

contextBridge.exposeInMainWorld('ntmusicNta', {
    getSpectrumBuffer: () => initSpectrumBuffer(),
    getSpectrumLength: async () => {
        const spec = await getSpectrumSpec();
        return spec && spec.bins ? spec.bins : 0;
    },
    getStatus: async () => {
        const status = await ipcRenderer.invoke('nta-get-status').catch(() => null);
        return {
            ...(status || {}),
            shared: Boolean(spectrumSharedBuffer),
            bins: spectrumBins || (status && status.bins) || 0
        };
    }
});
