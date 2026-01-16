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
import { SmartControlPanel } from '../features/ai/SmartControlPanel';
import { engineCmd } from '../shared/lib/engine';

const normalizeQueueTracks = (items: Track[]) =>
  items
    .filter((track) => track && track.path)
    .map((track) => ({
      path: track.path,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: Number.isFinite(track.duration) ? Number(track.duration) : 0,
    }));

const mapQueueTrackToUi = (track: any): Track => ({
  path: track?.path || '',
  title: track?.title ?? undefined,
  artist: track?.artist ?? undefined,
  album: track?.album ?? undefined,
  duration: Number.isFinite(track?.duration) ? Number(track.duration) : 0,
});


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
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const bufferMs = storeState.buffer?.bufferedMs ?? null;

  const [tracks, setTracks] = useState<Track[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [scanTotal, setScanTotal] = useState(0);
  const [scanDone, setScanDone] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<{ id: number; name: string; hostapi?: string }[]>([]);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  const [exclusive, setExclusive] = useState(false);
  const [inputMode, setInputMode] = useState<'file' | 'stream' | 'capture'>('file');
  const [streamUrl, setStreamUrl] = useState('');
  const [captureDevices, setCaptureDevices] = useState<{ id: number; name: string }[]>([]);
  const [captureDeviceId, setCaptureDeviceId] = useState<number | null>(null);
  const [proMode, setProMode] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'lyrics' | 'dsp' | 'analyzer'>('lyrics');

  const syncQueue = async (items: Track[], replace = true) => {
    if (!connected) return;
    if (!items.length) return;
    await engineCmd('queue-add', { tracks: normalizeQueueTracks(items), replace });
  };

  const applyQueueTrack = (nextTrack: any) => {
    const path = nextTrack?.path;
    if (!path) return;
    const existingIndex = tracks.findIndex((track) => track.path === path);
    if (existingIndex >= 0) {
      setCurrentIndex(existingIndex);
      return;
    }
    const mapped = mapQueueTrackToUi(nextTrack);
    setTracks((prev) => {
      if (prev.find((track) => track.path === path)) return prev;
      return [mapped, ...prev];
    });
    setCurrentIndex(0);
  };

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

    window.electron.on('library:scan-started', ({ total }) => {
      setScanning(true);
      setScanTotal(total || 0);
      setScanDone(0);
    });
    window.electron.on('library:progress', ({ done, total }) => {
      if (typeof total === 'number') {
        setScanTotal(total);
      }
      if (typeof done === 'number') {
        setScanDone(done);
      } else {
        setScanDone((prev) => prev + 1);
      }
    });
    window.electron.on('library:result', ({ status, tracks }) => {
      setScanning(false);
      if (status === 'success' && Array.isArray(tracks)) {
        setTracks(tracks);
        window.electron?.send('save-music-playlist', tracks);
      }
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
    if (!connected) return;
    if (tracks.length === 0) return;
    syncQueue(tracks, true);
  }, [connected, tracks]);

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
      setEngineAlert('引擎启动超时，请检查 ntmusic_engine 是否可用。');
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

  useEffect(() => {
    if (!window.player?.onTrackEnd) return;
    return window.player.onTrackEnd(async () => {
      if (!connected) return;
      const result = await engineCmd('queue-next');
      if (result?.status === 'success' && result.track?.path) {
        applyQueueTrack(result.track);
      }
    });
  }, [connected, tracks]);



  const currentTrack = useMemo(() => {
    if (currentIndex >= 0 && tracks[currentIndex]) return tracks[currentIndex];
    return fallbackTrack;
  }, [currentIndex, tracks]);

  useEffect(() => {
    const path = currentTrack?.path;
    if (!connected || !path) {
      setCoverPath(null);
      return;
    }
    engineCmd('cover', { path }).then((result: any) => {
      if (result?.status === 'success' && result.cover_path) {
        setCoverPath(result.cover_path);
      } else {
        setCoverPath(null);
      }
    });
  }, [connected, currentTrack?.path]);

  const isPlaying = Boolean(playback?.is_playing && !playback?.is_paused);
  const currentTime = Number(playback?.current_time || 0);
  const duration = Number(playback?.duration || 0);
  const sourceSampleRate = Number(playback?.source_sample_rate || playback?.sample_rate || 0);
  const sourceChannels = Number(playback?.source_channels || playback?.channels || 0);
  const sourceBitDepth =
    playback?.source_bit_depth !== undefined && playback?.source_bit_depth !== null
      ? Number(playback.source_bit_depth)
      : null;
  const outputSampleRate = Number(playback?.sample_rate || 0);
  const outputChannels = Number(playback?.channels || 0);
  const displayTitle = currentTrack.title || fallbackTrack.title;
  const displayArtist = currentTrack.artist || fallbackTrack.artist;
  const engineStatusLabel = connected ? 'ENGINE ONLINE' : 'ENGINE OFFLINE';
  const engineStatusHint = connected
    ? '连接稳定'
    : engineAlert || '引擎未连接，请检查日志或重启。';
  const playbackLabel = isPlaying ? '播放中' : '暂停中';
  const bufferLabel =
    bufferMs !== null ? `缓冲 ${Math.round(bufferMs)}ms` : '缓冲未知';
  const formatRate = (value: number) => {
    if (!value || !Number.isFinite(value)) return '';
    const khz = value / 1000;
    const digits = value % 1000 === 0 ? 0 : 1;
    return `${khz.toFixed(digits)} kHz`;
  };
  const sourceParts = [
    sourceSampleRate ? formatRate(sourceSampleRate) : null,
    sourceBitDepth ? `${sourceBitDepth}bit` : null,
    sourceChannels ? `${sourceChannels}ch` : null,
  ].filter(Boolean) as string[];
  const outputParts = [
    outputSampleRate && outputSampleRate !== sourceSampleRate
      ? formatRate(outputSampleRate)
      : null,
    outputChannels && outputChannels !== sourceChannels ? `${outputChannels}ch` : null,
  ].filter(Boolean) as string[];
  const formatLabel =
    sourceParts.length > 0
      ? `${sourceParts.join(' / ')}${outputParts.length ? ` → ${outputParts.join(' / ')}` : ''}`
      : '';
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


  const persistPlaylist = (nextTracks: Track[]) => {
    window.electron?.send('save-music-playlist', nextTracks);
  };

  const handleMoveTrack = (from: number, to: number) => {
    setTracks((prev) => {
      if (from < 0 || from >= prev.length) return prev;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      persistPlaylist(next);
      syncQueue(next, true);
      const currentPath = prev[currentIndex]?.path;
      if (currentPath) {
        const nextIndex = next.findIndex((track) => track.path === currentPath);
        if (nextIndex !== currentIndex) {
          setCurrentIndex(nextIndex);
        }
      }
      return next;
    });
  };

  const handleRemoveTrack = (index: number) => {
    setTracks((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = prev.filter((_track, idx) => idx !== index);
      persistPlaylist(next);
      syncQueue(next, true);
      const currentPath = prev[currentIndex]?.path;
      if (!currentPath) {
        setCurrentIndex(-1);
        return next;
      }
      const nextIndex = next.findIndex((track) => track.path === currentPath);
      setCurrentIndex(nextIndex);
      return next;
    });
  };

  const handlePrev = () => {
    if (!connected) return;
    if (tracks.length === 0) return;
    const nextIndex = currentIndex > 0 ? currentIndex - 1 : tracks.length - 1;
    handleSelect(nextIndex);
  };

  const handleNext = async () => {
    if (!connected) return;
    const result = await engineCmd('queue-next');
    if (result?.status === 'success') {
      if (result.track?.path) {
        applyQueueTrack(result.track);
      }
      return;
    }
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
                {coverPath || currentTrack.albumArt ? (
                  <img
                    src={`file://${coverPath || currentTrack.albumArt}`}
                    alt={displayTitle}
                  />
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
                  {formatLabel ? <span className="chip subtle">{formatLabel}</span> : null}
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
              onImport={() => window.electron?.invoke('library:scan')}
              onSelect={handleSelect}
              onMoveTrack={handleMoveTrack}
              onRemoveTrack={handleRemoveTrack}
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
          <SmartControlPanel connected={connected} />
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
