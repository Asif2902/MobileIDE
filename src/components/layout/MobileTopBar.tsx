import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useUIStore, useTerminalStore } from '../../stores';
import { Icon } from '../icons';

const VIEW_TITLES: Record<string, string> = {
  files: 'Explorer',
  editor: 'Editor',
  terminal: 'Terminal',
  git: 'Source Control',
  settings: 'Settings',
};

/**
 * Compact top app bar for the phone layout. Shows the current view title
 * and contextual actions (e.g. new terminal on the Terminal tab).
 */
export const MobileTopBar: React.FC = () => {
  const { activeView } = useUIStore();
  const { createSession } = useTerminalStore();

  const handleNewTerminal = async () => {
    try {
      await createSession();
    } catch (error) {
      console.error('Failed to create terminal:', error);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.brandName}>ADEV</Text>
        <Text style={styles.brandSuffix}>Studio</Text>
        <Text style={styles.divider}>·</Text>
        <Text style={styles.viewTitle}>{VIEW_TITLES[activeView]}</Text>
      </View>

      <View style={styles.actions}>
        {activeView === 'terminal' && (
          <TouchableOpacity
            style={styles.action}
            onPress={handleNewTerminal}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="plus" size={22} color="#ffffff" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 48,
    paddingHorizontal: 14,
    backgroundColor: '#181818',
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandName: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  brandSuffix: {
    color: '#8b5cf6',
    fontSize: 16,
    fontWeight: '800',
    marginLeft: 3,
  },
  divider: {
    color: '#555555',
    fontSize: 16,
    marginHorizontal: 8,
  },
  viewTitle: {
    color: '#bbbbbb',
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  action: {
    padding: 4,
    marginLeft: 8,
  },
});

export default MobileTopBar;
