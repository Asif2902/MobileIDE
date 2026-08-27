import React, { useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  StatusBar as RNStatusBar,
  useWindowDimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ActivityBar,
  Sidebar,
  BottomPanel,
  StatusBar,
  BottomTabBar,
  MobileTopBar,
} from '../components/layout';
import { EditorPanel } from '../components/editor';
import { TerminalPanel } from '../components/terminal';
import { FileExplorer } from '../components/explorer';
import {SettingsPanel} from '../components/settings';
import {uiColors} from '../theme';
import {
  useRuntimeStore,
  useUIStore,
  useFileStore,
  setupTerminalListeners,
  setupProcessListeners,
  setupStorageListeners,
} from '../stores';

// Tablet: both dimensions large enough. Phones in landscape stay on the
// mobile layout so we don't double-stack terminal headers.
const TABLET_MIN_WIDTH = 900;
const TABLET_MIN_HEIGHT = 600;

export const IDEScreen: React.FC = () => {
  const { isReady, checkRuntime, initializeRuntime } = useRuntimeStore();
  const { isActivityBarVisible, activeView } = useUIStore();
  const initWorkspace = useFileStore(state => state.initWorkspace);
  const { width, height } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH && height >= TABLET_MIN_HEIGHT;
  const isLandscape = width > height;
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [mountedMobileViews, setMountedMobileViews] = useState<Set<string>>(
    () => new Set(['files']),
  );

  useEffect(() => {
    setMountedMobileViews(previous => {
      if (previous.has(activeView)) return previous;
      const next = new Set(previous);
      next.add(activeView);
      return next;
    });
  }, [activeView]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    const cleanupTerminal = setupTerminalListeners();
    const cleanupProcess = setupProcessListeners();
    const cleanupStorage = setupStorageListeners();
    checkRuntime();
    return () => {
      cleanupTerminal();
      cleanupProcess();
      cleanupStorage();
    };
  }, [checkRuntime]);

  useEffect(() => {
    if (!isReady) {
      initializeRuntime();
    }
  }, [isReady, initializeRuntime]);

  useEffect(() => {
    if (isReady) {
      initWorkspace();
    }
  }, [isReady, initWorkspace]);

  // ---- Tablet / large screen: side-by-side IDE ----
  if (isTablet) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <RNStatusBar barStyle="light-content" backgroundColor={uiColors.canvas} />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.mainContainer}>
            {isActivityBarVisible && <ActivityBar />}
            <Sidebar />
            <View style={styles.editorArea}>
              <EditorPanel />
              {/* Shrink bottom panel when keyboard is open so the editor stays usable */}
              {!keyboardVisible && <BottomPanel />}
            </View>
          </View>
          <StatusBar />
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // ---- Phone: full-screen views + bottom tabs ----
  const validActiveView = ['files', 'editor', 'terminal', 'settings'].includes(activeView)
    ? activeView
    : 'files';

  // Hide bottom nav while typing in the editor (portrait or landscape) so the
  // soft keyboard + Monaco get maximum vertical space.
  const hideBottomTabs =
    keyboardVisible && (activeView === 'editor' || activeView === 'terminal');

  return (
    <SafeAreaView
      style={styles.container}
      edges={hideBottomTabs ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}
    >
      <RNStatusBar barStyle="light-content" backgroundColor={uiColors.canvas} />
      {/* Compact top bar in landscape to free vertical space */}
      {!(isLandscape && keyboardVisible && activeView === 'editor') && <MobileTopBar />}
      <KeyboardAvoidingView
        style={styles.flex}
        // Android 15+ edge-to-edge windows can leave adjustResize reporting the
        // IME without actually reducing the React root. "height" uses the
        // reported keyboard frame when needed, and computes a zero adjustment
        // when the OS has already resized us. This keeps terminal accessories
        // immediately above the keyboard instead of underneath it.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <View style={styles.mobileContent}>
          {mountedMobileViews.has('files') && (
            <View
              style={[styles.mobileView, validActiveView !== 'files' && styles.mobileViewHidden]}
              pointerEvents={validActiveView === 'files' ? 'auto' : 'none'}>
              <FileExplorer />
            </View>
          )}
          {mountedMobileViews.has('editor') && (
            <View
              style={[styles.mobileView, validActiveView !== 'editor' && styles.mobileViewHidden]}
              pointerEvents={validActiveView === 'editor' ? 'auto' : 'none'}>
              <EditorPanel />
            </View>
          )}
          {mountedMobileViews.has('terminal') && (
            <View
              style={[styles.mobileView, validActiveView !== 'terminal' && styles.mobileViewHidden]}
              pointerEvents={validActiveView === 'terminal' ? 'auto' : 'none'}>
              <TerminalPanel visible={validActiveView === 'terminal'} />
            </View>
          )}
          {mountedMobileViews.has('settings') && (
            <View
              style={[styles.mobileView, validActiveView !== 'settings' && styles.mobileViewHidden]}
              pointerEvents={validActiveView === 'settings' ? 'auto' : 'none'}>
              <SettingsPanel />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
      {!hideBottomTabs && <BottomTabBar />}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  flex: {
    flex: 1,
  },
  mainContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  editorArea: {
    flex: 1,
    flexDirection: 'column',
    minWidth: 0,
  },
  mobileContent: {
    flex: 1,
    backgroundColor: uiColors.canvas,
    minHeight: 0,
    position: 'relative',
  },
  mobileView: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  mobileViewHidden: {
    display: 'none',
  },
});

export default IDEScreen;
