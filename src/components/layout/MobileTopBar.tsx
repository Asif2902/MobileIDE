import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useUIStore, useTerminalStore, useEditorStore } from '../../stores';
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
 * and contextual actions (e.g. new terminal, save file).
 */
export const MobileTopBar: React.FC = () => {
  const { activeView } = useUIStore();
  const { createSession } = useTerminalStore();
  const { activeFilePath, openFiles, saveFile } = useEditorStore();
  const [saving, setSaving] = useState(false);
  const activeFile = openFiles.find(f => f.path === activeFilePath);
  const isDirty = !!activeFile?.isDirty;

  const handleNewTerminal = async () => {
    try {
      await createSession();
    } catch (error) {
      console.error('Failed to create terminal:', error);
    }
  };

  const handleSave = async () => {
    if (!activeFilePath || !isDirty) return;
    setSaving(true);
    try {
      await saveFile(activeFilePath);
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message || 'Could not write file');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <Text style={styles.brandName}>ADEV</Text>
        <Text style={styles.brandSuffix}>Studio</Text>
        <Text style={styles.divider}>·</Text>
        <Text style={styles.viewTitle} numberOfLines={1}>
          {VIEW_TITLES[activeView]}
          {activeView === 'editor' && activeFile ? ` · ${activeFile.name}` : ''}
          {isDirty ? ' ●' : ''}
        </Text>
      </View>

      <View style={styles.actions}>
        {activeView === 'editor' && activeFile && (
          <TouchableOpacity
            style={[styles.action, styles.saveAction, !isDirty && styles.saveDisabled]}
            onPress={handleSave}
            disabled={!isDirty || saving}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="save" size={20} color={isDirty ? '#ffffff' : '#666'} />
          </TouchableOpacity>
        )}
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
  saveAction: {
    backgroundColor: '#8b5cf6',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  saveDisabled: {
    backgroundColor: '#333',
  },
});

export default MobileTopBar;
