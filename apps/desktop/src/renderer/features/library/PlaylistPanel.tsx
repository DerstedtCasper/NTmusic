import { useMemo, useState } from 'react';

export type Track = {
  path: string;
  title?: string;
  artist?: string;
  album?: string;
  albumArt?: string;
};

type PlaylistPanelProps = {
  tracks: Track[];
  currentIndex: number;
  scanning: boolean;
  scanned: number;
  total: number;
  onImport: () => void;
  onSelect: (index: number) => void;
};

export const PlaylistPanel = ({
  tracks,
  currentIndex,
  scanning,
  scanned,
  total,
  onImport,
  onSelect,
}: PlaylistPanelProps) => {
  const [query, setQuery] = useState('');
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
      <ul className="playlist-list">
        {filtered.length === 0 ? (
          <li className="placeholder">暂无歌曲，请导入文件夹。</li>
        ) : (
          filtered.map((track, index) => {
            const isActive = tracks.indexOf(track) === currentIndex;
            return (
              <li
                key={track.path}
                className={isActive ? 'active' : ''}
                onClick={() => onSelect(tracks.indexOf(track))}
              >
                <div className="track-title">{track.title || '未知标题'}</div>
                <div className="track-artist">
                  {track.artist || '未知艺术家'}
                </div>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
};
