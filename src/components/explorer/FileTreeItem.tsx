import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { FileEntry } from '../../native';
import { useFileStore, useEditorStore, useUIStore } from '../../stores';

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
}

// Guard rails so the Monaco editor never hangs on content it cannot render.
const MAX_EDITABLE_BYTES = 3 * 1024 * 1024; // 3 MB
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'pdf', 'zip', 'gz',
  'tar', 'rar', '7z', 'apk', 'jar', 'so', 'dll', 'exe', 'bin', 'o', 'a', 'class',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ttf', 'otf', 'woff', 'woff2',
  'node', 'wasm', 'db', 'sqlite', 'sqlite3',
]);

export const FileTreeItem: React.FC<FileTreeItemProps> = ({ entry, depth }) => {
  const [_isRenaming, setIsRenaming] = useState(false);
  const { fileTree, expandedFolders, toggleFolder, loadDirectory } = useFileStore();
  const { openFile } = useEditorStore();
  const { setActiveView } = useUIStore();
  
  const isExpanded = expandedFolders.has(entry.path);
  const children = fileTree.get(entry.path) || [];
  
  const handlePress = () => {
    if (entry.isDirectory) {
      toggleFolder(entry.path);
      if (!isExpanded) {
        loadDirectory(entry.path);
      }
    } else {
      const ext = entry.name.split('.').pop()?.toLowerCase() || '';
      if (BINARY_EXTENSIONS.has(ext)) {
        Alert.alert('Binary file', `"${entry.name}" is a binary file and can't be opened in the text editor.`);
        return;
      }
      if (entry.size > MAX_EDITABLE_BYTES) {
        const mb = (entry.size / (1024 * 1024)).toFixed(1);
        Alert.alert('File too large', `"${entry.name}" is ${mb} MB. Files over 3 MB can't be opened in the editor.`);
        return;
      }
      setActiveView('editor');
      openFile(entry.path).catch(e => Alert.alert('Could not open file', e?.message || String(e)));
    }
  };

  return (
    <View>
      <TouchableOpacity
        style={[styles.item, { paddingLeft: 12 + depth * 16 }]}
        onPress={handlePress}
        onLongPress={() => setIsRenaming(true)}
      >
        {entry.isDirectory ? (
          <Text style={styles.folderIcon}>{isExpanded ? '\u25BC' : '\u25B6'} \uD83D\uDCC1</Text>
        ) : (
          <Text style={styles.fileIcon}>{'\uD83D\uDCC4'}</Text>
        )}
        <Text style={styles.name} numberOfLines={1}>
          {entry.name}
        </Text>
      </TouchableOpacity>
      
      {entry.isDirectory && isExpanded && children.map((child) => (
        <FileTreeItem
          key={child.path}
          entry={child}
          depth={depth + 1}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingRight: 8,
  },
  folderIcon: {
    fontSize: 13,
    marginRight: 6,
  },
  fileIcon: {
    fontSize: 13,
    marginRight: 6,
  },
  name: {
    fontSize: 14,
    color: '#cccccc',
    flex: 1,
  },
});

export default FileTreeItem;
