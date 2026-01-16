// Musicmodules/music.js - Rewritten for Python Hi-Fi Audio Engine
document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element Selections ---
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const modeBtn = document.getElementById('mode-btn');
    const volumeBtn = document.getElementById('volume-btn'); // 闊抽噺鍔熻兘鏆傛椂鐢盪I鎺у埗锛屼笉涓庡紩鎿庝氦浜?
    const volumeSlider = document.getElementById('volume-slider'); // 鍚屼笂
    const progressContainer = document.querySelector('.progress-container');
    const progressBar = document.querySelector('.progress-bar');
    const progress = document.querySelector('.progress');
    const currentTimeEl = document.querySelector('.current-time');
    const durationEl = document.querySelector('.duration');
    const albumArt = document.querySelector('.album-art');
    const albumArtWrapper = document.querySelector('.album-art-wrapper');
    const trackTitle = document.querySelector('.track-title');
    const trackArtist = document.querySelector('.track-artist');
    const trackBitrate = document.querySelector('.track-bitrate');
    const playlistEl = document.getElementById('playlist');
    const addFolderBtn = document.getElementById('add-folder-btn');
    const quickImportBtn = document.getElementById('quick-import-btn');
    const searchInput = document.getElementById('search-input');
    const loadingIndicator = document.getElementById('loading-indicator');
    const scanProgressContainer = document.querySelector('.scan-progress-container');
    const scanProgressBar = document.querySelector('.scan-progress-bar');
    const scanProgressLabel = document.querySelector('.scan-progress-label');
    const playerBackground = document.getElementById('player-background');
    const visualizerCanvas = document.getElementById('visualizer');
    const visualizerCtx = visualizerCanvas.getContext('2d');
    const shareBtn = document.getElementById('share-btn');
    const inputSourceSelect = document.getElementById('input-source');
    const streamControls = document.getElementById('stream-controls');
    const streamUrlInput = document.getElementById('stream-url');
    const streamStartBtn = document.getElementById('stream-start-btn');
    const streamStopBtn = document.getElementById('stream-stop-btn');
    const captureControls = document.getElementById('capture-controls');
    const captureDeviceSelect = document.getElementById('capture-device');
    const captureStartBtn = document.getElementById('capture-start-btn');
    const captureStopBtn = document.getElementById('capture-stop-btn');
    const liveIndicator = document.getElementById('live-indicator');
    const streamStatusEl = document.getElementById('stream-status');
    const bufferStatusEl = document.getElementById('buffer-status');
    const bufferStatusHero = document.getElementById('buffer-status-hero');
   // --- New UI Elements for WASAPI ---
   const deviceSelect = document.getElementById('device-select');
   const wasapiSwitch = document.getElementById('wasapi-switch');
  const eqSwitch = document.getElementById('eq-switch');
  const eqBandsContainer = document.getElementById('eq-bands');
  const eqPresetSelect = document.getElementById('eq-preset-select');
  const eqSection = document.getElementById('eq-section');
  const eqTypeSelect = document.getElementById('eq-type-select');
  const ditherSwitch = document.getElementById('dither-switch');
  const ditherTypeSelect = document.getElementById('dither-type-select');
  const replaygainSwitch = document.getElementById('replaygain-switch');
  const upsamplingSelect = document.getElementById('upsampling-select');
  const resamplerSelect = document.getElementById('resampler-select');
  const resamplerQualitySelect = document.getElementById('resampler-quality-select');
  const soxrStatus = document.getElementById('soxr-status');
  const lyricsContainer = document.getElementById('lyrics-container');
  const lyricsList = document.getElementById('lyrics-list');
  const uiModeToggle = document.getElementById('ui-mode-toggle');

  const phantomAudio = document.getElementById('phantom-audio');
  const store = window.ntmusicStore;
 
  // --- Custom Title Bar ---
  const minimizeBtn = document.getElementById('minimize-music-btn');
  const maximizeBtn = document.getElementById('maximize-music-btn');
  const closeBtn = document.getElementById('close-music-btn');

   // --- State Variables ---
    let playlist = [];
    let currentTrackIndex = 0;
    let isPlaying = false; // 鏈湴UI鐘舵€侊紝浼氫笌寮曟搸鍚屾
    let currentInputMode = 'file';
    const playModes = ['repeat', 'repeat-one', 'shuffle'];
    let currentPlayMode = 0;
    let currentTheme = 'dark';
    let currentLyrics = [];
    let currentLyricIndex = -1;
    let lyricOffset = -0.05; // In seconds. Negative value makes lyrics appear earlier to compensate for UI lag.

    const CONTROL_COMMANDS = {
        PLAY: 1,
        PAUSE: 2,
        STOP: 3,
        SEEK: 4,
        VOLUME: 5
    };

    const trySendControl = async (cmd, value = 0) => {
        if (!window.ntmusicNta || typeof window.ntmusicNta.sendControl !== 'function') {
            return false;
        }
        try {
            return await window.ntmusicNta.sendControl(cmd, value);
        } catch (_err) {
            return false;
        }
    };

    const engineCmd = async (name, payload) => {
        if (window.ntmusic && typeof window.ntmusic.cmd === 'function') {
            return window.ntmusic.cmd(name, payload);
        }
        if (!window.electron) {
            return { status: 'error', message: 'Engine command unavailable.' };
        }
        const legacyMap = {
            state: 'music-get-state',
            play: 'music-play',
            pause: 'music-pause',
            stop: 'music-stop',
            seek: 'music-seek',
            load: 'music-load',
            'set-volume': 'music-set-volume',
            'get-devices': 'music-get-devices',
            'configure-output': 'music-configure-output',
            'set-eq': 'music-set-eq',
            'set-eq-type': 'music-set-eq-type',
            'configure-optimizations': 'music-configure-optimizations',
            'configure-upsampling': 'music-configure-upsampling',
            'load-stream': 'music-load-stream',
            'capture-start': 'music-capture-start',
            'capture-stop': 'music-capture-stop',
            'get-capture-devices': 'music-get-capture-devices',
            'spectrum-ws': 'nta-set-spectrum-ws'
        };
        const channel = legacyMap[name];
        if (!channel) {
            return { status: 'error', message: `Unknown engine cmd: ${name}` };
        }
        return window.electron.invoke(channel, payload);
    };

    const setSpectrumWs = async (enabled) => {
        if (!window.ntmusicNta || typeof window.ntmusicNta.setSpectrumWs !== 'function') {
            return;
        }
        try {
            await window.ntmusicNta.setSpectrumWs(enabled);
        } catch (_err) {
            // ignore
        }
    };

    const applyUiMode = () => {
        if (!uiModeToggle) return;
        document.body.classList.toggle('mode-pro', uiModeToggle.checked);
    };

    const markLegacyHint = () => {
        const banner = document.querySelector('.legacy-banner');
        if (!banner) return;
        banner.innerHTML =
            '当前为 Legacy UI（旧版界面）。请优先使用新 UI（React + Vite）。';
    };
    let lyricSpeedFactor = 1.0; // Should be 1.0 for correctly timed LRC files.
    let lastKnownCurrentTime = 0;
    let lastStateUpdateTime = 0;
    let lastKnownDuration = 0;
    let wnpAdapter; // Rainmeter WebNowPlaying Adapter
    let visualizerColor = { r: 29, g: 185, b: 84 };
    let statePollInterval; // 鐢ㄤ簬杞鐘舵€佺殑瀹氭椂鍣?
   let currentDeviceId = null;
   let useWasapiExclusive = false;
   let targetUpsamplingRate = 0;
   let eqEnabled = false;
  const eqBands = {
       '31': 0, '62': 0, '125': 0, '250': 0, '500': 0,
       '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0
  };
  const eqPresets = {
       'balance': { '31': 0, '62': 0, '125': 0, '250': 0, '500': 0, '1k': 0, '2k': 0, '4k': 0, '8k': 0, '16k': 0 },
       'classical': { '31': 0, '62': 0, '125': 0, '250': -2, '500': -4, '1k': -5, '2k': -4, '4k': -3, '8k': 2, '16k': 3 },
       'pop': { '31': 2, '62': 4, '125': 5, '250': 2, '500': -1, '1k': -2, '2k': 0, '4k': 3, '8k': 4, '16k': 5 },
       'rock': { '31': 5, '62': 3, '125': -2, '250': -4, '500': -1, '1k': 2, '2k': 5, '4k': 6, '8k': 7, '16k': 7 },
       'electronic': { '31': 6, '62': 5, '125': 2, '250': 0, '500': -2, '1k': 0, '2k': 3, '4k': 5, '8k': 6, '16k': 7 },
  };
