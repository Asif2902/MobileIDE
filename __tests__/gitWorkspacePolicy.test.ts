import {
  normalizeProjectFolderName,
  privateCloneDestination,
  repositoryNameFromUrl,
} from '../src/utils/gitWorkspacePolicy';

describe('Git private workspace policy', () => {
  it.each([
    ['https://github.com/example/mobile-app.git', 'mobile-app'],
    ['git@github.com:example/mobile-app.git', 'mobile-app'],
    ['ssh://git@github.com/example/mobile-app', 'mobile-app'],
    ['https://github.com/example/mobile%20app.git?ref=main', 'mobile-app'],
  ])('derives a safe folder from %s', (url, expected) => {
    expect(repositoryNameFromUrl(url)).toBe(expected);
  });

  it('prevents path traversal and nested clone destinations', () => {
    expect(normalizeProjectFolderName('../../outside/project')).toBe('outside-project');
    expect(privateCloneDestination('/root/workspaces/', '../../outside')).toBe(
      '/root/workspaces/outside',
    );
  });

  it('matches the native requirement for an alphanumeric first character', () => {
    expect(normalizeProjectFolderName('_private-repo')).toBe('private-repo');
    expect(normalizeProjectFolderName('___')).toBe('cloned-repository');
    expect(privateCloneDestination('/root/workspaces', '_private-repo')).toBe(
      '/root/workspaces/private-repo',
    );
  });

  it('uses an actionable default for an unusable name', () => {
    expect(normalizeProjectFolderName('..')).toBe('cloned-repository');
    expect(() => privateCloneDestination('', 'repo')).toThrow(
      'Private workspace root is unavailable',
    );
  });
});
