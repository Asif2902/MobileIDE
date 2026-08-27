import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, Image } from 'react-native';
import { useUIStore, useTerminalStore, useEditorStore } from '../../stores';
import { Icon } from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

const VIEW_TITLES: Record<string, string> = {
  files: 'Explorer',
  editor: 'Editor',
  terminal: 'Terminal',
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
        <View style={styles.brandMark}>
          <Image
            source={require('../../assets/logo.jpg')}
            style={styles.brandLogo}
            resizeMode="contain"
            accessibilityLabel="ADEV Studio logo"
          />
        </View>
        <View style={styles.brandCopy}>
          <View style={styles.brandLine}>
            <Text style={styles.brandName}>ADEV</Text>
            <Text style={styles.brandSuffix}>Studio</Text>
          </View>
          <Text style={styles.viewTitle} numberOfLines={1}>
            {VIEW_TITLES[activeView]}
            {activeView === 'editor' && activeFile ? `  /  ${activeFile.name}` : ''}
            {isDirty ? '  •' : ''}
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        {activeView === 'editor' && activeFile && (
          <TouchableOpacity
            style={[styles.action, styles.saveAction, !isDirty && styles.saveDisabled]}
            onPress={handleSave}
            disabled={!isDirty || saving}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="save" size={18} color={isDirty ? uiColors.text : uiColors.textMuted} />
          </TouchableOpacity>
        )}
        {activeView === 'terminal' && (
          <TouchableOpacity
            style={styles.action}
            onPress={handleNewTerminal}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Icon name="plus" size={20} color={uiColors.text} />
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
    height: 60,
    paddingHorizontal: 16,
    backgroundColor: uiColors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  brandMark: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    overflow: 'hidden',
  },
  brandLogo: {
    width: 38,
    height: 38,
  },
  brandCopy: {
    flex: 1,
    minWidth: 0,
  },
  brandLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  brandName: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  brandSuffix: {
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    fontSize: 14,
    marginLeft: 4,
  },
  viewTitle: {
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    fontSize: 11,
    marginTop: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  action: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    borderRadius: uiRadii.medium,
    backgroundColor: uiColors.surfaceRaised,
    borderWidth: 1,
    borderColor: uiColors.border,
  },
  saveAction: {
    backgroundColor: uiColors.accent,
    borderColor: uiColors.accent,
  },
  saveDisabled: {
    backgroundColor: uiColors.surfaceRaised,
    borderColor: uiColors.border,
  },
});

export default MobileTopBar;
