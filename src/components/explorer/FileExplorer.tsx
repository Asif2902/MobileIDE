import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, StyleSheet, Modal, TextInput, Alert, ActivityIndicator } from 'react-native';
import { useEditorStore, useFileStore, useRuntimeStore, useUIStore } from '../../stores';
import {
  FileSystemNativeModule,
  FileEntry,
  ProjectSource,
  StorageNativeModule,
  TransferOptions,
} from '../../native';
import { FileTreeItem } from './FileTreeItem';
import {Icon} from '../icons';
import {flattenVisibleTree} from './treeModel';
import {uiColors, uiFonts, uiRadii} from '../../theme';

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
};

export const FileExplorer: React.FC = () => {
  const { 
    currentWorkspace, 
    currentWorkspaceRealPath,
    currentWorkspaceAssessment,
    workspaces, 
    fileTree, 
    expandedFolders,
    loadWorkspaces, 
    openWorkspace,
    openFolderFromDevice,
    importFileFromDevice,
    externalRoots,
    createWorkspace,
    createFile,
    createFolder,
    importProject,
    exportProject,
    activeTransfer,
    transferError,
    cancelTransfer,
    clearTransfer,
  } = useFileStore();
  const { isReady } = useRuntimeStore();
  const openEditorFile = useEditorStore(state => state.openFile);
  const setActiveView = useUIStore(state => state.setActiveView);
  const hasAutoOpened = useRef(false);
  const [inputModal, setInputModal] = useState<{
    visible: boolean;
    type: 'file' | 'folder' | 'project';
    value: string;
  }>({ visible: false, type: 'file', value: '' });
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [folderPickerVisible, setFolderPickerVisible] = useState(false);
  const [browsePath, setBrowsePath] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<FileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferSetup, setTransferSetup] = useState<{
    visible: boolean;
    direction: 'import' | 'export';
    source?: ProjectSource;
    destinationTreeUri?: string;
    requestedName: string;
  }>({ visible: false, direction: 'import', requestedName: '' });
  const [transferOptions, setTransferOptions] = useState<TransferOptions>({
    mode: 'source',
    includeGit: false,
    includeHidden: false,
    includeSecrets: false,
    conflictPolicy: 'unique',
  });
  const [transferStarting, setTransferStarting] = useState(false);
  
  useEffect(() => {
    if (isReady) {
      loadWorkspaces().catch(e => setError('Failed to load workspaces: ' + e.message));
    }
  }, [isReady, loadWorkspaces]);

  // Auto-open first workspace
  useEffect(() => {
    if (workspaces.length > 0 && !currentWorkspace && !hasAutoOpened.current) {
      hasAutoOpened.current = true;
      openWorkspace(workspaces[0].path).catch(e => setError('Failed to open workspace: ' + e.message));
    }
  }, [workspaces, currentWorkspace, openWorkspace]);
  
  const visibleEntries = useMemo(
    () => flattenVisibleTree(
      currentWorkspace ? (fileTree.get(currentWorkspace) || []) : [],
      fileTree,
      expandedFolders,
    ),
    [currentWorkspace, expandedFolders, fileTree],
  );
  const workspaceName = currentWorkspace?.split('/').pop() || 'No Workspace';

  const handleNewFile = useCallback(() => {
    if (!currentWorkspace) {
      Alert.alert('No Workspace', 'Open a workspace first');
      return;
    }
    setInputModal({ visible: true, type: 'file', value: 'new-file.js' });
  }, [currentWorkspace]);

  const handleNewFolder = useCallback(() => {
    if (!currentWorkspace) {
      Alert.alert('No Workspace', 'Open a workspace first');
      return;
    }
    setInputModal({ visible: true, type: 'folder', value: 'new-folder' });
  }, [currentWorkspace]);

  const handleImportFile = useCallback(async () => {
    if (!currentWorkspace) {
      Alert.alert('No Workspace', 'Open a workspace before importing a file.');
      return;
    }
    try {
      const imported = await importFileFromDevice();
      if (imported) {
        Alert.alert('File imported', `${imported.name} was copied into ${workspaceName}.`);
      }
    } catch (importError) {
      Alert.alert('Could not import file', (importError as Error)?.message || String(importError));
    }
  }, [currentWorkspace, importFileFromDevice, workspaceName]);

  const handleInputConfirm = useCallback(async () => {
    const name = inputModal.value.trim();
    if (!name) return;
    try {
      if (inputModal.type === 'project') {
        await createWorkspace(name);
      } else if (currentWorkspace) {
        if (inputModal.type === 'file') {
          await createFile(currentWorkspace, name);
        } else {
          await createFolder(currentWorkspace, name);
        }
      } else {
        throw new Error('Open a workspace first.');
      }
      setInputModal({ visible: false, type: 'file', value: '' });
    } catch (createError) {
      Alert.alert(
        inputModal.type === 'project' ? 'Could not create project' : 'Could not create item',
        (createError as Error)?.message || String(createError),
      );
    }
  }, [inputModal, currentWorkspace, createFile, createFolder, createWorkspace]);

  const handleNewProject = useCallback(() => {
    setProjectPickerVisible(false);
    setInputModal({visible: true, type: 'project', value: 'my-app'});
  }, []);

  const handleOpenFolder = useCallback(async () => {
    const roots = await openFolderFromDevice();
    if (roots.length > 0) {
      setBrowsePath(null);
      setBrowseDirs([]);
      setFolderPickerVisible(true);
    } else {
      Alert.alert(
        'Storage Permission',
        'Grant "All files access" in Settings to open device folders, then tap Open again.'
      );
    }
  }, [openFolderFromDevice]);

  const handleShowProjects = useCallback(async () => {
    try {
      await loadWorkspaces();
      setProjectPickerVisible(true);
    } catch (e) {
      Alert.alert('Projects unavailable', (e as Error)?.message || String(e));
    }
  }, [loadWorkspaces]);

  const handleOpenEnv = useCallback(async () => {
    if (!currentWorkspace) {
      Alert.alert('No Project', 'Open a private project first.');
      return;
    }
    const envPath = `${currentWorkspace}/.env`;
    try {
      if (!(await FileSystemNativeModule.exists(envPath))) {
        await FileSystemNativeModule.touch(envPath);
        await useFileStore.getState().refreshDirectory(currentWorkspace);
      }
      await openEditorFile(envPath);
      setActiveView('editor');
    } catch (e) {
      Alert.alert('Could not open .env', (e as Error)?.message || String(e));
    }
  }, [currentWorkspace, openEditorFile, setActiveView]);

  const handleSwitchProject = useCallback(async (path: string) => {
    setProjectPickerVisible(false);
    try {
      const opened = await openWorkspace(path);
      if (!opened) {
        throw new Error(
          useFileStore.getState().error || 'The selected project could not be opened.',
        );
      }
    } catch (e) {
      setError('Failed to open project: ' + ((e as Error)?.message || String(e)));
    }
  }, [openWorkspace]);

  // Browse into a directory, listing only its subfolders so the user can drill
  // down and pick any folder on the device (not just the preset roots).
  const navigateTo = useCallback(async (path: string) => {
    setBrowseLoading(true);
    try {
      const entries = await FileSystemNativeModule.listDir(path);
      const dirs = entries
        .filter(e => e.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name));
      setBrowseDirs(dirs);
      setBrowsePath(path);
    } catch (e) {
      Alert.alert('Cannot open folder', (e as Error)?.message || String(e));
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const goUp = useCallback(() => {
    if (!browsePath) return;
    const isRoot = externalRoots.some(r => r.path === browsePath);
    const parent = browsePath.substring(0, browsePath.lastIndexOf('/'));
    if (isRoot || !parent) {
      setBrowsePath(null);
      setBrowseDirs([]);
    } else {
      navigateTo(parent);
    }
  }, [browsePath, externalRoots, navigateTo]);

  const queueImport = useCallback((source: ProjectSource) => {
    const fallbackName = source.displayName || source.value.split('/').filter(Boolean).pop() || 'imported-project';
    setTransferOptions({
      mode: 'source',
      includeGit: false,
      includeHidden: false,
      includeSecrets: false,
      conflictPolicy: 'unique',
    });
    setTransferSetup({
      visible: true,
      direction: 'import',
      source,
      requestedName: fallbackName,
    });
  }, []);

  const openInPlace = useCallback(async (path: string) => {
    setFolderPickerVisible(false);
    const opened = await openWorkspace(path);
    if (!opened) {
      setError(useFileStore.getState().error || 'Failed to open the external folder.');
    }
  }, [openWorkspace]);

  const openHere = useCallback(async () => {
    if (!browsePath) return;
    try {
      const assessment = await StorageNativeModule.assessWorkspace(browsePath);
      if (!assessment.requiresPrivateImport) {
        await openInPlace(browsePath);
        return;
      }
      Alert.alert(
        'Choose how to open this project',
        'Android shared storage is suitable for viewing and simple editing, but npm, package managers, builds, native tools, and some Git operations need ADEV private storage.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Open in place',
            onPress: () => { openInPlace(browsePath).catch(() => undefined); },
          },
          {
            text: 'Import to ADEV',
            onPress: () => {
              setFolderPickerVisible(false);
              queueImport({ kind: 'rawPath', value: browsePath });
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('Cannot assess folder', (e as Error)?.message || String(e));
    }
  }, [browsePath, openInPlace, queueImport]);

  const chooseProjectWithAndroid = useCallback(async () => {
    try {
      const selection = await StorageNativeModule.pickProjectTree();
      if (!selection) return;
      setFolderPickerVisible(false);
      queueImport(selection);
    } catch (e) {
      Alert.alert('Cannot select folder', (e as Error)?.message || String(e));
    }
  }, [queueImport]);

  const queueCurrentWorkspaceImport = useCallback(() => {
    if (!currentWorkspaceRealPath) return;
    queueImport({
      kind: 'rawPath',
      value: currentWorkspaceRealPath,
      displayName: workspaceName,
    });
  }, [currentWorkspaceRealPath, queueImport, workspaceName]);

  const queueExport = useCallback(async () => {
    if (!currentWorkspaceAssessment?.privateWorkspace) {
      Alert.alert('Private project required', 'Import this project into the ADEV workspace before exporting it.');
      return;
    }
    try {
      const selection = await StorageNativeModule.pickExportTree();
      if (!selection) return;
      setTransferOptions({
        mode: 'source',
        includeGit: false,
        includeHidden: false,
        includeSecrets: false,
        conflictPolicy: 'unique',
      });
      setTransferSetup({
        visible: true,
        direction: 'export',
        destinationTreeUri: selection.value,
        requestedName: workspaceName,
      });
    } catch (e) {
      Alert.alert('Cannot choose export folder', (e as Error)?.message || String(e));
    }
  }, [currentWorkspaceAssessment, workspaceName]);

  const beginConfiguredTransfer = useCallback(async () => {
    const requestedName = transferSetup.requestedName.trim() || null;
    setTransferStarting(true);
    try {
      if (transferSetup.direction === 'import' && transferSetup.source) {
        await importProject(transferSetup.source, requestedName, transferOptions);
      } else if (transferSetup.direction === 'export' && transferSetup.destinationTreeUri) {
        await exportProject(transferSetup.destinationTreeUri, requestedName, transferOptions);
      } else {
        throw new Error('The selected transfer source or destination is unavailable.');
      }
      setTransferSetup(previous => ({ ...previous, visible: false }));
    } catch (e) {
      Alert.alert('Transfer could not start', (e as Error)?.message || String(e));
    } finally {
      setTransferStarting(false);
    }
  }, [exportProject, importProject, transferOptions, transferSetup]);

  const transferBusy = activeTransfer?.status === 'queued' || activeTransfer?.status === 'running';
  const transferPercent = activeTransfer && activeTransfer.totalBytes > 0
    ? Math.min(100, Math.round((activeTransfer.bytesCopied / activeTransfer.totalBytes) * 100))
    : 0;

  return (
    <View style={styles.container}>
      {/* Compact actions stay usable on narrow portrait screens. */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>WORKSPACE</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity accessibilityLabel="Private projects" style={styles.textButton} onPress={handleShowProjects}>
            <Icon name="files" size={15} color={uiColors.textSecondary} />
            <Text style={styles.textButtonLabel}>Projects</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityLabel="Open device folder" style={styles.textButton} onPress={handleOpenFolder}>
            <Icon name="folder-open" size={15} color={uiColors.textSecondary} />
            <Text style={styles.textButtonLabel}>Open</Text>
          </TouchableOpacity>
        </View>
      </View>
      
      {/* Workspace name */}
      <View style={styles.workspaceHeader}>
        <View style={styles.workspaceHeaderInfo}>
          <Text style={styles.workspaceName}>{workspaceName}</Text>
          <Text style={styles.workspacePath} numberOfLines={1} ellipsizeMode="middle">
            {currentWorkspace || 'No project selected'}
          </Text>
          <Text style={styles.dotfilesVisible}>Dotfiles visible in the file tree</Text>
        </View>
        <View style={styles.workspaceHeaderButtons}>
          {currentWorkspaceAssessment?.privateWorkspace && (
            <TouchableOpacity style={styles.envButton} onPress={queueExport}>
              <Text style={styles.envButtonText}>Export</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.envButton} onPress={handleOpenEnv}>
            <Text style={styles.envButtonText}>Open .env</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.workspaceActions}>
        <TouchableOpacity style={styles.actionButton} onPress={handleImportFile}>
          <Icon name="file" size={15} color={uiColors.accentText} />
          <Text style={styles.actionButtonText} numberOfLines={1}>Import file</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton} onPress={handleNewFile}>
          <Icon name="plus" size={14} color={uiColors.accentText} />
          <Text style={styles.actionButtonText} numberOfLines={1}>New file</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton} onPress={handleNewFolder}>
          <Icon name="folder" size={15} color={uiColors.accentText} />
          <Text style={styles.actionButtonText} numberOfLines={1}>New folder</Text>
        </TouchableOpacity>
      </View>
      
      {/* Error display */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {currentWorkspaceAssessment?.requiresPrivateImport && (
        <View style={styles.sharedStorageBanner}>
          <View style={styles.bannerCopy}>
            <Text style={styles.sharedStorageTitle}>Viewing shared-storage project</Text>
            <Text style={styles.sharedStorageText}>
              npm, pnpm, Yarn, Next/Vite builds, native compilation, and some Git operations require an ADEV private workspace.
            </Text>
          </View>
          <TouchableOpacity style={styles.importButton} onPress={queueCurrentWorkspaceImport}>
            <Text style={styles.importButtonText}>Import</Text>
          </TouchableOpacity>
        </View>
      )}

      {(activeTransfer || transferError) && (
        <View style={styles.transferBanner}>
          <View style={styles.bannerCopy}>
            <Text style={styles.transferTitle}>
              {activeTransfer
                ? `${activeTransfer.direction === 'import' ? 'Import' : 'Export'}: ${activeTransfer.phase}`
                : 'Project transfer'}
            </Text>
            {activeTransfer && (
              <Text style={styles.transferText}>
                {activeTransfer.filesCopied}/{activeTransfer.totalFiles || '?'} files · {formatBytes(activeTransfer.bytesCopied)} / {formatBytes(activeTransfer.totalBytes)}
                {activeTransfer.totalBytes > 0 ? ` · ${transferPercent}%` : ''}
                {activeTransfer.skippedEntries > 0 ? ` · ${activeTransfer.skippedEntries} skipped` : ''}
              </Text>
            )}
            {!!transferError && <Text style={styles.transferError}>{transferError}</Text>}
          </View>
          {transferBusy ? (
            <TouchableOpacity style={styles.transferAction} onPress={() => { cancelTransfer().catch(() => undefined); }}>
              <Text style={styles.transferActionText}>Cancel</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.transferAction} onPress={clearTransfer}>
              <Text style={styles.transferActionText}>Dismiss</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      
      {/* File tree */}
      {!isReady ? (
        <View style={[styles.treeContainer, styles.emptyState]}>
          <ActivityIndicator color={uiColors.accent} />
          <Text style={styles.emptyText}>Initializing workspace…</Text>
        </View>
      ) : currentWorkspace && visibleEntries.length > 0 ? (
        <FlatList
          style={styles.treeContainer}
          data={visibleEntries}
          keyExtractor={item => item.entry.path}
          renderItem={({item}) => <FileTreeItem entry={item.entry} depth={item.depth} />}
          initialNumToRender={32}
          maxToRenderPerBatch={40}
          windowSize={9}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <ScrollView style={styles.treeContainer} contentContainerStyle={styles.emptyState}>
          <Text style={styles.emptyText}>{currentWorkspace ? 'Empty folder' : 'No workspace open'}</Text>
          <Text style={styles.emptySubtext}>
            {currentWorkspace ? 'Create or import a file to get started.' : 'Choose a private project or open a device folder.'}
          </Text>
          {!currentWorkspace && workspaces.map(ws => (
            <TouchableOpacity
              key={ws.path}
              style={styles.workspaceItem}
              onPress={() => openWorkspace(ws.path)}>
              <Text style={styles.workspaceItemText}>{ws.name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* App-private project picker. Git clones are registered here automatically. */}
      <Modal
        visible={projectPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setProjectPickerVisible(false)}
      >
        <View style={styles.projectModalOverlay}>
          <TouchableOpacity
            style={styles.projectModalDismissArea}
            activeOpacity={1}
            onPress={() => setProjectPickerVisible(false)}
            accessibilityLabel="Close project picker"
          />
          <View style={styles.projectSheet}>
            <View style={styles.projectSheetHandle} />
            <View style={styles.projectSheetHeader}>
              <View style={styles.projectSheetIcon}>
                <Icon name="folder-open" size={19} color={uiColors.accentText} />
              </View>
              <View style={styles.projectSheetCopy}>
                <Text style={styles.projectSheetTitle}>Your projects</Text>
                <Text style={styles.projectSheetSubtitle}>
                  Private workspaces support Node, Git, Vite, and native builds.
                </Text>
              </View>
              <TouchableOpacity
                style={styles.projectCloseButton}
                onPress={() => setProjectPickerVisible(false)}
                accessibilityLabel="Close project picker">
                <Icon name="close" size={17} color={uiColors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.projectList}
              contentContainerStyle={styles.projectListContent}
              keyboardShouldPersistTaps="handled">
              {workspaces.length > 0 ? workspaces.map((workspace) => {
                const selected = workspace.path === currentWorkspace;
                return (
                  <TouchableOpacity
                    key={workspace.path}
                    style={[styles.projectRow, selected && styles.projectRowSelected]}
                    onPress={() => handleSwitchProject(workspace.path)}
                  >
                    <View style={styles.projectRowIcon}>
                      <Icon
                        name="folder"
                        size={18}
                        color={selected ? uiColors.accentText : uiColors.textSecondary}
                      />
                    </View>
                    <View style={styles.projectRowCopy}>
                      <Text style={styles.projectRowName}>{workspace.name}</Text>
                      <Text style={styles.projectRowPath} numberOfLines={1} ellipsizeMode="middle">
                        {workspace.path}
                      </Text>
                    </View>
                    {selected && (
                      <View style={styles.currentProjectBadge}>
                        <Text style={styles.currentProjectBadgeText}>Open</Text>
                      </View>
                    )}
                    <Icon name="chevron-right" size={16} color={uiColors.textMuted} />
                  </TouchableOpacity>
                );
              }) : (
                <View style={styles.projectEmptyState}>
                  <Icon name="folder" size={28} color={uiColors.textMuted} />
                  <Text style={styles.projectEmptyTitle}>No projects yet</Text>
                  <Text style={styles.projectEmptyCopy}>Create one here or clone a repository in Terminal.</Text>
                </View>
              )}
            </ScrollView>
            <View style={styles.projectSheetActions}>
              <TouchableOpacity
                style={styles.projectCreateButton}
                onPress={handleNewProject}
                accessibilityLabel="Create new private project">
                <Icon name="plus" size={17} color={uiColors.text} />
                <Text style={styles.projectCreateButtonText}>New project</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Input Modal for new file/folder */}
      <Modal
        visible={inputModal.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setInputModal({ visible: false, type: 'file', value: '' })}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>
              {inputModal.type === 'file'
                ? 'New file'
                : inputModal.type === 'folder'
                  ? 'New folder'
                  : 'New project'}
            </Text>
            {inputModal.type === 'project' && (
              <Text style={styles.modalDescription}>
                Creates a private ADEV workspace ready for Terminal, Node, Git, and builds.
              </Text>
            )}
            <TextInput
              style={styles.modalInput}
              value={inputModal.value}
              onChangeText={(text) => setInputModal(prev => ({ ...prev, value: text }))}
              placeholder={inputModal.type === 'file'
                ? 'filename.js'
                : inputModal.type === 'folder'
                  ? 'folder-name'
                  : 'my-app'}
              placeholderTextColor="#666666"
              autoFocus
              selectTextOnFocus
              onSubmitEditing={handleInputConfirm}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={() => setInputModal({ visible: false, type: 'file', value: '' })}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                onPress={() => { handleInputConfirm().catch(() => undefined); }}
              >
                <Text style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>
                  {inputModal.type === 'project' ? 'Create project' : 'Create'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Import/export choices. Source-only is safe by default; secrets opt in. */}
      <Modal
        visible={transferSetup.visible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!transferStarting) {
            setTransferSetup(previous => ({ ...previous, visible: false }));
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>
              {transferSetup.direction === 'import' ? 'Import to ADEV Workspace' : 'Export Project'}
            </Text>
            <Text style={styles.pickerHint}>
              {transferSetup.direction === 'import'
                ? 'The copied project becomes independent from the original folder. A new Terminal will open in the private workspace.'
                : 'Choose exactly what may leave ADEV private storage.'}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={transferSetup.requestedName}
              onChangeText={requestedName => setTransferSetup(previous => ({ ...previous, requestedName }))}
              placeholder="project-name"
              placeholderTextColor="#666666"
              editable={!transferStarting}
            />

            <Text style={styles.optionLabel}>Copy mode</Text>
            <View style={styles.segmentRow}>
              {(['source', 'full'] as const).map(mode => (
                <TouchableOpacity
                  key={mode}
                  style={[styles.segmentButton, transferOptions.mode === mode && styles.segmentButtonSelected]}
                  onPress={() => setTransferOptions(previous => ({ ...previous, mode }))}
                >
                  <Text style={styles.segmentText}>{mode === 'source' ? 'Source only' : 'Full project'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.optionHint}>
              {transferOptions.mode === 'source'
                ? 'Excludes generated directories such as node_modules, .next, dist, build, caches, coverage, and .gradle.'
                : 'Copies generated and heavy directories too. Large projects can take substantial time and space.'}
            </Text>

            {([
              ['includeGit', 'Include .git history'],
              ['includeHidden', 'Include other hidden files'],
              ['includeSecrets', 'Include .env and secret-like files'],
            ] as const).map(([key, label]) => (
              <TouchableOpacity
                key={key}
                style={styles.optionRow}
                onPress={() => setTransferOptions(previous => ({ ...previous, [key]: !previous[key] }))}
              >
                <Text style={styles.optionCheckbox}>{transferOptions[key] ? '☑' : '☐'}</Text>
                <Text style={styles.optionText}>{label}</Text>
              </TouchableOpacity>
            ))}

            <Text style={styles.optionLabel}>If the destination already exists</Text>
            <View style={styles.conflictRow}>
              {([
                ['unique', 'New name'],
                ['merge', 'Merge'],
                ['replace', 'Replace'],
                ['cancel', 'Stop'],
              ] as const).map(([policy, label]) => (
                <TouchableOpacity
                  key={policy}
                  style={[styles.conflictButton, transferOptions.conflictPolicy === policy && styles.segmentButtonSelected]}
                  onPress={() => setTransferOptions(previous => ({ ...previous, conflictPolicy: policy }))}
                >
                  <Text style={styles.conflictText}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {transferOptions.includeSecrets && (
              <Text style={styles.secretWarning}>
                Warning: this can copy tokens, private endpoints, or passwords stored in project files.
              </Text>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalButton}
                disabled={transferStarting}
                onPress={() => setTransferSetup(previous => ({ ...previous, visible: false }))}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonPrimary]}
                disabled={transferStarting}
                onPress={() => { beginConfiguredTransfer().catch(() => undefined); }}
              >
                {transferStarting ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
                  <Text style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>
                    {transferSetup.direction === 'import' ? 'Import' : 'Export'}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Device folder picker */}
      <Modal
        visible={folderPickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFolderPickerVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>
              {browsePath ? 'Choose Folder' : 'Open Device Folder'}
            </Text>

            {browsePath ? (
              <View style={styles.pathBar}>
                <TouchableOpacity style={styles.upBtn} onPress={goUp}>
                  <View style={styles.upButtonContent}>
                    <View style={styles.upIcon}>
                      <Icon name="chevron-right" size={15} color="#ffffff" />
                    </View>
                    <Text style={styles.upBtnText}>Up</Text>
                  </View>
                </TouchableOpacity>
                <Text style={styles.pathBarText} numberOfLines={1} ellipsizeMode="head">{browsePath}</Text>
              </View>
            ) : (
              <Text style={styles.pickerHint}>Pick a location, then drill down to any folder.</Text>
            )}

            <ScrollView style={styles.pickerList}>
              {browseLoading ? (
                <View style={styles.pickerLoading}>
                  <ActivityIndicator color="#8b5cf6" />
                </View>
              ) : browsePath === null ? (
                externalRoots.map((root) => (
                  <TouchableOpacity
                    key={root.path}
                    style={styles.workspaceItem}
                    onPress={() => navigateTo(root.path)}
                  >
                    <View style={styles.pickerItemContent}>
                      <Icon name="folder" size={18} color="#c4a7ff" />
                      <View style={styles.pickerItemCopy}>
                        <Text style={styles.workspaceItemText}>{root.name}</Text>
                        <Text style={styles.pickerPath}>{root.path}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                ))
              ) : browseDirs.length > 0 ? (
                browseDirs.map((dir) => (
                  <TouchableOpacity
                    key={dir.path}
                    style={styles.folderRow}
                    onPress={() => navigateTo(dir.path)}
                  >
                    <Icon name="folder" size={18} color="#c4a7ff" />
                    <Text style={styles.folderRowText} numberOfLines={1} ellipsizeMode="middle">{dir.name}</Text>
                    <Icon name="chevron-right" size={17} color="#888888" />
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.pickerHint}>No subfolders here. Tap "Open This Folder" to use it.</Text>
              )}
            </ScrollView>

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={chooseProjectWithAndroid}
              >
                <Text style={styles.modalButtonText}>Android picker</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalButton}
                onPress={() => setFolderPickerVisible(false)}
              >
                <Text style={styles.modalButtonText}>Cancel</Text>
              </TouchableOpacity>
              {browsePath && (
                <TouchableOpacity
                  style={[styles.modalButton, styles.modalButtonPrimary]}
                  onPress={openHere}
                >
                  <Text style={[styles.modalButtonText, styles.modalButtonTextPrimary]}>Open This Folder</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
  },
  headerTitle: {
    fontFamily: uiFonts.medium,
    fontSize: 10,
    fontWeight: '600',
    color: uiColors.textMuted,
    letterSpacing: 1.2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  textButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: uiColors.surfaceRaised,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: uiRadii.medium,
    borderWidth: 1,
    borderColor: uiColors.border,
  },
  textButtonLabel: {
    fontSize: 12,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    fontWeight: '600',
  },
  workspaceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 10,
    marginTop: 10,
    backgroundColor: uiColors.surface,
    borderWidth: 1,
    borderColor: uiColors.border,
    borderRadius: uiRadii.large,
  },
  workspaceHeaderInfo: {
    flex: 1,
  },
  workspaceHeaderButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  workspaceName: {
    fontSize: 13,
    fontWeight: '600',
    color: uiColors.text,
    fontFamily: uiFonts.medium,
  },
  workspacePath: {
    marginTop: 2,
    fontSize: 10,
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
  },
  dotfilesVisible: {
    marginTop: 3,
    fontSize: 10,
    color: uiColors.success,
    fontFamily: uiFonts.regular,
  },
  workspaceActions: {
    flexDirection: 'row',
    minHeight: 42,
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    minHeight: 30,
    paddingHorizontal: 6,
    borderRadius: uiRadii.small,
    backgroundColor: uiColors.surfaceRaised,
    borderWidth: 1,
    borderColor: uiColors.border,
  },
  actionButtonText: {
    flexShrink: 1,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    fontSize: 11,
    fontWeight: '600',
  },
  envButton: {
    backgroundColor: uiColors.surfaceRaised,
    borderRadius: uiRadii.small,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  envButtonText: {
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    fontSize: 11,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#4d1f1f',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  errorText: {
    fontSize: 11,
    color: '#f87171',
  },
  sharedStorageBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    backgroundColor: '#4a3517',
    borderBottomWidth: 1,
    borderBottomColor: '#7c5a22',
  },
  bannerCopy: {
    flex: 1,
  },
  sharedStorageTitle: {
    color: '#fbbf24',
    fontSize: 12,
    fontWeight: '700',
  },
  sharedStorageText: {
    color: '#f5d78e',
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
  },
  importButton: {
    backgroundColor: '#8b5cf6',
    borderRadius: 5,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  importButtonText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  transferBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#25344a',
    borderBottomWidth: 1,
    borderBottomColor: '#36557f',
  },
  transferTitle: {
    color: '#bfdbfe',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  transferText: {
    color: '#93c5fd',
    fontSize: 10,
    marginTop: 2,
  },
  transferError: {
    color: '#fca5a5',
    fontSize: 10,
    marginTop: 2,
  },
  transferAction: {
    borderWidth: 1,
    borderColor: '#60a5fa',
    borderRadius: 4,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  transferActionText: {
    color: '#dbeafe',
    fontSize: 10,
    fontWeight: '600',
  },
  treeContainer: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  emptyState: {
    paddingHorizontal: 24,
    paddingTop: 34,
    alignItems: 'center',
    gap: 6,
  },
  emptyText: {
    fontSize: 15,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    marginBottom: 6,
  },
  emptySubtext: {
    fontSize: 12,
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    marginBottom: 16,
    textAlign: 'center',
  },
  workspaceItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#2d2d2d',
    borderRadius: 6,
    marginBottom: 6,
    width: '100%',
    borderWidth: 1,
    borderColor: '#3f3f46',
  },
  workspaceItemText: {
    fontSize: 14,
    color: '#ffffff',
    fontFamily: uiFonts.medium,
    fontWeight: '500',
  },
  workspaceItemSelected: {
    borderColor: '#8b5cf6',
    backgroundColor: '#312e45',
  },
  pickerList: {
    maxHeight: 320,
    marginBottom: 12,
  },
  pickerPath: {
    fontSize: 11,
    color: '#888888',
    marginTop: 2,
  },
  pickerHint: {
    fontSize: 12,
    color: '#888888',
    paddingVertical: 12,
    textAlign: 'center',
  },
  pickerLoading: {
    paddingVertical: 30,
    alignItems: 'center',
  },
  pathBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  upBtn: {
    backgroundColor: '#3f3f46',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
  },
  upBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  upButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  upIcon: {
    transform: [{rotate: '-90deg'}],
  },
  pickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pickerItemCopy: {
    flex: 1,
  },
  pathBarText: {
    flex: 1,
    fontSize: 11,
    color: '#aaaaaa',
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
  },
  folderRowText: {
    flex: 1,
    fontSize: 14,
    color: '#ffffff',
    marginLeft: 9,
  },
  projectModalOverlay: {
    flex: 1,
    backgroundColor: uiColors.overlay,
    justifyContent: 'flex-end',
  },
  projectModalDismissArea: {
    flex: 1,
  },
  projectSheet: {
    maxHeight: '72%',
    backgroundColor: uiColors.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: uiColors.borderStrong,
    paddingHorizontal: 16,
    paddingBottom: 18,
  },
  projectSheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: uiColors.borderStrong,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  projectSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  projectSheetIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: uiColors.accentSoft,
  },
  projectSheetCopy: {
    flex: 1,
  },
  projectSheetTitle: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 17,
  },
  projectSheetSubtitle: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 2,
  },
  projectCloseButton: {
    width: 36,
    height: 36,
    borderRadius: uiRadii.medium,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: uiColors.surfaceRaised,
  },
  projectList: {
    flexGrow: 0,
  },
  projectListContent: {
    gap: 7,
    paddingBottom: 4,
  },
  projectRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: uiRadii.medium,
    backgroundColor: uiColors.surfaceRaised,
    borderWidth: 1,
    borderColor: uiColors.border,
  },
  projectRowSelected: {
    borderColor: uiColors.accent,
    backgroundColor: uiColors.accentSoft,
  },
  projectRowIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: uiRadii.small,
    backgroundColor: uiColors.surfacePressed,
  },
  projectRowCopy: {
    flex: 1,
    minWidth: 0,
  },
  projectRowName: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 13,
  },
  projectRowPath: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    fontSize: 9,
    marginTop: 3,
  },
  currentProjectBadge: {
    borderRadius: uiRadii.pill,
    paddingHorizontal: 7,
    paddingVertical: 3,
    backgroundColor: uiColors.accent,
  },
  currentProjectBadgeText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 9,
  },
  projectEmptyState: {
    alignItems: 'center',
    paddingVertical: 26,
  },
  projectEmptyTitle: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 14,
    marginTop: 8,
  },
  projectEmptyCopy: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    fontSize: 11,
    marginTop: 4,
    textAlign: 'center',
  },
  projectSheetActions: {
    paddingTop: 12,
  },
  projectCreateButton: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: uiRadii.medium,
    backgroundColor: uiColors.accent,
  },
  projectCreateButtonText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: uiColors.overlay,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 18,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: uiColors.surfaceRaised,
    borderRadius: uiRadii.large,
    borderWidth: 1,
    borderColor: uiColors.borderStrong,
    padding: 16,
  },
  modalTitle: {
    fontSize: 16,
    fontFamily: uiFonts.medium,
    color: uiColors.text,
    marginBottom: 10,
  },
  modalDescription: {
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 12,
  },
  modalInput: {
    backgroundColor: uiColors.canvas,
    color: uiColors.text,
    fontFamily: uiFonts.regular,
    fontSize: 14,
    padding: 12,
    borderRadius: uiRadii.small,
    borderWidth: 1,
    borderColor: uiColors.borderStrong,
    marginBottom: 16,
  },
  optionLabel: {
    color: '#d4d4d8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 7,
  },
  optionHint: {
    color: '#888888',
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 10,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 7,
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    backgroundColor: '#1e1e1e',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 5,
  },
  segmentButtonSelected: {
    backgroundColor: '#4c3b78',
    borderColor: '#8b5cf6',
  },
  segmentText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  optionCheckbox: {
    color: '#a78bfa',
    fontSize: 18,
    width: 28,
  },
  optionText: {
    color: '#dddddd',
    fontSize: 12,
  },
  conflictRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  conflictButton: {
    backgroundColor: '#1e1e1e',
    borderWidth: 1,
    borderColor: '#3f3f46',
    borderRadius: 4,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  conflictText: {
    color: '#eeeeee',
    fontSize: 10,
    fontWeight: '600',
  },
  secretWarning: {
    color: '#fbbf24',
    fontSize: 10,
    lineHeight: 14,
    marginBottom: 10,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: uiRadii.small,
    backgroundColor: uiColors.surfacePressed,
  },
  modalButtonPrimary: {
    backgroundColor: uiColors.accent,
  },
  modalButtonText: {
    fontSize: 14,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
  },
  modalButtonTextPrimary: {
    color: uiColors.text,
  },
});

export default FileExplorer;
