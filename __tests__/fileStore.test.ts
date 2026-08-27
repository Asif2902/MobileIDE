jest.mock('../src/native', () => ({
  STORAGE_EVENTS: {
    PROGRESS: 'onProjectTransferProgress',
    COMPLETE: 'onProjectTransferComplete',
    ERROR: 'onProjectTransferError',
  },
  StorageEventEmitter: {addListener: jest.fn(() => ({remove: jest.fn()}))},
  FileSystemNativeModule: {
    listDir: jest.fn(async () => []),
    writeFile: jest.fn(async () => true),
    mkdir: jest.fn(async () => true),
    delete: jest.fn(async () => true),
    exists: jest.fn(async () => false),
    readFile: jest.fn(async () => ''),
    getWorkspaces: jest.fn(async () => []),
  },
  MobileIDENativeModule: {
    resolvePath: jest.fn(async (path: string) => `/real${path}`),
    getRuntimePaths: jest.fn(async () => ({
      root: '/real/root',
      bin: '/real/root/bin',
      lib: '/real/root/lib',
      home: '/real/root/home',
      workspaces: '/real/root/workspaces',
      tmp: '/real/root/tmp',
      cache: '/real/root/cache',
      etc: '/real/root/etc',
    })),
    getVirtualPaths: jest.fn(async () => ({
      root: '/root',
      bin: '/root/bin',
      home: '/root/home',
      workspaces: '/root/workspaces',
      tmp: '/root/tmp',
      cache: '/root/cache',
    })),
  },
  StorageNativeModule: {
    hasAllFilesAccess: jest.fn(async () => false),
    requestAllFilesAccess: jest.fn(async () => false),
    listExternalRoots: jest.fn(async () => []),
    assessWorkspace: jest.fn(async (path: string) => ({
      path,
      privateWorkspace: path.includes('/workspaces/'),
      nativeBuilds: path.includes('/workspaces/'),
      executableModes: path.includes('/workspaces/'),
      symlinks: path.includes('/workspaces/'),
      caseSensitiveNames: path.includes('/workspaces/'),
      requiresPrivateImport: !path.includes('/workspaces/'),
    })),
    beginImport: jest.fn(async () => 'import-1'),
    beginExport: jest.fn(async () => 'export-1'),
    getTransfer: jest.fn(async (operationId: string) => ({
      operationId,
      direction: 'import',
      status: 'queued',
      phase: 'scanning',
      filesCopied: 0,
      totalFiles: 0,
      bytesCopied: 0,
      totalBytes: 0,
      skippedEntries: 0,
    })),
    cancelTransfer: jest.fn(async () => true),
    pickFile: jest.fn(async () => null),
    importFile: jest.fn(async () => ({
      name: 'config (1).json',
      path: '/root/workspaces/current/config (1).json',
      bytesCopied: 12,
    })),
  },
  PtyNativeModule: {
    createSession: jest.fn(async (_cols: number, _rows: number, cwd: string) => ({
      sessionId: 101,
      cwd,
      cols: 80,
      rows: 24,
    })),
  },
  PtyEventEmitter: {addListener: jest.fn(() => ({remove: jest.fn()}))},
  PTY_EVENTS: {OUTPUT: 'onPtyOutput', EXIT: 'onPtyExit'},
}));

import {FileSystemNativeModule, MobileIDENativeModule, PtyNativeModule, StorageNativeModule} from '../src/native';
import {useFileStore} from '../src/stores/fileStore';

const mockedFileSystem = FileSystemNativeModule as jest.Mocked<typeof FileSystemNativeModule>;
const mockedMobileIDE = MobileIDENativeModule as jest.Mocked<typeof MobileIDENativeModule>;
const mockedStorage = StorageNativeModule as jest.Mocked<typeof StorageNativeModule>;

