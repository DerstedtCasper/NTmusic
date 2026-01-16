import { useMemo } from 'react';

type PlayerBarProps = {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  disabled: boolean;
  onPlayPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (time: number) => void;
};

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
};

export const PlayerBar = ({
  isPlaying,
  currentTime,
  duration,
  disabled,
  onPlayPause,
  onPrev,
  onNext,
  onSeek,
}: PlayerBarProps) => {
  const progress = useMemo(() => {
    if (!duration || duration <= 0) return 0;
    return Math.min(100, (currentTime / duration) * 100);
  }, [currentTime, duration]);

  const handleSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = Math.max(0, Math.min(event.clientX - rect.left, rect.width));
    const ratio = rect.width > 0 ? offset / rect.width : 0;
    onSeek(duration * ratio);
  };

  return (
    <footer className="player-bar">
      <div className="player-controls">
        <button className="control-btn" onClick={onPrev} aria-label="上一首" disabled={disabled}>
          ◀◀
        </button>
        <button className="control-btn play-btn" onClick={onPlayPause} aria-label="播放/暂停" disabled={disabled}>
          {isPlaying ? '❚❚' : '▶'}
        </button>
        <button className="control-btn" onClick={onNext} aria-label="下一首" disabled={disabled}>
          ▶▶
        </button>
      </div>
      <div className="progress-section">
        <div className={`progress-container ${disabled ? 'disabled' : ''}`} onClick={disabled ? undefined : handleSeek}>
          <div className="progress-bar">
            <div className="progress" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="time-display">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </footer>
  );
};
