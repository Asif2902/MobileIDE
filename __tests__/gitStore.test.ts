jest.mock('../src/native/GitNativeModule', () => ({
  GitNative: {
    clone: jest.fn(async () => true),
    status: jest.fn(async () => ({
      added: [], changed: [], removed: [], untracked: [], modified: [], missing: [],
      conflicting: [], isClean: true, branch: 'main',
    })),
    diff: jest.fn(async () => []),
    branches: jest.fn(async () => [{name: 'main', isCurrent: true, isRemote: false}]),
    remotes: jest.fn(async () => [{name: 'origin', url: 'https://github.com/acme/app.git'}]),
    log: jest.fn(async () => []),
    fetch: jest.fn(async () => 'Fetched'),
    checkout: jest.fn(async () => 'feature/android'),
    createPullRequest: jest.fn(async () => ({number: 42, url: 'https://github.com/acme/app/pull/42', state: 'open'})),
    setCredentials: jest.fn(async (username: string) => ({
      reference: 'github-default',
      kind: 'https',
      host: 'github.com',
      username,
      createdAt: 1,
    })),
    listCredentials: jest.fn(async () => []),
    isGitRepo: jest.fn(async () => false),
  },
}));

import {GitNative} from '../src/native/GitNativeModule';
import {useGitStore} from '../src/stores/gitStore';

const mockedGit = GitNative as jest.Mocked<typeof GitNative>;

describe('Git store integration flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGitStore.setState({
      isRepo: false,
      isInitialized: true,
      status: null,
      commits: [],
      branches: [],
      remotes: [],
      diff: [],
      branch: 'main',
      isLoading: false,
      error: null,
      successMessage: null,
      isAuthenticated: false,
      username: '',
    });
  });

  it('clones without claiming that the destination is already open', async () => {
    const destination = '/root/workspaces/mobile-app';
    useGitStore.setState({isRepo: true, successMessage: null});
    await useGitStore.getState().cloneRepo('https://github.com/acme/mobile-app.git', destination);

    expect(mockedGit.clone).toHaveBeenCalledWith(
      'https://github.com/acme/mobile-app.git',
      destination,
    );
    expect(mockedGit.status).not.toHaveBeenCalled();
    expect(mockedGit.branches).not.toHaveBeenCalled();
    expect(mockedGit.remotes).not.toHaveBeenCalled();
    expect(mockedGit.log).not.toHaveBeenCalled();
    expect(useGitStore.getState().isRepo).toBe(true);
    expect(useGitStore.getState().successMessage).toBeNull();
  });

  it('preserves the current repository when a second clone fails', async () => {
    const currentStatus = {
      added: [], changed: [], removed: [], untracked: [], modified: ['src/app.ts'],
      missing: [], conflicting: [], isClean: false, branch: 'main',
    };
    useGitStore.setState({isRepo: true, status: currentStatus});
    mockedGit.clone.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(
      useGitStore.getState().cloneRepo(
        'https://github.com/acme/other.git',
        '/root/workspaces/other',
      ),
    ).rejects.toThrow('network unavailable');

    expect(useGitStore.getState().isRepo).toBe(true);
    expect(useGitStore.getState().status).toBe(currentStatus);
    expect(useGitStore.getState().error).toContain('network unavailable');
  });

  it('creates a tracked local branch when a remote branch is selected', async () => {
    await useGitStore.getState().checkoutBranch(
      '/root/workspaces/mobile-app',
      'origin/feature/android',
      false,
      true,
    );

    expect(mockedGit.checkout).toHaveBeenCalledWith(
      '/root/workspaces/mobile-app',
      'origin/feature/android',
      false,
      true,
    );
    expect(useGitStore.getState().branch).toBe('feature/android');
  });

  it('creates a pull request through the native protected-credential path', async () => {
    useGitStore.setState({
      remotes: [{name: 'origin', url: 'https://github.com/acme/app.git'}],
      branch: 'feature/android',
    });
    const result = await useGitStore.getState().createPullRequest(
      '/root/workspaces/mobile-app',
      'Android fixes',
      'Ready for review',
      'main',
      'feature/android',
      'origin',
    );

    expect(mockedGit.createPullRequest).toHaveBeenCalledWith(
      '/root/workspaces/mobile-app',
      'origin',
      'main',
      'feature/android',
      'Android fixes',
      'Ready for review',
    );
    expect(result?.number).toBe(42);
  });

  it('shows GitHub connected only for a github.com HTTPS token', async () => {
    mockedGit.listCredentials.mockResolvedValueOnce([
      {reference: 'ssh-gitlab', kind: 'ssh', host: 'gitlab.com', createdAt: 1},
      {reference: 'https-other', kind: 'https', host: 'example.com', username: 'other', createdAt: 2},
    ]);
    await useGitStore.getState().checkRepo('');
    expect(useGitStore.getState().isAuthenticated).toBe(false);

    mockedGit.listCredentials.mockResolvedValueOnce([
      {reference: 'github', kind: 'https', host: 'GitHub.COM.', username: 'asif', createdAt: 3},
    ]);
    await useGitStore.getState().checkRepo('');
    expect(useGitStore.getState().isAuthenticated).toBe(true);
    expect(useGitStore.getState().username).toBe('asif');
  });

  it('reports GitHub connected only after protected storage succeeds', async () => {
    const stored = await useGitStore.getState().setCredentials('asif', 'secret-token');

    expect(stored).toBe(true);
    expect(mockedGit.setCredentials).toHaveBeenCalledWith('asif', 'secret-token');
    expect(useGitStore.getState().isAuthenticated).toBe(true);
    expect(useGitStore.getState().username).toBe('asif');

    useGitStore.setState({isAuthenticated: false, username: '', error: null});
    mockedGit.setCredentials.mockRejectedValueOnce(new Error('keystore locked'));
    const failed = await useGitStore.getState().setCredentials('asif', 'new-token');

    expect(failed).toBe(false);
    expect(useGitStore.getState().isAuthenticated).toBe(false);
    expect(useGitStore.getState().error).toContain('keystore locked');
  });

  it('finishes initialization when no workspace is open', async () => {
    useGitStore.setState({isInitialized: false, isRepo: true});
    await useGitStore.getState().checkRepo('');

    expect(useGitStore.getState().isInitialized).toBe(true);
    expect(useGitStore.getState().isRepo).toBe(false);
  });
});
