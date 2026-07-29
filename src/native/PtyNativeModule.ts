import { NativeModules, NativeEventEmitter } from 'react-native';

const { PtyNative } = NativeModules;

export interface PtySession {
  sessionId: number;
  taskId: number;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtySessionInfo {
  id: number;
  taskId: number;
  pid: number;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  isAlive: boolean;
  createdAt: number;
}

export interface TerminalOutputEvent {
  sessionId: number;
  taskId: number;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: number;
  taskId: number;
  exitCode: number;
}

export interface PtyNativeInterface {
  createSession(cols: number, rows: number, cwd: string | null): Promise<PtySession>;
  write(sessionId: number, data: string): Promise<boolean>;
  resize(sessionId: number, cols: number, rows: number): Promise<boolean>;
  destroySession(sessionId: number): Promise<boolean>;
  getSessions(): Promise<PtySessionInfo[]>;
  isSessionAlive(sessionId: number): Promise<boolean>;
  sendInterrupt(sessionId: number): Promise<boolean>;
  sendSuspend(sessionId: number): Promise<boolean>;
  sendEOF(sessionId: number): Promise<boolean>;
  sendTab(sessionId: number): Promise<boolean>;
}

export const PtyNativeModule = PtyNative as PtyNativeInterface;
export const PtyEventEmitter = new NativeEventEmitter(PtyNative);

// Event names
export const PTY_EVENTS = {
  OUTPUT: 'onTerminalOutput',
  EXIT: 'onTerminalExit',
} as const;
