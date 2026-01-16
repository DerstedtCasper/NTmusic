import { useSyncExternalStore } from 'react';
import { getState, subscribe, StoreState } from './store';

export const useStore = (): StoreState =>
  useSyncExternalStore(subscribe, getState, getState);
