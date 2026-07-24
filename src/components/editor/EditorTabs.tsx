import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useEditorStore } from '../../stores';

interface EditorTabsProps {
  compact?: boolean;
}

export const EditorTabs: React.FC<EditorTabsProps> = ({ compact = false }) => {
  const { openFiles, activeFilePath, setActiveFile, closeFile } = useEditorStore();

  if (openFiles.length === 0) {
    return null;
  }

  return (
    <View style={[styles.container, compact && styles.containerCompact]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {openFiles.map(file => (
          <TouchableOpacity
            key={file.path}
            style={[
              styles.tab,
              compact && styles.tabCompact,
              file.path === activeFilePath && styles.activeTab,
            ]}
            onPress={() => setActiveFile(file.path)}
          >
            <Text
              style={[
                styles.tabText,
                file.path === activeFilePath && styles.activeTabText,
              ]}
              numberOfLines={1}
            >
              {file.isDirty ? '● ' : ''}
              {file.name}
            </Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => closeFile(file.path)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Text style={styles.closeButtonText}>×</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    height: 36,
  },
  containerCompact: {
    height: 32,
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
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginRight: 2,
    backgroundColor: '#2d2d2d',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    maxWidth: 160,
  },
  tabCompact: {
    paddingHorizontal: 8,
    maxWidth: 120,
  },
  activeTab: {
    backgroundColor: '#1e1e1e',
  },
  tabText: {
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
});

export default EditorTabs;
