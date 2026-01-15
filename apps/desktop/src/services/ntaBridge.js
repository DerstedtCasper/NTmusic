const path = require('path');
const fs = require('fs-extra');

const DEFAULT_SPECTRUM_BINS = 48;

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

function createSpectrumBuffer(length) {
    const byteLength = length * Float32Array.BYTES_PER_ELEMENT;
    if (typeof SharedArrayBuffer !== 'undefined') {
        return new SharedArrayBuffer(byteLength);
    }
    return new ArrayBuffer(byteLength);
}

function createNtaBridge({ appRoot, resourcesPath, isPackaged, spectrumBins = DEFAULT_SPECTRUM_BINS }) {
    const native = loadNativeAddon(appRoot, resourcesPath, isPackaged);
    let spectrumBuffer = null;
    if (native && typeof native.createSpectrumBuffer === 'function') {
        try {
            spectrumBuffer = native.createSpectrumBuffer(spectrumBins);
        } catch (_err) {
            spectrumBuffer = null;
        }
    }

    if (!spectrumBuffer) {
        spectrumBuffer = createSpectrumBuffer(spectrumBins);
    }

    return {
        getSpectrumBuffer: () => spectrumBuffer,
        getSpectrumLength: () => spectrumBins,
        getStatus: () => ({
            mode: native ? 'native' : 'fallback',
            shared: typeof SharedArrayBuffer !== 'undefined',
            bins: spectrumBins
        })
    };
}

module.exports = { createNtaBridge };
