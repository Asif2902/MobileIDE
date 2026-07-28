import React, { useCallback, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useEditorStore } from '../../stores';
import { EditorView, EditorViewHandle } from './EditorView';
import { EditorTabs } from './EditorTabs';
import { Icon } from '../icons';

export const EditorPanel: React.FC = () => {
  const {
    openFiles,
    activeFilePath,
    diagnostics,
    cursorLine,
    cursorColumn,
    saveFile,
    saveAllFiles,
    fontSize,
    setFontSize,
    toggleWordWrap,
    wordWrap,
  } = useEditorStore();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isCompact = width < 420 || isLandscape;
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<EditorViewHandle>(null);

  const activeFile = openFiles.find(f => f.path === activeFilePath);
  const diag = activeFile ? diagnostics[activeFile.path] : undefined;
  const errors = diag?.errors ?? 0;
  const warnings = diag?.warnings ?? 0;
  const dirtyCount = openFiles.filter(f => f.isDirty).length;

  const handleSave = useCallback(async () => {
    if (!activeFilePath) return;
    setSaving(true);
    try {
      await saveFile(activeFilePath);
    } catch (e) {
      Alert.alert('Save failed', (e as Error).message || 'Could not write file');
    } finally {
      setSaving(false);
    }
  }, [activeFilePath, saveFile]);

  const handleSaveAll = useCallback(async () => {
    setSaving(true);
    try {
      await saveAllFiles();
    } catch (e) {
      Alert.alert('Save all failed', (e as Error).message || 'Could not write files');
    } finally {
      setSaving(false);
    }
  }, [saveAllFiles]);

  return (
    <View style={styles.container}>
      <EditorTabs compact={isCompact} />

      {/* Action toolbar — Save is always visible when a file is open */}
      {activeFile && (
        <View style={[styles.toolbar, isCompact && styles.toolbarCompact]}>
          <TouchableOpacity
            style={[styles.toolBtn, !activeFile.isDirty && styles.toolBtnDisabled]}
            onPress={handleSave}
            disabled={saving || !activeFile.isDirty}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Icon name="save" size={16} color={activeFile.isDirty ? '#ffffff' : '#777'} />
                {!isCompact && (
                  <Text
                    style={[styles.toolBtnText, !activeFile.isDirty && styles.toolBtnTextDisabled]}
                  >
                    Save
                  </Text>
                )}
              </>
            )}
          </TouchableOpacity>

          {dirtyCount > 1 && (
            <TouchableOpacity style={styles.toolBtn} onPress={handleSaveAll} disabled={saving}>
              <Text style={styles.toolBtnText}>Save all ({dirtyCount})</Text>
            </TouchableOpacity>
          )}

          <View style={styles.toolSpacer} />

          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setFontSize(fontSize - 1)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.iconBtnText}>A−</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setFontSize(fontSize + 1)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.iconBtnText}>A+</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={toggleWordWrap}>
            <Text style={[styles.iconBtnText, wordWrap && styles.iconBtnActive]}>Wrap</Text>
          </TouchableOpacity>

          {/* Explicit keyboard affordance when WebView IME is sticky */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => editorRef.current?.focusEditor()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.iconBtnText}>⌨</Text>
          </TouchableOpacity>

          {activeFile.isDirty && (
            <Text style={styles.dirtyBadge} numberOfLines={1}>
              Unsaved
            </Text>
          )}
        </View>
      )}

      <View style={styles.editorContainer}>
        {activeFile ? (
          <EditorView
            ref={editorRef}
            filePath={activeFile.path}
            content={activeFile.content}
            language={activeFile.language}
          />
        ) : (
          <View style={styles.welcomeScreen}>
            <Text style={styles.welcomeTitle}>Editor</Text>
            <Text style={styles.welcomeSubtitle}>
              Open a file from the Files tab to start editing
            </Text>
            <Text style={styles.welcomeHint}>
              Tap the editor to show the keyboard · Save from the toolbar above
            </Text>
          </View>
        )}
      </View>

      {activeFile && (
        <View style={[styles.statusBar, isCompact && styles.statusBarCompact]}>
          <View style={styles.statusLeft}>
            <Text style={errors > 0 ? styles.errorText : styles.mutedText}>
              {errors} err
            </Text>
            <Text style={warnings > 0 ? styles.warnText : styles.mutedText}>
              {warnings} warn
            </Text>
          </View>
          <View style={styles.statusRight}>
            <Text style={styles.mutedText} numberOfLines={1}>
              Ln {cursorLine}, Col {cursorColumn}
            </Text>
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
    minHeight: 80,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#1e1e1e',
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 40,
    gap: 6,
  },
  toolbarCompact: {
    paddingVertical: 4,
    minHeight: 36,
  },
  toolBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#8b5cf6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 6,
    minWidth: 44,
    justifyContent: 'center',
  },
  toolBtnDisabled: {
    backgroundColor: '#333',
  },
  toolBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  toolBtnTextDisabled: {
    color: '#777',
  },
  toolSpacer: { flex: 1 },
  iconBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  iconBtnText: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
  },
  iconBtnActive: {
    color: '#c4b5fd',
  },
  dirtyBadge: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
  },
  statusBar: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#007acc',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusBarCompact: {
    minHeight: 22,
    paddingVertical: 2,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  mutedText: {
    color: '#ffffff',
    fontSize: 11,
    marginLeft: 8,
  },
  errorText: {
    color: '#ffd0d0',
    fontSize: 11,
    fontWeight: '600',
  },
  warnText: {
    color: '#fff0c0',
    fontSize: 11,
    fontWeight: '600',
  },
  langText: {
    color: '#ffffff',
    fontSize: 11,
    marginLeft: 10,
    textTransform: 'uppercase',
  },
  welcomeScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1e1e1e',
    padding: 24,
  },
  welcomeTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  welcomeSubtitle: {
    fontSize: 15,
    color: '#888888',
    textAlign: 'center',
    marginBottom: 12,
  },
  welcomeHint: {
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
  },
});

export default EditorPanel;
