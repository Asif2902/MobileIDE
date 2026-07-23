import React, { useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useFileStore } from '../../stores';
import { FileTreeItem } from './FileTreeItem';
import { Icon } from '../icons';

export const FileExplorer: React.FC = () => {
  const { 
    currentWorkspace, 
    workspaces, 
    fileTree, 
    loadWorkspaces, 
    openWorkspace,
    createFile,
    createFolder,
  } = useFileStore();
  
  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);
  
  const rootEntries = currentWorkspace ? (fileTree.get(currentWorkspace) || []) : [];
  const workspaceName = currentWorkspace?.split('/').pop() || 'No Workspace';

  const handleNewFile = async () => {
    if (currentWorkspace) {
      const name = 'new-file.js'; // In production, show input dialog
      await createFile(currentWorkspace, name);
    }
  };

  const handleNewFolder = async () => {
    if (currentWorkspace) {
      const name = 'new-folder'; // In production, show input dialog
      await createFolder(currentWorkspace, name);
    }
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>EXPLORER</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.actionButton} onPress={handleNewFile}>
            <Icon name="file" size={16} color="#bbbbbb" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleNewFolder}>
            <Icon name="folder" size={16} color="#bbbbbb" />
          </TouchableOpacity>
        </View>
      </View>
      
      {/* Workspace selector */}
      <View style={styles.workspaceHeader}>
        <Text style={styles.workspaceName}>{workspaceName}</Text>
      </View>
      
      {/* File tree */}
      <ScrollView style={styles.treeContainer}>
        {currentWorkspace ? (
          rootEntries.length > 0 ? (
            rootEntries.map((entry) => (
              <FileTreeItem
                key={entry.path}
                entry={entry}
                depth={0}
              />
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No files yet</Text>
              <Text style={styles.emptySubtext}>Create a file or clone a repository</Text>
            </View>
          )
        ) : (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No workspace open</Text>
            <Text style={styles.emptySubtext}>Select or create a workspace</Text>
            
            {/* Workspace list */}
            {workspaces.map((ws) => (
              <TouchableOpacity
                key={ws.path}
                style={styles.workspaceItem}
                onPress={() => openWorkspace(ws.path)}
              >
                <Text style={styles.workspaceItemText}>{ws.name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#252526',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
  },
  headerTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#bbbbbb',
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: 'row',
  },
  actionButton: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  actionButtonText: {
    fontSize: 12,
  },
  workspaceHeader: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2d2d2d',
  },
  workspaceName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  treeContainer: {
    flex: 1,
  },
  emptyState: {
    padding: 20,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#888888',
    marginBottom: 4,
  },
  emptySubtext: {
    fontSize: 12,
    color: '#666666',
    marginBottom: 16,
  },
  workspaceItem: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#2d2d2d',
    borderRadius: 4,
    marginBottom: 4,
    width: '100%',
  },
  workspaceItemText: {
    fontSize: 13,
    color: '#cccccc',
  },
});

export default FileExplorer;
