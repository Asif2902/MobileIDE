import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useEditorStore, useUIStore, useTerminalStore } from '../../stores';
import { Icon } from '../icons';
import {uiColors, uiFonts} from '../../theme';

export const StatusBar: React.FC = () => {
  const { activeFilePath, openFiles } = useEditorStore();
  const { toggleBottomPanel, toggleSidebar } = useUIStore();
  const { sessions } = useTerminalStore();
  
  const activeFile = openFiles.find(f => f.path === activeFilePath);
  const activeTerminals = sessions.filter(s => s.isAlive).length;

  return (
    <View style={styles.container}>
      {/* Left side */}
      <View style={styles.left}>
        <TouchableOpacity style={styles.item} onPress={toggleSidebar}>
          <Icon name="menu" size={14} color={uiColors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.item} onPress={toggleBottomPanel}>
          <Icon name="terminal" size={14} color={uiColors.textSecondary} />
          <Text style={styles.itemText}>{activeTerminals}</Text>
        </TouchableOpacity>
      </View>
      
      {/* Right side */}
      <View style={styles.right}>
        {activeFile && (
          <>
            <View style={styles.item}>
              <Text style={styles.itemText}>{activeFile.language}</Text>
            </View>
            <View style={styles.item}>
              <Text style={styles.itemText}>UTF-8</Text>
            </View>
          </>
        )}
        <View style={styles.item}>
          <Text style={styles.itemText}>ADEV Studio</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: uiColors.surface,
    borderTopWidth: 1,
    borderTopColor: uiColors.border,
    height: 24,
    paddingHorizontal: 8,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  itemText: {
    fontSize: 11,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    marginLeft: 4,
  },
});

export default StatusBar;
