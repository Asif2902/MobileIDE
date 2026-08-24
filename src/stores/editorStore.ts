import { create } from 'zustand';
import { FileSystemNativeModule, MobileIDENativeModule } from '../native';

export interface OpenFile {
  path: string;
  name: string;
  language: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
}

export interface Problem {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  source: string;
}

export interface FileDiagnostics {
  errors: number;
  warnings: number;
  problems: Problem[];
}

export interface EditorLocation {
  path: string;
  line: number;
  column: number;
  nonce: number;
}

interface EditorState {
  openFiles: OpenFile[];
  activeFilePath: string | null;
  fontSize: number;
  wordWrap: boolean;
  theme: 'dark' | 'light';
  diagnostics: Record<string, FileDiagnostics>;
  cursorLine: number;
  cursorColumn: number;
  revealRequest: EditorLocation | null;
  
  // Actions
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  saveAllFiles: () => Promise<void>;
  setFontSize: (size: number) => void;
  loadPreferences: () => Promise<void>;
  toggleWordWrap: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setDiagnostics: (path: string, diagnostics: FileDiagnostics) => void;
  setCursor: (line: number, column: number) => void;
  revealLocation: (path: string, line: number, column?: number) => Promise<void>;
}

// Language detection from file extension
export const getLanguageFromPath = (path: string): string => {
  const fileName = getFileName(path).toLowerCase();
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'ini';
  if (fileName === 'dockerfile' || fileName.startsWith('dockerfile.')) return 'dockerfile';
  const wellKnownNames: Record<string, string> = {
    'makefile': 'plaintext',
    '.gitignore': 'plaintext',
    '.npmrc': 'ini',
    '.yarnrc': 'yaml',
  };
  if (wellKnownNames[fileName]) return wellKnownNames[fileName];

  const ext = path.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'json': 'json',
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'md': 'markdown',
    'markdown': 'markdown',
    'py': 'python',
    'sh': 'shell',
    'bash': 'shell',
    'yml': 'yaml',
    'yaml': 'yaml',
    'xml': 'xml',
    'sql': 'sql',
    'java': 'java',
    'kt': 'kotlin',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'swift': 'swift',
    'dart': 'dart',
    'vue': 'html',
    'svelte': 'html',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'mts': 'typescript',
    'cts': 'typescript',
    'toml': 'ini',
    'env': 'ini',
    'dockerfile': 'dockerfile',
  };
  return languageMap[ext] || 'plaintext';
};

const getFileName = (path: string): string => {
  return path.split('/').pop() || path;
};

const EDITOR_SETTINGS_FILE = '.adev-editor-settings.json';

const clampFontSize = (size: number): number => Math.max(8, Math.min(32, Math.round(size)));

const getEditorSettingsPath = async (): Promise<string> => {
  const paths = await MobileIDENativeModule.getRuntimePaths();
  return `${paths.home}/${EDITOR_SETTINGS_FILE}`;
};

let preferenceWriteChain: Promise<void> = Promise.resolve();

const persistEditorPreferences = (fontSize: number, wordWrap: boolean): Promise<void> => {
  preferenceWriteChain = preferenceWriteChain
    .then(async () => {
      await FileSystemNativeModule.writeFile(
        await getEditorSettingsPath(),
        JSON.stringify({ fontSize: clampFontSize(fontSize), wordWrap }),
      );
    })
    .catch(() => {
      // Editor preferences are best-effort and must never block editing.
    });
  return preferenceWriteChain;
};

export const useEditorStore = create<EditorState>((set, get) => ({
  openFiles: [],
  activeFilePath: null,
  fontSize: 14,
  wordWrap: true,
  theme: 'dark',
  diagnostics: {},
  cursorLine: 1,
  cursorColumn: 1,
  revealRequest: null,

  openFile: async (path: string) => {
    const state = get();
    
    // Check if file is already open
    const existing = state.openFiles.find(f => f.path === path);
    if (existing) {
      set({ activeFilePath: path });
      return;
    }
    
    try {
      const content = await FileSystemNativeModule.readFile(path);
      const newFile: OpenFile = {
        path,
        name: getFileName(path),
        language: getLanguageFromPath(path),
        content,
        originalContent: content,
        isDirty: false,
      };
      
      set(current => ({
        openFiles: [...current.openFiles, newFile],
        activeFilePath: path,
      }));
    } catch (error) {
      console.error('Failed to open file:', error);
      throw error;
    }
  },

  closeFile: (path: string) => {
    set(state => {
      const openFiles = state.openFiles.filter(f => f.path !== path);
      const activeFilePath = state.activeFilePath === path
        ? (openFiles.length > 0 ? openFiles[openFiles.length - 1].path : null)
        : state.activeFilePath;
      const diagnostics = { ...state.diagnostics };
      delete diagnostics[path];
      return { openFiles, activeFilePath, diagnostics };
    });
  },

  setActiveFile: (path: string) => {
    set({ activeFilePath: path });
  },

  updateContent: (path: string, content: string) => {
    set(state => ({
      openFiles: state.openFiles.map(f =>
        f.path === path
          ? { ...f, content, isDirty: content !== f.originalContent }
          : f
      ),
    }));
  },

  saveFile: async (path: string) => {
    const state = get();
    const file = state.openFiles.find(f => f.path === path);
    if (!file) return;
    
    try {
      await FileSystemNativeModule.writeFile(path, file.content);
      set(current => ({
        openFiles: current.openFiles.map(f =>
          f.path === path
            ? { ...f, originalContent: f.content, isDirty: false }
            : f
        ),
      }));
    } catch (error) {
      console.error('Failed to save file:', error);
      throw error;
    }
  },

  saveAllFiles: async () => {
    const state = get();
    const dirtyFiles = state.openFiles.filter(f => f.isDirty);
    
    for (const file of dirtyFiles) {
      await get().saveFile(file.path);
    }
  },

  setFontSize: (size: number) => {
    const fontSize = clampFontSize(size);
    set({ fontSize });
    persistEditorPreferences(fontSize, get().wordWrap).catch(() => {});
  },

  loadPreferences: async () => {
    try {
      const file = await getEditorSettingsPath();
      if (!(await FileSystemNativeModule.exists(file))) return;
      const parsed = JSON.parse(await FileSystemNativeModule.readFile(file)) as {
        fontSize?: unknown;
        wordWrap?: unknown;
      };
      set(state => ({
        fontSize:
          typeof parsed.fontSize === 'number' ? clampFontSize(parsed.fontSize) : state.fontSize,
        wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : state.wordWrap,
      }));
    } catch {
      // Ignore malformed or unavailable settings and retain safe defaults.
    }
  },

  toggleWordWrap: () => {
    set(state => {
      const wordWrap = !state.wordWrap;
      persistEditorPreferences(state.fontSize, wordWrap).catch(() => {});
      return { wordWrap };
    });
  },

  setTheme: (theme: 'dark' | 'light') => {
    set({ theme });
  },

  setDiagnostics: (path: string, diagnostics: FileDiagnostics) => {
    set(state => ({ diagnostics: { ...state.diagnostics, [path]: diagnostics } }));
  },

  setCursor: (line: number, column: number) => {
    set({ cursorLine: line, cursorColumn: column });
  },

  revealLocation: async (path: string, line: number, column = 1) => {
    await get().openFile(path);
    set({
      activeFilePath: path,
      revealRequest: {
        path,
        line: Math.max(1, Math.round(line)),
        column: Math.max(1, Math.round(column)),
        nonce: Date.now(),
      },
    });
  },
}));
