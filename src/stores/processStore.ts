import { create } from 'zustand';
import {
  ProcessNativeModule,
  ProcessEventEmitter,
  TaskDetails,
  TaskType,
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
  processes: TaskDetails[];
  ports: ActivePort[];
  logs: ProcessLogLine[];
  isLoading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  kill: (processId: number) => Promise<void>;
  clearLogs: () => void;
  appendLog: (line: ProcessLogLine) => void;
  /** Run a shell line in background (Vite/Express demos, builds). */
  runShell: (script: string, cwd?: string | null) => Promise<number | null>;
  startTask: (
    type: TaskType,
    command: string,
    args?: string[],
    cwd?: string | null,
    persistent?: boolean,
  ) => Promise<number | null>;
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
        ProcessNativeModule.getTasks(false),
        ProcessNativeModule.getActivePorts(),
      ]);
      set({ processes: processes || [], ports: ports || [], isLoading: false });
    } catch (e) {
      set({ isLoading: false, error: (e as Error).message, processes: [], ports: [] });
    }
  },

  kill: async (processId: number) => {
    try {
      const clean = await ProcessNativeModule.kill(processId);
      get().appendLog({
        processId,
        stream: 'system',
        data: clean
          ? `[stopped task ${processId}; ports closed]`
          : `[task ${processId} stop incomplete; check child processes and ports]`,
        at: Date.now(),
      });
      if (!clean) {
        set({ error: `Task ${processId} did not confirm complete process/port cleanup.` });
      }
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

  runShell: async (script: string, cwd: string | null = null) => {
    try {
      set({ error: null });
      const info = await ProcessNativeModule.runShell(script, cwd);
      get().appendLog({
        processId: info.processId,
        stream: 'system',
        data: `[started #${info.processId}] ${script}`,
        at: Date.now(),
      });
      await get().refresh();
      return info.processId;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
  },

  startTask: async (
    type,
    command,
    args = [],
    cwd = null,
    persistent = type === 'NODE' || type === 'EXPRESS' || type === 'VITE' || type === 'NEXT',
  ) => {
    try {
      set({ error: null });
      const info = await ProcessNativeModule.startTask(type, command, args, cwd, persistent);
      get().appendLog({
        processId: info.taskId,
        stream: 'system',
        data: `[started ${type.toLowerCase()} task #${info.taskId}] ${command} ${args.join(' ')}`,
        at: Date.now(),
      });
      await get().refresh();
      return info.taskId;
    } catch (e) {
      set({ error: (e as Error).message });
      return null;
    }
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

  const portsSub = ProcessEventEmitter.addListener(
    PROCESS_EVENTS.PORTS,
    (event: { ports: ActivePort[] }) => {
      useProcessStore.setState({ ports: event.ports || [] });
    },
  );

  return () => {
    outSub.remove();
    exitSub.remove();
    portsSub.remove();
  };
};
