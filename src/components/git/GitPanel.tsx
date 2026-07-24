import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { useGitStore } from '../../stores/gitStore';
import { useFileStore } from '../../stores/fileStore';
import { useRuntimeStore } from '../../stores/runtimeStore';

type GitTab = 'changes' | 'commit' | 'branches' | 'remote';

export const GitPanel: React.FC = () => {
  const {
    isRepo,
    isInitialized,
    status,
    commits,
    branches,
    remotes,
    diff,
    branch,
    isLoading,
    error,
    successMessage,
    isAuthenticated,
    username,
    checkRepo,
    initRepo,
    cloneRepo,
    refreshStatus,
    stageAll,
    stageFile,
    unstageFile,
    commitChanges,
    pushChanges,
    pullChanges,
    loadLog,
    loadBranches,
    checkoutBranch,
    addRemote,
    setCredentials,
    clearError,
    clearSuccess,
  } = useGitStore();

  // JGit needs a real filesystem path. Prefer the resolved real path; fall back
  // to the virtual workspace path only if resolve failed.
  const currentWorkspace = useFileStore(state => state.currentWorkspace);
  const currentWorkspaceRealPath = useFileStore(state => state.currentWorkspaceRealPath);
  const { isReady } = useRuntimeStore();
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [commitMsg, setCommitMsg] = useState('');
  const [authorName, setAuthorName] = useState('Developer');
  const [authorEmail, setAuthorEmail] = useState('dev@adevstudio.local');
  const [cloneUrl, setCloneUrl] = useState('');
  const [showClone, setShowClone] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [remoteName, setRemoteName] = useState('origin');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [showAddRemote, setShowAddRemote] = useState(false);
  const hasChecked = useRef(false);

  const repoPath = currentWorkspaceRealPath || currentWorkspace || '';

  // Re-check whenever the workspace path changes (JGit needs the real FS path).
  useEffect(() => {
    if (!isReady || !repoPath) return;
    hasChecked.current = true;
    checkRepo(repoPath);
  }, [isReady, repoPath, checkRepo]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(clearError, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, clearError]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(clearSuccess, 4000);
      return () => clearTimeout(timer);
    }
  }, [successMessage, clearSuccess]);

  const handleRefresh = useCallback(() => {
    if (repoPath) {
      refreshStatus(repoPath);
      loadLog(repoPath);
      loadBranches(repoPath);
    }
  }, [repoPath, refreshStatus, loadLog, loadBranches]);

  const handleCommit = () => {
    if (!commitMsg.trim()) {
      Alert.alert('Error', 'Please enter a commit message');
      return;
    }
    commitChanges(repoPath, commitMsg.trim(), authorName, authorEmail);
    setCommitMsg('');
  };

  const handleClone = () => {
    if (!cloneUrl.trim()) {
      Alert.alert('Error', 'Please enter a repository URL');
      return;
    }
    const repoName = cloneUrl.split('/').pop()?.replace('.git', '') || 'cloned-repo';
    // Put cloned repo in the same parent directory as current workspace
    const parentDir = repoPath.substring(0, repoPath.lastIndexOf('/'));
    const destPath = `${parentDir}/${repoName}`;
    cloneRepo(cloneUrl.trim(), destPath);
    setShowClone(false);
    setCloneUrl('');
  };

  const handleAuth = () => {
    if (!tokenInput.trim()) {
      Alert.alert('Error', 'Please enter a GitHub token');
      return;
    }
    setCredentials(usernameInput.trim() || 'token', tokenInput.trim());
    setShowAuth(false);
    setTokenInput('');
    setUsernameInput('');
  };

  const handleCreateBranch = () => {
    if (!newBranch.trim()) return;
    checkoutBranch(repoPath, newBranch.trim(), true);
    setNewBranch('');
  };

  const handleAddRemote = () => {
    if (!remoteUrl.trim()) return;
    addRemote(repoPath, remoteName, remoteUrl.trim());
    setShowAddRemote(false);
    setRemoteUrl('');
  };

  // Not initialized yet
  if (!isInitialized) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#8b5cf6" />
        <Text style={styles.loadingText}>Checking repository...</Text>
      </View>
    );
  }

  // No repo - show init/clone options
  if (!isRepo) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Source Control</Text>
        </View>
        <View style={styles.center}>
          <Text style={styles.noRepoText}>No Git Repository</Text>
          <Text style={styles.noRepoSub}>Initialize a new repo or clone an existing one</Text>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => initRepo(repoPath)}>
            <Text style={styles.primaryBtnText}>Initialize Repository</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShowClone(true)}>
            <Text style={styles.secondaryBtnText}>Clone Repository</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.linkBtn} onPress={() => setShowAuth(true)}>
            <Text style={styles.linkBtnText}>
              {isAuthenticated ? `GitHub: ${username}` : 'Connect GitHub Account'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Clone Modal */}
        <Modal visible={showClone} transparent animationType="slide" onRequestClose={() => setShowClone(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Clone Repository</Text>
              <TextInput
                style={styles.input}
                placeholder="https://github.com/user/repo.git"
                placeholderTextColor="#666"
                value={cloneUrl}
                onChangeText={setCloneUrl}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowClone(false)}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalConfirmBtn} onPress={handleClone}>
                  <Text style={styles.primaryBtnText}>Clone</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Auth Modal */}
        <AuthModal
          visible={showAuth}
          onClose={() => setShowAuth(false)}
          onConfirm={handleAuth}
          username={usernameInput}
          setUsername={setUsernameInput}
          token={tokenInput}
          setToken={setTokenInput}
        />

        {renderMessages()}
      </View>
    );
  }

  // Main git UI with tabs
  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>Git</Text>
          <View style={styles.branchBadge}>
            <Text style={styles.branchText}>{branch}</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={handleRefresh}>
            <Text style={styles.iconBtnText}>⟳</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowAuth(true)}>
            <Text style={styles.iconBtnText}>{isAuthenticated ? '👤' : '🔑'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        {(['changes', 'commit', 'branches', 'remote'] as GitTab[]).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'changes' ? `Changes${status && !status.isClean ? ' •' : ''}` : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
        {activeTab === 'changes' && renderChanges()}
        {activeTab === 'commit' && renderCommitTab()}
        {activeTab === 'branches' && renderBranches()}
        {activeTab === 'remote' && renderRemote()}
      </ScrollView>

      {/* Quick actions bar */}
      <View style={styles.actionBar}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.stageBtn]}
          onPress={() => stageAll(repoPath)}
          disabled={isLoading}
        >
          <Text style={styles.actionBtnText}>Stage All</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.pushBtn]}
          onPress={() => pushChanges(repoPath)}
          disabled={isLoading}
        >
          <Text style={styles.actionBtnText}>↑ Push</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.pullBtn]}
          onPress={() => pullChanges(repoPath)}
          disabled={isLoading}
        >
          <Text style={styles.actionBtnText}>↓ Pull</Text>
        </TouchableOpacity>
      </View>

      {/* Auth Modal */}
      <AuthModal
        visible={showAuth}
        onClose={() => setShowAuth(false)}
        onConfirm={handleAuth}
        username={usernameInput}
        setUsername={setUsernameInput}
        token={tokenInput}
        setToken={setTokenInput}
      />

      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#8b5cf6" />
        </View>
      )}

      {renderMessages()}
    </View>
  );

  function renderMessages() {
    return (
      <>
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText} numberOfLines={2}>{error}</Text>
            <TouchableOpacity onPress={clearError}>
              <Text style={styles.dismissText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}
        {successMessage && (
          <View style={styles.successBanner}>
            <Text style={styles.successText} numberOfLines={2}>{successMessage}</Text>
          </View>
        )}
      </>
    );
  }

  function renderChanges() {
    if (!status) {
      return <Text style={styles.emptyText}>Loading status...</Text>;
    }
    if (status.isClean && diff.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>✓</Text>
          <Text style={styles.emptyText}>Working tree clean</Text>
          <Text style={styles.emptySub}>No changes to commit</Text>
        </View>
      );
    }

    const allFiles = diff.length > 0 ? diff : [];

    return (
      <View>
        {allFiles.map((file, idx) => (
          <View key={idx} style={styles.fileRow}>
            <View style={styles.fileInfo}>
              <Text style={styles.fileName} numberOfLines={1}>{file.path}</Text>
              <Text style={[styles.fileStatus, getStatusColor(file.status)]}>{file.status}</Text>
            </View>
            <TouchableOpacity
              style={styles.stageBtn2}
              onPress={() => stageFile(repoPath, file.path)}
            >
              <Text style={styles.stageBtn2Text}>+</Text>
            </TouchableOpacity>
          </View>
        ))}

        {/* Staged files */}
        {status.added.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Staged ({status.added.length})</Text>
            {status.added.map((file, idx) => (
              <View key={idx} style={styles.fileRow}>
                <Text style={styles.fileName} numberOfLines={1}>{file}</Text>
                <TouchableOpacity onPress={() => unstageFile(repoPath, file)}>
                  <Text style={styles.unstageText}>−</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  }

  function renderCommitTab() {
    return (
      <View>
        {/* Commit form */}
        <View style={styles.commitForm}>
          <TextInput
            style={[styles.input, styles.commitInput]}
            placeholder="Commit message..."
            placeholderTextColor="#666"
            value={commitMsg}
            onChangeText={setCommitMsg}
            multiline
            numberOfLines={3}
          />
          <View style={styles.authorRow}>
            <TextInput
              style={[styles.input, styles.halfInput]}
              placeholder="Name"
              placeholderTextColor="#666"
              value={authorName}
              onChangeText={setAuthorName}
            />
            <TextInput
              style={[styles.input, styles.halfInput]}
              placeholder="Email"
              placeholderTextColor="#666"
              value={authorEmail}
              onChangeText={setAuthorEmail}
              autoCapitalize="none"
            />
          </View>
          <TouchableOpacity style={styles.commitBtn} onPress={handleCommit} disabled={isLoading}>
            <Text style={styles.commitBtnText}>Commit</Text>
          </TouchableOpacity>
        </View>

        {/* Recent commits */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Commits</Text>
          {commits.length === 0 ? (
            <Text style={styles.emptySub}>No commits yet</Text>
          ) : (
            commits.slice(0, 15).map((commit, idx) => (
              <View key={idx} style={styles.commitRow}>
                <Text style={styles.commitHash}>{commit.shortId}</Text>
                <View style={styles.commitInfo}>
                  <Text style={styles.commitMessage} numberOfLines={1}>{commit.message}</Text>
                  <Text style={styles.commitMeta}>
                    {commit.author || ''}{commit.time ? ` • ${formatTime(commit.time)}` : ''}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>
      </View>
    );
  }

  function renderBranches() {
    return (
      <View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Branches</Text>
          {branches.map((b, idx) => (
            <TouchableOpacity
              key={idx}
              style={[styles.branchRow, b.isCurrent && styles.branchRowActive]}
              onPress={() => !b.isCurrent && checkoutBranch(repoPath, b.name)}
            >
              <Text style={[styles.branchName, b.isCurrent && styles.branchNameActive]}>
                {b.isCurrent ? '● ' : '○ '}{b.name}
              </Text>
              {b.isCurrent && <Text style={styles.currentBadge}>current</Text>}
            </TouchableOpacity>
          ))}
        </View>

        {/* Create branch */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>New Branch</Text>
          <View style={styles.rowInput}>
            <TextInput
              style={[styles.input, styles.flexInput]}
              placeholder="branch-name"
              placeholderTextColor="#666"
              value={newBranch}
              onChangeText={setNewBranch}
              autoCapitalize="none"
            />
            <TouchableOpacity style={styles.smallBtn} onPress={handleCreateBranch}>
              <Text style={styles.smallBtnText}>Create</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  function renderRemote() {
    return (
      <View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Remotes</Text>
          {remotes.length === 0 ? (
            <Text style={styles.emptySub}>No remotes configured</Text>
          ) : (
            remotes.map((r, idx) => (
              <View key={idx} style={styles.remoteRow}>
                <Text style={styles.remoteName}>{r.name}</Text>
                <Text style={styles.remoteUrl} numberOfLines={1}>{r.url}</Text>
              </View>
            ))
          )}
          <TouchableOpacity style={styles.linkBtn} onPress={() => setShowAddRemote(true)}>
            <Text style={styles.linkBtnText}>+ Add Remote</Text>
          </TouchableOpacity>
        </View>

        {/* GitHub auth section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>GitHub</Text>
          {isAuthenticated ? (
            <View style={styles.authStatus}>
              <Text style={styles.authText}>Connected as: {username}</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setShowAuth(true)}>
              <Text style={styles.secondaryBtnText}>Connect GitHub (Token)</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Add Remote Modal */}
        <Modal visible={showAddRemote} transparent animationType="slide" onRequestClose={() => setShowAddRemote(false)}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Add Remote</Text>
              <TextInput
                style={styles.input}
                placeholder="origin"
                placeholderTextColor="#666"
                value={remoteName}
                onChangeText={setRemoteName}
              />
              <TextInput
                style={styles.input}
                placeholder="https://github.com/user/repo.git"
                placeholderTextColor="#666"
                value={remoteUrl}
                onChangeText={setRemoteUrl}
                autoCapitalize="none"
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowAddRemote(false)}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.modalConfirmBtn} onPress={handleAddRemote}>
                  <Text style={styles.primaryBtnText}>Add</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }
};

// Auth Modal Component
const AuthModal: React.FC<{
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  username: string;
  setUsername: (v: string) => void;
  token: string;
  setToken: (v: string) => void;
}> = ({ visible, onClose, onConfirm, username, setUsername, token, setToken }) => (
  <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.modalOverlay}>
      <View style={styles.modalContent}>
        <View style={styles.modalHeaderRow}>
          <Text style={styles.modalTitle}>GitHub Authentication</Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.modalCloseX}>✕</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.modalSub}>
          Use a Personal Access Token (PAT) with repo scope.{'\n'}
          GitHub → Settings → Developer → Tokens
        </Text>
        <TextInput
          style={styles.input}
          placeholder="GitHub username"
          placeholderTextColor="#666"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="ghp_xxxxxxxxxxxx (token)"
          placeholderTextColor="#666"
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          secureTextEntry
        />
        <View style={styles.modalActions}>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalConfirmBtn} onPress={onConfirm}>
            <Text style={styles.primaryBtnText}>Connect</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  </Modal>
);

function getStatusColor(status: string) {
  switch (status) {
    case 'modified': return { color: '#e2b93d' };
    case 'added': return { color: '#73c991' };
    case 'untracked': return { color: '#73c991' };
    case 'removed': return { color: '#f14c4c' };
    default: return { color: '#ccc' };
  }
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1e1e1e' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#333',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: '#e4e4e7' },
  headerActions: { flexDirection: 'row', gap: 8 },
  branchBadge: {
    backgroundColor: '#2d2d3d', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
  },
  branchText: { fontSize: 12, color: '#8b5cf6' },
  iconBtn: { padding: 6 },
  iconBtnText: { fontSize: 18, color: '#ccc' },

  tabBar: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#333' },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  tabActive: { borderBottomWidth: 2, borderBottomColor: '#8b5cf6' },
  tabText: { fontSize: 12, color: '#888' },
  tabTextActive: { color: '#e4e4e7', fontWeight: '600' },

  content: { flex: 1 },
  contentInner: { padding: 12 },

  actionBar: {
    flexDirection: 'row', padding: 8, gap: 8,
    borderTopWidth: 1, borderTopColor: '#333', backgroundColor: '#252526',
  },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 6, alignItems: 'center' },
  stageBtn: { backgroundColor: '#2d4a2d' },
  pushBtn: { backgroundColor: '#2d3a5a' },
  pullBtn: { backgroundColor: '#3a2d5a' },
  actionBtnText: { color: '#e4e4e7', fontSize: 13, fontWeight: '600' },

  fileRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#2a2a2a',
  },
  fileInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fileName: { flex: 1, fontSize: 13, color: '#e4e4e7' },
  fileStatus: { fontSize: 11, fontWeight: '600' },
  stageBtn2: {
    width: 28, height: 28, borderRadius: 14, backgroundColor: '#2d4a2d',
    alignItems: 'center', justifyContent: 'center',
  },
  stageBtn2Text: { color: '#73c991', fontSize: 16, fontWeight: '700' },
  unstageText: { color: '#f14c4c', fontSize: 18, fontWeight: '700', paddingHorizontal: 8 },

  section: { marginTop: 16 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', marginBottom: 8, textTransform: 'uppercase' },

  commitForm: { gap: 8 },
  commitInput: { height: 70, textAlignVertical: 'top' },
  authorRow: { flexDirection: 'row', gap: 8 },
  commitBtn: { backgroundColor: '#8b5cf6', paddingVertical: 12, borderRadius: 6, alignItems: 'center' },
  commitBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  commitRow: { flexDirection: 'row', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#2a2a2a', gap: 10 },
  commitHash: { fontSize: 12, color: '#8b5cf6', fontFamily: 'monospace' },
  commitInfo: { flex: 1 },
  commitMessage: { fontSize: 13, color: '#e4e4e7' },
  commitMeta: { fontSize: 11, color: '#666', marginTop: 2 },

  branchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#2a2a2a',
  },
  branchRowActive: { backgroundColor: '#2d2d3d' },
  branchName: { fontSize: 14, color: '#e4e4e7' },
  branchNameActive: { color: '#8b5cf6', fontWeight: '600' },
  currentBadge: { fontSize: 10, color: '#8b5cf6', backgroundColor: '#2d2d3d', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8 },

  remoteRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#2a2a2a' },
  remoteName: { fontSize: 14, color: '#e4e4e7', fontWeight: '600' },
  remoteUrl: { fontSize: 12, color: '#888', marginTop: 2 },

  authStatus: { padding: 12, backgroundColor: '#2d4a2d', borderRadius: 6 },
  authText: { color: '#73c991', fontSize: 13 },

  input: {
    backgroundColor: '#2d2d2d', borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10,
    color: '#e4e4e7', fontSize: 14, borderWidth: 1, borderColor: '#444',
  },
  halfInput: { flex: 1 },
  flexInput: { flex: 1 },
  rowInput: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  smallBtn: { backgroundColor: '#8b5cf6', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 6 },
  smallBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  primaryBtn: {
    backgroundColor: '#8b5cf6', paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 8, alignItems: 'center', marginTop: 12, width: '100%',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: '#2d2d3d', paddingHorizontal: 20, paddingVertical: 12,
    borderRadius: 8, alignItems: 'center', marginTop: 12, width: '100%',
    borderWidth: 1, borderColor: '#8b5cf6',
  },
  secondaryBtnText: { color: '#8b5cf6', fontSize: 15, fontWeight: '600' },
  linkBtn: { marginTop: 16, padding: 8 },
  linkBtnText: { color: '#8b5cf6', fontSize: 14 },

  noRepoText: { fontSize: 20, fontWeight: '700', color: '#e4e4e7', marginBottom: 8 },
  noRepoSub: { fontSize: 14, color: '#888', textAlign: 'center', marginBottom: 20 },

  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyIcon: { fontSize: 36, color: '#73c991', marginBottom: 8 },
  emptyText: { fontSize: 14, color: '#888', textAlign: 'center' },
  emptySub: { fontSize: 12, color: '#666', marginTop: 4 },

  loadingText: { color: '#888', marginTop: 12, fontSize: 14 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },

  errorBanner: {
    position: 'absolute', bottom: 60, left: 12, right: 12,
    backgroundColor: '#4d2020', borderRadius: 8, padding: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  errorText: { color: '#f14c4c', fontSize: 12, flex: 1 },
  dismissText: { color: '#f14c4c', fontSize: 16, paddingHorizontal: 8 },
  successBanner: {
    position: 'absolute', bottom: 60, left: 12, right: 12,
    backgroundColor: '#1d3d1d', borderRadius: 8, padding: 12,
  },
  successText: { color: '#73c991', fontSize: 12 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: {
    backgroundColor: '#252526', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    padding: 20, gap: 12,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#e4e4e7' },
  modalSub: { fontSize: 12, color: '#888', lineHeight: 18 },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalCloseX: { color: '#888', fontSize: 20, paddingHorizontal: 4 },
  modalConfirmBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center',
    backgroundColor: '#8b5cf6',
  },
  cancelBtn: {
    flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center',
    backgroundColor: '#333',
  },
  cancelBtnText: { color: '#ccc', fontSize: 14 },
});

export default GitPanel;
