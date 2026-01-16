import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../shared/lib/useStore';
import { PlayerBar } from '../features/playback/PlayerBar';
import { PlaylistPanel, Track } from '../features/library/PlaylistPanel';
import { DevicePanel } from '../features/settings/DevicePanel';
import { InputPanel } from '../features/input/InputPanel';
import { LyricsPanel } from '../features/lyrics/LyricsPanel';
import { QualityPanel } from '../features/quality/QualityPanel';
import { EqPanel } from '../features/quality/EqPanel';
import { DspChainPanel } from '../features/dspChain/DspChainPanel';
import { AnalyzerPanel } from '../features/analyzer/AnalyzerPanel';
import { engineCmd } from '../shared/lib/engine';

const fallbackTrack: Track = {
  path: '',
  title: '未选择歌曲',
  artist: '等待导入本地音乐',
};

export const App = () => {
  const storeState = useStore();
  const playback = storeState.playback as Record<string, any> | null;
  const spectrum = storeState.spectrum ?? null;
  const connected = storeState.engine.connected;
  const engineMessage = storeState.engine.message;
  const [engineAlert, setEngineAlert] = useState('');
  const bufferMs = storeState.buffer?.bufferedMs ?? null;

  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [scanTotal, setScanTotal] = useState(0);
  const [scanDone, setScanDone] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<{ id: number; name: string }[]>([]);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [exclusive, setExclusive] = useState(false);
  const [inputMode, setInputMode] = useState<'file' | 'stream' | 'capture'>('file');
  const [streamUrl, setStreamUrl] = useState('');
  const [captureDevices, setCaptureDevices] = useState<{ id: number; name: string }[]>([]);
  const [captureDeviceId, setCaptureDeviceId] = useState<number | null>(null);
  const [proMode, setProMode] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'lyrics' | 'dsp' | 'analyzer'>('lyrics');

  useEffect(() => {
    window.electron?.send('music-renderer-ready');
  }, []);

  useEffect(() => {
    if (!window.electron) return;
    window.electron.invoke('get-music-playlist').then((list) => {
      if (Array.isArray(list)) {
        setTracks(list);
      }
    });

    window.electron.on('scan-started', ({ total }) => {
      setScanning(true);
      setScanTotal(total || 0);
      setScanDone(0);
    });
    window.electron.on('scan-progress', () => {
      setScanDone((prev) => prev + 1);
    });
    window.electron.on('scan-finished', (newTracks) => {
      setScanning(false);
      setTracks(Array.isArray(newTracks) ? newTracks : []);
      window.electron?.send('save-music-playlist', newTracks);
    });
    window.electron.on('music-set-track', (track) => {
      if (!track?.path) return;
      setTracks((prev) => {
        if (prev.find((t) => t.path === track.path)) return prev;
        return [track, ...prev];
      });
      const index = tracks.findIndex((t) => t.path === track.path);
      if (index >= 0) {
        setCurrentIndex(index);
      }
    });
  }, [tracks]);

  useEffect(() => {
    if (!playback) return;
    if (playback.device_id !== undefined) {
      setDeviceId(playback.device_id ?? null);
    }
    if (playback.exclusive_mode !== undefined) {
      setExclusive(Boolean(playback.exclusive_mode));
    }
    if (playback.mode && ['file', 'stream', 'capture'].includes(playback.mode)) {
      setInputMode(playback.mode);
    }
    if (playback.capture_device_id !== undefined) {
      setCaptureDeviceId(playback.capture_device_id ?? null);
    }
  }, [playback]);

  useEffect(() => {
    if (connected) {
      setEngineAlert('');
      return;
    }
    const message = engineMessage || '';
    const lower = message.toLowerCase();
    if (lower.includes('restart')) {
      setEngineAlert('引擎正在重启，请稍后...');
    } else if (lower.includes('not found')) {
      setEngineAlert('未找到引擎可执行文件，请先构建或检查安装。');
    } else if (lower.includes('timeout')) {
      setEngineAlert('引擎启动超时，请检查 vmusic_engine 是否可用。');
    } else if (lower.includes('http')) {
      setEngineAlert('引擎通信失败，请稍后重试。');
    } else if (lower.includes('error')) {
      setEngineAlert('引擎发生错误，请查看日志。');
    } else if (lower.includes('disconnected')) {
      setEngineAlert('引擎已断开连接，正在重试。');
    } else {
      setEngineAlert(message || '引擎未连接，请检查日志或重启。');
    }
  }, [connected, engineMessage]);

  const refreshDevices = async () => {
    const result = await engineCmd('get-devices');
    if (result && result.status === 'success' && Array.isArray(result.devices)) {
      setDevices(result.devices);
    }
  };

  const refreshCaptureDevices = async () => {
    const result = await engineCmd('get-capture-devices');
    if (result && result.status === 'success' && Array.isArray(result.devices)) {
      setCaptureDevices(result.devices);
    }
  };

  useEffect(() => {
    refreshDevices();
    refreshCaptureDevices();
  }, []);

  const currentTrack = useMemo(() => {
    if (currentIndex >= 0 && tracks[currentIndex]) return tracks[currentIndex];
    return fallbackTrack;
  }, [currentIndex, tracks]);

  const isPlaying = Boolean(playback?.is_playing && !playback?.is_paused);
  const currentTime = Number(playback?.current_time || 0);
  const duration = Number(playback?.duration || 0);
  const displayTitle = currentTrack.title || fallbackTrack.title;
  const displayArtist = currentTrack.artist || fallbackTrack.artist;
  const engineStatusLabel = connected ? 'ENGINE ONLINE' : 'ENGINE OFFLINE';
  const engineStatusHint = connected
    ? '连接稳定'
    : engineAlert || '引擎未连接，请检查日志或重启。';
  const playbackLabel = isPlaying ? '播放中' : '暂停中';
  const bufferLabel =
    bufferMs !== null ? `缓冲 ${Math.round(bufferMs)}ms` : '缓冲未知';
  const handleWindowMinimize = () => {
    if (window.electronAPI?.minimizeWindow) {
      window.electronAPI.minimizeWindow();
      return;
    }
    window.electron?.invoke?.('window-minimize');
  };
  const handleWindowMaximize = () => {
    if (window.electronAPI?.maximizeWindow) {
      window.electronAPI.maximizeWindow();
      return;
    }
    window.electron?.invoke?.('window-maximize');
  };
  const handleWindowClose = () => {
    if (window.electronAPI?.closeWindow) {
      window.electronAPI.closeWindow();
      return;
    }
    window.electron?.invoke?.('window-close');
  };

  const handleSelect = async (index: number) => {
    if (!connected) return;
    const track = tracks[index];
    if (!track) return;
    setCurrentIndex(index);
    const result = await engineCmd('load', { path: track.path });
    if (result?.status === 'success') {
      await engineCmd('play');
    }
  };

  const handlePrev = () => {
    if (!connected) return;
    if (tracks.length === 0) return;
    const nextIndex = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
    handleSelect(nextIndex);
  };

  const handleNext = () => {
    if (!connected) return;
    if (tracks.length === 0) return;
    const nextIndex = currentIndex < tracks.length - 1 ? currentIndex + 1 : 0;
    handleSelect(nextIndex);
  };

  const handleSeek = async (time: number) => {
    if (!connected) return;
    if (!Number.isFinite(time)) return;
    await engineCmd('seek', { position: time });
  };

  const handlePlayPause = async () => {
    if (!connected) return;
    if (isPlaying) {
      await engineCmd('pause');
    } else {
      await engineCmd('play');
    }
  };

  const handleDeviceChange = async (nextDeviceId: number | null, nextExclusive: boolean) => {
    if (!connected) return;
    setDeviceId(nextDeviceId);
    setExclusive(nextExclusive);
    await engineCmd('configure-output', {
      device_id: nextDeviceId,
      exclusive: nextExclusive,
    });
  };

  const handleToggleExclusive = async (nextExclusive: boolean) => {
    if (!connected) return;
    setExclusive(nextExclusive);
    await engineCmd('configure-output', {
      device_id: deviceId,
      exclusive: nextExclusive,
    });
  };

  const handleStreamStart = async () => {
    if (!connected) return;
    if (!streamUrl.trim()) return;
    setInputMode('stream');
    await engineCmd('load-stream', { url: streamUrl.trim() });
    await engineCmd('play');
  };

  const handleStreamStop = async () => {
    if (!connected) return;
    await engineCmd('stop');
  };

  const handleCaptureStart = async () => {
    if (!connected) return;
    setInputMode('capture');
    await engineCmd('capture-start', { device_id: captureDeviceId });
    await engineCmd('play');
  };

  const handleCaptureStop = async () => {
    if (!connected) return;
    await engineCmd('capture-stop');
    await engineCmd('stop');
  };

  return (
    <div className="app-frame">
      <header className="titlebar">
        <div className="titlebar-left">
          <div className="logo-orb" />
          <div className="title-stack">
            <div className="title-name">NTmusic</div>
            <div className="title-sub">Spatial-ready playback lab</div>
          </div>
        </div>
        <div className="titlebar-center">
          <div className="now-label">Now Playing</div>
          <div className="now-title">{displayTitle}</div>
          <div className="now-artist">{displayArtist}</div>
        </div>
        <div className="titlebar-right">
          <div className={`engine-pill ${connected ? 'ok' : 'warn'}`}>
            {engineStatusLabel}
          </div>
          <div className="engine-hint">{engineStatusHint}</div>
        </div>
        <div className="titlebar-controls">
          <button
            className="window-btn"
            type="button"
            onClick={handleWindowMinimize}
            aria-label="最小化"
          >
            —
          </button>
          <button
            className="window-btn"
            type="button"
            onClick={handleWindowMaximize}
            aria-label="最大化"
          >
            □
          </button>
          <button
            className="window-btn close"
            type="button"
            onClick={handleWindowClose}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      </header>

      {!connected && (
        <div className="status-banner">
          <span className="status-tag">引擎未连接</span>
          <span>{engineStatusHint}</span>
        </div>
      )}

      <div className="app-body">
        <aside className="nav-panel">
          <div className="nav-group">
            <button className="nav-pill active">首页</button>
            <button className="nav-pill">搜索</button>
            <button className="nav-pill">本地库</button>
            <button className="nav-pill">收藏</button>
          </div>
          <div className="panel status-card">
            <div className="section-title">连接状态</div>
            <div className={`status-chip ${connected ? 'ok' : 'warn'}`}>
              {connected ? 'Engine Connected' : 'Engine Offline'}
            </div>
            <p className="status-text">
              {connected ? '引擎已连接，可进行播放与设备控制。' : engineStatusHint}
            </p>
            <button
              className="ghost-btn full-width"
              onClick={() => window.electron?.send('open-music-folder')}
            >
              导入文件夹
            </button>
          </div>
        </aside>

        <main className="main-panel">
          <section className="panel hero-card">
            <div className="hero-top">
              <div className="album-shell">
                {currentTrack.albumArt ? (
                  <img src={`file://${currentTrack.albumArt}`} alt={displayTitle} />
                ) : (
                  <div className="album-placeholder" />
                )}
              </div>
              <div className="hero-copy">
                <div className="hero-title">{displayTitle}</div>
                <div className="hero-artist">{displayArtist}</div>
                <div className="hero-meta">
                  <span className="chip">Hi-Res Ready</span>
                  <span className={`chip ${connected ? 'accent' : ''}`}>
                    {connected ? 'Engine Online' : 'Waiting for Engine'}
                  </span>
                </div>
              </div>
            </div>
            <div className="hero-stats">
              <div className="stat-pill">{playbackLabel}</div>
              <div className="stat-text">{bufferLabel}</div>
            </div>
          </section>

          <div className="main-grid">
            <InputPanel
              mode={inputMode}
              streamUrl={streamUrl}
              captureDevices={captureDevices}
              captureDeviceId={captureDeviceId}
              onCaptureDeviceChange={setCaptureDeviceId}
              onModeChange={setInputMode}
              onStreamUrlChange={setStreamUrl}
              onStreamStart={handleStreamStart}
              onStreamStop={handleStreamStop}
              onCaptureStart={handleCaptureStart}
              onCaptureStop={handleCaptureStop}
              onRefreshCaptureDevices={refreshCaptureDevices}
            />

            <PlaylistPanel
              tracks={tracks}
              currentIndex={currentIndex}
              scanning={scanning}
              scanned={scanDone}
              total={scanTotal}
              onImport={() => window.electron?.send('open-music-folder')}
              onSelect={handleSelect}
            />
          </div>
        </main>

        <aside className="side-panel">
          <div className="panel settings-container">
            <div className="section-title">模式</div>
            <div className="setting-row">
              <label>Pro 模式</label>
              <input
                type="checkbox"
                checked={proMode}
                onChange={(event) => setProMode(event.target.checked)}
              />
            </div>
            <div className="tab-row">
              <button
                className={`tab-btn ${inspectorTab === 'lyrics' ? 'active' : ''}`}
                onClick={() => setInspectorTab('lyrics')}
              >
                Lyrics
              </button>
              <button
                className={`tab-btn ${inspectorTab === 'dsp' ? 'active' : ''}`}
                onClick={() => setInspectorTab('dsp')}
              >
                DSP
              </button>
              <button
                className={`tab-btn ${inspectorTab === 'analyzer' ? 'active' : ''}`}
                onClick={() => setInspectorTab('analyzer')}
              >
                Analyzer
              </button>
            </div>
          </div>
          <DevicePanel
            devices={devices}
            currentDeviceId={deviceId}
            exclusive={exclusive}
            onRefresh={refreshDevices}
            onChange={handleDeviceChange}
            onToggleExclusive={handleToggleExclusive}
          />
          <QualityPanel playback={playback} proMode={proMode} />
          <EqPanel playback={playback} proMode={proMode} />
          {inspectorTab === 'dsp' && <DspChainPanel proMode={proMode} />}
          {inspectorTab === 'analyzer' && (
            <AnalyzerPanel proMode={proMode} spectrum={spectrum} />
          )}
          {inspectorTab === 'lyrics' && (
            <LyricsPanel
              track={{ title: displayTitle, artist: displayArtist }}
              currentTime={currentTime}
            />
          )}
        </aside>
      </div>

      <div className="player-footer">
        <PlayerBar
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          disabled={!connected}
          onPlayPause={handlePlayPause}
          onPrev={handlePrev}
          onNext={handleNext}
          onSeek={handleSeek}
        />
      </div>
    </div>
  );
};