let isDraggingProgress = false;

   // --- Visualizer State ---
    let animationFrameId;
    let targetVisualizerData = [];
    let currentVisualizerData = [];
    let spectrumSharedView = null;
    let spectrumSharedBins = 0;
    let useSharedSpectrum = false;
    const easingFactor = 0.2; // 缂撳姩鍥犲瓙锛屽€艰秺灏忓姩鐢昏秺骞虫粦
    let bassScale = 1.0; // 鐢ㄤ簬涓撹緫灏侀潰 Bass 鍔ㄧ敾
    const BASS_BOOST = 1.06; // Bass 瑙﹀彂鏃剁殑鏀惧ぇ绯绘暟
    const BASS_DECAY = 0.96; // 鍔ㄧ敾鎭㈠閫熷害
    const BASS_THRESHOLD = 0.55; // Bass 瑙﹀彂闃堝€?
    let particles = []; // 鐢ㄤ簬瀛樺偍绮掑瓙
    const PARTICLE_COUNT = 80; // 瀹氫箟绮掑瓙鏁伴噺

    // --- Particle Class ---
    class Particle {
        constructor(x, y) {
            this.x = x;
            this.y = y;
            this.targetY = y;
            this.vy = 0; // Vertical velocity
            this.size = 1.1;
            this.spring = 0.08; // Spring stiffness
            this.friction = 0.85; // Friction/damping
        }

        update() {
            // Spring physics for a bouncy effect
            const dy = this.targetY - this.y;
            const ay = dy * this.spring;
            this.vy += ay;
            this.vy *= this.friction;
            this.y += this.vy;
        }

    }

    const recreateParticles = () => {
        particles.length = 0; // Clear existing particles, more performant
        if (visualizerCanvas.width > 0) {
            // Distribute particles across the full width of the canvas
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                // This ensures the first particle is at x=0 and the last is at x=width
                const x = visualizerCanvas.width * (i / (PARTICLE_COUNT - 1));
                // Initially place them slightly above the bottom
                particles.push(new Particle(x, visualizerCanvas.height - 10));
            }
        }
    };
 
    // --- Spectrum Bridge ---
    const initNtaSpectrum = async () => {
        if (!window.ntmusicNta || typeof window.ntmusicNta.getSpectrumBuffer !== 'function') {
            return;
        }
        try {
            const status = await window.ntmusicNta.getStatus();
            const buffer = await window.ntmusicNta.getSpectrumBuffer();
            const bins = await window.ntmusicNta.getSpectrumLength();
            if (!buffer || !bins) {
                await setSpectrumWs(true);
                return;
            }
            spectrumSharedView = new Float32Array(buffer);
            spectrumSharedBins = bins;
            useSharedSpectrum = Boolean(status && status.shared && spectrumSharedView);
            await setSpectrumWs(!useSharedSpectrum);
            if (spectrumSharedView && currentVisualizerData.length === 0) {
                currentVisualizerData = Array(spectrumSharedView.length).fill(0);
            }
        } catch (_err) {
            spectrumSharedView = null;
            spectrumSharedBins = 0;
            useSharedSpectrum = false;
            await setSpectrumWs(true);
        }
    };

    const mergePlaybackState = (playback, buffer, stream) => {
        if (!playback) return playback;
        const merged = { ...playback };
        if (buffer && typeof buffer.bufferedMs === 'number' && merged.buffered_ms === undefined) {
            merged.buffered_ms = buffer.bufferedMs;
        }
        if (stream && stream.status && !merged.stream_status) {
            merged.stream_status = stream.status;
        }
        return merged;
    };

    const wireEngineEvents = () => {
        if (window.ntmusic && store) {
            window.ntmusic.onEngineEvent((event) => {
                store.ingest(event);
            });
        }
        if (!store) return;
        store.subscribe((next, prev) => {
            if (
                next.playback !== prev.playback ||
                next.buffer !== prev.buffer ||
                next.stream !== prev.stream
            ) {
                const merged = mergePlaybackState(next.playback, next.buffer, next.stream);
                if (merged) {
                    updateUIWithState(merged);
                }
            }
            if (next.buffer !== prev.buffer && next.buffer) {
                updateBufferState({ buffered_ms: next.buffer.bufferedMs });
            }
            if (next.stream !== prev.stream && next.stream) {
                updateStreamState({ status: next.stream.status, error: next.stream.error });
            }
            if (next.spectrum !== prev.spectrum && !useSharedSpectrum && next.spectrum) {
                targetVisualizerData = next.spectrum;
                if (currentVisualizerData.length === 0) {
                    currentVisualizerData = Array(targetVisualizerData.length).fill(0);
                }
            }
        });
    };
    // --- Helper Functions ---
    const formatTime = (seconds) => {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    };

    const updateBlurredBackground = (imageUrl) => {
        if (playerBackground) {
            // 濡傛灉 imageUrl 鏄?'none'锛屽畠浼氭竻闄よ儗鏅浘鐗囷紝浠庤€屾樉绀哄叏灞€鑳屾櫙
            playerBackground.style.backgroundImage = imageUrl;
        }
    };
    
    const hexToRgb = (hex) => {
        if (!hex) return null;
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    };

    const setInputMode = (mode) => {
        const normalized = mode === 'stream' || mode === 'capture' ? mode : 'file';
        currentInputMode = normalized;
        if (inputSourceSelect) {
            inputSourceSelect.value = normalized;
        }
        if (streamControls) {
            streamControls.classList.toggle('active', normalized === 'stream');
        }
        if (captureControls) {
            captureControls.classList.toggle('active', normalized === 'capture');
        }
        progressContainer.classList.toggle('disabled', normalized !== 'file');
        const isLive = normalized === 'stream' || normalized === 'capture';
        if (liveIndicator) {
            liveIndicator.hidden = !isLive;
        }
        if (!isLive) {
            if (streamStatusEl) streamStatusEl.textContent = '';
            if (bufferStatusEl) bufferStatusEl.textContent = '';
            if (bufferStatusHero) bufferStatusHero.textContent = '';
        }
    };

    const updateStreamState = (payload) => {
        if (!streamStatusEl) return;
        if (!payload || !payload.status) {
            streamStatusEl.textContent = '';
            return;
        }
        const errorText = payload.error ? ` (${payload.error})` : '';
        streamStatusEl.textContent = `鐘舵€? ${payload.status}${errorText}`;
    };

    const updateBufferState = (payload) => {
        if (!bufferStatusEl) return;
        if (!payload || typeof payload.buffered_ms !== 'number') {
            bufferStatusEl.textContent = '';
            if (bufferStatusHero) bufferStatusHero.textContent = '';
            return;
        }
        bufferStatusEl.textContent = `缂撳啿 ${Math.round(payload.buffered_ms)}ms`;
        if (bufferStatusHero) bufferStatusHero.textContent = bufferStatusEl.textContent;
    };

    const updateSoxrIndicator = (available) => {
        if (!soxrStatus) return;
        if (available === undefined || available === null) {
            soxrStatus.textContent = 'Unknown';
            soxrStatus.classList.remove('available', 'missing');
            return;
        }
        const isAvailable = Boolean(available);
        soxrStatus.textContent = isAvailable ? 'Available' : 'Missing';
        soxrStatus.classList.toggle('available', isAvailable);
        soxrStatus.classList.toggle('missing', !isAvailable);
        if (resamplerSelect) {
            const soxrOption = resamplerSelect.querySelector('option[value="soxr"]');
            if (soxrOption) {
                soxrOption.disabled = !isAvailable;
            }
            if (!isAvailable && resamplerSelect.value === 'soxr') {
                resamplerSelect.value = 'auto';
            }
        }
    };

// --- Rainmeter WebNowPlaying Adapter ---
class WebNowPlayingAdapter {
    constructor() {
        this.ws = null;
        this.reconnectInterval = 5000; // 5 seconds
        this.connect();
    }

