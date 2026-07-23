import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useEditorStore } from '../../stores';
import { EditorView } from './EditorView';
import { EditorTabs } from './EditorTabs';

export const EditorPanel: React.FC = () => {
  const { openFiles, activeFilePath } = useEditorStore();
  
  const activeFile = openFiles.find(f => f.path === activeFilePath);

  return (
    <View style={styles.container}>
      <EditorTabs />
      <View style={styles.editorContainer}>
        {activeFile ? (
          <EditorView
            filePath={activeFile.path}
            content={activeFile.content}
            language={activeFile.language}
          />
        ) : (
          <View style={styles.welcomeScreen}>
            <Text style={styles.welcomeTitle}>ADEV Studio</Text>
            <Text style={styles.welcomeSubtitle}>Desktop-class development on Android</Text>
            <View style={styles.shortcuts}>
              <Text style={styles.shortcutText}>Open a file from the explorer to start editing</Text>
              <Text style={styles.shortcutText}>Create a new project from the templates</Text>
              <Text style={styles.shortcutText}>Use the terminal to run commands</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  editorContainer: {
    flex: 1,
  },
  welcomeScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1e1e1e',
    padding: 20,
  },
  welcomeTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  welcomeSubtitle: {
    fontSize: 16,
    color: '#888888',
    marginBottom: 40,
  },
  shortcuts: {
    alignItems: 'center',
  },
  shortcutText: {
    fontSize: 14,
    color: '#666666',
    marginBottom: 8,
  },
});

export default EditorPanel;
