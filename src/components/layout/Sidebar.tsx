import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUIStore } from '../../stores';
import { FileExplorer } from '../explorer';
import {uiColors, uiFonts} from '../../theme';

export const Sidebar: React.FC = () => {
  const { activeSidebarView, isSidebarVisible, sidebarWidth } = useUIStore();

  if (!isSidebarVisible) {
    return null;
  }

  const renderContent = () => {
    switch (activeSidebarView) {
      case 'explorer':
        return <FileExplorer />;
      case 'search':
        return (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Search</Text>
            <Text style={styles.placeholderSubtext}>Search across files (coming soon)</Text>
          </View>
        );
      case 'settings':
        return (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Settings</Text>
            <Text style={styles.placeholderSubtext}>IDE settings (coming soon)</Text>
          </View>
        );
      default:
        return <FileExplorer />;
    }
  };

  return (
    <View style={[styles.container, { width: sidebarWidth }]}>
      {renderContent()}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: uiColors.canvas,
    borderRightWidth: 1,
    borderRightColor: uiColors.border,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  placeholderText: {
    fontSize: 16,
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    marginBottom: 8,
  },
  placeholderSubtext: {
    fontSize: 12,
    color: uiColors.textMuted,
  },
});

export default Sidebar;
