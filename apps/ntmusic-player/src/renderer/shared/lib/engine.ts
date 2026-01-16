type EngineResult = {
  status?: string;
  message?: string;
  [key: string]: any;
};

export const engineCmd = async (
  name: string,
  payload?: unknown,
): Promise<EngineResult> => {
  const player = (window as typeof window & {
    player?: {
      load?: (path: string) => Promise<EngineResult>;
      play?: (path?: string) => Promise<EngineResult>;
      resume?: () => Promise<EngineResult>;
      pause?: () => Promise<EngineResult>;
      stop?: () => Promise<EngineResult>;
      selectDevice?: (deviceId: number | null, exclusive?: boolean | null) => Promise<EngineResult>;
      getDevices?: () => Promise<EngineResult>;
      queueAdd?: (tracks: Array<Record<string, any>>, replace?: boolean) => Promise<EngineResult>;
      next?: () => Promise<EngineResult>;
      captureStart?: (options?: {
        device_id?: string | null;
        deviceId?: string | null;
        samplerate?: number | null;
        channels?: number | null;
      }) => Promise<EngineResult>;
      captureStop?: () => Promise<EngineResult>;
    };
  }).player;

  const fallback = () =>
    window.ntmusic?.cmd
      ? (window.ntmusic.cmd(name, payload) as Promise<EngineResult>)
      : Promise.resolve({ status: 'error', message: 'Engine command unavailable.' });

  if (player) {
    switch (name) {
      case 'load': {
        const path = (payload as { path?: string } | undefined)?.path;
        if (path && player.load) {
          const result = await player.load(path);
          if (result?.status === 'error') return fallback();
          return result;
        }
        break;
      }
      case 'play': {
        const path = (payload as { path?: string } | undefined)?.path;
        if (path && player.play) {
          const result = await player.play(path);
          if (result?.status === 'error') return fallback();
          return result;
        }
        if (!path && player.resume) {
          const result = await player.resume();
          if (result?.status === 'error') return fallback();
          return result;
        }
        if (player.play) {
          const result = await player.play();
          if (result?.status === 'error') return fallback();
          return result;
        }
        break;
      }
      case 'pause':
        if (player.pause) {
          const result = await player.pause();
          if (result?.status === 'error') return fallback();
          return result;
        }
        break;
      case 'stop':
        if (player.stop) {
          const result = await player.stop();
          if (result?.status === 'error') return fallback();
          return result;
        }
        break;
      case 'get-devices':
        if (player.getDevices) {
          const result = await player.getDevices();
          if (result?.status === 'error') return fallback();
          return result;
        }
        break;
      case 'configure-output': {
        if (!player.selectDevice) break;
        const data = payload as { device_id?: number | null; exclusive?: boolean | null } | undefined;
        const result = await player.selectDevice(data?.device_id ?? null, data?.exclusive ?? null);
        if (result?.status === 'error') return fallback();
        return result;
      }
      case 'capture-start': {
        if (!player.captureStart) break;
        const data = payload as {
          device_id?: string | null;
          deviceId?: string | null;
          samplerate?: number | null;
          channels?: number | null;
        } | undefined;
        const result = await player.captureStart(data);
        if (result?.status === 'error') return fallback();
        return result;
      }
      case 'capture-stop': {
        if (!player.captureStop) break;
        const result = await player.captureStop();
        if (result?.status === 'error') return fallback();
        return result;
      }
      case 'queue-add': {
        if (!player.queueAdd) break;
        const data = payload as { tracks?: Array<Record<string, any>>; replace?: boolean } | undefined;
        const result = await player.queueAdd(data?.tracks ?? [], data?.replace);
        if (result?.status === 'error') return fallback();
        return result;
      }
      case 'queue-next': {
        if (!player.next) break;
        const result = await player.next();
        if (result?.status === 'error') return fallback();
        return result;
      }
      default:
        break;
    }
  }

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
      'queue-add': 'player:queueAdd',
      'queue-next': 'player:next',
      'spectrum-ws': 'nta-set-spectrum-ws',
    };
    const channel = legacyMap[name];
    if (channel) {
      return window.electron.invoke(channel, payload);
    }
  }
  return { status: 'error', message: 'Engine command unavailable.' };
};
