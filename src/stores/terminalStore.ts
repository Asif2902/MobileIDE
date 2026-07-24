import { create } from 'zustand';
import { PtyNativeModule, PtyEventEmitter, PTY_EVENTS, TerminalOutputEvent, TerminalExitEvent } from '../native';

export interface TerminalSession {
  id: number;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  isAlive: boolean;
  createdAt: number;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: number | null;
  isCreating: boolean;
  // Whether the Termux-style extra-keys accessory bar is shown above the keyboard.
  isKeyboardBarVisible: boolean;
  
  // Actions
  createSession: (cwd?: string) => Promise<number>;
  closeSession: (sessionId: number) => Promise<void>;
  setActiveSession: (sessionId: number) => void;
  writeToSession: (sessionId: number, data: string) => Promise<void>;
  resizeSession: (sessionId: number, cols: number, rows: number) => Promise<void>;
  sendInterrupt: (sessionId: number) => Promise<void>;
  sendTab: (sessionId: number) => Promise<void>;
  refreshSessions: () => Promise<void>;
  toggleKeyboardBar: () => void;
  
  // Event handlers
  handleOutput: (event: TerminalOutputEvent) => void;
  handleExit: (event: TerminalExitEvent) => void;
}

// Output buffer for each terminal (sessionId -> output chunks)
const outputBuffers = new Map<number, string[]>();

export const getOutputBuffer = (sessionId: number): string[] => {
  return outputBuffers.get(sessionId) || [];
};

export const clearOutputBuffer = (sessionId: number): void => {
  outputBuffers.delete(sessionId);
};

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isCreating: false,
  isKeyboardBarVisible: true,

  toggleKeyboardBar: () => {
    set(state => ({ isKeyboardBarVisible: !state.isKeyboardBarVisible }));
  },

  createSession: async (cwd?: string) => {
    set({ isCreating: true });
    try {
      const session = await PtyNativeModule.createSession(80, 24, cwd || null);
      const newSession: TerminalSession = {
        id: session.sessionId,
        title: `Terminal ${session.sessionId}`,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        isAlive: true,
        createdAt: Date.now(),
      };
      
      // Initialize output buffer
      outputBuffers.set(session.sessionId, []);
      
      set(state => ({
        sessions: [...state.sessions, newSession],
        activeSessionId: session.sessionId,
        isCreating: false,
      }));
      
      return session.sessionId;
    } catch (error) {
      set({ isCreating: false });
      throw error;
    }
  },

  closeSession: async (sessionId: number) => {
    try {
      await PtyNativeModule.destroySession(sessionId);
      clearOutputBuffer(sessionId);
      
      set(state => {
        const sessions = state.sessions.filter(s => s.id !== sessionId);
        const activeSessionId = state.activeSessionId === sessionId 
          ? (sessions.length > 0 ? sessions[sessions.length - 1].id : null)
          : state.activeSessionId;
        return { sessions, activeSessionId };
      });
    } catch (error) {
      console.error('Failed to close session:', error);
    }
  },

  setActiveSession: (sessionId: number) => {
    set({ activeSessionId: sessionId });
  },

  writeToSession: async (sessionId: number, data: string) => {
    try {
      await PtyNativeModule.write(sessionId, data);
    } catch (error) {
      console.error('Failed to write to session:', error);
    }
  },

  resizeSession: async (sessionId: number, cols: number, rows: number) => {
    try {
      await PtyNativeModule.resize(sessionId, cols, rows);
      set(state => ({
        sessions: state.sessions.map(s => 
          s.id === sessionId ? { ...s, cols, rows } : s
        ),
      }));
    } catch (error) {
      console.error('Failed to resize session:', error);
    }
  },

  sendInterrupt: async (sessionId: number) => {
    try {
      await PtyNativeModule.sendInterrupt(sessionId);
    } catch (error) {
      console.error('Failed to send interrupt:', error);
    }
  },

  sendTab: async (sessionId: number) => {
    try {
      await PtyNativeModule.sendTab(sessionId);
    } catch (error) {
      console.error('Failed to send tab:', error);
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await PtyNativeModule.getSessions();
      set({
        sessions: sessions.map(s => ({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          cols: s.cols,
          rows: s.rows,
          isAlive: s.isAlive,
          createdAt: s.createdAt,
        })),
      });
    } catch (error) {
      console.error('Failed to refresh sessions:', error);
    }
  },

  handleOutput: (event: TerminalOutputEvent) => {
    const buffer = outputBuffers.get(event.sessionId) || [];
    buffer.push(event.data);
    // Keep buffer size manageable
    if (buffer.length > 1000) {
      buffer.splice(0, buffer.length - 1000);
    }
    outputBuffers.set(event.sessionId, buffer);
  },

  handleExit: (event: TerminalExitEvent) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === event.sessionId ? { ...s, isAlive: false } : s
      ),
    }));
  },
}));

// Setup event listeners
export const setupTerminalListeners = () => {
  const outputSub = PtyEventEmitter.addListener(
    PTY_EVENTS.OUTPUT,
    (event: TerminalOutputEvent) => {
      useTerminalStore.getState().handleOutput(event);
    }
  );

  const exitSub = PtyEventEmitter.addListener(
    PTY_EVENTS.EXIT,
    (event: TerminalExitEvent) => {
      useTerminalStore.getState().handleExit(event);
    }
  );

  return () => {
    outputSub.remove();
    exitSub.remove();
  };
};
