import fs from 'fs';
import path from 'path';

const readProjectFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('Git Android security and UI contracts', () => {
  it('validates remote and branch operands before native Git execution', () => {
    const source = readProjectFile(
      'android/app/src/main/java/com/mobileide/app/modules/GitNativeModule.kt',
    );

    expect(source).toContain('GitPolicy.requireRemoteName(remote)');
    expect(source).toContain('GitPolicy.requireBranch(');
    expect(source).toContain('"push", "--porcelain", "--set-upstream", "--"');
    expect(source).toContain('listOf("pull", "--ff-only", "--", safeRemote, safeBranch)');
    expect(source).toContain('listOf("fetch", "--prune", "--", safeRemote)');
  });

  it('redacts configured remote credentials before crossing the bridge', () => {
    const source = readProjectFile(
      'android/app/src/main/java/com/mobileide/app/modules/GitNativeModule.kt',
    );
    const policy = readProjectFile(
      'android/app/src/main/java/com/mobileide/app/git/GitPolicy.kt',
    );

    expect(source).toContain('GitPolicy.redactRemoteUrl(');
    expect(policy).toContain('fun redactRemoteUrl(remoteUrl: String)');
  });

  it('clears PAT state whenever authentication closes or completes', () => {
    const panel = readProjectFile('src/components/git/GitPanel.tsx');
    const store = readProjectFile('src/stores/gitStore.ts');
    const nativeBridge = readProjectFile('src/native/GitNativeModule.ts');

    expect(panel).toContain('const closeAuthModal = useCallback(() => {');
    expect(panel).toContain("setTokenInput('');");
    expect(panel).toContain('const stored = await setCredentials(');
    expect(store).toContain('const metadata = await GitNative.setCredentials(username, token);');
    expect(nativeBridge).toContain('return GitNativeModule.storeHttpsCredential(');
  });

  it('settles the Git tab when runtime is ready without a workspace', () => {
    const panel = readProjectFile('src/components/git/GitPanel.tsx');

    expect(panel).toContain('if (!isReady) return;');
    expect(panel).not.toContain('if (!isReady || !repoPath) return;');
    expect(panel).toContain('await checkRepo(repoPath);');
  });
});
