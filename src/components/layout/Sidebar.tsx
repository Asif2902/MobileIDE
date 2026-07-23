import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUIStore } from '../../stores';
import { FileExplorer } from '../explorer';

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
      case 'git':
        return (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>Source Control</Text>
            <Text style={styles.placeholderSubtext}>Git integration (coming soon)</Text>
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
        return null;
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
    backgroundColor: '#252526',
    borderRightWidth: 1,
    borderRightColor: '#1e1e1e',
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  placeholderText: {
    fontSize: 16,
    color: '#cccccc',
    marginBottom: 8,
  },
  placeholderSubtext: {
    fontSize: 12,
    color: '#666666',
  },
});

export default Sidebar;
