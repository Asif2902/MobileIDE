import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View,
  StyleSheet,
  Modal,
  Text,
  TouchableOpacity,
  TextInput,
  useWindowDimensions,
  LayoutChangeEvent,
  Platform,
} from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTerminalStore, getOutputBuffer } from '../../stores';
import {
  PtyEventEmitter,
  PTY_EVENTS,
  TerminalOutputEvent,
  TerminalExitEvent,
  ClipboardNativeModule,
} from '../../native';
import { TerminalAccessoryBar } from './TerminalAccessoryBar';
import { Icon } from '../icons';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebViewAny = WebView as any;

interface TerminalViewProps {
  sessionId: number;
  active?: boolean;
}

function fontForWidth(width: number): number {
  if (width < 360) return 10;
  if (width < 480) return 11;
  if (width < 700) return 12;
  if (width < 1000) return 13;
  return 14;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ sessionId, active = true }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webViewRef = useRef<any>(null);
  const isReady = useRef(false);
  const pendingOutput = useRef<string[]>([]);
  const { width: windowWidth } = useWindowDimensions();

  // Ctrl/Alt "armed" state mirrored from the WebView so the accessory bar can
  // highlight the modifier while it waits for the next key.
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const [fontSize, setFontSize] = useState(() => fontForWidth(windowWidth));

  // Selection modal state for finger text selection
  const [isSelectModalVisible, setIsSelectModalVisible] = useState(false);
  const [selectModalText, setSelectModalText] = useState('');
  const selectInputRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();

  const { writeToSession, resizeSession } = useTerminalStore();
  const isKeyboardBarVisible = useTerminalStore(state => state.isKeyboardBarVisible);

  // When the select/copy sheet opens, jump to the bottom so the latest output is visible.
  useEffect(() => {
    if (!isSelectModalVisible) return;
    const t = setTimeout(() => {
      try {
        selectInputRef.current?.focus();
        // scrollToEnd exists on TextInput for multiline on Android/iOS
        (selectInputRef.current as any)?.scrollToEnd?.({ animated: false });
        // Place caret at end so long-press selection can start from the bottom
        const len = selectModalText.length;
        selectInputRef.current?.setNativeProps?.({
          selection: { start: len, end: len },
        });
      } catch (_e) {}
    }, 120);
    return () => clearTimeout(t);
  }, [isSelectModalVisible, selectModalText]);

  // Post a message into the terminal WebView's handleMessage() dispatcher.
  const postToWeb = useCallback((msg: object) => {
    webViewRef.current?.injectJavaScript(
      `handleMessage(${JSON.stringify(JSON.stringify(msg))}); true;`,
    );
  }, []);

  const changeFontSize = useCallback((delta: number) => {
    setFontSize(prev => {
      const next = Math.max(9, Math.min(22, prev + delta));
      postToWeb({ type: 'fontSize', size: next });
      return next;
    });
  }, [postToWeb]);

  // Subscribe to terminal output
  useEffect(() => {
    const subscription = PtyEventEmitter.addListener(
      PTY_EVENTS.OUTPUT,
      (event: TerminalOutputEvent) => {
        if (event.sessionId === sessionId) {
          if (isReady.current && webViewRef.current) {
            webViewRef.current.injectJavaScript(`
              handleMessage(${JSON.stringify(JSON.stringify({
                type: 'output',
                data: event.data
              }))});
              true;
            `);
          } else {
            pendingOutput.current.push(event.data);
          }
        }
      }
    );

    return () => subscription.remove();
  }, [sessionId]);

  // Show a clear notice when the shell/process exits so a dead terminal is not
  // mistaken for a frozen one (e.g. after a command crashes the session).
  useEffect(() => {
    const subscription = PtyEventEmitter.addListener(
      PTY_EVENTS.EXIT,
      (event: TerminalExitEvent) => {
        if (event.sessionId === sessionId) {
          const notice = `\r\n\x1b[33m[process exited with code ${event.exitCode}]\x1b[0m\r\n`;
          if (isReady.current && webViewRef.current) {
            webViewRef.current.injectJavaScript(`
              handleMessage(${JSON.stringify(JSON.stringify({ type: 'output', data: notice }))});
              true;
            `);
          } else {
            pendingOutput.current.push(notice);
          }
        }
      }
    );
    return () => subscription.remove();
  }, [sessionId]);

  // When this terminal becomes the active tab, re-fit to the current viewport
  // and focus it so the keyboard targets the right session.
  useEffect(() => {
    if (active && isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        handleMessage(${JSON.stringify(JSON.stringify({ type: 'fit' }))});
        handleMessage(${JSON.stringify(JSON.stringify({ type: 'focus' }))});
        true;
      `);
    }
  }, [active]);

  // Phone rotate / tablet split: re-fit and adapt font so text stays on-screen.
  useEffect(() => {
    const next = fontForWidth(windowWidth);
    setFontSize(next);
    if (isReady.current) {
      postToWeb({ type: 'fontSize', size: next });
      postToWeb({ type: 'fit' });
    }
  }, [windowWidth, postToWeb]);

  // Keyboard bar show/hide changes available height — re-fit.
  useEffect(() => {
    if (active && isReady.current) {
      const t = setTimeout(() => postToWeb({ type: 'fit' }), 80);
      return () => clearTimeout(t);
    }
  }, [isKeyboardBarVisible, active, postToWeb]);

  const onContainerLayout = useCallback((_e: LayoutChangeEvent) => {
    if (isReady.current) {
      postToWeb({ type: 'fit' });
    }
  }, [postToWeb]);

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      switch (message.type) {
        case 'ready':
          isReady.current = true;
          // Flush pending output
          pendingOutput.current.forEach(data => {
            webViewRef.current?.injectJavaScript(`
              handleMessage(${JSON.stringify(JSON.stringify({
                type: 'output',
                data
              }))});
              true;
            `);
          });
          pendingOutput.current = [];
          
          // Load existing buffer
          const buffer = getOutputBuffer(sessionId);
          if (buffer.length > 0) {
            webViewRef.current?.injectJavaScript(`
              handleMessage(${JSON.stringify(JSON.stringify({
                type: 'output',
                data: buffer.join('')
              }))});
              true;
            `);
          }
          
          // Set initial size
          if (message.cols && message.rows) {
            resizeSession(sessionId, message.cols, message.rows);
          }
          break;
          
        case 'input':
          writeToSession(sessionId, message.data);
          break;
          
        case 'resize':
          resizeSession(sessionId, message.cols, message.rows);
          break;

        case 'modifier':
          setCtrlArmed(!!message.ctrl);
          setAltArmed(!!message.alt);
          break;

        case 'openSelectionModal':
          setSelectModalText(message.bufferText || '');
          setIsSelectModalVisible(true);
          break;

        case 'copyText':
          // System clipboard via native module (WebView clipboard is unreliable).
          ClipboardNativeModule.setString(message.text || '').catch(err => {
            console.error('Clipboard copy failed:', err);
          });
          break;

        case 'requestPaste':
          ClipboardNativeModule.getString()
            .then(text => {
              if (text) {
                postToWeb({ type: 'pasteText', data: text });
              }
            })
            .catch(err => console.error('Clipboard paste failed:', err));
          break;

        case 'copied':
          break;
      }
    } catch (error) {
      console.error('Error handling WebView message:', error);
    }
  }, [sessionId, writeToSession, resizeSession, postToWeb]);

  return (
    <View style={styles.container} onLayout={onContainerLayout}>
      <WebViewAny
        ref={webViewRef}
        source={{ uri: 'file:///android_asset/terminal/index.html' }}
        style={styles.webview}
        onMessage={handleWebViewMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        keyboardDisplayRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        scalesPageToFit={false}
        setSupportMultipleWindows={false}
        androidHardwareAccelerationDisabled={false}
        originWhitelist={['*']}
        // Required so the bundled xterm.js and its addons load from file://.
        allowFileAccess={true}
        allowFileAccessFromFileURLs={true}
        allowUniversalAccessFromFileURLs={true}
        mixedContentMode="always"
        // Prevent Android from zooming / clipping the xterm cell grid.
        setBuiltInZoomControls={false}
        textZoom={100}
        overScrollMode="never"
      />
      {active && isKeyboardBarVisible && (
        <TerminalAccessoryBar
          ctrlArmed={ctrlArmed}
          altArmed={altArmed}
          onKey={seq => postToWeb({ type: 'key', data: seq })}
          onCtrl={() => postToWeb({ type: 'armCtrl' })}
          onAlt={() => postToWeb({ type: 'armAlt' })}
          onCopy={() => postToWeb({ type: 'copy' })}
          onPaste={() => postToWeb({ type: 'requestPasteFromNative' })}
          onSelectText={() => postToWeb({ type: 'openSelectModal' })}
          onFontSmaller={() => changeFontSize(-1)}
          onFontLarger={() => changeFontSize(1)}
        />
      )}

      {/* Select & copy — TextInput scrolls to the bottom (Text+ScrollView does not on Android). */}
      <Modal
        visible={isSelectModalVisible}
        animationType="slide"
        onRequestClose={() => setIsSelectModalVisible(false)}
        presentationStyle="fullScreen"
      >
        <View
          style={[
            styles.modalContainer,
            {
              paddingTop: Math.max(insets.top, 12) + 8,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select & copy</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setIsSelectModalVisible(false)}
            >
              <Icon name="close" size={20} color="#ffffff" />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalHint}>
            Scroll freely · long-press to select · or Copy all for the full buffer
          </Text>
          <View style={styles.modalJumpRow}>
            <TouchableOpacity
              style={styles.jumpBtn}
              onPress={() => {
                selectInputRef.current?.setNativeProps?.({
                  selection: { start: 0, end: 0 },
                });
              }}
            >
              <Text style={styles.jumpBtnText}>↑ Top</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.jumpBtn}
              onPress={() => {
                const len = selectModalText.length;
                (selectInputRef.current as any)?.scrollToEnd?.({ animated: true });
                selectInputRef.current?.setNativeProps?.({
                  selection: { start: len, end: len },
                });
              }}
            >
              <Text style={styles.jumpBtnText}>↓ Bottom</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            ref={selectInputRef}
            style={styles.selectableInput}
            value={selectModalText}
            multiline
            // editable + no soft keyboard: Android can scroll + select reliably
            editable
            showSoftInputOnFocus={false}
            caretHidden={false}
            scrollEnabled
            textAlignVertical="top"
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            // Keep buffer read-only for the user without killing selection
            onChangeText={() => {
              /* ignore edits — buffer is a snapshot */
            }}
            contextMenuHidden={false}
            selectTextOnFocus={false}
          />
          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={styles.copyAllButton}
              onPress={() => {
                ClipboardNativeModule.setString(selectModalText || '').catch(() => {});
                setIsSelectModalVisible(false);
              }}
            >
              <Text style={styles.copyAllButtonText}>Copy all</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.modalCancelButton}
              onPress={() => setIsSelectModalVisible(false)}
            >
              <Text style={styles.modalCancelText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  modalContainer: {
    flex: 1,
    backgroundColor: '#1e1e1e',
    paddingHorizontal: 16,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#333333',
    flexShrink: 0,
  },
  modalTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  closeButton: {
    padding: 6,
  },
  modalHint: {
    color: '#8a8a92',
    fontSize: 12,
    marginTop: 8,
    marginBottom: 6,
    flexShrink: 0,
  },
  modalJumpRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    flexShrink: 0,
  },
  jumpBtn: {
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  jumpBtnText: {
    color: '#c4b5fd',
    fontSize: 13,
    fontWeight: '600',
  },
  selectableInput: {
    flex: 1,
    minHeight: 160,
    backgroundColor: '#141414',
    borderRadius: 8,
    borderColor: '#2a2a2a',
    borderWidth: 1,
    padding: 12,
    color: '#d4d4d4',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo',
    fontSize: 12,
    lineHeight: 18,
  },
  modalFooter: {
    flexShrink: 0,
    paddingTop: 12,
    gap: 8,
  },
  copyAllButton: {
    backgroundColor: '#8b5cf6',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  copyAllButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  modalCancelButton: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#333',
  },
  modalCancelText: {
    color: '#a1a1aa',
    fontSize: 14,
  },
});

export default TerminalView;
