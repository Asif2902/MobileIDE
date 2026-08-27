import { create } from 'zustand';
import {
  FileSystemNativeModule,
  FileEntry,
  MobileIDENativeModule,
  StorageNativeModule,
  StorageEventEmitter,
  STORAGE_EVENTS,
  ExternalRoot,
  ProjectSource,
  TransferOptions,
  TransferSnapshot,
  WorkspaceAssessment,
  ImportedDocument,
} from '../native';
import { useTerminalStore } from './terminalStore';

// Best-effort persistence of the last opened workspace so it reopens next launch.
const WORKSPACE_STATE_FILE = '.adev-last-workspace';

const getStateFilePath = async (): Promise<string> => {
  const paths = await MobileIDENativeModule.getRuntimePaths();
  return `${paths.home}/${WORKSPACE_STATE_FILE}`;
};

const persistWorkspace = async (path: string): Promise<void> => {
  try {
    const file = await getStateFilePath();
    await FileSystemNativeModule.writeFile(file, path);
  } catch {
    // Non-fatal: persistence is best-effort.
  }
};

const readPersistedWorkspace = async (): Promise<string | null> => {
  try {
    const file = await getStateFilePath();
    if (await FileSystemNativeModule.exists(file)) {
      const content = (await FileSystemNativeModule.readFile(file)).trim();
      return content.length > 0 ? content : null;
    }
  } catch {
    // ignore
  }
  return null;
};

interface FileState {
  // Current workspace
  currentWorkspace: string | null;
  currentWorkspaceRealPath: string | null;
  currentWorkspaceAssessment: WorkspaceAssessment | null;
  workspaces: FileEntry[];

  // Storage / device folders
  hasStorageAccess: boolean;
  externalRoots: ExternalRoot[];
  
  // File tree
  fileTree: Map<string, FileEntry[]>;
  expandedFolders: Set<string>;
  
  // Loading states
  isLoading: boolean;
  error: string | null;
  activeTransfer: TransferSnapshot | null;
  transferError: string | null;
  
  // Actions
  loadWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<string>;
  /** Returns true only after the folder was listed and its real path resolved. */
  openWorkspace: (path: string) => Promise<boolean>;
  initWorkspace: () => Promise<void>;
  requestStorageAccess: () => Promise<boolean>;
  openFolderFromDevice: () => Promise<ExternalRoot[]>;
  importFileFromDevice: () => Promise<ImportedDocument | null>;
  importProject: (
    source: ProjectSource,
    requestedName: string | null,
    options: TransferOptions,
  ) => Promise<string>;
  exportProject: (
    destinationTreeUri: string,
    requestedName: string | null,
    options: TransferOptions,
  ) => Promise<string>;
  cancelTransfer: () => Promise<void>;
  clearTransfer: () => void;
  handleTransferUpdate: (snapshot: TransferSnapshot) => void;
  handleTransferComplete: (snapshot: TransferSnapshot) => Promise<void>;
  loadDirectory: (path: string) => Promise<void>;
  toggleFolder: (path: string) => void;
  createFile: (path: string, name: string) => Promise<void>;
  createFolder: (path: string, name: string) => Promise<void>;
  renameItem: (oldPath: string, newName: string) => Promise<void>;
  deleteItem: (path: string) => Promise<void>;
  refreshDirectory: (path: string) => Promise<void>;
}

