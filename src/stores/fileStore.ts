import { create } from 'zustand';
import {
  FileSystemNativeModule,
  FileEntry,
  MobileIDENativeModule,
  StorageNativeModule,
  ExternalRoot,
} from '../native';

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
  
  // Actions
  loadWorkspaces: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  initWorkspace: () => Promise<void>;
  requestStorageAccess: () => Promise<boolean>;
  openFolderFromDevice: () => Promise<ExternalRoot[]>;
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
  workspaces: [],
  hasStorageAccess: false,
  externalRoots: [],
  fileTree: new Map(),
  expandedFolders: new Set(),
  isLoading: false,
  error: null,

  loadWorkspaces: async () => {
    try {
      const workspaces = await FileSystemNativeModule.getWorkspaces();
      set({ 
        workspaces: workspaces.map(w => ({
          name: w.name,
          path: w.path,
          isDirectory: true,
          size: 0,
          modifiedTime: w.modifiedTime,
          isHidden: false,
        }))
      });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  openWorkspace: async (path: string) => {
    set({ currentWorkspace: path, isLoading: true, error: null });
    try {
      await get().loadDirectory(path);
      set(state => ({
        expandedFolders: new Set(state.expandedFolders).add(path)
      }));
      // Resolve to a real filesystem path so the terminal can chdir into it.
      let realPath = path;
      try {
        realPath = await MobileIDENativeModule.resolvePath(path);
      } catch {
        // resolvePath is a no-op for already-real paths.
      }
      set({ currentWorkspaceRealPath: realPath });
      persistWorkspace(path);
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
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
          await get().openWorkspace(persisted);
          return;
        }
      }

      // Fall back to the default runtime workspace.
      try {
        const vpaths = await MobileIDENativeModule.getVirtualPaths();
        await get().openWorkspace(`${vpaths.workspaces}/my-project`);
      } catch {
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
    try {
      await FileSystemNativeModule.delete(path, true);
      await get().refreshDirectory(parentPath);
    } catch (error) {
      set({ error: (error as Error).message });
      throw error;
    }
  },

  refreshDirectory: async (path: string) => {
    await get().loadDirectory(path);
  },
}));
