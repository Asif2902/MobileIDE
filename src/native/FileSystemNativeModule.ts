import { NativeModules, NativeEventEmitter } from 'react-native';

const { FileSystemNative } = NativeModules;

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedTime: number;
  isHidden: boolean;
}

export interface FileStat extends FileEntry {
  isReadable: boolean;
  isWritable: boolean;
  isExecutable: boolean;
}

export interface GrepResult {
  file: string;
  line: number;
  content: string;
  match: string;
}

export interface FileChangeEvent {
  type: 'CREATE' | 'DELETE' | 'MODIFY' | 'MOVE';
  path: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  modifiedTime: number;
}

export interface FileSystemNativeInterface {
  listDir(path: string): Promise<FileEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<boolean>;
  appendFile(path: string, content: string): Promise<boolean>;
  mkdir(path: string, recursive: boolean): Promise<boolean>;
  touch(path: string): Promise<boolean>;
  rename(oldPath: string, newPath: string): Promise<boolean>;
  copy(sourcePath: string, destPath: string): Promise<boolean>;
  delete(path: string, recursive: boolean): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  exists(path: string): Promise<boolean>;
  search(rootPath: string, pattern: string, maxResults: number): Promise<FileEntry[]>;
  grep(rootPath: string, pattern: string, maxResults: number): Promise<GrepResult[]>;
  watchDirectory(path: string): Promise<string>;
  stopWatching(watchId: string): Promise<boolean>;
  getWorkspaces(): Promise<WorkspaceEntry[]>;
  openExternalFolder(path: string): Promise<FileEntry[]>;
}

export const FileSystemNativeModule = FileSystemNative as FileSystemNativeInterface;
export const FileSystemEventEmitter = new NativeEventEmitter(FileSystemNative);

// Event names
export const FS_EVENTS = {
  FILE_CHANGE: 'onFileChange',
} as const;
