import { create } from 'zustand';
import { GitNative, GitStatus, GitCommitInfo, GitBranch, GitRemote, GitDiffEntry } from '../native/GitNativeModule';

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
  loadLog: (repoPath: string) => Promise<void>;
  loadBranches: (repoPath: string) => Promise<void>;
  loadRemotes: (repoPath: string) => Promise<void>;
  checkoutBranch: (repoPath: string, branch: string, create?: boolean) => Promise<void>;
  addRemote: (repoPath: string, name: string, url: string) => Promise<void>;
  setCredentials: (username: string, token: string) => void;
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
      const isRepo = await GitNative.isGitRepo(repoPath);
      set({ isRepo, isInitialized: true });
      if (isRepo) {
        await get().refreshStatus(repoPath);
        await get().loadBranches(repoPath);
        await get().loadRemotes(repoPath);
      }
    } catch (e: any) {
      set({ isRepo: false, isInitialized: true, error: e.message });
    }
  },

  initRepo: async (repoPath: string) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.init(repoPath);
      set({ isRepo: true, isLoading: false, successMessage: 'Repository initialized' });
      await get().refreshStatus(repoPath);
    } catch (e: any) {
      set({ isLoading: false, error: e.message });
    }
  },

  cloneRepo: async (url: string, destPath: string) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.clone(url, destPath);
      set({ isRepo: true, isLoading: false, successMessage: 'Repository cloned successfully' });
      await get().refreshStatus(destPath);
      await get().loadBranches(destPath);
      await get().loadRemotes(destPath);
    } catch (e: any) {
      set({ isLoading: false, error: 'Clone failed: ' + e.message });
    }
  },

  refreshStatus: async (repoPath: string) => {
    try {
      const status = await GitNative.status(repoPath);
      const diff = await GitNative.diff(repoPath);
      set({ status, diff, branch: status.branch });
    } catch (e: any) {
      set({ error: e.message });
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
      const b = branch || get().branch;
      const msg = await GitNative.push(repoPath, remote, b);
      set({ isLoading: false, successMessage: msg || 'Pushed successfully' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Push failed: ' + e.message });
    }
  },

  pullChanges: async (repoPath: string, remote = 'origin', branch?: string) => {
    set({ isLoading: true, error: null });
    try {
      const b = branch || get().branch;
      const msg = await GitNative.pull(repoPath, remote, b);
      await get().refreshStatus(repoPath);
      set({ isLoading: false, successMessage: msg || 'Pulled successfully' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Pull failed: ' + e.message });
    }
  },

  fetchRemote: async (repoPath: string, remote = 'origin') => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.fetch(repoPath, remote);
      set({ isLoading: false, successMessage: 'Fetched from remote' });
    } catch (e: any) {
      set({ isLoading: false, error: 'Fetch failed: ' + e.message });
    }
  },

  loadLog: async (repoPath: string) => {
    try {
      const commits = await GitNative.log(repoPath, 30);
      set({ commits });
    } catch (e: any) {
      // Silently fail for log
    }
  },

  loadBranches: async (repoPath: string) => {
    try {
      const branches = await GitNative.branches(repoPath);
      set({ branches });
    } catch (e: any) {
      // Silently fail
    }
  },

  loadRemotes: async (repoPath: string) => {
    try {
      const remotes = await GitNative.remotes(repoPath);
      set({ remotes });
    } catch (e: any) {
      // Silently fail
    }
  },

  checkoutBranch: async (repoPath: string, branch: string, create = false) => {
    set({ isLoading: true, error: null });
    try {
      await GitNative.checkout(repoPath, branch, create);
      await get().refreshStatus(repoPath);
      await get().loadBranches(repoPath);
      set({ isLoading: false, branch, successMessage: `Switched to ${branch}` });
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

  setCredentials: (username: string, token: string) => {
    GitNative.setCredentials(username, token);
    set({ isAuthenticated: true, username });
  },

  clearError: () => set({ error: null }),
  clearSuccess: () => set({ successMessage: null }),
}));
