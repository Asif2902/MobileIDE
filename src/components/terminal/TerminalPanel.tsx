import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTerminalStore } from '../../stores';
import { TerminalView } from './TerminalView';
import { TerminalTabs } from './TerminalTabs';

export const TerminalPanel: React.FC = () => {
  const { sessions, activeSessionId } = useTerminalStore();
  
  const activeSession = sessions.find(s => s.id === activeSessionId);

  return (
    <View style={styles.container}>
      <TerminalTabs />
      <View style={styles.terminalContainer}>
        {activeSession ? (
          <TerminalView sessionId={activeSession.id} />
        ) : (
          <View style={styles.emptyState}>
            <View style={styles.emptyText}>
              <View style={styles.emptyIcon} />
            </View>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  terminalContainer: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1e1e1e',
  },
  emptyText: {
    alignItems: 'center',
  },
  emptyIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#333',
  },
});

export default TerminalPanel;
