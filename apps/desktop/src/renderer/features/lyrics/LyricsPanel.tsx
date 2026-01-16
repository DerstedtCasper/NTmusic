import { useEffect, useMemo, useState } from 'react';

type TrackMeta = {
  title?: string;
  artist?: string;
};

type LyricsLine = {
  time: number;
  original: string;
  translation?: string;
};

const parseLrc = (content: string) => {
  const lines: LyricsLine[] = [];
  const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;

  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const text = trimmed.replace(timeRegex, '').trim();
    if (!text) return;

    let match: RegExpExecArray | null;
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(trimmed))) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const milliseconds = Number(match[3].padEnd(3, '0'));
      const time = minutes * 60 + seconds + milliseconds / 1000;
      lines.push({ time, original: text });
    }
  });

  lines.sort((a, b) => a.time - b.time);
  return lines;
};

type LyricsPanelProps = {
  track: TrackMeta;
  currentTime: number;
};

export const LyricsPanel = ({ track, currentTime }: LyricsPanelProps) => {
  const [lines, setLines] = useState<LyricsLine[]>([]);
  const [status, setStatus] = useState('暂无歌词');

  useEffect(() => {
    const title = track.title?.trim();
    if (!title || !window.electron) {
      setLines([]);
      setStatus('暂无歌词');
      return;
    }

    let cancelled = false;
    const fetchLyrics = async () => {
      setStatus('加载歌词中...');
      const artist = track.artist?.trim();
      const local = await window.electron?.invoke('music-get-lyrics', { artist, title });
      if (cancelled) return;
      if (local) {
        setLines(parseLrc(local));
        setStatus('');
        return;
      }
      const fetched = await window.electron?.invoke('music-fetch-lyrics', { artist, title });
      if (cancelled) return;
      if (fetched) {
        setLines(parseLrc(fetched));
        setStatus('');
      } else {
        setLines([]);
        setStatus('暂无歌词');
      }
    };

    fetchLyrics();
    return () => {
      cancelled = true;
    };
  }, [track.title, track.artist]);

  const activeIndex = useMemo(() => {
    if (!lines.length) return -1;
    let idx = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (currentTime >= lines[i].time) idx = i;
      else break;
    }
    return idx;
  }, [lines, currentTime]);

  return (
    <section className="panel lyrics-panel">
      <div className="section-title">歌词</div>
      <div className="lyrics-list">
        {lines.length === 0 ? (
          <div className="placeholder">{status}</div>
        ) : (
          lines.map((line, index) => (
            <div
              key={`${line.time}-${line.original}`}
              className={`lyrics-line ${index === activeIndex ? 'active' : ''}`}
            >
              {line.original}
            </div>
          ))
        )}
      </div>
    </section>
  );
};
