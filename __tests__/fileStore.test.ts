jest.mock('../src/native', () => ({
  FileSystemNativeModule: {
    listDir: jest.fn(async () => []),
    writeFile: jest.fn(async () => true),
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
  },
}));

import {FileSystemNativeModule, MobileIDENativeModule} from '../src/native';
import {useFileStore} from '../src/stores/fileStore';

const mockedFileSystem = FileSystemNativeModule as jest.Mocked<typeof FileSystemNativeModule>;
const mockedMobileIDE = MobileIDENativeModule as jest.Mocked<typeof MobileIDENativeModule>;

describe('File workspace open contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useFileStore.setState({
      currentWorkspace: '/root/workspaces/current',
      currentWorkspaceRealPath: '/real/root/workspaces/current',
      workspaces: [],
      fileTree: new Map(),
      expandedFolders: new Set(),
      isLoading: false,
      error: null,
    });
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
});
