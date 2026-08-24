import { NativeModules, NativeEventEmitter } from 'react-native';

const { ProcessNative } = NativeModules;

export interface ProcessInfo {
  processId: number;
  taskId?: number;
  pid: number;
  command: string;
  cwd: string;
}

export interface ProcessDetails {
  id: number;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  uptime: number;
  isRunning: boolean;
}

export interface ActivePort {
  port: number;
  processId: number;
  taskId: number;
  pid: number;
  processGroupId: number;
  url: string;
  source: 'NODE_EVENT' | 'PROC_OWNERSHIP' | 'LOG_HINT';
  state: 'LISTENING';
  verifiedAt: number;
}

export type TaskType =
  | 'NODE'
  | 'EXPRESS'
  | 'VITE'
  | 'NEXT'
  | 'BUILD'
  | 'TEST'
  | 'SHELL'
  | 'GENERIC';

export interface TaskDetails {
  id: number;
  taskId: number;
  pid: number;
  processGroupId: number;
  type: TaskType;
  source: 'BACKGROUND' | 'TERMINAL';
  command: string;
  cwd: string;
  persistent: boolean;
  startTime: number;
  uptime: number;
  state: 'STARTING' | 'RUNNING' | 'STOPPING' | 'EXITED' | 'FAILED';
  isRunning: boolean;
  exitCode: number | null;
  failure: string | null;
  ports: ActivePort[];
}

export interface TaskLog {
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}

export interface ProcessOutputEvent {
  processId: number;
  data: string;
  stream: 'stdout' | 'stderr';
}

export interface ProcessExitEvent {
  processId: number;
  exitCode: number;
}

export interface ProcessNativeInterface {
  spawn(command: string, args: string[], cwd: string | null): Promise<ProcessInfo>;
  /** Background shell with ADEV wrappers (npm/tsc/build/servers for agents). */
  runShell(script: string, cwd: string | null): Promise<ProcessInfo>;
  startTask(
    type: TaskType,
    command: string,
    args: string[],
    cwd: string | null,
    persistent: boolean,
  ): Promise<ProcessInfo & { taskId: number; type: TaskType }>;
  stopTask(taskId: number): Promise<boolean>;
  restartTask(taskId: number): Promise<ProcessInfo & { taskId: number }>;
  getTasks(includeExited: boolean): Promise<TaskDetails[]>;
  getTaskLogs(taskId: number, limit: number): Promise<TaskLog[]>;
  kill(processId: number): Promise<boolean>;
  getProcesses(): Promise<ProcessDetails[]>;
  getActivePorts(): Promise<ActivePort[]>;
  isPortActive(port: number): Promise<boolean>;
  getMonitoredPorts(): Promise<number[]>;
  killAll(): Promise<boolean>;
}

export const ProcessNativeModule = ProcessNative as ProcessNativeInterface;
export const ProcessEventEmitter = new NativeEventEmitter(ProcessNative);

// Event names
export const PROCESS_EVENTS = {
  OUTPUT: 'onProcessOutput',
  EXIT: 'onProcessExit',
  PORTS: 'onTaskPortsChanged',
} as const;

// Common dev server ports
export const DEV_SERVER_PORTS = [3000, 3001, 4173, 5173, 8000, 8080];
