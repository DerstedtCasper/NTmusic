type EngineResult = {
  status?: string;
  message?: string;
  [key: string]: any;
};

export const engineCmd = async (
  name: string,
  payload?: unknown,
): Promise<EngineResult> => {
  if (window.ntmusic?.cmd) {
    return window.ntmusic.cmd(name, payload) as Promise<EngineResult>;
  }
  if (window.electron?.invoke) {
    const legacyMap: Record<string, string> = {
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
      'spectrum-ws': 'nta-set-spectrum-ws',
    };
    const channel = legacyMap[name];
    if (channel) {
      return window.electron.invoke(channel, payload);
    }
  }
  return { status: 'error', message: 'Engine command unavailable.' };
};
