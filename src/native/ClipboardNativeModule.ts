import { NativeModules } from 'react-native';

interface ClipboardNativeModuleInterface {
  setString(text: string): Promise<boolean>;
  getString(): Promise<string>;
  hasString(): Promise<boolean>;
}

const { ClipboardNative } = NativeModules;

export const ClipboardNativeModule: ClipboardNativeModuleInterface = ClipboardNative ?? {
  setString: async () => false,
  getString: async () => '',
  hasString: async () => false,
};

export default ClipboardNativeModule;
