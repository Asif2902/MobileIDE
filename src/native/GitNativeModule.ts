import { NativeModules } from 'react-native';

const { GitNativeModule } = NativeModules;

export interface GitStatus {
  added: string[];
  changed: string[];
  removed: string[];
  untracked: string[];
  modified: string[];
  missing: string[];
  conflicting: string[];
  isClean: boolean;
  branch: string;
}

export interface GitCommitInfo {
  id: string;
  shortId: string;
  message: string;
  author?: string;
  email?: string;
  time?: number;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface GitDiffEntry {
  path: string;
  status: 'modified' | 'added' | 'untracked' | 'removed';
}

export const GitNative = {
  // Auth
  setCredentials(username: string, token: string): void {
    GitNativeModule.setCredentials(username, token);
  },
  clearCredentials(): void {
    GitNativeModule.clearCredentials();
  },
  hasCredentials(): Promise<boolean> {
    return GitNativeModule.hasCredentials();
  },

  // Repo operations
  init(repoPath: string): Promise<boolean> {
    return GitNativeModule.gitInit(repoPath);
  },
  clone(url: string, destPath: string): Promise<boolean> {
    return GitNativeModule.gitClone(url, destPath);
  },
  isGitRepo(repoPath: string): Promise<boolean> {
    return GitNativeModule.isGitRepo(repoPath);
  },

  // Status
  status(repoPath: string): Promise<GitStatus> {
    return GitNativeModule.gitStatus(repoPath);
  },

  // Stage
  add(repoPath: string, files: string[]): Promise<boolean> {
    return GitNativeModule.gitAdd(repoPath, files);
  },
  addAll(repoPath: string): Promise<boolean> {
    return GitNativeModule.gitAddAll(repoPath);
  },
  reset(repoPath: string, files: string[]): Promise<boolean> {
    return GitNativeModule.gitReset(repoPath, files);
  },

  // Commit
  commit(repoPath: string, message: string, authorName: string, authorEmail: string): Promise<GitCommitInfo> {
    return GitNativeModule.gitCommit(repoPath, message, authorName, authorEmail);
  },

  // Push / Pull
  push(repoPath: string, remote: string, branch: string): Promise<string> {
    return GitNativeModule.gitPush(repoPath, remote, branch);
  },
  pull(repoPath: string, remote: string, branch: string): Promise<string> {
    return GitNativeModule.gitPull(repoPath, remote, branch);
  },
  fetch(repoPath: string, remote: string): Promise<string> {
    return GitNativeModule.gitFetch(repoPath, remote);
  },

  // Log
  log(repoPath: string, maxCount: number = 20): Promise<GitCommitInfo[]> {
    return GitNativeModule.gitLog(repoPath, maxCount);
  },

  // Branches
  branches(repoPath: string): Promise<GitBranch[]> {
    return GitNativeModule.gitBranches(repoPath);
  },
  checkout(repoPath: string, branch: string, create: boolean = false): Promise<boolean> {
    return GitNativeModule.gitCheckout(repoPath, branch, create);
  },

  // Remotes
  remotes(repoPath: string): Promise<GitRemote[]> {
    return GitNativeModule.gitRemotes(repoPath);
  },
  addRemote(repoPath: string, name: string, url: string): Promise<boolean> {
    return GitNativeModule.gitAddRemote(repoPath, name, url);
  },
  setRemoteUrl(repoPath: string, name: string, url: string): Promise<boolean> {
    return GitNativeModule.gitSetRemoteUrl(repoPath, name, url);
  },

  // Diff
  diff(repoPath: string): Promise<GitDiffEntry[]> {
    return GitNativeModule.gitDiff(repoPath);
  },
};

export default GitNative;
