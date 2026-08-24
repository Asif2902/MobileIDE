import { PtyNativeModule } from '../src/native';
import {
  clearOutputBuffer,
  getOutputBuffer,
  useTerminalStore,
} from '../src/stores/terminalStore';

jest.mock('../src/native', () => ({
  PtyNativeModule: {
    createSession: jest.fn(),
    destroySession: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    sendInterrupt: jest.fn(),
    sendTab: jest.fn(),
    getSessions: jest.fn(),
  },
  PtyEventEmitter: {
    addListener: jest.fn(),
  },
  PTY_EVENTS: {
    OUTPUT: 'onTerminalOutput',
    EXIT: 'onTerminalExit',
  },
}));

const mockedPty = PtyNativeModule as jest.Mocked<typeof PtyNativeModule>;

describe('terminalStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTerminalStore.setState({
      sessions: [],
      activeSessionId: null,
      isCreating: false,
      creationError: null,
      isKeyboardBarVisible: true,
    });
    clearOutputBuffer(41);
  });

  it('deduplicates concurrent terminal creation attempts', async () => {
    let resolveSession!: (session: {
      sessionId: number;
      taskId: number;
      pid: number;
      cwd: string;
      cols: number;
      rows: number;
    }) => void;
    mockedPty.createSession.mockReturnValue(
      new Promise(resolve => {
        resolveSession = resolve;
      }),
    );

    const first = useTerminalStore.getState().createSession('/project');
    const second = useTerminalStore.getState().createSession('/project');

    expect(first).toBe(second);
    await Promise.resolve();
    expect(mockedPty.createSession).toHaveBeenCalledTimes(1);

    resolveSession({
      sessionId: 7,
      taskId: 9,
      pid: 11,
      cwd: '/project',
      cols: 80,
      rows: 24,
    });
    await Promise.all([first, second]);

    expect(useTerminalStore.getState().activeSessionId).toBe(7);
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
  });

  it('exposes terminal failures without remaining in loading state', async () => {
    mockedPty.createSession.mockRejectedValue(new Error('shell is not executable'));

    await expect(
      useTerminalStore.getState().createSession('/project'),
    ).rejects.toThrow('shell is not executable');

    expect(useTerminalStore.getState().isCreating).toBe(false);
    expect(useTerminalStore.getState().creationError).toBe(
      'shell is not executable',
    );
    expect(mockedPty.createSession).toHaveBeenCalledTimes(1);
  });

  it('recovers after a synchronous native bridge failure', async () => {
    mockedPty.createSession.mockImplementationOnce(() => {
      throw new Error('native bridge unavailable');
    });

    await expect(
      useTerminalStore.getState().createSession('/project'),
    ).rejects.toThrow('native bridge unavailable');

    mockedPty.createSession.mockResolvedValue({
      sessionId: 8,
      taskId: 10,
      pid: 12,
      cwd: '/project',
      cols: 80,
      rows: 24,
    });
    await expect(
      useTerminalStore.getState().createSession('/project'),
    ).resolves.toBe(8);
    expect(mockedPty.createSession).toHaveBeenCalledTimes(2);
  });

  it('restores an active session when native sessions already exist', async () => {
    mockedPty.getSessions.mockResolvedValue([
      {
        id: 3,
        taskId: 5,
        pid: 13,
        title: 'Terminal 3',
        cwd: '/first',
        cols: 80,
        rows: 24,
        isAlive: true,
        createdAt: 1,
      },
      {
        id: 4,
        taskId: 6,
        pid: 14,
        title: 'Terminal 4',
        cwd: '/second',
        cols: 80,
        rows: 24,
        isAlive: true,
        createdAt: 2,
      },
    ]);

    await useTerminalStore.getState().refreshSessions();

    expect(useTerminalStore.getState().activeSessionId).toBe(4);
  });

  it('keeps terminal replay output until full scrollback is explicitly cleared', () => {
    useTerminalStore.getState().handleOutput({
      sessionId: 41,
      taskId: 7,
      data: 'first line\r\n',
    });
    useTerminalStore.getState().handleOutput({
      sessionId: 41,
      taskId: 7,
      data: 'second line\r\n',
    });

    expect(getOutputBuffer(41).join('')).toContain('second line');
    clearOutputBuffer(41);
    expect(getOutputBuffer(41)).toEqual([]);
  });
});
