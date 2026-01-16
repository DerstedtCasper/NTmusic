import { useState } from 'react';
import { engineCmd } from '../../shared/lib/engine';

type SmartControlPanelProps = {
  connected: boolean;
};

type CommandResponse = {
  status?: string;
  action?: string;
  message?: string;
  matches?: number;
  track?: { title?: string | null; artist?: string | null; path?: string } | null;
};

export const SmartControlPanel = ({ connected }: SmartControlPanelProps) => {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!connected) {
      setStatus('?????');
      return;
    }
    setBusy(true);
    try {
      const result = (await engineCmd('command', { text: trimmed })) as CommandResponse;
      if (result?.status === 'success') {
        if (result.track?.title || result.track?.artist) {
          const title = result.track.title || '????';
          const artist = result.track.artist || '?????';
          setStatus(`?? ${result.action || 'command'}?${title} - ${artist}`);
        } else if (typeof result.matches === 'number') {
          setStatus(`?? ${result.action || 'command'}??? ${result.matches} ?`);
        } else {
          setStatus(`?? ${result.action || 'command'} ??`);
        }
      } else {
        setStatus(result?.message || '??????');
      }
    } catch (_err) {
      setStatus('??????');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel smart-panel">
      <div className="section-title">Smart Control</div>
      <p className="muted">?????????? ?? / ?? / ???</p>
      <div className="smart-input">
        <input
          type="text"
          placeholder="????????"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleSend();
          }}
        />
        <button
          className="ghost-btn"
          type="button"
          onClick={handleSend}
          disabled={busy}
        >
          {busy ? '???' : '??'}
        </button>
      </div>
      {status ? <div className="smart-status">{status}</div> : null}
    </div>
  );
};