describe('File workspace open contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFileStore.setState({
      currentWorkspace: '/root/workspaces/current',
      currentWorkspaceRealPath: '/real/root/workspaces/current',
      currentWorkspaceAssessment: null,
      workspaces: [],
      fileTree: new Map(),
      expandedFolders: new Set(),
      isLoading: false,
      error: null,
      activeTransfer: null,
      transferError: null,
    });
  });

  it('marks a shared-storage folder as view-only development storage', async () => {
    mockedMobileIDE.resolvePath.mockResolvedValueOnce('/storage/emulated/0/Download/app');

    const opened = await useFileStore.getState().openWorkspace(
      '/storage/emulated/0/Download/app',
    );

    expect(opened).toBe(true);
    expect(useFileStore.getState().currentWorkspaceAssessment?.requiresPrivateImport).toBe(true);
    expect(useFileStore.getState().currentWorkspaceAssessment?.symlinks).toBe(false);
  });

  it('switches Explorer and a new Terminal to an imported private project', async () => {
    mockedMobileIDE.resolvePath.mockResolvedValueOnce('/real/root/workspaces/imported-app');

    await useFileStore.getState().handleTransferComplete({
      operationId: 'import-1',
      direction: 'import',
      status: 'complete',
      phase: 'complete',
      filesCopied: 2,
      totalFiles: 2,
      bytesCopied: 10,
      totalBytes: 10,
      skippedEntries: 1,
      result: {
        kind: 'import',
        path: '/real/root/workspaces/imported-app',
        virtualPath: '/root/workspaces/imported-app',
        project: {
          id: 'project-1',
          projectName: 'imported-app',
          workspacePath: '/real/root/workspaces/imported-app',
          virtualPath: '/root/workspaces/imported-app',
          importedAt: 1,
          projectType: 'nextjs',
        },
      },
    });

    expect(useFileStore.getState().currentWorkspace).toBe('/root/workspaces/imported-app');
    expect(useFileStore.getState().currentWorkspaceRealPath).toBe(
      '/real/root/workspaces/imported-app',
    );
    expect(PtyNativeModule.createSession).toHaveBeenCalledWith(
      80,
      24,
      '/real/root/workspaces/imported-app',
    );
  });

  it('publishes a workspace only after it can be listed and resolved', async () => {
    const entry = {
      name: '.env',
      path: '/root/workspaces/new/.env',
      isDirectory: false,
      size: 0,
      modifiedTime: 1,
      isHidden: true,
    };
    mockedFileSystem.listDir.mockResolvedValueOnce([entry]);
    mockedMobileIDE.resolvePath.mockResolvedValueOnce('/real/root/workspaces/new');

    const opened = await useFileStore.getState().openWorkspace('/root/workspaces/new');

    expect(opened).toBe(true);
    expect(useFileStore.getState().currentWorkspace).toBe('/root/workspaces/new');
    expect(useFileStore.getState().currentWorkspaceRealPath).toBe(
      '/real/root/workspaces/new',
    );
    expect(useFileStore.getState().fileTree.get('/root/workspaces/new')).toEqual([entry]);
  });

  it('keeps the previous virtual and real paths together when opening fails', async () => {
    mockedFileSystem.listDir.mockRejectedValueOnce(new Error('directory unavailable'));

    const opened = await useFileStore.getState().openWorkspace('/root/workspaces/broken');

    expect(opened).toBe(false);
    expect(useFileStore.getState().currentWorkspace).toBe('/root/workspaces/current');
    expect(useFileStore.getState().currentWorkspaceRealPath).toBe(
      '/real/root/workspaces/current',
    );
    expect(useFileStore.getState().error).toContain('directory unavailable');
  });

  it('imports a picked document into the active workspace and refreshes the tree', async () => {
    mockedStorage.pickFile.mockResolvedValueOnce({
      kind: 'documentUri',
      value: 'content://downloads/config',
      displayName: 'config.json',
      mimeType: 'application/json',
      size: 12,
    });
    mockedFileSystem.listDir.mockResolvedValueOnce([]);

    const result = await useFileStore.getState().importFileFromDevice();

    expect(mockedStorage.importFile).toHaveBeenCalledWith(
      'content://downloads/config',
      '/root/workspaces/current',
      'config.json',
    );
    expect(mockedFileSystem.listDir).toHaveBeenCalledWith('/root/workspaces/current');
    expect(result?.name).toBe('config (1).json');
  });

  it('deletes files and folders recursively and refreshes their parent', async () => {
    mockedFileSystem.listDir.mockResolvedValueOnce([]);

    await useFileStore.getState().deleteItem('/root/workspaces/current/src');

    expect(mockedFileSystem.delete).toHaveBeenCalledWith(
      '/root/workspaces/current/src',
      true,
    );
    expect(mockedFileSystem.listDir).toHaveBeenCalledWith(
      '/root/workspaces/current',
    );
  });

  it('removes a deleted subtree from Explorer state before native refresh completes', async () => {
    let finishDelete: (() => void) | undefined;
    mockedFileSystem.delete.mockImplementationOnce(
      () => new Promise<boolean>(resolve => {
        finishDelete = () => resolve(true);
      }),
    );
    mockedFileSystem.listDir.mockResolvedValueOnce([]);
    useFileStore.setState({
      fileTree: new Map([
        ['/root/workspaces/current', [{
          name: 'src',
          path: '/root/workspaces/current/src',
          isDirectory: true,
          size: 0,
          modifiedTime: 1,
          isHidden: false,
        }]],
        ['/root/workspaces/current/src', [{
          name: 'index.js',
          path: '/root/workspaces/current/src/index.js',
          isDirectory: false,
          size: 8,
          modifiedTime: 1,
          isHidden: false,
        }]],
      ]),
      expandedFolders: new Set(['/root/workspaces/current/src']),
    });

    const deletion = useFileStore.getState().deleteItem('/root/workspaces/current/src');

    expect(useFileStore.getState().fileTree.get('/root/workspaces/current')).toEqual([]);
    expect(useFileStore.getState().fileTree.has('/root/workspaces/current/src')).toBe(false);
    expect(useFileStore.getState().expandedFolders.has('/root/workspaces/current/src')).toBe(false);

    finishDelete?.();
    await deletion;
  });

  it('creates and opens a private project without Git or Terminal setup', async () => {
    mockedFileSystem.exists.mockResolvedValueOnce(false);
    mockedFileSystem.getWorkspaces.mockResolvedValueOnce([]);
    mockedFileSystem.listDir.mockResolvedValueOnce([]);
    mockedMobileIDE.resolvePath.mockResolvedValueOnce('/real/root/workspaces/fresh-app');

    const created = await useFileStore.getState().createWorkspace('fresh-app');

    expect(mockedFileSystem.mkdir).toHaveBeenCalledWith(
      '/root/workspaces/fresh-app',
      true,
    );
    expect(created).toBe('/root/workspaces/fresh-app');
    expect(useFileStore.getState().currentWorkspace).toBe('/root/workspaces/fresh-app');
  });

  it('does not expose hidden runtime directories as projects', async () => {
    mockedFileSystem.getWorkspaces.mockResolvedValueOnce([
      {name: '.cache', path: '/root/workspaces/.cache', modifiedTime: 1},
      {name: '.npm', path: '/root/workspaces/.npm', modifiedTime: 1},
      {name: 'demo-web', path: '/root/workspaces/demo-web', modifiedTime: 1},
    ]);

    await useFileStore.getState().loadWorkspaces();

    expect(useFileStore.getState().workspaces.map(workspace => workspace.name)).toEqual([
      'demo-web',
    ]);
  });
});
