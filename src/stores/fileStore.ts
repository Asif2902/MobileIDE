import { create } from 'zustand';
import { FileSystemNativeModule, FileEntry } from '../native';

interface FileState {
  // Current workspace
  currentWorkspace: string | null;
  workspaces: FileEntry[];
  
  // File tree
  fileTree: Map<string, FileEntry[]>;
  expandedFolders: Set<string>;
  
  // Loading states
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadWorkspaces: () => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
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
  workspaces: [],
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
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ isLoading: false });
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
