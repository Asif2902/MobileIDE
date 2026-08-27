import React, {memo, useCallback} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Alert} from 'react-native';
import {FileEntry} from '../../native';
import {useFileStore, useEditorStore, useUIStore} from '../../stores';
import {Icon} from '../icons';
import {getFileVisual} from './treeModel';
import {uiColors, uiFonts} from '../../theme';

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
  const deleteItem = useFileStore(state => state.deleteItem);
  const openFile = useEditorStore(state => state.openFile);
  const openFiles = useEditorStore(state => state.openFiles);
  const closeFile = useEditorStore(state => state.closeFile);
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

  const performDelete = useCallback(async () => {
    try {
      await deleteItem(entry.path);
      const deletedPrefix = `${entry.path}/`;
      openFiles
        .filter(file => file.path === entry.path || file.path.startsWith(deletedPrefix))
        .forEach(file => closeFile(file.path));
    } catch (error) {
      Alert.alert(
        `Could not delete ${entry.isDirectory ? 'folder' : 'file'}`,
        (error as Error)?.message || String(error),
      );
    }
  }, [closeFile, deleteItem, entry, openFiles]);

  const confirmDelete = useCallback(() => {
    const kind = entry.isDirectory ? 'folder' : 'file';
    const warning = entry.isDirectory
      ? `Delete “${entry.name}” and everything inside it? This cannot be undone.`
      : `Delete “${entry.name}”? This cannot be undone.`;
    Alert.alert(`Delete ${kind}?`, warning, [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          performDelete().catch(() => undefined);
        },
      },
    ]);
  }, [entry, performDelete]);

  return (
    <View
      style={[
        styles.item,
        isSelected && styles.itemSelected,
      ]}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${entry.isDirectory ? 'Folder' : 'File'} ${entry.name}`}
        accessibilityState={{expanded: entry.isDirectory ? isExpanded : undefined, selected: isSelected}}
        activeOpacity={0.65}
        style={[styles.itemContent, {paddingLeft: 10 + Math.min(depth, 12) * 14}]}
        onPress={handlePress}
        onLongPress={confirmDelete}>
        <View style={styles.chevronSlot}>
          {entry.isDirectory && (
            <Icon
              name={isExpanded ? 'chevron-down' : 'chevron-right'}
              size={14}
              color={uiColors.textMuted}
              strokeWidth={2.3}
            />
          )}
        </View>
        <View style={styles.iconSlot}>
          <Icon
            name={entry.isDirectory ? (isExpanded ? 'folder-open' : 'folder') : 'file'}
            size={18}
            color={entry.isDirectory ? uiColors.accentText : visual.color}
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
      <TouchableOpacity
        style={styles.deleteButton}
        onPress={confirmDelete}
        hitSlop={{top: 4, bottom: 4, left: 4, right: 4}}
        accessibilityRole="button"
        accessibilityLabel={`Delete ${entry.isDirectory ? 'folder' : 'file'} ${entry.name}`}>
        <Icon
          name="trash"
          size={16}
          color={uiColors.textMuted}
          strokeWidth={1.8}
        />
      </TouchableOpacity>
    </View>
  );
};

export const FileTreeItem = memo(FileTreeRow);

const styles = StyleSheet.create({
  item: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  itemContent: {
    minHeight: 40,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  deleteButton: {
    width: 42,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemSelected: {
    backgroundColor: uiColors.accentSoft,
    borderLeftColor: uiColors.accent,
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
    backgroundColor: uiColors.surface,
  },
  name: {
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    flex: 1,
    fontSize: 13,
  },
  hiddenName: {
    color: uiColors.textMuted,
  },
  selectedName: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontWeight: '600',
  },
});

export default FileTreeItem;
