import { create } from 'zustand';
import {
  GitNative,
  GitStatus,
  GitCommitInfo,
  GitBranch,
  GitRemote,
  GitDiffEntry,
  GitPullRequestResult,
} from '../native/GitNativeModule';

interface GitState {
  // State
  isRepo: boolean;
  isInitialized: boolean;
  status: GitStatus | null;
  commits: GitCommitInfo[];
  branches: GitBranch[];
  remotes: GitRemote[];
  diff: GitDiffEntry[];
  branch: string;
  isLoading: boolean;
  error: string | null;
  successMessage: string | null;

  // Auth
  isAuthenticated: boolean;
  username: string;

  // Actions
  checkRepo: (repoPath: string) => Promise<void>;
  initRepo: (repoPath: string) => Promise<void>;
  cloneRepo: (url: string, destPath: string) => Promise<void>;
  refreshStatus: (repoPath: string) => Promise<void>;
  stageAll: (repoPath: string) => Promise<void>;
  stageFile: (repoPath: string, file: string) => Promise<void>;
  unstageFile: (repoPath: string, file: string) => Promise<void>;
  commitChanges: (repoPath: string, message: string, author: string, email: string) => Promise<void>;
  pushChanges: (repoPath: string, remote?: string, branch?: string) => Promise<void>;
  pullChanges: (repoPath: string, remote?: string, branch?: string) => Promise<void>;
  fetchRemote: (repoPath: string, remote?: string) => Promise<void>;
  createPullRequest: (
    repoPath: string,
    title: string,
    body: string,
    base?: string,
    head?: string,
    remote?: string,
  ) => Promise<GitPullRequestResult | null>;
  loadLog: (repoPath: string) => Promise<void>;
  loadBranches: (repoPath: string) => Promise<void>;
  loadRemotes: (repoPath: string) => Promise<void>;
  checkoutBranch: (
    repoPath: string,
    branch: string,
    create?: boolean,
    remote?: boolean,
  ) => Promise<void>;
  addRemote: (repoPath: string, name: string, url: string) => Promise<void>;
  setCredentials: (username: string, token: string) => Promise<boolean>;
  clearError: () => void;
  clearSuccess: () => void;
}

