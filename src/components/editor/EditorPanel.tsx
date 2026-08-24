import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  Alert,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useEditorStore } from '../../stores';
import { EditorSearchResult, EditorView, EditorViewHandle } from './EditorView';
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
    loadPreferences,
  } = useEditorStore();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const isCompact = width < 420 || isLandscape;
  const [saving, setSaving] = useState(false);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [searchResult, setSearchResult] = useState<EditorSearchResult>({
    query: '',
    current: 0,
    total: 0,
  });
  const editorRef = useRef<EditorViewHandle>(null);

  useEffect(() => {
    loadPreferences().catch(() => {});
  }, [loadPreferences]);

  useEffect(() => {
    if (!searchVisible) return;
    const timer = setTimeout(() => editorRef.current?.find(searchQuery, 'next'), 120);
    return () => clearTimeout(timer);
  }, [searchQuery, searchVisible, activeFilePath]);

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

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchResult({ query: '', current: 0, total: 0 });
    editorRef.current?.focusEditor();
  }, []);

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
            style={[styles.iconBtn, searchVisible && styles.iconBtnSelected]}
            onPress={() => setSearchVisible(value => !value)}
            accessibilityRole="button"
            accessibilityLabel="Find and replace"
          >
            <Icon name="search" size={17} color={searchVisible ? '#c4b5fd' : '#aaa'} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setFontSize(fontSize - 1)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Decrease editor font size"
          >
            <Text style={styles.iconBtnText}>A−</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setFontSize(fontSize + 1)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Increase editor font size"
          >
            <Text style={styles.iconBtnText}>A+</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.iconBtn, wordWrap && styles.iconBtnSelected]}
            onPress={toggleWordWrap}
            accessibilityRole="button"
            accessibilityLabel="Toggle word wrap"
          >
            <Text style={[styles.iconBtnText, wordWrap && styles.iconBtnActive]}>Wrap</Text>
          </TouchableOpacity>

          {/* Explicit keyboard affordance when WebView IME is sticky */}
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => editorRef.current?.focusEditor()}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Show editor keyboard"
          >
            <Icon name="keyboard" size={18} color="#aaa" />
          </TouchableOpacity>

          {activeFile.isDirty && (
            <Text style={styles.dirtyBadge} numberOfLines={1}>
              Unsaved
            </Text>
          )}
        </View>
      )}

      {activeFile && searchVisible && (
        <View style={styles.searchPanel}>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Find"
              placeholderTextColor="#777"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => editorRef.current?.find(searchQuery, 'next')}
              selectTextOnFocus
              accessibilityLabel="Find text"
            />
            <Text style={styles.matchCount} numberOfLines={1}>
              {searchResult.total > 0
                ? `${searchResult.current}/${searchResult.total}`
                : searchQuery
                  ? '0/0'
                  : '—'}
            </Text>
            <TouchableOpacity
              style={styles.searchAction}
              onPress={() => editorRef.current?.find(searchQuery, 'previous')}
              accessibilityLabel="Previous match"
            >
              <Text style={styles.searchActionText}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.searchAction}
              onPress={() => editorRef.current?.find(searchQuery, 'next')}
              accessibilityLabel="Next match"
            >
              <Text style={styles.searchActionText}>↓</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.searchAction}
              onPress={closeSearch}
              accessibilityLabel="Close find and replace"
            >
              <Icon name="close" size={16} color="#aaa" />
            </TouchableOpacity>
          </View>
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              value={replacement}
              onChangeText={setReplacement}
              placeholder="Replace"
              placeholderTextColor="#777"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => editorRef.current?.replace(searchQuery, replacement)}
              accessibilityLabel="Replacement text"
            />
            <TouchableOpacity
              style={styles.replaceAction}
              onPress={() => editorRef.current?.replace(searchQuery, replacement)}
              disabled={!searchQuery}
              accessibilityLabel="Replace current match"
            >
              <Text style={styles.replaceActionText}>Replace</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.replaceAction}
              onPress={() => editorRef.current?.replace(searchQuery, replacement, true)}
              disabled={!searchQuery}
              accessibilityLabel="Replace all matches"
            >
              <Text style={styles.replaceActionText}>All</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.editorContainer}>
        {activeFile ? (
          <EditorView
            ref={editorRef}
            filePath={activeFile.path}
            content={activeFile.content}
            language={activeFile.language}
            onSearchResult={setSearchResult}
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
    minWidth: 34,
    minHeight: 32,
    paddingHorizontal: 6,
    paddingVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  iconBtnText: {
    color: '#aaa',
    fontSize: 12,
    fontWeight: '600',
  },
  iconBtnActive: {
    color: '#c4b5fd',
  },
  iconBtnSelected: {
    backgroundColor: '#373044',
  },
  dirtyBadge: {
    color: '#fbbf24',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
  },
  searchPanel: {
    backgroundColor: '#252526',
    borderBottomWidth: 1,
    borderBottomColor: '#333338',
    paddingHorizontal: 8,
    paddingBottom: 6,
    gap: 5,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  searchInput: {
    flex: 1,
    minWidth: 72,
    height: 36,
    borderWidth: 1,
    borderColor: '#45454b',
    borderRadius: 6,
    backgroundColor: '#1e1e1e',
    color: '#e4e4e7',
    fontSize: 13,
    paddingHorizontal: 9,
    paddingVertical: 0,
  },
  matchCount: {
    width: 44,
    color: '#a1a1aa',
    fontSize: 11,
    textAlign: 'center',
  },
  searchAction: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#333338',
  },
  searchActionText: {
    color: '#d4d4d8',
    fontSize: 17,
    fontWeight: '600',
  },
  replaceAction: {
    height: 34,
    minWidth: 42,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: '#373044',
  },
  replaceActionText: {
    color: '#c4b5fd',
    fontSize: 11,
    fontWeight: '700',
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
