import { NativeModules } from 'react-native';

const { StorageNative } = NativeModules;

export interface ExternalRoot {
  name: string;
  path: string;
}

export interface StorageNativeInterface {
  hasAllFilesAccess(): Promise<boolean>;
  requestAllFilesAccess(): Promise<boolean>;
  listExternalRoots(): Promise<ExternalRoot[]>;
}

export const StorageNativeModule = StorageNative as StorageNativeInterface;
