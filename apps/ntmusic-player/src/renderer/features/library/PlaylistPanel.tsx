import { useEffect, useMemo, useRef, useState } from 'react';
import type { UIEvent } from 'react';

export type Track = {
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArt?: string;
  duration?: number;
};

type PlaylistPanelProps = {
  tracks: Track[];
  currentIndex: number;
  scanning: boolean;
  scanned: number;
  total: number;
  onImport: () => void;
  onSelect: (index: number) => void;
  onMoveTrack: (from: number, to: number) => void;
  onRemoveTrack: (index: number) => void;
};

export const PlaylistPanel = ({
  tracks,
  currentIndex,
  scanning,
  scanned,
  total,
  onImport,
  onSelect,
  onMoveTrack,
  onRemoveTrack,
}: PlaylistPanelProps) => {
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const itemHeight = 64;
  const buffer = 6;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tracks;
    return tracks.filter((track) => {
      const title = track.title || '';
      const artist = track.artist || '';
      return (
        title.toLowerCase().includes(q) || artist.toLowerCase().includes(q)
      );
    });
  }, [tracks, query]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const update = () => {
      setViewportHeight(list.clientHeight || 0);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const handleScroll = (event: UIEvent<HTMLUListElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const totalHeight = filtered.length * itemHeight;
  const visibleCount =
    viewportHeight > 0 ? Math.ceil(viewportHeight / itemHeight) + buffer * 2 : 0;
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
  const endIndex = Math.min(filtered.length, startIndex + visibleCount);
  const visibleTracks =
    filtered.length > 0 ? filtered.slice(startIndex, endIndex) : [];


  return (
    <section className="playlist-section panel">
      <div className="playlist-header">
        <div>
          <h3>播放队列</h3>
          <p className="muted">本地音乐扫描与导入</p>
        </div>
        <div className="playlist-actions">
          <button className="ghost-btn" onClick={onImport}>
            导入文件夹
          </button>
        </div>
      </div>
      <div className="playlist-toolbar">
        <input
          type="text"
          placeholder="搜索本地库"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {scanning && (
          <div className="scan-status">
            扫描中 {scanned}/{total}
          </div>
        )}
      </div>
      
      <ul className="playlist-list" ref={listRef} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <li className="placeholder">暂无歌曲，请导入文件夹。</li>
        ) : (
          <>
            <li className="playlist-spacer" style={{ height: totalHeight }} aria-hidden="true" />
            {visibleTracks.map((track, index) => {
              const absoluteIndex = startIndex + index;
              const trackIndex = tracks.indexOf(track);
              const isActive = trackIndex === currentIndex;
              const canMoveUp = trackIndex > 0;
              const canMoveDown = trackIndex >= 0 && trackIndex < tracks.length - 1;
              return (
                <li
                  key={track.path}
                  className={isActive ? 'active' : ''}
                  style={{
                    position: 'absolute',
                    top: absoluteIndex * itemHeight,
                    left: 0,
                    right: 0,
                    height: itemHeight,
                  }}
                  onClick={() => {
                    if (trackIndex >= 0) onSelect(trackIndex);
                  }}
                >
                  <div className="track-main">
                    <div className="track-title">{track.title || '未知标题'}</div>
                    <div className="track-artist">{track.artist || '未知艺术家'}</div>
                  </div>
                  <div className="track-actions">
                    <button
                      type="button"
                      className="track-action"
                      disabled={!canMoveUp}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (canMoveUp) onMoveTrack(trackIndex, trackIndex - 1);
                      }}
                    >
                      Up
                    </button>
                    <button
                      type="button"
                      className="track-action"
                      disabled={!canMoveDown}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (canMoveDown) onMoveTrack(trackIndex, trackIndex + 1);
                      }}
                    >
                      Down
                    </button>
                    <button
                      type="button"
                      className="track-action danger"
                      disabled={trackIndex < 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (trackIndex >= 0) onRemoveTrack(trackIndex);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </>
        )}
      </ul>

    </section>
  );
};
