import { create } from 'zustand';
import { MobileIDENativeModule, RuntimePaths, VirtualPaths } from '../native';

interface RuntimeState {
  isReady: boolean;
  isInitializing: boolean;
  progress: number;
  progressMessage: string;
  paths: RuntimePaths | null;
  virtualPaths: VirtualPaths | null;
  error: string | null;
  
  // Actions
  checkRuntime: () => Promise<void>;
  initializeRuntime: () => Promise<void>;
  setProgress: (progress: number, message: string) => void;
  loadPaths: () => Promise<void>;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  isReady: false,
  isInitializing: false,
  progress: 0,
  progressMessage: '',
  paths: null,
  virtualPaths: null,
  error: null,

  checkRuntime: async () => {
    try {
      const isReady = await MobileIDENativeModule.isRuntimeReady();
      set({ isReady });
      if (isReady) {
        await get().loadPaths();
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  initializeRuntime: async () => {
    set({ isInitializing: true, progress: 0, error: null });
    try {
      await MobileIDENativeModule.initializeRuntime();
      set({ isReady: true, isInitializing: false, progress: 100 });
      await get().loadPaths();
    } catch (error) {
      set({ 
        isInitializing: false, 
        error: (error as Error).message 
      });
    }
  },

  setProgress: (progress, message) => {
    set({ progress: progress * 100, progressMessage: message });
  },

  loadPaths: async () => {
    try {
      const [paths, virtualPaths] = await Promise.all([
        MobileIDENativeModule.getRuntimePaths(),
        MobileIDENativeModule.getVirtualPaths(),
      ]);
      set({ paths, virtualPaths });
    } catch (error) {
      console.error('Failed to load paths:', error);
    }
  },
}));
