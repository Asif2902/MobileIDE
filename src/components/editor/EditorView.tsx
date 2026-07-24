import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { useEditorStore } from '../../stores';
import { ClipboardNativeModule } from '../../native';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebViewAny = WebView as any;

const MONACO_URI = 'file:///android_asset/editor/index.html';

interface EditorViewProps {
  filePath: string;
  content: string;
  language: string;
  onRequestFocus?: () => void;
}

export const EditorView: React.FC<EditorViewProps> = ({
  filePath,
  content,
  language,
  onRequestFocus,
}) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webViewRef = useRef<any>(null);
  const isReady = useRef(false);
  // Last path pushed into Monaco. Content updates from typing must NOT re-open
  // the file or the caret/keyboard die on every keystroke.
  const lastOpenedPath = useRef<string | null>(null);
  const contentRef = useRef(content);
  contentRef.current = content;

  const { updateContent, setDiagnostics, setCursor, fontSize, wordWrap, theme, saveFile } =
    useEditorStore();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readyTimer = useRef<any>(null);

  const startReadyTimer = useCallback(() => {
    if (readyTimer.current) clearTimeout(readyTimer.current);
    readyTimer.current = setTimeout(() => {
      if (!isReady.current) {
        setErrorMsg(
          'The editor engine did not finish loading. Try Retry, or update Android System WebView.',
        );
        setLoadState('error');
      }
    }, 25000);
  }, []);

  useEffect(() => {
    startReadyTimer();
    return () => {
      if (readyTimer.current) clearTimeout(readyTimer.current);
    };
  }, [startReadyTimer]);

  const inject = useCallback((js: string) => {
    webViewRef.current?.injectJavaScript(`${js}; true;`);
  }, []);

  const post = useCallback(
    (payload: object) => {
      if (isReady.current && webViewRef.current) {
        inject(`handleMessage(${JSON.stringify(JSON.stringify(payload))})`);
      }
    },
    [inject],
  );

  const pushFileToMonaco = useCallback(
    (path: string, fileContent: string | null, lang: string) => {
      if (!isReady.current || !webViewRef.current) return;
      // null content => keep existing model buffer (path switch already loaded)
      inject(
        `openFile(${JSON.stringify(path)}, ${
          fileContent === null ? 'null' : JSON.stringify(fileContent)
        }, ${JSON.stringify(lang)})`,
      );
      lastOpenedPath.current = path;
    },
    [inject],
  );

  // Path / language changes only — never re-inject on every content keystroke.
  useEffect(() => {
    if (!isReady.current) return;
    if (lastOpenedPath.current !== filePath) {
      pushFileToMonaco(filePath, contentRef.current, language);
    } else {
      pushFileToMonaco(filePath, null, language);
    }
  }, [filePath, language, pushFileToMonaco]);

  useEffect(() => {
    post({ type: 'setTheme', theme });
  }, [theme, post]);

  useEffect(() => {
    post({ type: 'setFontSize', size: fontSize });
  }, [fontSize, post]);

  useEffect(() => {
    post({ type: 'setWordWrap', enabled: wordWrap });
  }, [wordWrap, post]);

  const onLayout = useCallback(() => {
    post({ type: 'layout' });
  }, [post]);

  const reload = useCallback(() => {
    isReady.current = false;
    lastOpenedPath.current = null;
    setErrorMsg('');
    setLoadState('loading');
    startReadyTimer();
    webViewRef.current?.reload();
  }, [startReadyTimer]);

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data);

        switch (message.type) {
          case 'ready':
            isReady.current = true;
            if (readyTimer.current) clearTimeout(readyTimer.current);
            setLoadState('ready');
            post({ type: 'setTheme', theme });
            post({ type: 'setFontSize', size: fontSize });
            post({ type: 'setWordWrap', enabled: wordWrap });
            pushFileToMonaco(filePath, contentRef.current, language);
            setTimeout(() => post({ type: 'focus' }), 200);
            break;

          case 'change': {
            const path = message.path || filePath;
            updateContent(path, message.content);
            break;
          }

          case 'cursor':
            setCursor(message.line, message.column);
            break;

          case 'markers':
            setDiagnostics(message.path || filePath, {
              errors: message.errors || 0,
              warnings: message.warnings || 0,
              problems: message.problems || [],
            });
            break;

          case 'saveRequest':
            saveFile(message.path || filePath).catch(err => console.error('Save failed:', err));
            break;

          case 'fatal':
            console.error(`Monaco fatal [${message.where}]:`, message.message);
            isReady.current = false;
            if (readyTimer.current) clearTimeout(readyTimer.current);
            setErrorMsg(`Editor engine error (${message.where}): ${message.message}`);
            setLoadState('error');
            break;

          case 'warn':
            console.warn(`Monaco warn [${message.where}]:`, message.message);
            break;

          case 'copyText':
            ClipboardNativeModule.setString(message.text || '').catch(err => {
              console.error('Editor clipboard copy failed:', err);
            });
            break;

          case 'fileOpened':
            onRequestFocus?.();
            break;
        }
      } catch (error) {
        console.error('Error handling WebView message:', error);
      }
    },
    [
      filePath,
      language,
      post,
      pushFileToMonaco,
      theme,
      fontSize,
      wordWrap,
      updateContent,
      setCursor,
      setDiagnostics,
      saveFile,
      onRequestFocus,
    ],
  );

  return (
    <View style={styles.container} onLayout={onLayout}>
      <WebViewAny
        ref={webViewRef}
        source={{ uri: MONACO_URI }}
        style={styles.webview}
        onMessage={handleWebViewMessage}
        onError={() => {
          setErrorMsg('The editor page failed to load.');
          setLoadState('error');
        }}
        onRenderProcessGone={() => {
          isReady.current = false;
          setErrorMsg('The editor process stopped unexpectedly.');
          setLoadState('error');
        }}
        javaScriptEnabled
        domStorageEnabled
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        {...(Platform.OS === 'android'
          ? {
              nestedScrollEnabled: true,
              overScrollMode: 'never',
              androidLayerType: 'hardware',
              focusable: true,
            }
          : {})}
        allowsInlineMediaPlayback
        scalesPageToFit={false}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        androidHardwareAccelerationDisabled={false}
        onTouchEnd={() => {
          post({ type: 'focus' });
          onRequestFocus?.();
        }}
      />
      {loadState === 'loading' && (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#8b5cf6" />
          <Text style={styles.overlayText}>Loading editor…</Text>
        </View>
      )}
      {loadState === 'error' && (
        <View style={styles.overlay}>
          <Text style={styles.overlayTitle}>Editor failed to load</Text>
          <Text style={styles.overlayText}>{errorMsg}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={reload}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1e1e1e' },
  webview: { flex: 1, backgroundColor: '#1e1e1e' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1e1e1e',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  overlayTitle: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  overlayText: {
    color: '#888',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
  },
  retryBtn: {
    marginTop: 20,
    backgroundColor: '#8b5cf6',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  retryBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});

export default EditorView;
