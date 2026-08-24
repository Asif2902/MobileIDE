import React, {memo, useCallback} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Alert} from 'react-native';
import {FileEntry} from '../../native';
import {useFileStore, useEditorStore, useUIStore} from '../../stores';
import {Icon} from '../icons';
import {getFileVisual} from './treeModel';

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
}

const MAX_EDITABLE_BYTES = 3 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf', 'zip', 'gz',
  'tar', 'rar', '7z', 'apk', 'jar', 'so', 'dll', 'exe', 'bin', 'o', 'a', 'class',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ttf', 'otf', 'woff', 'woff2',
  'node', 'wasm', 'db', 'sqlite', 'sqlite3',
]);

const FileTreeRow: React.FC<FileTreeItemProps> = ({entry, depth}) => {
  const isExpanded = useFileStore(state => state.expandedFolders.has(entry.path));
  const toggleFolder = useFileStore(state => state.toggleFolder);
  const openFile = useEditorStore(state => state.openFile);
  const activeFilePath = useEditorStore(state => state.activeFilePath);
  const setActiveView = useUIStore(state => state.setActiveView);
  const isSelected = !entry.isDirectory && activeFilePath === entry.path;
  const visual = getFileVisual(entry.name);

  const handlePress = useCallback(() => {
    if (entry.isDirectory) {
      toggleFolder(entry.path);
      return;
    }
    const ext = entry.name.split('.').pop()?.toLowerCase() || '';
    if (BINARY_EXTENSIONS.has(ext)) {
      Alert.alert('Binary file', `"${entry.name}" cannot be opened in the text editor.`);
      return;
    }
    if (entry.size > MAX_EDITABLE_BYTES) {
      const mb = (entry.size / (1024 * 1024)).toFixed(1);
      Alert.alert('File too large', `"${entry.name}" is ${mb} MB. The editor limit is 3 MB.`);
      return;
    }
    setActiveView('editor');
    openFile(entry.path).catch(error =>
      Alert.alert('Could not open file', error?.message || String(error)),
    );
  }, [entry, openFile, setActiveView, toggleFolder]);

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`${entry.isDirectory ? 'Folder' : 'File'} ${entry.name}`}
      accessibilityState={{expanded: entry.isDirectory ? isExpanded : undefined, selected: isSelected}}
      activeOpacity={0.65}
      style={[
        styles.item,
        {paddingLeft: 10 + Math.min(depth, 12) * 14},
        isSelected && styles.itemSelected,
      ]}
      onPress={handlePress}>
      <View style={styles.chevronSlot}>
        {entry.isDirectory && (
          <Icon
            name={isExpanded ? 'chevron-down' : 'chevron-right'}
            size={14}
            color="#8e8e93"
            strokeWidth={2.3}
          />
        )}
      </View>
      <View style={styles.iconSlot}>
        <Icon
          name={entry.isDirectory ? (isExpanded ? 'folder-open' : 'folder') : 'file'}
          size={18}
          color={entry.isDirectory ? '#c4a7ff' : visual.color}
          strokeWidth={1.8}
        />
        {!entry.isDirectory && !!visual.label && (
          <Text style={[styles.typeBadge, {color: visual.color}]}>{visual.label}</Text>
        )}
      </View>
      <Text
        style={[styles.name, entry.isHidden && styles.hiddenName, isSelected && styles.selectedName]}
        numberOfLines={1}
        ellipsizeMode="middle">
        {entry.name}
      </Text>
    </TouchableOpacity>
  );
};

export const FileTreeItem = memo(FileTreeRow);

const styles = StyleSheet.create({
  item: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 12,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  itemSelected: {
    backgroundColor: '#352b4d',
    borderLeftColor: '#a78bfa',
  },
  chevronSlot: {
    width: 18,
    alignItems: 'center',
  },
  iconSlot: {
    width: 25,
    height: 25,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 5,
  },
  typeBadge: {
    position: 'absolute',
    bottom: -1,
    fontSize: 6,
    lineHeight: 7,
    fontWeight: '800',
    backgroundColor: '#252526',
  },
  name: {
    color: '#d4d4d4',
    flex: 1,
    fontSize: 13,
  },
  hiddenName: {
    color: '#a8a8ad',
  },
  selectedName: {
    color: '#ffffff',
    fontWeight: '600',
  },
});

export default FileTreeItem;
