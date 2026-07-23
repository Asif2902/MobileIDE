import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { FileEntry } from '../../native';
import { useFileStore, useEditorStore } from '../../stores';
import { Icon } from '../icons';

interface FileTreeItemProps {
  entry: FileEntry;
  depth: number;
}

// Color hint for common source file extensions.
const getFileColor = (name: string): string => {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const colorMap: Record<string, string> = {
    js: '#f7df1e',
    jsx: '#61dafb',
    ts: '#3178c6',
    tsx: '#61dafb',
    json: '#cbcb41',
    html: '#e34c26',
    css: '#563d7c',
    scss: '#cf649a',
    md: '#42a5f5',
    py: '#3572A5',
  };
  return colorMap[ext] || '#8a8a92';
};

export const FileTreeItem: React.FC<FileTreeItemProps> = ({ entry, depth }) => {
  const [isRenaming, setIsRenaming] = useState(false);
  const { fileTree, expandedFolders, toggleFolder, loadDirectory } = useFileStore();
  const { openFile } = useEditorStore();
  
  const isExpanded = expandedFolders.has(entry.path);
  const children = fileTree.get(entry.path) || [];
  
  const handlePress = () => {
    if (entry.isDirectory) {
      toggleFolder(entry.path);
      if (!isExpanded) {
        loadDirectory(entry.path);
      }
    } else {
      openFile(entry.path);
    }
  };

  return (
    <View>
      <TouchableOpacity
        style={[styles.item, { paddingLeft: 12 + depth * 16 }]}
        onPress={handlePress}
        onLongPress={() => setIsRenaming(true)}
      >
        {entry.isDirectory && (
          <View style={styles.chevron}>
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} color="#8a8a92" />
          </View>
        )}
        <View style={styles.icon}>
          {entry.isDirectory ? (
            <Icon name={isExpanded ? 'folder-open' : 'folder'} size={15} color="#dcb67a" />
          ) : (
            <Icon name="file" size={15} color={getFileColor(entry.name)} />
          )}
        </View>
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
    paddingVertical: 4,
    paddingRight: 8,
  },
  icon: {
    marginRight: 6,
  },
  chevron: {
    marginRight: 2,
  },
  name: {
    fontSize: 13,
    color: '#cccccc',
    flex: 1,
  },
});

export default FileTreeItem;
