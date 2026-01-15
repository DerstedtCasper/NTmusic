const { contextBridge, ipcRenderer } = require('electron');

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
    'music-seek',
    'music-get-state',
    'music-set-volume',
    'music-get-devices',
    'music-configure-output',
    'music-set-eq',
    'music-set-eq-type',
    'music-configure-optimizations',
    'music-configure-upsampling',
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
