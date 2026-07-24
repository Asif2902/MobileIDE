import { create } from 'zustand';
import {
  ProcessNativeModule,
  ProcessEventEmitter,
  ProcessDetails,
  ActivePort,
  PROCESS_EVENTS,
} from '../native/ProcessNativeModule';

export interface ProcessLogLine {
  processId: number;
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
  at: number;
}

interface ProcessState {
  processes: ProcessDetails[];
  ports: ActivePort[];
  logs: ProcessLogLine[];
  isLoading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  kill: (processId: number) => Promise<void>;
  clearLogs: () => void;
  appendLog: (line: ProcessLogLine) => void;
}

const MAX_LOGS = 500;

export const useProcessStore = create<ProcessState>((set, get) => ({
  processes: [],
  ports: [],
  logs: [],
  isLoading: false,
  error: null,

  refresh: async () => {
    set({ isLoading: true, error: null });
    try {
      const [processes, ports] = await Promise.all([
        ProcessNativeModule.getProcesses(),
        ProcessNativeModule.getActivePorts(),
      ]);
      set({ processes: processes || [], ports: ports || [], isLoading: false });
    } catch (e) {
      set({ isLoading: false, error: (e as Error).message, processes: [], ports: [] });
    }
  },

  kill: async (processId: number) => {
    try {
      await ProcessNativeModule.kill(processId);
      get().appendLog({
        processId,
        stream: 'system',
        data: `[killed process ${processId}]`,
        at: Date.now(),
      });
      await get().refresh();
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  clearLogs: () => set({ logs: [] }),

  appendLog: (line: ProcessLogLine) => {
    set(state => {
      const logs = [...state.logs, line];
      if (logs.length > MAX_LOGS) {
        logs.splice(0, logs.length - MAX_LOGS);
      }
      return { logs };
    });
  },
}));

export const setupProcessListeners = () => {
  const outSub = ProcessEventEmitter.addListener(
    PROCESS_EVENTS.OUTPUT,
    (event: { processId: number; data: string; stream: string }) => {
      useProcessStore.getState().appendLog({
        processId: event.processId,
        stream: event.stream === 'stderr' ? 'stderr' : 'stdout',
        data: event.data,
        at: Date.now(),
      });
    },
  );

  const exitSub = ProcessEventEmitter.addListener(
    PROCESS_EVENTS.EXIT,
    (event: { processId: number; exitCode: number }) => {
      useProcessStore.getState().appendLog({
        processId: event.processId,
        stream: 'system',
        data: `[process ${event.processId} exited with code ${event.exitCode}]`,
        at: Date.now(),
      });
      useProcessStore.getState().refresh();
    },
  );

  return () => {
    outSub.remove();
    exitSub.remove();
  };
};
