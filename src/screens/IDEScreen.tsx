import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
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
import { GitPanel } from '../components/git';
import { Icon, IconName } from '../components/icons';
import {
  useRuntimeStore,
  useUIStore,
  useFileStore,
  setupTerminalListeners,
  setupProcessListeners,
} from '../stores';

// Tablet: both dimensions large enough. Phones in landscape stay on the
// mobile layout so we don't double-stack terminal headers.
const TABLET_MIN_WIDTH = 900;
const TABLET_MIN_HEIGHT = 600;

const PlaceholderView: React.FC<{ icon: IconName; title: string; subtitle: string }> = ({
  icon,
  title,
  subtitle,
}) => (
  <View style={styles.placeholder}>
    <Icon name={icon} size={44} color="#3f3f46" />
    <Text style={styles.placeholderTitle}>{title}</Text>
    <Text style={styles.placeholderSubtitle}>{subtitle}</Text>
  </View>
);

export const IDEScreen: React.FC = () => {
  const { isReady, checkRuntime, initializeRuntime } = useRuntimeStore();
  const { isActivityBarVisible, activeView } = useUIStore();
  const initWorkspace = useFileStore(state => state.initWorkspace);
  const { width, height } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH && height >= TABLET_MIN_HEIGHT;
  const isLandscape = width > height;
  const [keyboardVisible, setKeyboardVisible] = useState(false);

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
    checkRuntime();
    return () => {
      cleanupTerminal();
      cleanupProcess();
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
        <RNStatusBar barStyle="light-content" backgroundColor="#1e1e1e" />
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
  const renderMobileView = () => {
    switch (activeView) {
      case 'files':
        return <FileExplorer />;
      case 'editor':
        return <EditorPanel />;
      case 'terminal':
        return <TerminalPanel />;
      case 'git':
        return <GitPanel />;
      case 'settings':
        return (
          <PlaceholderView
            icon="settings"
            title="Settings"
            subtitle="IDE preferences are coming soon"
          />
        );
      default:
        return null;
    }
  };

  // Hide bottom nav while typing in the editor (portrait or landscape) so the
  // soft keyboard + Monaco get maximum vertical space.
  const hideBottomTabs =
    keyboardVisible && (activeView === 'editor' || activeView === 'terminal');

  return (
    <SafeAreaView
      style={styles.container}
      edges={hideBottomTabs ? ['top', 'left', 'right'] : ['top', 'left', 'right', 'bottom']}
    >
      <RNStatusBar barStyle="light-content" backgroundColor="#181818" />
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
        <View style={styles.mobileContent}>{renderMobileView()}</View>
      </KeyboardAvoidingView>
      {!hideBottomTabs && <BottomTabBar />}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
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
    backgroundColor: '#1e1e1e',
    minHeight: 0,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  placeholderTitle: {
    fontSize: 18,
    color: '#e4e4e7',
    fontWeight: '600',
    marginTop: 16,
  },
  placeholderSubtitle: {
    fontSize: 13,
    color: '#71717a',
    marginTop: 6,
  },
});

export default IDEScreen;
