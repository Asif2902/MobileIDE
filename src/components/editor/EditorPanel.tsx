import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  Alert,
  TextInput,
} from 'react-native';
import { useEditorStore, useUIStore } from '../../stores';
import { EditorSearchResult, EditorView, EditorViewHandle } from './EditorView';
import { EditorTabs } from './EditorTabs';
import { Icon } from '../icons';
import {uiColors, uiFonts, uiRadii} from '../../theme';

export const EditorPanel: React.FC = () => {
  const {
    openFiles,
    activeFilePath,
    diagnostics,
    cursorLine,
    cursorColumn,
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
  const setActiveView = useUIStore(state => state.setActiveView);

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

      {/* The single-file save action lives in the top bar. */}
      {activeFile && (
        <View style={[styles.toolbar, isCompact && styles.toolbarCompact]}>
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
              <Icon name="arrow-up" size={17} color={uiColors.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.searchAction}
              onPress={() => editorRef.current?.find(searchQuery, 'next')}
              accessibilityLabel="Next match"
            >
              <Icon name="arrow-down" size={17} color={uiColors.textSecondary} />
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
            <View style={styles.welcomeIcon}>
              <Icon name="editor" size={28} color={uiColors.accentText} />
            </View>
            <Text style={styles.welcomeTitle}>Editor</Text>
            <Text style={styles.welcomeSubtitle}>
              Open a file from your workspace to start editing.
            </Text>
            <TouchableOpacity
              style={styles.welcomeAction}
              onPress={() => setActiveView('files')}
              accessibilityRole="button"
              accessibilityLabel="Browse workspace files">
              <Icon name="files" size={17} color={uiColors.text} />
              <Text style={styles.welcomeActionText}>Browse files</Text>
            </TouchableOpacity>
            <Text style={styles.welcomeHint}>Files open here in editor tabs</Text>
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
    backgroundColor: uiColors.canvas,
  },
  editorContainer: {
    flex: 1,
    minHeight: 80,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: uiColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
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
    backgroundColor: uiColors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: uiRadii.small,
    gap: 6,
    minWidth: 44,
    justifyContent: 'center',
  },
  toolBtnText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 13,
    fontWeight: '600',
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
    color: uiColors.textSecondary,
    fontFamily: uiFonts.medium,
    fontSize: 12,
    fontWeight: '600',
  },
  iconBtnActive: {
    color: uiColors.accentText,
  },
  iconBtnSelected: {
    backgroundColor: uiColors.accentSoft,
  },
  dirtyBadge: {
    color: uiColors.warning,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 4,
  },
  searchPanel: {
    backgroundColor: uiColors.surface,
    borderBottomWidth: 1,
    borderBottomColor: uiColors.border,
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
    borderColor: uiColors.borderStrong,
    borderRadius: 6,
    backgroundColor: uiColors.canvas,
    color: uiColors.text,
    fontFamily: uiFonts.regular,
    fontSize: 13,
    paddingHorizontal: 9,
    paddingVertical: 0,
  },
  matchCount: {
    width: 44,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    fontSize: 11,
    textAlign: 'center',
  },
  searchAction: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: uiColors.surfacePressed,
  },
  replaceAction: {
    height: 34,
    minWidth: 42,
    paddingHorizontal: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: uiColors.accentSoft,
  },
  replaceActionText: {
    color: uiColors.accentText,
    fontFamily: uiFonts.medium,
    fontSize: 11,
  },
  statusBar: {
    minHeight: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: uiColors.surface,
    borderTopWidth: 1,
    borderTopColor: uiColors.border,
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
    color: uiColors.textSecondary,
    fontSize: 11,
    marginLeft: 8,
  },
  errorText: {
    color: uiColors.danger,
    fontSize: 11,
    fontWeight: '600',
  },
  warnText: {
    color: uiColors.warning,
    fontSize: 11,
    fontWeight: '600',
  },
  langText: {
    color: uiColors.textSecondary,
    fontSize: 11,
    marginLeft: 10,
    textTransform: 'uppercase',
  },
  welcomeScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: uiColors.canvas,
    padding: 24,
  },
  welcomeTitle: {
    fontFamily: uiFonts.medium,
    fontSize: 22,
    fontWeight: '600',
    color: uiColors.text,
    marginBottom: 7,
  },
  welcomeIcon: {
    width: 60,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: uiColors.accentSoft,
    borderWidth: 1,
    borderColor: '#382d63',
    marginBottom: 18,
  },
  welcomeSubtitle: {
    maxWidth: 300,
    fontSize: 13,
    lineHeight: 19,
    color: uiColors.textSecondary,
    fontFamily: uiFonts.regular,
    textAlign: 'center',
    marginBottom: 18,
  },
  welcomeAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: uiColors.accent,
    borderRadius: uiRadii.medium,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  welcomeActionText: {
    color: uiColors.text,
    fontFamily: uiFonts.medium,
    fontSize: 13,
    fontWeight: '600',
  },
  welcomeHint: {
    fontSize: 11,
    color: uiColors.textMuted,
    fontFamily: uiFonts.regular,
    textAlign: 'center',
    marginTop: 12,
  },
});

export default EditorPanel;
