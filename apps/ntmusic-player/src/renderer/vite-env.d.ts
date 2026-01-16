/// <reference types="vite/client" />

declare global {
  interface Window {
    ntmusic?: {
      onEngineEvent?: (callback: (payload: unknown) => void) => () => void;
      cmd?: (name: string, payload?: unknown) => Promise<unknown>;
    };
    electron?: {
      send: (channel: string, data?: unknown) => void;
      invoke: (channel: string, data?: unknown) => Promise<any>;
      on: (channel: string, callback: (...args: any[]) => void) => void;
    };
    ntmusicNta?: {
      getSpectrumBuffer?: () => Promise<SharedArrayBuffer | null>;
      getSpectrumLength?: () => Promise<number>;
      consumeSpectrumFrame?: () => Promise<{ buffer: SharedArrayBuffer; bins: number } | null>;
      setSpectrumWs?: (enabled: boolean) => Promise<unknown>;
    };
    player?: {
      load?: (path: string) => Promise<any>;
      play?: (path?: string) => Promise<any>;
      resume?: () => Promise<any>;
      pause?: () => Promise<any>;
      stop?: () => Promise<any>;
      selectDevice?: (deviceId: number | null, exclusive?: boolean | null) => Promise<any>;
      getDevices?: () => Promise<any>;
      getTrack?: () => Promise<{
        path: string | null;
        title: string | null;
        duration: number;
        sample_rate: number;
        channels: number;
        bit_depth?: number | null;
      }>;
      getPosition?: () => Promise<any>;
      queueAdd?: (tracks: Array<Record<string, any>>, replace?: boolean) => Promise<any>;
      next?: () => Promise<any>;
      captureStart?: (options?: {
        device_id?: string | null;
        deviceId?: string | null;
        samplerate?: number | null;
        channels?: number | null;
      }) => Promise<any>;
      captureStop?: () => Promise<any>;
      onProgress?: (callback: (payload: { current: number; duration: number }) => void) => () => void;
      onTrackEnd?: (callback: (payload: { path: string | null; duration: number }) => void) => () => void;
    };
  }
}

export {};
