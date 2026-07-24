import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  StatusBar as RNStatusBar,
  useWindowDimensions,
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

// Only treat as tablet when BOTH dimensions are large enough. Phones in
// landscape often exceed 768px width and would otherwise flip into the
// desktop layout (BottomPanel + TerminalPanel), which stacked the
// Terminal/Problems/Output/Debug headers twice.
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

  // Restore/open a workspace once the runtime is ready so the Explorer and
  // terminal always have a project to work in.
  useEffect(() => {
    if (isReady) {
      initWorkspace();
    }
  }, [isReady, initWorkspace]);

  // ---- Tablet / large screen: classic side-by-side IDE layout ----
  if (isTablet) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
        <RNStatusBar barStyle="light-content" backgroundColor="#1e1e1e" />
        <View style={styles.mainContainer}>
          {isActivityBarVisible && <ActivityBar />}
          <Sidebar />
          <View style={styles.editorArea}>
            <EditorPanel />
            <BottomPanel />
          </View>
        </View>
        <StatusBar />
      </SafeAreaView>
    );
  }

  // ---- Phone: full-screen views + bottom tab navigation ----
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

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      <RNStatusBar barStyle="light-content" backgroundColor="#181818" />
      <MobileTopBar />
      <View style={styles.mobileContent}>{renderMobileView()}</View>
      <BottomTabBar />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  mainContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  editorArea: {
    flex: 1,
    flexDirection: 'column',
  },
  mobileContent: {
    flex: 1,
    backgroundColor: '#1e1e1e',
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
