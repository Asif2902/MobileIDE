import { NativeModules, NativeEventEmitter } from 'react-native';

const { ProcessNative } = NativeModules;

export interface ProcessInfo {
  processId: number;
  command: string;
  cwd: string;
}

export interface ProcessDetails {
  id: number;
  command: string;
  cwd: string;
  startTime: number;
  uptime: number;
  isRunning: boolean;
}

export interface ActivePort {
  port: number;
  processId: number;
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
} as const;

// Common dev server ports
export const DEV_SERVER_PORTS = [3000, 3001, 4173, 5173, 8000, 8080];
