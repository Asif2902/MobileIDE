import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { useTerminalStore, useRuntimeStore, useFileStore, useUIStore, BottomPanelView } from '../../stores';
import { TerminalView } from './TerminalView';
import { TerminalTabs } from './TerminalTabs';
import { Icon, IconName } from '../icons';
import { ProblemsView, OutputView, DebugView } from '../layout/BottomPanelViews';
import {uiColors, uiFonts, uiRadii} from '../../theme';

interface SubTab {
  id: BottomPanelView;
  label: string;
  icon: IconName;
}

const subTabs: SubTab[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'problems', label: 'Problems', icon: 'problems' },
  { id: 'output', label: 'Output', icon: 'output' },
  { id: 'debug', label: 'Debug', icon: 'debug' },
];

interface TerminalPanelProps {
  /** When true, omit the Terminal/Problems/Output/Debug switcher — parent already has it (tablet BottomPanel). */
  embedded?: boolean;
  /** False while the phone terminal screen is kept mounted behind another tab. */
  visible?: boolean;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  embedded = false,
  visible = true,
}) => {
  const {
    sessions,
    activeSessionId,
    createSession,
    isCreating,
    creationError,
  } = useTerminalStore();
  const {
    isReady,
    isInitializing,
    error: runtimeError,
    initializeRuntime,
  } = useRuntimeStore();
  const { activeBottomPanelView, setBottomPanelView } = useUIStore();
  const currentWorkspaceRealPath = useFileStore(state => state.currentWorkspaceRealPath);
  const hasAutoCreated = useRef(false);

  // Auto-create a terminal session when runtime is ready, starting in the
  // currently opened workspace so CLI tools operate on the open project.
  useEffect(() => {
    if (isReady && sessions.length === 0 && !isCreating && !hasAutoCreated.current) {
      hasAutoCreated.current = true;
      createSession(currentWorkspaceRealPath || undefined).catch(err => {
        console.error('Failed to auto-create terminal session:', err);
      });
    }
  }, [isReady, sessions.length, isCreating, createSession, currentWorkspaceRealPath]);

  const retryTerminal = () => {
    hasAutoCreated.current = true;
    createSession(currentWorkspaceRealPath || undefined).catch(err => {
      console.error('Failed to create terminal session:', err);
    });
  };

  const renderActiveView = () => {
    switch (activeBottomPanelView) {
      case 'problems':
        return <ProblemsView />;
      case 'output':
        return <OutputView />;
      case 'debug':
        return <DebugView />;
      case 'terminal':
      default:
        return (
          <View style={styles.terminalWrapper}>
            <TerminalTabs />
            <View style={styles.terminalContainer}>
              {sessions.length > 0 ? (
                sessions.map(session => {
                  const active = session.id === activeSessionId;
                  return (
                    <View
                      key={session.id}
                      style={[StyleSheet.absoluteFill, { opacity: active ? 1 : 0, zIndex: active ? 1 : 0 }]}
                      pointerEvents={active ? 'auto' : 'none'}
                    >
                      <TerminalView sessionId={session.id} active={active && visible} />
                    </View>
                  );
                })
              ) : (
                <View style={styles.emptyState}>
                  {runtimeError && !isReady ? (
                    <>
                      <Icon name="problems" size={28} color="#f59e0b" />
                      <Text style={styles.errorTitle}>Runtime could not start</Text>
                      <Text style={styles.errorText}>{runtimeError}</Text>
                      <TouchableOpacity
                        style={styles.retryButton}
                        onPress={() => initializeRuntime()}
                        accessibilityRole="button"
                        accessibilityLabel="Retry runtime initialization"
                      >
                        <Text style={styles.retryButtonText}>Retry runtime</Text>
                      </TouchableOpacity>
                    </>
                  ) : creationError ? (
                    <>
                      <Icon name="problems" size={28} color="#f59e0b" />
                      <Text style={styles.errorTitle}>Terminal could not start</Text>
                      <Text style={styles.errorText}>{creationError}</Text>
                      <TouchableOpacity
                        style={styles.retryButton}
                        onPress={retryTerminal}
                        accessibilityRole="button"
                        accessibilityLabel="Retry terminal creation"
                      >
                        <Text style={styles.retryButtonText}>Retry terminal</Text>
                      </TouchableOpacity>
                    </>
                  ) : isCreating || isInitializing || !isReady ? (
                    <>
                      <ActivityIndicator size="small" color="#569cd6" />
                      <Text style={styles.loadingText}>
                        {!isReady ? 'Initializing runtime...' : 'Starting terminal...'}
                      </Text>
                    </>
                  ) : (
                    <Text style={styles.loadingText}>Tap + to open a terminal</Text>
                  )}
                </View>
              )}
            </View>
          </View>
        );
    }
  };

  return (
    <View style={styles.container}>
      {/* Phone layout needs this switcher. Tablet BottomPanel already draws the same tabs. */}
      {!embedded && (
        <View style={styles.subTabBar}>
          {subTabs.map(tab => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.subTab,
                activeBottomPanelView === tab.id && styles.subTabActive,
              ]}
              onPress={() => setBottomPanelView(tab.id)}
            >
              <Icon
                name={tab.icon}
                size={13}
                color={activeBottomPanelView === tab.id ? uiColors.accentText : uiColors.textMuted}
              />
              <Text
                style={[
                  styles.subTabText,
                  activeBottomPanelView === tab.id && styles.subTabTextActive,
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.content}>
        {renderActiveView()}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: uiColors.canvas,
  },
  subTabBar: {
    flexDirection: 'row',
    backgroundColor: uiColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
    height: 42,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  subTab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    height: 32,
    marginHorizontal: 1,
    borderRadius: uiRadii.small,
  },
  subTabActive: {
    backgroundColor: uiColors.accentSoft,
  },
  subTabText: {
    fontFamily: uiFonts.regular,
    fontSize: 11,
    color: uiColors.textMuted,
    marginLeft: 5,
  },
  subTabTextActive: {
    color: uiColors.accentText,
    fontFamily: uiFonts.medium,
  },
  content: {
    flex: 1,
  },
  terminalWrapper: {
    flex: 1,
  },
  terminalContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: uiColors.canvas,
  },
  loadingText: {
    color: uiColors.textMuted,
    fontSize: 13,
    marginTop: 8,
  },
  errorTitle: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 15,
    fontWeight: '600',
    marginTop: 10,
  },
  errorText: {
    color: uiColors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    marginHorizontal: 24,
    marginTop: 7,
    textAlign: 'center',
  },
  retryButton: {
    backgroundColor: uiColors.accent,
    borderRadius: uiRadii.medium,
    marginTop: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryButtonText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 13,
    fontWeight: '600',
  },
});

export default TerminalPanel;
