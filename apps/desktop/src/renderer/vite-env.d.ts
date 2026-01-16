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
  }
}

export {};
