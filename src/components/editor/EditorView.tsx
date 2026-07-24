import React, { useRef, useEffect, useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { useEditorStore } from '../../stores';
import { ClipboardNativeModule } from '../../native';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebViewAny = WebView as any;

// Real Monaco editor bundled in the app assets. This is the genuine VS Code
// editor engine, so it ships the same language services ("compilers") that
// surface inline errors, warnings, hovers and IntelliSense on desktop.
const MONACO_URI = 'file:///android_asset/editor/index.html';

interface EditorViewProps {
  filePath: string;
  content: string;
  language: string;
}

export const EditorView: React.FC<EditorViewProps> = ({ filePath, content, language }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webViewRef = useRef<any>(null);
  const isReady = useRef(false);
  const { updateContent, setDiagnostics, setCursor, fontSize, wordWrap, theme } = useEditorStore();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readyTimer = useRef<any>(null);

  const startReadyTimer = useCallback(() => {
    if (readyTimer.current) clearTimeout(readyTimer.current);
    readyTimer.current = setTimeout(() => {
      if (!isReady.current) {
        setErrorMsg('The editor engine did not finish loading. This can happen if the device WebView is out of date.');
        setLoadState('error');
      }
    }, 25000);
  }, []);

  useEffect(() => {
    startReadyTimer();
    return () => { if (readyTimer.current) clearTimeout(readyTimer.current); };
  }, [startReadyTimer]);

  const reload = useCallback(() => {
    isReady.current = false;
    setErrorMsg('');
    setLoadState('loading');
    startReadyTimer();
    webViewRef.current?.reload();
  }, [startReadyTimer]);

  const post = useCallback((payload: object) => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(
        `handleMessage(${JSON.stringify(JSON.stringify(payload))}); true;`
      );
    }
  }, []);

  const openActiveFile = useCallback(() => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(
        `openFile(${JSON.stringify(filePath)}, ${JSON.stringify(content)}, ${JSON.stringify(language)}); true;`
      );
    }
  }, [filePath, content, language]);

  // Switch the model whenever the active file changes.
  useEffect(() => {
    openActiveFile();
  }, [openActiveFile]);

  useEffect(() => {
    post({ type: 'setTheme', theme });
  }, [theme, post]);

  useEffect(() => {
    post({ type: 'setFontSize', size: fontSize });
  }, [fontSize, post]);

  useEffect(() => {
    post({ type: 'setWordWrap', enabled: wordWrap });
  }, [wordWrap, post]);

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);

      switch (message.type) {
        case 'ready':
          isReady.current = true;
          if (readyTimer.current) clearTimeout(readyTimer.current);
          setLoadState('ready');
          // Apply persisted preferences, then open the active file.
          post({ type: 'setTheme', theme });
          post({ type: 'setFontSize', size: fontSize });
          post({ type: 'setWordWrap', enabled: wordWrap });
          openActiveFile();
          break;

        case 'change':
          updateContent(filePath, message.content);
          break;

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

        case 'fatal':
          // The Monaco loader reported a hard failure; show the real reason
          // instead of leaving the user on an endless spinner.
          console.error(`Monaco fatal [${message.where}]:`, message.message);
          isReady.current = false;
          if (readyTimer.current) clearTimeout(readyTimer.current);
          setErrorMsg(`Editor engine error (${message.where}): ${message.message}`);
          setLoadState('error');
          break;

        case 'warn':
          // Non-fatal Monaco noise (stub workers, optional assets) — log only.
          console.warn(`Monaco warn [${message.where}]:`, message.message);
          break;

        case 'copyText':
          ClipboardNativeModule.setString(message.text || '').catch(err => {
            console.error('Editor clipboard copy failed:', err);
          });
          break;
      }
    } catch (error) {
      console.error('Error handling WebView message:', error);
    }
  }, [filePath, post, openActiveFile, theme, fontSize, wordWrap, updateContent, setCursor, setDiagnostics]);

  return (
    <View style={styles.container}>
      <WebViewAny
        ref={webViewRef}
        source={{ uri: MONACO_URI }}
        style={styles.webview}
        onMessage={handleWebViewMessage}
        onError={() => { setErrorMsg('The editor page failed to load.'); setLoadState('error'); }}
        onRenderProcessGone={() => { isReady.current = false; setErrorMsg('The editor process stopped unexpectedly.'); setLoadState('error'); }}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        keyboardDisplayRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        scalesPageToFit={false}
        originWhitelist={['*']}
        // Required so Monaco can load its bundled assets and language workers
        // from the file:// origin (this is what powers the live diagnostics).
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        androidHardwareAccelerationDisabled={false}
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
  container: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
  webview: {
    flex: 1,
    backgroundColor: '#1e1e1e',
  },
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
