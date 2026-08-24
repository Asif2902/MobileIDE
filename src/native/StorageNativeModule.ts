import {NativeEventEmitter, NativeModules} from 'react-native';

const {StorageNative} = NativeModules;

export interface ExternalRoot {
  name: string;
  path: string;
}

export interface WorkspaceAssessment {
  path: string;
  privateWorkspace: boolean;
  sharedStorage?: boolean;
  nativeBuilds: boolean;
  executableModes: boolean;
  symlinks: boolean;
  caseSensitiveNames: boolean;
  requiresPrivateImport: boolean;
  reason?: string;
}

export interface PrivateWorkspaceImport {
  name: string;
  path: string;
  virtualPath: string;
  privateWorkspace: true;
}

export interface TreeSelection {
  kind: 'treeUri';
  value: string;
  displayName: string;
  canRead: boolean;
  canWrite: boolean;
}

export interface DocumentSelection {
  kind: 'documentUri';
  value: string;
  displayName: string;
  mimeType?: string;
  size?: number;
}

export interface ImportedDocument {
  name: string;
  path: string;
  bytesCopied: number;
}

export type ProjectSource = {
  kind: 'rawPath' | 'treeUri';
  value: string;
  displayName?: string;
};

export type TransferMode = 'source' | 'full';
export type TransferConflictPolicy = 'unique' | 'merge' | 'replace' | 'cancel';

export interface TransferOptions {
  mode: TransferMode;
  includeGit: boolean;
  includeHidden: boolean;
  includeSecrets: boolean;
  conflictPolicy: TransferConflictPolicy;
}

export type TransferDirection = 'import' | 'export';
export type TransferStatus = 'queued' | 'running' | 'complete' | 'cancelled' | 'error';

export interface ProjectRecord {
  id: string;
  projectName: string;
  workspacePath: string;
  virtualPath: string;
  originalImportedPath?: string;
  originalSourceKind?: 'rawPath' | 'treeUri';
  originalTreeUri?: string;
  importedAt: number;
  projectType: string;
  lastExportUri?: string;
  lastExportAt?: number;
}

export interface ImportTransferResult {
  kind: 'import';
  path: string;
  virtualPath: string;
  project: ProjectRecord;
}

export interface ExportTransferResult {
  kind: 'export';
  destinationTreeUri: string;
  projectDocumentUri: string;
  exportedName: string;
  project: ProjectRecord;
}

export interface TransferSnapshot {
  operationId: string;
  direction: TransferDirection;
  status: TransferStatus;
  phase: string;
  filesCopied: number;
  totalFiles: number;
  bytesCopied: number;
  totalBytes: number;
  skippedEntries: number;
  currentPath?: string;
  code?: string;
  message?: string;
  result?: ImportTransferResult | ExportTransferResult;
}

export interface StorageNativeInterface {
  hasAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): Promise<boolean>;
  listExternalRoots(): Promise<ExternalRoot[]>;
  assessWorkspace(realPath: string): Promise<WorkspaceAssessment>;
  pickProjectTree(): Promise<TreeSelection | null>;
  pickExportTree(): Promise<TreeSelection | null>;
  pickFile(): Promise<DocumentSelection | null>;
  importFile(
    documentUri: string,
    workspacePath: string,
    displayName?: string,
  ): Promise<ImportedDocument>;
  beginImport(
    source: ProjectSource,
    requestedName: string | null,
    options: TransferOptions,
  ): Promise<string>;
  beginExport(
    workspacePath: string,
    destinationTreeUri: string,
    requestedName: string | null,
    options: TransferOptions,
  ): Promise<string>;
  getTransfer(operationId: string): Promise<TransferSnapshot>;
  cancelTransfer(operationId: string): Promise<boolean>;
  listProjectMetadata(): Promise<ProjectRecord[]>;
  importWorkspaceToPrivate(
    realPath: string,
    requestedName?: string,
  ): Promise<PrivateWorkspaceImport>;
}

export const StorageNativeModule = StorageNative as StorageNativeInterface;
export const StorageEventEmitter = new NativeEventEmitter(StorageNative);

export const STORAGE_EVENTS = {
  PROGRESS: 'onProjectTransferProgress',
  COMPLETE: 'onProjectTransferComplete',
  ERROR: 'onProjectTransferError',
} as const;
