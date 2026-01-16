import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { EngineEvent } from './shared/lib/events';
import { ingest } from './shared/lib/store';
import './styles.css';

const SPECTRUM_POLL_MS = 50;
const SAB_FALLBACK_THRESHOLD = 20;

const Root = () => {
  useEffect(() => {
    let spectrumTimer: number | null = null;
    let sabMissCount = 0;
    let usingSAB = false;
    if (window.ntmusic?.onEngineEvent) {
      const unsubscribe = window.ntmusic.onEngineEvent((payload) => {
        const parsed = EngineEvent.safeParse(payload);
        if (parsed.success) {
          ingest(parsed.data);
        }
      });
      const initSpectrum = async () => {
        if (!window.ntmusicNta?.getSpectrumBuffer || !window.ntmusicNta?.consumeSpectrumFrame) {
          return;
        }
        const buffer = await window.ntmusicNta.getSpectrumBuffer();
        if (!buffer) return;
        if (window.ntmusic?.cmd) {
          window.ntmusic.cmd('spectrum-ws', { enabled: false }).catch(() => {});
        }
        usingSAB = true;
        spectrumTimer = window.setInterval(() => {
          window.ntmusicNta
            ?.consumeSpectrumFrame()
            .then((frame) => {
              if (!frame) {
                sabMissCount += 1;
                if (sabMissCount >= SAB_FALLBACK_THRESHOLD && usingSAB) {
                  usingSAB = false;
                  window.ntmusic?.cmd?.('spectrum-ws', { enabled: true }).catch(() => {});
                }
                return;
              }
              if (!usingSAB) {
                usingSAB = true;
                window.ntmusic?.cmd?.('spectrum-ws', { enabled: false }).catch(() => {});
              }
              sabMissCount = 0;
              const spectrumView = new Float32Array(frame.buffer);
              const slice = spectrumView.slice(0, frame.bins);
              ingest({ type: 'spectrum.data', data: Array.from(slice) });
            })
            .catch(() => {});
        }, SPECTRUM_POLL_MS);
      };
      initSpectrum();
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
        if (spectrumTimer) {
          window.clearInterval(spectrumTimer);
        }
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