export const useFileStore = create<FileState>((set, get) => ({
  currentWorkspace: null,
  currentWorkspaceRealPath: null,
  currentWorkspaceAssessment: null,
  workspaces: [],
  hasStorageAccess: false,
  externalRoots: [],
  fileTree: new Map(),
  expandedFolders: new Set(),
  isLoading: false,
  error: null,
  activeTransfer: null,
  transferError: null,

  loadWorkspaces: async () => {
    try {
      const workspaces = await FileSystemNativeModule.getWorkspaces();
      set({ 
        workspaces: workspaces
          .filter(w => !w.name.startsWith('.'))
          .map(w => ({
          name: w.name,
          path: w.path,
          isDirectory: true,
          size: 0,
          modifiedTime: w.modifiedTime,
          isHidden: false,
          })),
      });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  openWorkspace: async (path: string) => {
    set({ isLoading: true, error: null });
    try {
      // Listing is the actual openability check. Do it directly here because
      // background tree refreshes intentionally swallow transient failures.
      const entries = await FileSystemNativeModule.listDir(path);

      // Resolve to a real filesystem path so the terminal can chdir into it.
      // Native resolution is a no-op for already-real paths. A failed virtual
      // resolution means the terminal cannot safely chdir, so opening fails.
      const realPath = await MobileIDENativeModule.resolvePath(path);
      const assessment = await StorageNativeModule.assessWorkspace(realPath);

      set(state => {
        const fileTree = new Map(state.fileTree);
        fileTree.set(path, entries);
        return {
          currentWorkspace: path,
          currentWorkspaceRealPath: realPath,
          currentWorkspaceAssessment: assessment,
          fileTree,
          expandedFolders: new Set(state.expandedFolders).add(path),
          isLoading: false,
          error: null,
        };
      });
      await persistWorkspace(path);
      return true;
    } catch (error) {
      // Keep the previously opened workspace and its resolved path together.
      set({
        isLoading: false,
        error: (error as Error).message || 'Workspace could not be opened',
      });
      return false;
    }
  },

  createWorkspace: async (name: string) => {
    const projectName = name.trim();
    if (!projectName || projectName === '.' || projectName === '..') {
      throw new Error('Enter a project name.');
    }
    if (projectName.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectName)) {
      throw new Error('Use up to 80 letters, numbers, dots, dashes, or underscores.');
    }

    try {
      const virtualPaths = await MobileIDENativeModule.getVirtualPaths();
      const workspacePath = `${virtualPaths.workspaces}/${projectName}`;
      if (await FileSystemNativeModule.exists(workspacePath)) {
        throw new Error(`A project named "${projectName}" already exists.`);
      }
      await FileSystemNativeModule.mkdir(workspacePath, true);
      await get().loadWorkspaces();
      if (!(await get().openWorkspace(workspacePath))) {
        throw new Error(get().error || 'The new project could not be opened.');
      }
      return workspacePath;
    } catch (error) {
      set({error: (error as Error).message || 'Project creation failed'});
      throw error;
    }
  },

  /**
   * Restore the last opened workspace on launch, or open the default runtime
   * workspace so the Explorer is never empty.
   */
  initWorkspace: async () => {
    try {
      try {
        const granted = await StorageNativeModule.hasAllFilesAccess();
        set({ hasStorageAccess: granted });
      } catch {
        // storage module optional
      }

      const persisted = await readPersistedWorkspace();
      if (persisted) {
        let stillExists = false;
        try {
          stillExists = await FileSystemNativeModule.exists(persisted);
        } catch {
          stillExists = false;
        }
        if (stillExists) {
          if (await get().openWorkspace(persisted)) return;
        }
      }

      // Fall back to the default runtime workspace.
      let openedDefault = false;
      try {
        const vpaths = await MobileIDENativeModule.getVirtualPaths();
        openedDefault = await get().openWorkspace(`${vpaths.workspaces}/my-project`);
      } catch {
        openedDefault = false;
      }
      if (!openedDefault) {
        await get().loadWorkspaces();
        const first = get().workspaces[0];
        if (first) await get().openWorkspace(first.path);
      }
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  /**
   * Ensure all-files access, prompting the system settings screen if needed.
   */
  requestStorageAccess: async () => {
    try {
      let granted = await StorageNativeModule.hasAllFilesAccess();
      if (!granted) {
        await StorageNativeModule.requestAllFilesAccess();
        granted = await StorageNativeModule.hasAllFilesAccess();
      }
      set({ hasStorageAccess: granted });
      return granted;
    } catch (error) {
      set({ error: (error as Error).message });
      return false;
    }
  },

  /**
   * Ensure storage access and return the list of external roots for a picker.
   * The caller opens a chosen root via openWorkspace(root.path).
   */
  openFolderFromDevice: async () => {
    try {
      const granted = await get().requestStorageAccess();
      if (!granted) return [];
      const roots = await StorageNativeModule.listExternalRoots();
      set({ externalRoots: roots });
      return roots;
    } catch (error) {
      set({ error: (error as Error).message });
      return [];
    }
  },

  importFileFromDevice: async () => {
    const workspacePath = get().currentWorkspace;
    if (!workspacePath) {
      throw new Error('Open a workspace before importing a file.');
    }
    set({error: null});
    try {
      const selection = await StorageNativeModule.pickFile();
      if (!selection) return null;
      const imported = await StorageNativeModule.importFile(
        selection.value,
        workspacePath,
        selection.displayName,
      );
      await get().refreshDirectory(workspacePath);
      return imported;
    } catch (error) {
      set({error: (error as Error).message || 'File import failed'});
      throw error;
    }
  },

  importProject: async (source, requestedName, options) => {
    set({ transferError: null });
    try {
      const operationId = await StorageNativeModule.beginImport(
        source,
        requestedName,
        options,
      );
      const snapshot = await StorageNativeModule.getTransfer(operationId);
      set({ activeTransfer: snapshot });
      return operationId;
    } catch (error) {
      const message = (error as Error).message || 'Project import could not start';
      set({ transferError: message });
      throw error;
    }
  },

  exportProject: async (destinationTreeUri, requestedName, options) => {
    const workspacePath = get().currentWorkspaceRealPath;
    if (!workspacePath || !get().currentWorkspaceAssessment?.privateWorkspace) {
      const error = new Error('Only projects in the private ADEV workspace can be exported.');
      set({ transferError: error.message });
      throw error;
    }
    set({ transferError: null });
    try {
      const operationId = await StorageNativeModule.beginExport(
        workspacePath,
        destinationTreeUri,
        requestedName,
        options,
      );
      const snapshot = await StorageNativeModule.getTransfer(operationId);
      set({ activeTransfer: snapshot });
      return operationId;
    } catch (error) {
      const message = (error as Error).message || 'Project export could not start';
      set({ transferError: message });
      throw error;
    }
  },

  cancelTransfer: async () => {
    const operationId = get().activeTransfer?.operationId;
    if (!operationId) return;
    await StorageNativeModule.cancelTransfer(operationId);
  },

  clearTransfer: () => set({ activeTransfer: null, transferError: null }),

  handleTransferUpdate: snapshot => {
    if (
      !get().activeTransfer ||
      get().activeTransfer?.operationId === snapshot.operationId
    ) {
      set({ activeTransfer: snapshot });
    }
  },

  handleTransferComplete: async snapshot => {
    get().handleTransferUpdate(snapshot);
    if (snapshot.direction !== 'import' || !snapshot.result) return;
    const result = snapshot.result as { virtualPath?: string; workspacePath?: string; path?: string };
    const importedPath = result.virtualPath || result.workspacePath || result.path;
    if (!importedPath) return;
    await get().loadWorkspaces();
    if (await get().openWorkspace(importedPath)) {
      const realPath = get().currentWorkspaceRealPath;
      if (realPath) {
        try {
          await useTerminalStore.getState().createSession(realPath);
        } catch {
          // The Explorer is already switched; Terminal displays its own error.
        }
      }
    }
  },

  loadDirectory: async (path: string) => {
    try {
      const entries = await FileSystemNativeModule.listDir(path);
      set(state => {
        const newTree = new Map(state.fileTree);
        newTree.set(path, entries);
        return { fileTree: newTree };
      });
    } catch (error) {
      console.error(`Failed to load directory ${path}:`, error);
    }
  },

  toggleFolder: (path: string) => {
    set(state => {
      const expanded = new Set(state.expandedFolders);
      if (expanded.has(path)) {
        expanded.delete(path);
      } else {
        expanded.add(path);
        // Load directory contents if not loaded
        if (!state.fileTree.has(path)) {
          get().loadDirectory(path);
        }
      }
      return { expandedFolders: expanded };
    });
  },

  createFile: async (path: string, name: string) => {
    const fullPath = `${path}/${name}`;
    try {
      await FileSystemNativeModule.touch(fullPath);
      await get().refreshDirectory(path);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  createFolder: async (path: string, name: string) => {
    const fullPath = `${path}/${name}`;
    try {
      await FileSystemNativeModule.mkdir(fullPath, true);
      await get().refreshDirectory(path);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  renameItem: async (oldPath: string, newName: string) => {
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const newPath = `${parentPath}/${newName}`;
    try {
      await FileSystemNativeModule.rename(oldPath, newPath);
      await get().refreshDirectory(parentPath);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  deleteItem: async (path: string) => {
    const parentPath = path.substring(0, path.lastIndexOf('/'));
    const deletedPrefix = `${path}/`;

    // Android directory reads can briefly return a stale snapshot after a
    // recursive delete. Remove the target from the visible tree immediately,
    // then reconcile with the filesystem below.
    set(state => {
      const fileTree = new Map(state.fileTree);
      for (const [directory, entries] of fileTree.entries()) {
        if (directory === path || directory.startsWith(deletedPrefix)) {
          fileTree.delete(directory);
          continue;
        }
        const nextEntries = entries.filter(
          entry => entry.path !== path && !entry.path.startsWith(deletedPrefix),
        );
        if (nextEntries.length !== entries.length) {
          fileTree.set(directory, nextEntries);
        }
      }
      const expandedFolders = new Set(
        [...state.expandedFolders].filter(
          directory => directory !== path && !directory.startsWith(deletedPrefix),
        ),
      );
      return {fileTree, expandedFolders};
    });

    try {
      await FileSystemNativeModule.delete(path, true);
      await get().refreshDirectory(parentPath);
    } catch (error) {
      // Restore the authoritative parent listing if the native delete failed.
      await get().refreshDirectory(parentPath);
      set({ error: (error as Error).message });
      throw error;
    }
  },

  refreshDirectory: async (path: string) => {
    await get().loadDirectory(path);
  },
}));

export const setupStorageListeners = () => {
  const progressSub = StorageEventEmitter.addListener(
    STORAGE_EVENTS.PROGRESS,
    (snapshot: TransferSnapshot) => {
      useFileStore.getState().handleTransferUpdate(snapshot);
    },
  );
  const completeSub = StorageEventEmitter.addListener(
    STORAGE_EVENTS.COMPLETE,
    (snapshot: TransferSnapshot) => {
      useFileStore.getState().handleTransferComplete(snapshot).catch(() => undefined);
    },
  );
  const errorSub = StorageEventEmitter.addListener(
    STORAGE_EVENTS.ERROR,
    (snapshot: TransferSnapshot) => {
      useFileStore.getState().handleTransferUpdate(snapshot);
      useFileStore.setState({
        transferError:
          snapshot.status === 'cancelled'
            ? null
            : snapshot.message || 'Project transfer failed',
      });
    },
  );

  return () => {
    progressSub.remove();
    completeSub.remove();
    errorSub.remove();
  };
};
