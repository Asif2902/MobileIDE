import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { useEditorStore } from '../../stores';
import {uiColors, uiFonts, uiRadii} from '../../theme';

interface EditorTabsProps {
  compact?: boolean;
}

export const EditorTabs: React.FC<EditorTabsProps> = ({ compact = false }) => {
  // Content changes are owned by Monaco and must not redraw the tab strip on
  // every keystroke. The signature changes only when visible tab metadata does.
  const tabSignature = useEditorStore(state =>
    JSON.stringify(
      state.openFiles.map(file => ({
        path: file.path,
        name: file.name,
        isDirty: file.isDirty,
      })),
    ),
  );
  const activeFilePath = useEditorStore(state => state.activeFilePath);
  const setActiveFile = useEditorStore(state => state.setActiveFile);
  const closeFile = useEditorStore(state => state.closeFile);
  const openFiles = JSON.parse(tabSignature) as Array<{
    path: string;
    name: string;
    isDirty: boolean;
  }>;

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
    backgroundColor: uiColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
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
    backgroundColor: uiColors.surfaceRaised,
    borderRadius: uiRadii.small,
    maxWidth: 160,
  },
  tabCompact: {
    paddingHorizontal: 8,
    maxWidth: 120,
  },
  activeTab: {
    backgroundColor: uiColors.canvas,
  },
  tabText: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    fontSize: 12,
    marginRight: 6,
  },
  activeTabText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
  },
  closeButton: {
    padding: 2,
  },
  closeButtonText: {
    color: uiColors.textMuted,
    fontSize: 14,
    lineHeight: 14,
  },
});

export default EditorTabs;
