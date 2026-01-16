import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { EngineEvent } from './shared/lib/events';
import { ingest } from './shared/lib/store';
import './styles.css';

const Root = () => {
  useEffect(() => {
    if (window.ntmusic?.onEngineEvent) {
      const unsubscribe = window.ntmusic.onEngineEvent((payload) => {
        const parsed = EngineEvent.safeParse(payload);
        if (parsed.success) {
          ingest(parsed.data);
        }
      });
      if (window.ntmusic?.cmd) {
        window.ntmusic.cmd('state').then((result) => {
          const state = (result as { status?: string; state?: unknown })?.state;
          if (state) {
            ingest({ type: 'playback.state', state });
          }
        });
      }
      return () => {
        if (typeof unsubscribe === 'function') unsubscribe();
      };
    }
    return () => undefined;
  }, []);

  return <App />;
};

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
