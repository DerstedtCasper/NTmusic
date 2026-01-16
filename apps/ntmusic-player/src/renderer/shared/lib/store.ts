import { EngineEvent } from './events';

export type EngineState = {
  connected: boolean;
  message?: string;
};

export type PlaybackState = Record<string, unknown> | null;

export type BufferState = {
  bufferedMs: number;
  status?: string;
  targetMs?: number;
} | null;

export type StreamState = {
  status: string;
  error?: string;
} | null;

export type StoreState = {
  playback: PlaybackState;
  buffer: BufferState;
  stream: StreamState;
  spectrum: number[] | null;
  engine: EngineState;
};

type Listener = (state: StoreState, prev: StoreState) => void;

const listeners = new Set<Listener>();

let state: StoreState = {
  playback: null,
  buffer: null,
  stream: null,
  spectrum: null,
  engine: { connected: false },
};

const notify = (prev: StoreState) => {
  listeners.forEach((listener) => listener(state, prev));
};

export const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getState = () => state;

export const ingest = (event: EngineEvent) => {
  const prev = state;
  switch (event.type) {
    case 'playback.state':
      state = { ...state, playback: event.state };
      break;
    case 'buffer.state':
      state = { ...state, buffer: event };
      break;
    case 'stream.state':
      state = { ...state, stream: event };
      break;
    case 'spectrum.data':
      state = { ...state, spectrum: event.data };
      break;
    case 'engine.status':
      state = {
        ...state,
        engine: { connected: event.connected, message: event.message },
      };
      break;
    case 'error':
      state = {
        ...state,
        engine: { connected: false, message: event.message },
      };
      break;
    default:
      break;
  }
  if (prev !== state) {
    notify(prev);
  }
};
