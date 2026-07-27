import { NativeModules, NativeEventEmitter } from 'react-native';

const { MobileIDENative } = NativeModules;

export interface RuntimePaths {
  root: string;
  bin: string;
  lib: string;
  home: string;
  workspaces: string;
  tmp: string;
  cache: string;
  etc: string;
}

export interface VirtualPaths {
  root: string;
  bin: string;
  home: string;
  workspaces: string;
  tmp: string;
  cache: string;
}

export interface VersionInfo {
  versionName: string;
  versionCode: number;
  packageName: string;
}

export interface RuntimeProgressEvent {
  message: string;
  progress: number;
}

export interface MobileIDENativeInterface {
  isRuntimeReady(): Promise<boolean>;
  initializeRuntime(): Promise<boolean>;
  getRuntimeRoot(): Promise<string>;
  getRuntimePaths(): Promise<RuntimePaths>;
  getVirtualPaths(): Promise<VirtualPaths>;
  resolvePath(virtualPath: string): Promise<string>;
  toVirtualPath(realPath: string): Promise<string>;
  getEnvironment(): Promise<Record<string, string>>;
  getVersionInfo(): Promise<VersionInfo>;
  /** Open http(s) URL in the system browser (dev-server preview). */
  openUrl(url: string): Promise<boolean>;
}

export const MobileIDENativeModule = MobileIDENative as MobileIDENativeInterface;
export const MobileIDEEventEmitter = new NativeEventEmitter(MobileIDENative);
