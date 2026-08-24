import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useTerminalStore, useFileStore } from '../../stores';
import { Icon } from '../icons';

export const TerminalTabs: React.FC = () => {
  const { sessions, activeSessionId, setActiveSession, createSession, closeSession } = useTerminalStore();
  const isKeyboardBarVisible = useTerminalStore(state => state.isKeyboardBarVisible);
  const toggleKeyboardBar = useTerminalStore(state => state.toggleKeyboardBar);
  const currentWorkspaceRealPath = useFileStore(state => state.currentWorkspaceRealPath);

  const handleNewTerminal = async () => {
    try {
      // Start new terminals in the currently opened folder so tools like npm/git
      // operate on the open project instead of the runtime home directory.
      await createSession(currentWorkspaceRealPath || undefined);
    } catch (error) {
      console.error('Failed to create terminal:', error);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {sessions.map((session, index) => (
          <TouchableOpacity
            key={session.id}
            style={[
              styles.tab,
              session.id === activeSessionId && styles.activeTab
            ]}
            onPress={() => setActiveSession(session.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: session.id === activeSessionId }}
            accessibilityLabel={`Terminal ${index + 1}${session.isAlive ? '' : ', exited'}`}
          >
            <Text 
              style={[
                styles.tabText,
                session.id === activeSessionId && styles.activeTabText
              ]}
              numberOfLines={1}
            >
              {`Terminal ${index + 1}`}
            </Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => closeSession(session.id)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={`Close terminal ${index + 1}`}
            >
              <Icon name="close" size={13} color="#969696" />
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ScrollView>
      
      <TouchableOpacity
        style={styles.addButton}
        onPress={toggleKeyboardBar}
        accessibilityRole="button"
        accessibilityLabel="Toggle terminal extra keys above the keyboard"
        accessibilityState={{ selected: isKeyboardBarVisible }}
      >
        <Icon name="keyboard" size={18} color={isKeyboardBarVisible ? '#ffffff' : '#6e6e6e'} />
      </TouchableOpacity>

      <TouchableOpacity 
        style={styles.addButton}
        onPress={handleNewTerminal}
        accessibilityRole="button"
        accessibilityLabel="New terminal"
      >
        <Icon name="plus" size={18} color="#ffffff" />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    height: 33,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 96,
    maxWidth: 132,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginRight: 2,
    backgroundColor: '#2d2d2d',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  activeTab: {
    backgroundColor: '#1e1e1e',
  },
  tabText: {
    flexShrink: 1,
    color: '#969696',
    fontSize: 12,
    marginRight: 6,
  },
  activeTabText: {
    color: '#ffffff',
  },
  closeButton: {
    padding: 2,
  },
  closeButtonText: {
    color: '#969696',
    fontSize: 14,
    lineHeight: 14,
  },
  addButton: {
    width: 42,
    height: 33,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonText: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 20,
  },
});

export default TerminalTabs;