    connect() {
        try {
            // WebNowPlaying default port is 8974
            this.ws = new WebSocket('ws://127.0.0.1:8974');

            this.ws.onopen = () => {
                console.log('[WebNowPlaying] Connected to Rainmeter.');
                this.sendUpdate(); // Send initial state
            };

            this.ws.onerror = (err) => {
                // This will fire on connection refusal, ignore silently
                this.ws = null;
            };

            this.ws.onclose = () => {
                // Automatically try to reconnect
                this.ws = null;
                setTimeout(() => this.connect(), this.reconnectInterval);
            };
        } catch (e) {
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
    }

    sendUpdate() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const track = playlist.length > 0 ? playlist[currentTrackIndex] : null;
        const currentMode = playModes[currentPlayMode];

        const data = {
            player: 'VCP Music Player',
            state: !track ? 0 : (isPlaying ? 1 : 2), // 0=stopped, 1=playing, 2=paused
            title: track ? track.title || '' : 'No Track Loaded',
            artist: track ? track.artist || '' : '',
            album: track ? track.album || '' : '',
            cover: track && track.albumArt ? 'file://' + track.albumArt.replace(/\\/g, '/') : '',
            duration: lastKnownDuration || 0,
            position: lastKnownCurrentTime || 0,
            volume: Math.round(parseFloat(volumeSlider.value) * 100),
            rating: 0, // Not implemented
            // WebNowPlaying standard: 0=off, 1=repeat track, 2=repeat playlist
            repeat: currentMode === 'repeat-one' ? 1 : (currentMode === 'repeat' ? 2 : 0),
            shuffle: currentMode === 'shuffle' ? 1 : 0
        };

        try {
            this.ws.send(JSON.stringify(data));
        } catch (e) {
            console.error('[WebNowPlaying] Failed to send update:', e);
        }
    }
}

    // --- Media Session API Integration ---
    const setupMediaSessionHandlers = () => {
        if (!('mediaSession' in navigator)) {
            return;
        }
        navigator.mediaSession.setActionHandler('play', playTrack);
        navigator.mediaSession.setActionHandler('pause', pauseTrack);
        navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
        navigator.mediaSession.setActionHandler('nexttrack', nextTrack);
    };

    const updateMediaSessionMetadata = () => {
        if (!('mediaSession' in navigator) || playlist.length === 0 || !playlist[currentTrackIndex]) {
            return;
        }
        const track = playlist[currentTrackIndex];
        const artworkSrc = track.albumArt ? `file://${track.albumArt.replace(/\\/g, '/')}` : '';

        navigator.mediaSession.metadata = new MediaMetadata({
            title: track.title || '鏈煡鏍囬',
            artist: track.artist || '鏈煡鑹烘湳瀹?,
            album: track.album || 'VCP Music Player', // Default album name
            artwork: artworkSrc ? [{ src: artworkSrc }] : []
        });
    };

    // --- Core Player Logic ---
    const loadTrack = async (trackIndex, andPlay = true) => {
        if (playlist.length === 0) {
            // 娓呯┖UI
            trackTitle.textContent = '鏈€夋嫨姝屾洸';
            trackArtist.textContent = '鏈煡鑹烘湳瀹?;
            trackBitrate.textContent = '';
            const defaultArtUrl = `url('../../assets/ntmusic-default.png')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground('none'); // 娌℃湁姝屾洸鏃讹紝鍥為€€鍒板叏灞€鑳屾櫙
            renderPlaylist();
            return;
        }
        
        currentTrackIndex = trackIndex;
        setInputMode('file');
        const track = playlist[trackIndex];

        // 鏇存柊UI
        trackTitle.textContent = track.title || '鏈煡鏍囬';
        trackArtist.textContent = track.artist || '鏈煡鑹烘湳瀹?;
        if (track.bitrate) {
            trackBitrate.textContent = `${Math.round(track.bitrate / 1000)} kbps`;
        } else {
            trackBitrate.textContent = '';
        }
        
        const defaultArtUrl = `url('../../assets/ntmusic-default.png')`;
        if (track.albumArt) {
            const albumArtUrl = `url('file://${track.albumArt.replace(/\\/g, '/')}')`;
            albumArt.style.backgroundImage = albumArtUrl;
            updateBlurredBackground(albumArtUrl);
        } else {
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground('none'); // 娌℃湁灏侀潰鏃讹紝鍥為€€鍒板叏灞€鑳屾櫙
        }

        renderPlaylist();
        fetchAndDisplayLyrics(track.artist, track.title);
        updateMediaSessionMetadata(); // Update OS media controls
        if (wnpAdapter) wnpAdapter.sendUpdate();

        // 閫氳繃IPC璁╀富杩涚▼閫氱煡Python寮曟搸鍔犺浇鏂囦欢
        const result = await engineCmd('load', { path: track.path });
        if (result && result.status === 'success') {
            if (store) {
                store.ingest({ type: 'playback.state', state: result.state });
            } else {
                updateUIWithState(result.state);
            }
            if (andPlay) {
                playTrack();
            }
        } else {
            console.error("Failed to load track in audio engine:", result.message);
        }
    };

    const playTrack = async () => {
        if (currentInputMode === 'file' && playlist.length === 0) return;
        const controlOk = await trySendControl(CONTROL_COMMANDS.PLAY);
        if (!controlOk) {
            const result = await engineCmd('play');
            if (result.status !== 'success') {
                return;
            }
        }
        isPlaying = true;
        playPauseBtn.classList.add('is-playing');
        phantomAudio.play().catch(e => console.error("Phantom audio play failed:", e));
        startStatePolling();
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const pauseTrack = async () => {
        const controlOk = await trySendControl(CONTROL_COMMANDS.PAUSE);
        if (!controlOk) {
            const result = await engineCmd('pause');
            if (result.status !== 'success') {
                return;
            }
        }
        isPlaying = false;
        playPauseBtn.classList.remove('is-playing');
        phantomAudio.pause();
        stopStatePolling();
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const prevTrack = () => {
        currentTrackIndex = (currentTrackIndex - 1 + playlist.length) % playlist.length;
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    const nextTrack = () => {
        if (playlist.length <= 1) {
            loadTrack(currentTrackIndex);
            return;
        }

        switch (playModes[currentPlayMode]) {
            case 'repeat':
                currentTrackIndex = (currentTrackIndex + 1) % playlist.length;
                break;
            case 'repeat-one':
                // 寮曟搸浼氬湪鎾斁缁撴潫鏃跺仠姝紝鎴戜滑闇€瑕佸湪杩欓噷閲嶆柊鍔犺浇骞舵挱鏀?
                break; 
            case 'shuffle':
                let nextIndex;
                do {
                    nextIndex = Math.floor(Math.random() * playlist.length);
                } while (playlist.length > 1 && nextIndex === currentTrackIndex);
                currentTrackIndex = nextIndex;
                break;
        }
        loadTrack(currentTrackIndex);
        if (wnpAdapter) wnpAdapter.sendUpdate();
    };

    // --- UI Update and State Management ---
    const updateUIWithState = (state) => {
        if (!state) return;

        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = (state.is_playing && !state.is_paused) ? 'playing' : 'paused';
        }
        
        const engineMode = state.mode || currentInputMode;
        const displayMode = engineMode === 'idle' ? currentInputMode : engineMode;
        if (engineMode && engineMode !== 'idle' && engineMode !== currentInputMode) {
            setInputMode(engineMode);
        }

        isPlaying = state.is_playing && !state.is_paused;
        playPauseBtn.classList.toggle('is-playing', isPlaying);

        const duration = state.duration || 0;
        lastKnownDuration = duration; // Store for WebNowPlaying
        const currentTime = state.current_time || 0;
        lastKnownCurrentTime = currentTime;
        lastStateUpdateTime = Date.now();
        
        durationEl.textContent = displayMode === 'file' ? formatTime(duration) : 'LIVE';
        currentTimeEl.textContent = formatTime(currentTime);
        
        const progressPercent = displayMode === 'file' && duration > 0 ? (currentTime / duration) * 100 : 0;
        progress.style.width = `${progressPercent}%`;

        // 妫€鏌ユ挱鏀炬槸鍚﹀凡缁撴潫
        if (displayMode === 'file' && state.is_playing === false && currentTrackIndex !== -1 && currentTime > 0) {
             // 鎾斁缁撴潫
            // console.log("Playback seems to have ended.");
            stopStatePolling();
            if (playModes[currentPlayMode] === 'repeat-one') {
                loadTrack(currentTrackIndex, true);
            } else {
                nextTrack();
            }
        }
       // Update device selection UI
       if (deviceSelect.value !== state.device_id) {
           deviceSelect.value = state.device_id;
       }
       if (wasapiSwitch.checked !== state.exclusive_mode) {
           wasapiSwitch.checked = state.exclusive_mode;
       }
      // Update EQ UI
      if (state.eq_enabled !== undefined && eqSwitch.checked !== state.eq_enabled) {
          eqSwitch.checked = state.eq_enabled;
          eqSection.classList.toggle('expanded', state.eq_enabled);
      }
      if (state.eq_type !== undefined && eqTypeSelect.value !== state.eq_type && !eqTypeSelect.matches(':focus')) {
          eqTypeSelect.value = state.eq_type;
      }
      if (state.dither_enabled !== undefined && ditherSwitch.checked !== state.dither_enabled) {
          ditherSwitch.checked = state.dither_enabled;
      }
      if (ditherTypeSelect && !ditherTypeSelect.matches(':focus')) {
          const desiredDither = resolveDitherChoice(state);
          if (ditherTypeSelect.value !== desiredDither) {
              ditherTypeSelect.value = desiredDither;
          }
      }
      if (state.replaygain_enabled !== undefined && replaygainSwitch.checked !== state.replaygain_enabled) {
          replaygainSwitch.checked = state.replaygain_enabled;
      }
      if (resamplerSelect && state.resampler_mode && resamplerSelect.value !== state.resampler_mode && !resamplerSelect.matches(':focus')) {
          resamplerSelect.value = state.resampler_mode;
      }
      if (resamplerQualitySelect && state.resampler_quality && resamplerQualitySelect.value !== state.resampler_quality && !resamplerQualitySelect.matches(':focus')) {
          resamplerQualitySelect.value = state.resampler_quality;
      }
      if (state.soxr_available !== undefined) {
          updateSoxrIndicator(state.soxr_available);
      }
      if (state.eq_bands) {
          for (const [band, gain] of Object.entries(state.eq_bands)) {
              const slider = document.getElementById(`eq-${band}`);
              if (slider && slider.value !== gain) {
                  slider.value = gain;
              }
              eqBands[band] = gain;
          }
      }
      // Update upsampling UI
      if (state.target_samplerate !== undefined && upsamplingSelect.value !== state.target_samplerate) {
          upsamplingSelect.value = state.target_samplerate || 0;
      }

      if (displayMode === 'stream') {
          trackTitle.textContent = '娴佸獟浣撴挱鏀?;
          trackArtist.textContent = state.stream_status ? `鐘舵€? ${state.stream_status}` : 'LIVE';
          trackBitrate.textContent = '';
      } else if (displayMode === 'capture') {
          trackTitle.textContent = '绯荤粺鎹曡幏';
          trackArtist.textContent = state.stream_status ? `鐘舵€? ${state.stream_status}` : 'LIVE';
          trackBitrate.textContent = '';
      }

      if (displayMode === 'stream' || displayMode === 'capture') {
          if (streamStatusEl && state.stream_status) {
              streamStatusEl.textContent = `鐘舵€? ${state.stream_status}`;
          }
          if (bufferStatusEl && typeof state.buffered_ms === 'number') {
              bufferStatusEl.textContent = `缂撳啿 ${Math.round(state.buffered_ms)}ms`;
          }
      }
      if (wnpAdapter) wnpAdapter.sendUpdate();
  };

   const pollState = async () => {
        let result;
        if (window.ntmusic && typeof window.ntmusic.cmd === 'function') {
            result = await window.ntmusic.cmd('state');
        } else if (window.electron) {
            result = await engineCmd('state');
        }
        if (result && result.status === 'success') {
            if (store) {
                store.ingest({ type: 'playback.state', state: result.state });
            } else {
                updateUIWithState(result.state);
            }
        }
    };

    const startStatePolling = () => {
        if (statePollInterval) clearInterval(statePollInterval);
        statePollInterval = setInterval(pollState, 250); // 姣?50ms鏇存柊涓€娆¤繘搴?
    };

    const stopStatePolling = () => {
        clearInterval(statePollInterval);
        statePollInterval = null;
    };


    // --- Visualizer ---
    const startVisualizerAnimation = () => {
        const draw = () => {
           if (isPlaying) {
               animateLyrics();
           }

            // --- Bass Animation Logic ---
            if (isPlaying && currentVisualizerData.length > 0 && albumArtWrapper) {
                // 浠庝綆棰戞璁＄畻 Bass 鑳介噺
                const bassBinCount = Math.floor(currentVisualizerData.length * 0.05); // 鍙栧墠5%鐨勯娈?
                let bassEnergy = 0;
                for (let i = 0; i < bassBinCount; i++) {
                    bassEnergy += currentVisualizerData[i];
                }
                bassEnergy /= bassBinCount; // 骞冲潎鑳介噺

                // 濡傛灉 Bass 鑳介噺瓒呰繃闃堝€硷紝鍒欒Е鍙戝姩鐢?
                if (bassEnergy > BASS_THRESHOLD && bassScale < BASS_BOOST) {
                    bassScale = BASS_BOOST;
                } else {
                    // 鍔ㄧ敾鏁堟灉閫愭笎琛板噺鍥炲師鏍?
                    bassScale = Math.max(1.0, bassScale * BASS_DECAY);
                }
                
                albumArtWrapper.style.transform = `scale(${bassScale})`;
            }
            // --- End Bass Animation Logic ---

            const sourceData = useSharedSpectrum && spectrumSharedView ? spectrumSharedView : targetVisualizerData;
            if (!sourceData || sourceData.length === 0) {
               visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
               animationFrameId = requestAnimationFrame(draw);
               return;
           }

           if (currentVisualizerData.length !== sourceData.length) {
               currentVisualizerData = Array(sourceData.length).fill(0);
           }

           // 浣跨敤缂撳姩鍏紡鏇存柊褰撳墠鏁版嵁
           for (let i = 0; i < sourceData.length; i++) {
               if (currentVisualizerData[i] === undefined) {
                   currentVisualizerData[i] = 0;
               }
               currentVisualizerData[i] += (sourceData[i] - currentVisualizerData[i]) * easingFactor;
           }

           // 浣跨敤骞虫粦鍚庣殑褰撳墠鏁版嵁杩涜缁樺埗
           drawVisualizer(currentVisualizerData);

           // 鏇存柊鍜岀粯鍒剁矑瀛?
           // 鏇存柊鍜岀粯鍒剁矑瀛?
           // First, update all particle positions based on the spectrum
           particles.forEach(p => {
               // 鎵惧埌绮掑瓙瀵瑰簲鐨勯璋辨暟鎹偣
               const positionRatio = p.x / visualizerCanvas.width;
               const dataIndexFloat = positionRatio * (currentVisualizerData.length - 1);
               const index1 = Math.floor(dataIndexFloat);
               const index2 = Math.min(index1 + 1, currentVisualizerData.length - 1);
               
               // Linear interpolation for smooth height transition between data points
               const value1 = currentVisualizerData[index1] || 0;
               const value2 = currentVisualizerData[index2] || 0;
               const fraction = dataIndexFloat - index1;
               const interpolatedValue = value1 + (value2 - value1) * fraction;

               // 璁＄畻鐩爣Y鍊硷紝璁╃矑瀛愬湪棰戣氨绾夸笂鏂逛竴鐐?
               const spectrumY = visualizerCanvas.height - (interpolatedValue * visualizerCanvas.height * 1.2);
               p.targetY = spectrumY - 6; // Keep particles a bit higher than the curve

               p.update();
           });

           // Now, draw a smooth curve connecting the particles
           if (particles.length > 1) {
               visualizerCtx.beginPath();
               visualizerCtx.moveTo(particles[0].x, particles[0].y);

               // Draw segments to midpoints, which creates a smooth chain
               for (let i = 0; i < particles.length - 2; i++) {
                   const p1 = particles[i];
                   const p2 = particles[i+1];
                   const xc = (p1.x + p2.x) / 2;
                   const yc = (p1.y + p2.y) / 2;
                   visualizerCtx.quadraticCurveTo(p1.x, p1.y, xc, yc);
               }
               
               // For the last segment, curve to the last point to make it smooth
               const secondLast = particles[particles.length - 2];
               const last = particles[particles.length - 1];
               visualizerCtx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);


               const { r, g, b } = visualizerColor;
               visualizerCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
               visualizerCtx.lineWidth = 1.5;
               visualizerCtx.lineJoin = 'round';
               visualizerCtx.lineCap = 'round';
               visualizerCtx.stroke();
           }

           animationFrameId = requestAnimationFrame(draw);
       };
        draw();
    };

    const drawVisualizer = (data) => {
        visualizerCtx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

        const bufferLength = data.length;
        if (bufferLength === 0) return;

        const gradient = visualizerCtx.createLinearGradient(0, 0, 0, visualizerCanvas.height);
        const { r, g, b } = visualizerColor;
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.85)`);
        gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0.4)`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);
        
        visualizerCtx.fillStyle = gradient;
        visualizerCtx.strokeStyle = gradient;
        visualizerCtx.lineWidth = 2;

        visualizerCtx.beginPath();
        visualizerCtx.moveTo(0, visualizerCanvas.height);

        const sliceWidth = visualizerCanvas.width / (bufferLength - 1);
        
        // Helper to get a point's coordinates
        const getPoint = (index) => {
            const value = data[index] || 0;
            const x = index * sliceWidth;
            const y = visualizerCanvas.height - (value * visualizerCanvas.height * 1.2);
            return [x, y];
        };

        for (let i = 0; i < bufferLength - 1; i++) {
            const [x1, y1] = getPoint(i);
            const [x2, y2] = getPoint(i + 1);
            
            const [prev_x, prev_y] = i > 0 ? getPoint(i - 1) : [x1, y1];
            const [next_x, next_y] = i < bufferLength - 2 ? getPoint(i + 2) : [x2, y2];

            const tension = 0.5;
            const cp1_x = x1 + (x2 - prev_x) / 6 * tension;
            const cp1_y = y1 + (y2 - prev_y) / 6 * tension;
            const cp2_x = x2 - (next_x - x1) / 6 * tension;
            const cp2_y = y2 - (next_y - y1) / 6 * tension;

            if (i === 0) {
                visualizerCtx.lineTo(x1, y1);
            }
            
            visualizerCtx.bezierCurveTo(cp1_x, cp1_y, cp2_x, cp2_y, x2, y2);

            // --- Particle Generation ---
        }

        visualizerCtx.lineTo(visualizerCanvas.width, visualizerCanvas.height);
        visualizerCtx.closePath();
        visualizerCtx.fill();
    };

    // --- Event Listeners ---
    playPauseBtn.addEventListener('click', () => {
        isPlaying ? pauseTrack() : playTrack();
    });
    prevBtn.addEventListener('click', prevTrack);
    nextBtn.addEventListener('click', nextTrack);
    // --- Progress Bar Drag Logic ---
    let dragInProgress = false; // Use a different name to avoid conflict
    
    const handleProgressUpdate = async (e, shouldSeek = false) => {
        if (currentInputMode !== 'file') return;
        if (!window.ntmusic && !window.electron) return;
        const rect = progressContainer.getBoundingClientRect();
        // Ensure offsetX is within valid bounds
        const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const width = rect.width;

        const result = await engineCmd('state');
        if (result.status === 'success' && result.state.duration > 0) {
            const duration = result.state.duration;
            const newTime = (offsetX / width) * duration;

            // Update UI immediately
            progress.style.width = `${(newTime / duration) * 100}%`;
            currentTimeEl.textContent = formatTime(newTime);

            if (shouldSeek) {
                const controlOk = await trySendControl(CONTROL_COMMANDS.SEEK, newTime);
                if (!controlOk) {
                    await engineCmd('seek', { position: newTime });
                }
                // If still playing after drag, resume polling
                if (isPlaying) {
                    startStatePolling();
                }
            }
        }
    };

    progressContainer.addEventListener('mousedown', (e) => {
        dragInProgress = true;
        stopStatePolling(); // Pause state polling during drag to prevent UI jumps
        handleProgressUpdate(e);
    });

    window.addEventListener('mousemove', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e);
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (dragInProgress) {
            handleProgressUpdate(e, true); // Pass true to seek
            // The click event will fire after mouseup, so we delay resetting the flag
            setTimeout(() => {
                dragInProgress = false;
            }, 0);
        }
    });

    progressContainer.addEventListener('click', (e) => {
        // Only seek on click if not dragging
        if (!dragInProgress) {
             handleProgressUpdate(e, true);
        }
    });
    
    const updateVolumeSliderBackground = (value) => {
        const percentage = value * 100;
        volumeSlider.style.backgroundSize = `${percentage}% 100%`;
    };

    // 闊抽噺鎺у埗鏆傛椂淇濇寔鍓嶇鎺у埗锛屽洜涓哄畠涓嶅奖鍝岺IFI瑙ｇ爜
    volumeSlider.addEventListener('input', async (e) => {
        const newVolume = parseFloat(e.target.value);
        updateVolumeSliderBackground(newVolume);
        if (window.electron) {
            const controlOk = await trySendControl(CONTROL_COMMANDS.VOLUME, newVolume);
            if (!controlOk) {
                await engineCmd('set-volume', { volume: newVolume });
            }
        }
    });
    volumeBtn.addEventListener('click', () => {
        // Mute toggle logic can be implemented here if needed
        const isMuted = volumeSlider.value === '0';
        const newVolume = isMuted ? (volumeBtn.dataset.lastVolume || 1) : 0;
        
        if (!isMuted) {
            volumeBtn.dataset.lastVolume = volumeSlider.value;
        }
        
        volumeSlider.value = newVolume;
        // Manually trigger the input event to send the new volume to the engine
        volumeSlider.dispatchEvent(new Event('input'));
    });

    modeBtn.addEventListener('click', () => {
        currentPlayMode = (currentPlayMode + 1) % playModes.length;
        updateModeButton();
        if (wnpAdapter) wnpAdapter.sendUpdate();
    });

    const updateModeButton = () => {
        modeBtn.className = 'control-btn icon-btn'; // Reset classes
        const currentMode = playModes[currentPlayMode];
        modeBtn.classList.add(currentMode);
        if (currentMode !== 'repeat') {
            modeBtn.classList.add('active');
        }
    };

    playlistEl.addEventListener('click', (e) => {
        if (e.target.tagName === 'LI') {
            const index = parseInt(e.target.dataset.index, 10);
            loadTrack(index);
        }
    });

    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        const filteredPlaylist = playlist.filter(track =>
            (track.title || '').toLowerCase().includes(searchTerm) ||
            (track.artist || '').toLowerCase().includes(searchTerm)
        );
        renderPlaylist(filteredPlaylist);
    });

    window.addEventListener('resize', () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;
        recreateParticles(); // Re-distribute particles on resize
    });

    shareBtn.addEventListener('click', () => {
        if (!playlist || playlist.length === 0 || !playlist[currentTrackIndex]) return;
        const track = playlist[currentTrackIndex];
        if (track.path && window.electron) {
            window.electron.send('share-file-to-main', track.path);
        }
    });

    // --- Custom Title Bar Listeners ---
    minimizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.minimizeWindow();
    });

    maximizeBtn.addEventListener('click', () => {
        if (window.electronAPI) window.electronAPI.maximizeWindow();
    });

    closeBtn.addEventListener('click', () => {
        window.close();
    });

   // --- WASAPI and Device Control ---
   const populateDeviceList = async () => {
       if (!window.ntmusic && !window.electron) return;
       const result = await engineCmd('get-devices');
       if (result.status === 'success' && result.devices) {
           deviceSelect.innerHTML = ''; // Clear existing options

           // Add default device option
           const defaultOption = document.createElement('option');
           defaultOption.value = 'default';
           defaultOption.textContent = '榛樿璁惧';
           deviceSelect.appendChild(defaultOption);

           // Add WASAPI devices
           if (result.devices.wasapi && result.devices.wasapi.length > 0) {
               const wasapiGroup = document.createElement('optgroup');
               wasapiGroup.label = 'WASAPI';
               result.devices.wasapi.forEach(device => {
                   const option = document.createElement('option');
                   option.value = device.id;
                   option.textContent = device.name;
                   wasapiGroup.appendChild(option);
               });
               deviceSelect.appendChild(wasapiGroup);
           }
       } else {
           console.error("Failed to get audio devices:", result.message);
       }
   };

   const configureOutput = async () => {
       if (!window.ntmusic && !window.electron) return;
       
       const selectedDeviceId = deviceSelect.value === 'default' ? null : parseInt(deviceSelect.value, 10);
       const useExclusive = wasapiSwitch.checked;

       console.log(`Configuring output: Device ID=${selectedDeviceId}, Exclusive=${useExclusive}`);
       
       // Prevent re-configuration if nothing changed
       if (selectedDeviceId === currentDeviceId && useExclusive === useWasapiExclusive) {
           return;
       }

       currentDeviceId = selectedDeviceId;
       useWasapiExclusive = useExclusive;

       await engineCmd('configure-output', {
           device_id: currentDeviceId,
           exclusive: useWasapiExclusive
       });
   };

   deviceSelect.addEventListener('change', configureOutput);
   wasapiSwitch.addEventListener('change', configureOutput);

  // --- Upsampling Control ---
  const configureUpsampling = async () => {
      if (!window.ntmusic && !window.electron) return;
      const selectedRate = parseInt(upsamplingSelect.value, 10);
      
      if (selectedRate === targetUpsamplingRate) {
          return;
      }
      
      targetUpsamplingRate = selectedRate;
      
      console.log(`Configuring upsampling: Target Rate=${targetUpsamplingRate}`);
      await engineCmd('configure-upsampling', {
          target_samplerate: targetUpsamplingRate > 0 ? targetUpsamplingRate : null
      });
  };

  upsamplingSelect.addEventListener('change', configureUpsampling);

  // --- EQ Control ---
  const populateEqPresets = () => {
       const presetNames = {
           'balance': '骞宠　',
           'classical': '鍙ゅ吀',
           'pop': '娴佽',
           'rock': '鎽囨粴',
           'electronic': '鐢靛瓙'
       };
       for (const preset in eqPresets) {
           const option = document.createElement('option');
           option.value = preset;
           option.textContent = presetNames[preset] || preset;
           eqPresetSelect.appendChild(option);
       }
  };

  const applyEqPreset = (presetName) => {
       const preset = eqPresets[presetName];
       if (!preset) return;

       for (const band in preset) {
           const slider = document.getElementById(`eq-${band}`);
           if (slider) {
               slider.value = preset[band];
           }
       }
       sendEqSettings();
  };

  const createEqBands = () => {
      eqBandsContainer.innerHTML = '';
      for (const band in eqBands) {
          const bandContainer = document.createElement('div');
          bandContainer.className = 'eq-band';

          const label = document.createElement('label');
          label.setAttribute('for', `eq-${band}`);
          label.textContent = band;
          
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.id = `eq-${band}`;
          slider.min = -15;
          slider.max = 15;
          slider.step = 1;
          slider.value = eqBands[band];
          
          slider.addEventListener('input', () => sendEqSettings());
          
          bandContainer.appendChild(label);
          bandContainer.appendChild(slider);
          eqBandsContainer.appendChild(bandContainer);
      }
  };

  const sendEqSettings = async () => {
      if (!window.ntmusic && !window.electron) return;

      const newBands = {};
      for (const band in eqBands) {
          const slider = document.getElementById(`eq-${band}`);
          newBands[band] = parseInt(slider.value, 10);
      }
      
      eqEnabled = eqSwitch.checked;

      await engineCmd('set-eq', {
          bands: newBands,
          enabled: eqEnabled
      });
  };

  eqSwitch.addEventListener('change', () => {
       eqSection.classList.toggle('expanded', eqSwitch.checked);
       sendEqSettings();
  });

  eqTypeSelect.addEventListener('change', async () => {
      if (!window.ntmusic && !window.electron) return;
      const result = await engineCmd('set-eq-type', { type: eqTypeSelect.value });
      if (result.status === 'success') {
          if (store) {
              store.ingest({ type: 'playback.state', state: result.state });
          } else {
              updateUIWithState(result.state);
          }
      }
  });

  const resolveDitherChoice = (state) => {
      const enabled = state.dither_enabled !== false;
      const bits = state.dither_bits || 24;
      const ditherType = (state.dither_type || (enabled ? 'tpdf' : 'off')).toLowerCase();
      if (!enabled || ditherType === 'off') {
          return 'off';
      }
      const bitSuffix = bits === 16 ? '16' : '24';
      if (ditherType === 'tpdf_ns1') return `tpdf_ns1_${bitSuffix}`;
      if (ditherType === 'tpdf_ns2') return `tpdf_ns2_${bitSuffix}`;
      return `tpdf${bitSuffix}`;
  };

  const parseDitherChoice = (choice) => {
      if (!choice || choice === 'off') {
          return { enabled: false, type: 'off', bits: 24 };
      }
      if (choice.startsWith('tpdf_ns1_')) {
          return { enabled: true, type: 'tpdf_ns1', bits: choice.endsWith('16') ? 16 : 24 };
      }
      if (choice.startsWith('tpdf_ns2_')) {
          return { enabled: true, type: 'tpdf_ns2', bits: choice.endsWith('16') ? 16 : 24 };
      }
      return { enabled: true, type: 'tpdf', bits: choice === 'tpdf16' ? 16 : 24 };
  };

  const updateOptimizations = async () => {
      if (!window.ntmusic && !window.electron) return;
      const ditherChoice = ditherTypeSelect ? ditherTypeSelect.value : (ditherSwitch.checked ? 'tpdf24' : 'off');
      const parsed = parseDitherChoice(ditherChoice);
      const quality = resamplerQualitySelect ? resamplerQualitySelect.value : 'hq';
      const resamplerMode = resamplerSelect ? resamplerSelect.value : 'auto';
      await engineCmd('configure-optimizations', {
          dither_enabled: ditherSwitch.checked && parsed.enabled,
          dither_type: parsed.enabled ? parsed.type : 'off',
          dither_bits: parsed.bits,
          replaygain_enabled: replaygainSwitch.checked,
          resampler_mode: resamplerMode,
          resampler_quality: quality
      });
  };

  ditherSwitch.addEventListener('change', () => {
      if (ditherTypeSelect) {
          ditherTypeSelect.value = ditherSwitch.checked ? (ditherTypeSelect.value === 'off' ? 'tpdf24' : ditherTypeSelect.value) : 'off';
      }
      updateOptimizations();
  });
  if (ditherTypeSelect) {
      ditherTypeSelect.addEventListener('change', () => {
          ditherSwitch.checked = ditherTypeSelect.value !== 'off';
          updateOptimizations();
      });
  }
  replaygainSwitch.addEventListener('change', updateOptimizations);
  if (resamplerSelect) {
      resamplerSelect.addEventListener('change', updateOptimizations);
  }
  if (resamplerQualitySelect) {
      resamplerQualitySelect.addEventListener('change', updateOptimizations);
  }

  eqPresetSelect.addEventListener('change', (e) => {
       applyEqPreset(e.target.value);
  });

  const populateCaptureDevices = async () => {
      if (!window.electron || !captureDeviceSelect) return;
      const result = await engineCmd('get-capture-devices');
      const devices = result && result.devices ? result.devices : [];
      captureDeviceSelect.innerHTML = '';
      if (!devices.length) {
          const option = document.createElement('option');
          option.value = 'default';
          option.textContent = 'default';
          captureDeviceSelect.appendChild(option);
          return;
      }
      devices.forEach((device) => {
          const option = document.createElement('option');
          option.value = device.id;
          option.textContent = device.name || device.id;
          captureDeviceSelect.appendChild(option);
      });
  };

  const startStream = async () => {
      if (!window.electron || !streamUrlInput) return;
      const url = streamUrlInput.value.trim();
      if (!url) return;
      setInputMode('stream');
      trackTitle.textContent = '娴佸獟浣撴挱鏀?;
      trackArtist.textContent = url;
      trackBitrate.textContent = '';
      const result = await engineCmd('load-stream', { url });
      if (result.status === 'success') {
          const controlOk = await trySendControl(CONTROL_COMMANDS.PLAY);
          if (!controlOk) {
              await engineCmd('play');
          }
      }
  };

  const stopStream = async () => {
      if (!window.ntmusic && !window.electron) return;
      const controlOk = await trySendControl(CONTROL_COMMANDS.STOP);
      if (!controlOk) {
          await engineCmd('stop');
      }
  };

  const startCapture = async () => {
      if (!window.ntmusic && !window.electron) return;
      setInputMode('capture');
      trackTitle.textContent = '绯荤粺鎹曡幏';
      trackArtist.textContent = 'LIVE';
      trackBitrate.textContent = '';
      const device_id = captureDeviceSelect ? captureDeviceSelect.value : 'default';
      const result = await engineCmd('capture-start', { device_id });
      if (result.status === 'success') {
          const controlOk = await trySendControl(CONTROL_COMMANDS.PLAY);
          if (!controlOk) {
              await engineCmd('play');
          }
      }
  };

  const stopCapture = async () => {
      if (!window.ntmusic && !window.electron) return;
      await engineCmd('capture-stop');
  };

  const setupSourceControls = () => {
      if (!inputSourceSelect) return;
      inputSourceSelect.addEventListener('change', async () => {
          if (currentInputMode !== inputSourceSelect.value) {
              const controlOk = await trySendControl(CONTROL_COMMANDS.STOP);
              if (!controlOk) {
                  await engineCmd('stop');
              }
          }
          setInputMode(inputSourceSelect.value);
      });
      if (streamStartBtn) streamStartBtn.addEventListener('click', startStream);
      if (streamStopBtn) streamStopBtn.addEventListener('click', stopStream);
      if (captureStartBtn) captureStartBtn.addEventListener('click', startCapture);
      if (captureStopBtn) captureStopBtn.addEventListener('click', stopCapture);
  };

   // --- Electron IPC and Initialization ---
    const setupElectronHandlers = () => {
        if (!window.ntmusic && !window.electron) return;

        if (quickImportBtn && addFolderBtn) {
            quickImportBtn.addEventListener('click', () => addFolderBtn.click());
        }

        addFolderBtn.addEventListener('click', () => {
            loadingIndicator.style.display = 'flex';
            scanProgressContainer.style.display = 'none';
            scanProgressBar.style.width = '0%';
            scanProgressLabel.textContent = '';
            window.electron.send('open-music-folder');
        });

        let totalFilesToScan = 0, filesScanned = 0;
        window.electron.on('scan-started', ({ total }) => {
            totalFilesToScan = total;
            filesScanned = 0;
            scanProgressContainer.style.display = 'block';
            scanProgressLabel.textContent = `0 / ${totalFilesToScan}`;
        });

        window.electron.on('scan-progress', () => {
            filesScanned++;
            const percentage = totalFilesToScan > 0 ? (filesScanned / totalFilesToScan) * 100 : 0;
            scanProgressBar.style.width = `${percentage}%`;
            scanProgressLabel.textContent = `${filesScanned} / ${totalFilesToScan}`;
        });

        window.electron.on('scan-finished', (newlyScannedFiles) => {
            loadingIndicator.style.display = 'none';
            // Only update playlist if new files were actually scanned.
            // This prevents clearing the list if the user cancels the folder selection.
            if (newlyScannedFiles && newlyScannedFiles.length > 0) {
                playlist = newlyScannedFiles;
                renderPlaylist();
                window.electron.send('save-music-playlist', playlist);
                if (playlist.length > 0) {
                    loadTrack(0, false); // Load first track but don't play
                }
            }
            // If newlyScannedFiles is empty or null, do nothing, preserving the old playlist.
        });
        
        // Listen for errors from the main process (e.g., engine connection failed)
        window.electron.on('audio-engine-error', ({ message }) => {
            console.error("Received error from main process:", message);
            // Legacy UI: show banner as warning
            const banner = document.querySelector('.legacy-banner');
            if (banner) {
                banner.textContent = `Legacy UI：引擎异常 - ${message || '未知错误'}`;
            }
        });

        // Listen for track changes from the main process (e.g., from AI control)
        window.electron.on('music-set-track', (track) => {
            if (!playlist.some(t => t.path === track.path)) {
                playlist.unshift(track); // Add to playlist if not already there
            }
            const trackIndex = playlist.findIndex(t => t.path === track.path);
            if (trackIndex !== -1) {
                loadTrack(trackIndex, true); // Load and play the track
            }
        });
    };

    const renderPlaylist = (filteredPlaylist) => {
        const songsToRender = filteredPlaylist || playlist;
        playlistEl.innerHTML = '';
        const fragment = document.createDocumentFragment();
        songsToRender.forEach((track) => {
            const li = document.createElement('li');
            li.textContent = track.title || '鏈煡鏍囬';
            const originalIndex = playlist.indexOf(track);
            li.dataset.index = originalIndex;
            if (originalIndex === currentTrackIndex) {
                li.classList.add('active');
            }
            fragment.appendChild(li);
        });
        playlistEl.appendChild(fragment);
    };
    
   // --- Lyrics Handling ---
   const fetchAndDisplayLyrics = async (artist, title) => {
       resetLyrics();
       if (!window.electron) return;

       const lrcContent = await window.electron.invoke('music-get-lyrics', { artist, title });

       if (lrcContent) {
           currentLyrics = parseLrc(lrcContent);
           renderLyrics();
       } else {
           // If no local lyrics, try fetching from network
           lyricsList.innerHTML = '<li class="no-lyrics">姝ｅ湪缃戠粶涓婃悳绱㈡瓕璇?..</li>';
           try {
               const fetchedLrc = await window.electron.invoke('music-fetch-lyrics', { artist, title });
               if (fetchedLrc) {
                   currentLyrics = parseLrc(fetchedLrc);
                   renderLyrics();
               } else {
                   lyricsList.innerHTML = '<li class="no-lyrics">鏆傛棤姝岃瘝</li>';
               }
           } catch (error) {
               console.error('Failed to fetch lyrics from network:', error);
               lyricsList.innerHTML = '<li class="no-lyrics">姝岃瘝鑾峰彇澶辫触</li>';
           }
       }
   };

   const parseLrc = (lrcContent) => {
        const lyricsMap = new Map();
        const lines = lrcContent.split('\n');
        const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const text = trimmedLine.replace(timeRegex, '').trim();
            if (text) {
                let match;
                timeRegex.lastIndex = 0;
                while ((match = timeRegex.exec(trimmedLine)) !== null) {
                    const minutes = parseInt(match[1], 10);
                    const seconds = parseInt(match[2], 10);
                    const milliseconds = parseInt(match[3].padEnd(3, '0'), 10);
                    const time = (minutes * 60 + seconds + milliseconds / 1000) * lyricSpeedFactor + lyricOffset;
                    
                    const timeKey = time.toFixed(4); // Use fixed precision for map key

                    if (lyricsMap.has(timeKey)) {
                        // This is likely the translation, append it.
                        // This simple logic assumes original text comes before translation for the same timestamp.
                        if (!lyricsMap.get(timeKey).translation) {
                           lyricsMap.get(timeKey).translation = text;
                        }
                    } else {
                        // This is the original lyric
                        lyricsMap.set(timeKey, { time, original: text, translation: '' });
                    }
                }
            }
        }

        return Array.from(lyricsMap.values()).sort((a, b) => a.time - b.time);
   };

   const renderLyrics = () => {
        lyricsList.innerHTML = '';
        const fragment = document.createDocumentFragment();
        currentLyrics.forEach((line, index) => {
            const li = document.createElement('li');
            
            const originalSpan = document.createElement('span');
            originalSpan.textContent = line.original;
            originalSpan.className = 'lyric-original';
            li.appendChild(originalSpan);

            if (line.translation) {
                const translationSpan = document.createElement('span');
                translationSpan.textContent = line.translation;
                translationSpan.className = 'lyric-translation';
                li.appendChild(translationSpan);
            }

            li.dataset.index = index;
            fragment.appendChild(li);
        });
        lyricsList.appendChild(fragment);
   };

   const animateLyrics = () => {
       if (currentLyrics.length === 0 || !isPlaying) return;

       // Re-introduce client-side time estimation for smooth scrolling, anchored by backend state.
       const elapsedTime = (Date.now() - lastStateUpdateTime) / 1000;
       const estimatedTime = lastKnownCurrentTime + elapsedTime;

       let newLyricIndex = -1;
       for (let i = 0; i < currentLyrics.length; i++) {
           if (estimatedTime >= currentLyrics[i].time) {
               newLyricIndex = i;
           } else {
               break;
           }
       }

       if (newLyricIndex !== currentLyricIndex) {
           currentLyricIndex = newLyricIndex;
       }
       
       // Update visual styles (like opacity) on every frame for smoothness.
       const allLi = lyricsList.querySelectorAll('li');
       allLi.forEach((li, index) => {
           const distance = Math.abs(index - currentLyricIndex);
           
           if (index === currentLyricIndex) {
               li.classList.add('active');
               li.style.opacity = 1;
           } else {
               li.classList.remove('active');
               li.style.opacity = Math.max(0.1, 1 - distance * 0.22).toFixed(2);
           }
       });

       // Smooth scrolling logic
       if (currentLyricIndex > -1) {
           const currentLine = currentLyrics[currentLyricIndex];
           const nextLine = currentLyrics[currentLyricIndex + 1];
           
           const currentLineLi = lyricsList.querySelector(`li[data-index='${currentLyricIndex}']`);
           if (!currentLineLi) return;

           let progress = 0;
           if (nextLine) {
               const timeIntoLine = estimatedTime - currentLine.time;
               const lineDuration = nextLine.time - currentLine.time;
               if (lineDuration > 0) {
                   progress = Math.max(0, Math.min(1, timeIntoLine / lineDuration));
               }
           }

           const nextLineLi = nextLine ? lyricsList.querySelector(`li[data-index='${currentLyricIndex + 1}']`) : null;
           const currentOffset = currentLineLi.offsetTop;
           const nextOffset = nextLineLi ? nextLineLi.offsetTop : currentOffset;
           
           const interpolatedOffset = currentOffset + (nextOffset - currentOffset) * progress;

           const goldenRatioPoint = lyricsContainer.clientHeight * 0.382;
           const scrollOffset = interpolatedOffset - goldenRatioPoint + (currentLineLi.clientHeight / 2);

           lyricsList.style.transform = `translateY(-${scrollOffset}px)`;
       }
   };

   const resetLyrics = () => {
       currentLyrics = [];
       currentLyricIndex = -1;
       lyricsList.innerHTML = '<li class="no-lyrics">鍔犺浇姝岃瘝涓?..</li>';
       lyricsList.style.transform = 'translateY(0px)';
   };

    // --- Theme Handling ---
    const applyTheme = (theme) => {
        currentTheme = theme;
        document.body.classList.toggle('light-theme', theme === 'light');
        // Use requestAnimationFrame to wait for the styles to be applied
        requestAnimationFrame(() => {
            // A second frame might be needed for variables to be fully available
            requestAnimationFrame(() => {
                const highlightColor = getComputedStyle(document.body).getPropertyValue('--music-highlight');
                const rgbColor = hexToRgb(highlightColor);
                if (rgbColor) {
                    visualizerColor = rgbColor;
                }
                 // Also re-apply volume slider background as it depends on a theme variable
                updateVolumeSliderBackground(volumeSlider.value);
            });
        });
        const currentArt = albumArt.style.backgroundImage;
        if (
            !currentArt ||
            currentArt.includes('ntmusic-default.png') ||
            currentArt.includes('musicdark.jpeg') ||
            currentArt.includes('musiclight.jpeg')
        ) {
            const defaultArtUrl = `url('../../assets/ntmusic-default.png')`;
            albumArt.style.backgroundImage = defaultArtUrl;
            updateBlurredBackground(defaultArtUrl);
        }
    };
    
    const initializeTheme = async () => {
        if (window.electronAPI) {
            // Use the new robust theme listener
            window.electronAPI.onThemeUpdated(applyTheme);
            try {
                const theme = await window.electronAPI.getCurrentTheme();
                applyTheme(theme || 'dark');
            } catch (error) {
                console.error('Failed to initialize theme:', error);
                applyTheme('dark');
            }
        } else {
            applyTheme('dark'); // Fallback for non-electron env
        }
    };

    // --- Phantom Audio Generation ---
    const createSilentAudio = () => {
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const sampleRate = 44100;
        const duration = 1; // 1 second
        const frameCount = sampleRate * duration;
        const buffer = context.createBuffer(1, frameCount, sampleRate);
        // The buffer is already filled with zeros (silence)

        // Convert buffer to WAV
        const getWav = (buffer) => {
            const numChannels = buffer.numberOfChannels;
            const sampleRate = buffer.sampleRate;
            const format = 1; // PCM
            const bitDepth = 16;
            const blockAlign = numChannels * bitDepth / 8;
            const byteRate = sampleRate * blockAlign;
            const dataSize = buffer.length * numChannels * bitDepth / 8;
            const bufferSize = 44 + dataSize;
            
            const view = new DataView(new ArrayBuffer(bufferSize));
            let offset = 0;

            const writeString = (str) => {
                for (let i = 0; i < str.length; i++) {
                    view.setUint8(offset++, str.charCodeAt(i));
                }
            };

            writeString('RIFF');
            view.setUint32(offset, 36 + dataSize, true); offset += 4;
            writeString('WAVE');
            writeString('fmt ');
            view.setUint32(offset, 16, true); offset += 4;
            view.setUint16(offset, format, true); offset += 2;
            view.setUint16(offset, numChannels, true); offset += 2;
            view.setUint32(offset, sampleRate, true); offset += 4;
            view.setUint32(offset, byteRate, true); offset += 4;
            view.setUint16(offset, blockAlign, true); offset += 2;
            view.setUint16(offset, bitDepth, true); offset += 2;
            writeString('data');
            view.setUint32(offset, dataSize, true); offset += 4;

            const pcm = new Int16Array(buffer.length);
            const channelData = buffer.getChannelData(0);
            for (let i = 0; i < buffer.length; i++) {
                pcm[i] = Math.max(-1, Math.min(1, channelData[i])) * 32767;
            }
            for (let i = 0; i < pcm.length; i++, offset += 2) {
                view.setInt16(offset, pcm[i], true);
            }

            return view.buffer;
        };

        const wavBuffer = getWav(buffer);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
    };

    // --- App Initialization ---
    const init = async () => {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;

        // --- Initialize Particles ---
        recreateParticles();

        if (uiModeToggle) {
            uiModeToggle.addEventListener('change', applyUiMode);
        }
        applyUiMode();
        markLegacyHint();

        setupElectronHandlers();
        setupSourceControls();
        setupMediaSessionHandlers(); // Setup OS media controls
        updateModeButton();
        await initializeTheme();
        await initNtaSpectrum();
        wireEngineEvents();
        if (!animationFrameId) {
            startVisualizerAnimation();
        }
        
        // Setup phantom audio
        try {
            phantomAudio.src = createSilentAudio();
        } catch (e) {
            console.error("Failed to create silent audio:", e);
        }

        // Initialize WebNowPlaying Adapter for Rainmeter
        wnpAdapter = new WebNowPlayingAdapter();
    
        if (window.electron) {
            const savedPlaylist = await window.electron.invoke('get-music-playlist');
            if (savedPlaylist && savedPlaylist.length > 0) {
                playlist = savedPlaylist;
                renderPlaylist();
                await loadTrack(0, false); // Wait for the track to load
            }
            // Sync initial volume
            const initialState = await engineCmd('state');
            if (initialState && initialState.state && initialState.state.volume !== undefined) {
                volumeSlider.value = initialState.state.volume;
                updateVolumeSliderBackground(initialState.state.volume);
            }
        }
       
       // --- New: Populate devices and set initial state ---
       await populateDeviceList();
       await populateCaptureDevices();
      createEqBands(); // Create EQ sliders
      populateEqPresets(); // Populate EQ presets
       const initialDeviceState = await engineCmd('state');
       if (initialDeviceState && initialDeviceState.state) {
           setInputMode(initialDeviceState.state.mode || 'file');
           currentDeviceId = initialDeviceState.state.device_id;
           useWasapiExclusive = initialDeviceState.state.exclusive_mode;
           deviceSelect.value = currentDeviceId === null ? 'default' : currentDeviceId;
           wasapiSwitch.checked = useWasapiExclusive;

           // Set initial EQ state from engine
           if (initialDeviceState.state.eq_enabled !== undefined) {
               eqEnabled = initialDeviceState.state.eq_enabled;
               eqSwitch.checked = eqEnabled;
               eqSection.classList.toggle('expanded', eqEnabled);
           }
           if (initialDeviceState.state.eq_type !== undefined) {
               eqTypeSelect.value = initialDeviceState.state.eq_type;
           }
           if (initialDeviceState.state.dither_enabled !== undefined) {
               ditherSwitch.checked = initialDeviceState.state.dither_enabled;
           }
           if (ditherTypeSelect) {
               const ditherType = initialDeviceState.state.dither_type || (initialDeviceState.state.dither_enabled ? 'tpdf' : 'off');
               const ditherBits = initialDeviceState.state.dither_bits || 24;
               ditherTypeSelect.value = (ditherType !== 'off' && initialDeviceState.state.dither_enabled !== false)
                   ? (ditherBits === 16 ? 'tpdf16' : 'tpdf24')
                   : 'off';
           }
           if (initialDeviceState.state.replaygain_enabled !== undefined) {
               replaygainSwitch.checked = initialDeviceState.state.replaygain_enabled;
           }
           if (resamplerSelect && initialDeviceState.state.resampler_mode !== undefined) {
               resamplerSelect.value = initialDeviceState.state.resampler_mode;
           }
           if (resamplerQualitySelect && initialDeviceState.state.resampler_quality !== undefined) {
               resamplerQualitySelect.value = initialDeviceState.state.resampler_quality;
           }
           if (initialDeviceState.state.soxr_available !== undefined) {
               updateSoxrIndicator(initialDeviceState.state.soxr_available);
           }
           if (initialDeviceState.state.eq_bands) {
                for (const [band, gain] of Object.entries(initialDeviceState.state.eq_bands)) {
                   const slider = document.getElementById(`eq-${band}`);
                   if (slider) {
                       slider.value = gain;
                   }
                   eqBands[band] = gain;
               }
           }
           // Set initial upsampling state
           if (initialDeviceState.state.target_samplerate !== undefined) {
               targetUpsamplingRate = initialDeviceState.state.target_samplerate || 0;
               upsamplingSelect.value = targetUpsamplingRate;
           }
       }


        if (window.electron) {
            window.electron.send('music-renderer-ready');
        }
    };

    init();
});
