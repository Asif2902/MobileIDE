import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useEditorStore } from '../../stores';
import { EditorView } from './EditorView';
import { EditorTabs } from './EditorTabs';

export const EditorPanel: React.FC = () => {
  const { openFiles, activeFilePath, diagnostics, cursorLine, cursorColumn } = useEditorStore();

  const activeFile = openFiles.find(f => f.path === activeFilePath);
  const diag = activeFile ? diagnostics[activeFile.path] : undefined;
  const errors = diag?.errors ?? 0;
  const warnings = diag?.warnings ?? 0;

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
      {activeFile && (
        <View style={styles.statusBar}>
          <View style={styles.statusLeft}>
            <View style={styles.statusItem}>
              <Text style={[styles.statusIcon, errors > 0 ? styles.errorText : styles.mutedText]}>⨂</Text>
              <Text style={errors > 0 ? styles.errorText : styles.mutedText}>{errors}</Text>
            </View>
            <View style={styles.statusItem}>
              <Text style={[styles.statusIcon, warnings > 0 ? styles.warnText : styles.mutedText]}>⚠</Text>
              <Text style={warnings > 0 ? styles.warnText : styles.mutedText}>{warnings}</Text>
            </View>
          </View>
          <View style={styles.statusRight}>
            <Text style={styles.mutedText}>Ln {cursorLine}, Col {cursorColumn}</Text>
            <Text style={styles.langText}>{activeFile.language}</Text>
          </View>
        </View>
      )}
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
  statusBar: {
    height: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#007acc',
    paddingHorizontal: 10,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 14,
  },
  statusIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  mutedText: {
    color: '#ffffff',
    fontSize: 12,
    marginLeft: 12,
  },
  errorText: {
    color: '#ffd0d0',
    fontSize: 12,
    fontWeight: '600',
  },
  warnText: {
    color: '#fff0c0',
    fontSize: 12,
    fontWeight: '600',
  },
  langText: {
    color: '#ffffff',
    fontSize: 12,
    marginLeft: 12,
    textTransform: 'uppercase',
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
