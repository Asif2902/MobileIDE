import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent, WebView as WebViewType } from 'react-native-webview';
import { useTerminalStore, getOutputBuffer } from '../../stores';
import { PtyEventEmitter, PTY_EVENTS, TerminalOutputEvent } from '../../native';

interface TerminalViewProps {
  sessionId: number;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ sessionId }) => {
  const webViewRef = useRef<WebViewType>(null);
  const isReady = useRef(false);
  const pendingOutput = useRef<string[]>([]);
  
  const { writeToSession, resizeSession } = useTerminalStore();

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
      }
    } catch (error) {
      console.error('Error handling WebView message:', error);
    }
  }, [sessionId, writeToSession, resizeSession]);

  const terminalHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background-color: #1e1e1e; }
        #terminal { width: 100%; height: 100%; padding: 4px; }
        .xterm { height: 100%; }
        .xterm-viewport { overflow-y: auto !important; }
      </style>
    </head>
    <body>
      <div id="terminal"></div>
      <script>
        // Simple terminal emulation without xterm.js for now
        const terminal = document.getElementById('terminal');
        let output = '';
        
        const term = {
          write: function(data) {
            output += data;
            terminal.innerHTML = '<pre style="color:#d4d4d4;font-family:monospace;font-size:14px;white-space:pre-wrap;word-wrap:break-word;margin:0;">' + escapeHtml(output) + '</pre>';
            terminal.scrollTop = terminal.scrollHeight;
          },
          clear: function() {
            output = '';
            terminal.innerHTML = '';
          },
          cols: 80,
          rows: 24,
          focus: function() {},
          blur: function() {}
        };
        
        function escapeHtml(text) {
          const div = document.createElement('div');
          div.textContent = text;
          return div.innerHTML;
        }
        
        function handleMessage(data) {
          try {
            const message = JSON.parse(data);
            switch (message.type) {
              case 'output':
                term.write(message.data);
                break;
              case 'clear':
                term.clear();
                break;
              case 'focus':
                term.focus();
                break;
            }
          } catch (e) {
            console.error('Error:', e);
          }
        }
        
        // Keyboard input handling
        document.addEventListener('keydown', function(e) {
          let data = '';
          if (e.key === 'Enter') data = '\\r';
          else if (e.key === 'Backspace') data = '\\x7f';
          else if (e.key === 'Tab') { data = '\\t'; e.preventDefault(); }
          else if (e.key === 'Escape') data = '\\x1b';
          else if (e.ctrlKey && e.key.length === 1) {
            data = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64);
          }
          else if (e.key.length === 1) data = e.key;
          
          if (data) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'input',
              data: data
            }));
          }
        });
        
        // Notify ready
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'ready',
          cols: term.cols,
          rows: term.rows
        }));
        
        // Focus on touch
        terminal.addEventListener('touchstart', function() {
          term.focus();
        });
      </script>
    </body>
    </html>
  `;

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: terminalHtml }}
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
      />
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
});

export default TerminalView;