export const useGitStore = create<GitState>((set, get) => ({
  isRepo: false,
  isInitialized: false,
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

  checkRepo: async (repoPath: string) => {
    try {
      const credentials = await GitNative.listCredentials();
      const httpsCredential = credentials.find(
        item =>
          item.kind === 'https' &&
          item.host.trim().replace(/\.$/, '').toLowerCase() === 'github.com',
      );
      set({
        isAuthenticated: !!httpsCredential,
        username: httpsCredential?.username || '',
      });
    } catch {
      // Credential metadata is advisory; repository operations still work.
    }
    if (!repoPath?.trim()) {
      set({ isRepo: false, isInitialized: true, status: null, error: null });
      return;
    }
    try {
      // isGitRepo now validates the repo is openable (not just .git folder exists)
      const isRepo = await GitNative.isGitRepo(repoPath);
      if (!isRepo) {
        set({
          isRepo: false,
          isInitialized: true,
          error: null,
          status: null,
          commits: [],
          branches: [],
          remotes: [],
          diff: [],
        });
        return;
      }
      set({ isRepo: true, isInitialized: true, error: null });
      // Load sequentially; each method is crash-safe on native side
      await get().refreshStatus(repoPath);
      await get().loadBranches(repoPath);
      await get().loadRemotes(repoPath);
      await get().loadLog(repoPath);
    } catch (e: any) {
      // Never leave the tab in a crashing state
      set({
        isRepo: false,
        isInitialized: true,
        error: e?.message || 'Failed to open repository',
        status: null,
        commits: [],
        branches: [],
        remotes: [],
        diff: [],
      });
    }
  },

  initRepo: async (repoPath: string) => {
    if (!repoPath?.trim()) {
      set({ error: 'No project folder open' });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      await GitNative.init(repoPath);
      // Optimistic UI first so the tab never hangs if status is slow
      set({
        isRepo: true,
        isLoading: false,
        successMessage: 'Repository ready (local). GitHub not required to start.',
        branch: 'main',
        status: {
          added: [],
          changed: [],
          removed: [],
          untracked: [],
          modified: [],
          missing: [],
          conflicting: [],
          isClean: true,
          branch: 'main',
        },
        commits: [],
        remotes: [],
        branches: [{ name: 'main', isCurrent: true }],
        diff: [],
      });
      try {
        await get().refreshStatus(repoPath);
        await get().loadBranches(repoPath);
        await get().loadRemotes(repoPath);
        await get().loadLog(repoPath);
      } catch {
        // Keep optimistic state — tab stays usable
      }
    } catch (e: any) {
      set({
        isLoading: false,
        isRepo: false,
        error: e?.message || 'git init failed',
      });
    }
  },

  cloneRepo: async (url: string, destPath: string) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.clone(url, destPath);
      // Cloning and opening are separate operations. Keep the currently open
      // repository state intact until FileStore confirms the new workspace.
      set({ isLoading: false, error: null });
    } catch (e: any) {
      set({
        isLoading: false,
        error: 'Clone failed: ' + (e?.message || 'unknown clone error'),
      });
      throw e;
    }
  },

  refreshStatus: async (repoPath: string) => {
    if (!repoPath?.trim()) return;
    try {
      const status = await GitNative.status(repoPath);
      let diff: GitDiffEntry[] = [];
      try {
        diff = await GitNative.diff(repoPath);
      } catch {
        diff = [];
      }
      set({
        status: {
          ...status,
          added: status.added || [],
          changed: status.changed || [],
          removed: status.removed || [],
          untracked: status.untracked || [],
          modified: status.modified || [],
          missing: status.missing || [],
          conflicting: status.conflicting || [],
          branch: status.branch || 'main',
        },
        diff: diff || [],
        branch: status.branch || 'main',
        error: null,
      });
    } catch (e: any) {
      // Keep UI usable after local init even if status hiccups
      set({
        status: {
          added: [],
          changed: [],
          removed: [],
          untracked: [],
          modified: [],
          missing: [],
          conflicting: [],
          isClean: true,
          branch: get().branch || 'main',
        },
        diff: [],
        error: e?.message || null,
      });
    }
  },

  stageAll: async (repoPath: string) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.addAll(repoPath);
      await get().refreshStatus(repoPath);
      set({ isLoading: false, successMessage: 'All changes staged' });
    } catch (e: any) {
      set({ isLoading: false, error: e.message });
    }
  },

  stageFile: async (repoPath: string, file: string) => {
    try {
      await GitNative.add(repoPath, [file]);
      await get().refreshStatus(repoPath);
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  unstageFile: async (repoPath: string, file: string) => {
    try {
      await GitNative.reset(repoPath, [file]);
      await get().refreshStatus(repoPath);
    } catch (e: any) {
      set({ error: e.message });
    }
  },

  commitChanges: async (repoPath: string, message: string, author: string, email: string) => {
    set({ isLoading: true, error: null });
    try {
      const result = await GitNative.commit(repoPath, message, author, email);
      await get().refreshStatus(repoPath);
      await get().loadLog(repoPath);
      set({ isLoading: false, successMessage: `Committed: ${result.shortId} - ${message}` });
    } catch (e: any) {
      set({ isLoading: false, error: 'Commit failed: ' + e.message });
    }
  },

  pushChanges: async (repoPath: string, remote = 'origin', branch?: string) => {
    set({ isLoading: true, error: null });
    try {
      if ((get().remotes || []).length === 0) {
        set({
          isLoading: false,
          error: 'No remote yet. Open Remote tab → Add Remote (GitHub token optional).',
        });
        return;
      }
      const b = branch || get().branch || 'main';
      const msg = await GitNative.push(repoPath, remote, b);
      set({ isLoading: false, successMessage: msg || 'Pushed successfully' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Push failed: ' + (e?.message || 'unknown') });
    }
  },

  pullChanges: async (repoPath: string, remote = 'origin', branch?: string) => {
    set({ isLoading: true, error: null });
    try {
      if ((get().remotes || []).length === 0) {
        set({
          isLoading: false,
          error: 'No remote yet. Open Remote tab → Add Remote first.',
        });
        return;
      }
      const b = branch || get().branch || 'main';
      const msg = await GitNative.pull(repoPath, remote, b);
      await get().refreshStatus(repoPath);
      set({ isLoading: false, successMessage: msg || 'Pulled successfully' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Pull failed: ' + (e?.message || 'unknown') });
    }
  },

  fetchRemote: async (repoPath: string, remote = 'origin') => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.fetch(repoPath, remote);
      await get().loadBranches(repoPath);
      await get().loadRemotes(repoPath);
      await get().refreshStatus(repoPath);
      set({ isLoading: false, successMessage: 'Fetched from remote' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Fetch failed: ' + e.message });
    }
  },

  loadLog: async (repoPath: string) => {
    try {
      const commits = await GitNative.log(repoPath, 30);
      set({ commits: Array.isArray(commits) ? commits : [] });
    } catch {
      set({ commits: [] });
    }
  },

  loadBranches: async (repoPath: string) => {
    try {
      const branches = await GitNative.branches(repoPath);
      set({
        branches: Array.isArray(branches) && branches.length
          ? branches
          : [{ name: get().branch || 'main', isCurrent: true }],
      });
    } catch {
      set({ branches: [{ name: get().branch || 'main', isCurrent: true }] });
    }
  },

  loadRemotes: async (repoPath: string) => {
    try {
      const remotes = await GitNative.remotes(repoPath);
      set({ remotes: Array.isArray(remotes) ? remotes : [] });
    } catch {
      set({ remotes: [] });
    }
  },

  checkoutBranch: async (
    repoPath: string,
    branch: string,
    shouldCreate = false,
    remote = false,
  ) => {
    set({ isLoading: true, error: null });
    try {
      const checkedOutBranch = await GitNative.checkout(
        repoPath,
        branch,
        shouldCreate,
        remote,
      );
      await get().refreshStatus(repoPath);
      await get().loadBranches(repoPath);
      set({
        isLoading: false,
        branch: checkedOutBranch,
        successMessage: `Switched to ${checkedOutBranch}`,
      });
    } catch (e: any) {
      set({ isLoading: false, error: e.message });
    }
  },

  addRemote: async (repoPath: string, name: string, url: string) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.addRemote(repoPath, name, url);
      await get().loadRemotes(repoPath);
      set({ isLoading: false, successMessage: `Remote '${name}' added` });
    } catch (e: any) {
      set({ isLoading: false, error: e.message });
    }
  },

  setCredentials: async (username: string, token: string) => {
    try {
      // No API exists to read the stored token back into React Native. Await
      // this write so a Keystore failure can never produce a false Connected UI.
      const metadata = await GitNative.setCredentials(username, token);
      set({
        isAuthenticated: true,
        username: metadata.username || username,
        error: null,
      });
      return true;
    } catch (e: any) {
      set({
        error: 'Could not store GitHub credential: ' +
          (e?.message || 'Android Keystore is unavailable'),
      });
      return false;
    }
  },

  createPullRequest: async (
    repoPath: string,
    title: string,
    body: string,
    base = 'main',
    head?: string,
    remote = 'origin',
  ) => {
    set({ isLoading: true, error: null });
    try {
      if ((get().remotes || []).length === 0) {
        set({
          isLoading: false,
          error: 'Add a GitHub remote before creating a pull request.',
        });
        return null;
      }
      const result = await GitNative.createPullRequest(
        repoPath,
        remote,
        base,
        head || get().branch || 'main',
        title,
        body,
      );
      set({
        isLoading: false,
        successMessage: `Pull request #${result.number} created`,
      });
      return result;
    } catch (e: any) {
      set({
        isLoading: false,
        error: 'Pull request failed: ' + (e?.message || 'unknown error'),
      });
      return null;
    }
  },

  clearError: () => set({ error: null }),
  clearSuccess: () => set({ successMessage: null }),
}));
