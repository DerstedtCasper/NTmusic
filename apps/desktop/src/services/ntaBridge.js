const path = require('path');
const fs = require('fs-extra');

const DEFAULT_SPECTRUM_BINS = 48;
const DEFAULT_SPECTRUM_DIR = 'nta';
const DEFAULT_CONTROL_CAPACITY = 64;

function resolveNativeAddon(appRoot, resourcesPath, isPackaged) {
    const candidates = isPackaged
        ? [path.join(resourcesPath, 'native', 'ntmusic_core.node')]
        : [
              path.join(appRoot, 'engine', 'rust', 'ntmusic_core', 'dist', 'ntmusic_core.node'),
              path.join(appRoot, 'engine', 'rust', 'ntmusic_core', 'target', 'release', 'ntmusic_core.node')
          ];

    for (const candidate of candidates) {
        if (fs.pathExistsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function loadNativeAddon(appRoot, resourcesPath, isPackaged) {
    const addonPath = resolveNativeAddon(appRoot, resourcesPath, isPackaged);
    if (!addonPath) return null;
    try {
        return require(addonPath);
    } catch (_err) {
        return null;
    }
}

function createSpectrumSpec({ native, spectrumBins, spectrumDir }) {
    if (!native || typeof native.createSpectrumShm !== 'function') {
        return null;
    }
    try {
        fs.ensureDirSync(spectrumDir);
        return native.createSpectrumShm(spectrumDir, spectrumBins);
    } catch (_err) {
        return null;
    }
}

function createControlSpec({ native, controlCapacity, controlDir }) {
    if (!native || typeof native.createControlShm !== 'function') {
        return null;
    }
    try {
        fs.ensureDirSync(controlDir);
        return native.createControlShm(controlDir, controlCapacity);
    } catch (_err) {
        return null;
    }
}

function createNtaBridge({
    appRoot,
    resourcesPath,
    isPackaged,
    spectrumBins = DEFAULT_SPECTRUM_BINS,
    spectrumDir = DEFAULT_SPECTRUM_DIR,
    controlCapacity = DEFAULT_CONTROL_CAPACITY
}) {
    const native = loadNativeAddon(appRoot, resourcesPath, isPackaged);
    const spectrumSpec = createSpectrumSpec({ native, spectrumBins, spectrumDir });
    const controlSpec = createControlSpec({ native, controlCapacity, controlDir: spectrumDir });
    const mode = spectrumSpec ? 'native' : 'fallback';

    return {
        getSpectrumSpec: () => spectrumSpec,
        getSpectrumLength: () => spectrumBins,
        getControlSpec: () => controlSpec,
        getStatus: () => ({
            mode,
            shared: Boolean(spectrumSpec),
            bins: spectrumBins,
            path: spectrumSpec ? spectrumSpec.path : null,
            controlShared: Boolean(controlSpec),
            controlPath: controlSpec ? controlSpec.path : null,
            controlCapacity: controlSpec ? controlSpec.capacity : 0
        })
    };
}

module.exports = { createNtaBridge };
