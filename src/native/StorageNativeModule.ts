import {NativeModules} from 'react-native';

const {StorageNative} = NativeModules;

export interface ExternalRoot {
  name: string;
  path: string;
}

export interface WorkspaceAssessment {
  path: string;
  privateWorkspace: boolean;
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

export interface StorageNativeInterface {
  hasAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): Promise<boolean>;
  listExternalRoots(): Promise<ExternalRoot[]>;
  assessWorkspace(realPath: string): Promise<WorkspaceAssessment>;
  importWorkspaceToPrivate(
    realPath: string,
    requestedName?: string,
  ): Promise<PrivateWorkspaceImport>;
}

export const StorageNativeModule = StorageNative as StorageNativeInterface;
