import React, { useRef, useEffect, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { useEditorStore } from '../../stores';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebViewAny = WebView as any;

interface EditorViewProps {
  filePath: string;
  content: string;
  language: string;
}

export const EditorView: React.FC<EditorViewProps> = ({ filePath, content, language }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webViewRef = useRef<any>(null);
  const isReady = useRef(false);
  const { updateContent, fontSize, wordWrap, theme } = useEditorStore();

  useEffect(() => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        openFile(${JSON.stringify(filePath)}, ${JSON.stringify(content)}, ${JSON.stringify(language)});
        true;
      `);
    }
  }, [filePath, content, language]);

  useEffect(() => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        handleMessage(${JSON.stringify(JSON.stringify({ type: 'setTheme', theme }))});
        true;
      `);
    }
  }, [theme]);

  useEffect(() => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        handleMessage(${JSON.stringify(JSON.stringify({ type: 'setFontSize', size: fontSize }))});
        true;
      `);
    }
  }, [fontSize]);

  useEffect(() => {
    if (isReady.current && webViewRef.current) {
      webViewRef.current.injectJavaScript(`
        handleMessage(${JSON.stringify(JSON.stringify({ type: 'setWordWrap', enabled: wordWrap }))});
        true;
      `);
    }
  }, [wordWrap]);

  const handleWebViewMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const message = JSON.parse(event.nativeEvent.data);
      
      switch (message.type) {
        case 'ready':
          isReady.current = true;
          // Open the file
          webViewRef.current?.injectJavaScript(`
            openFile(${JSON.stringify(filePath)}, ${JSON.stringify(content)}, ${JSON.stringify(language)});
            true;
          `);
          break;
          
        case 'change':
          updateContent(filePath, message.content);
          break;
          
        case 'cursor':
          // Could update status bar with cursor position
          break;
      }
    } catch (error) {
      console.error('Error handling WebView message:', error);
    }
  }, [filePath, content, language, updateContent]);

  const editorHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background-color: #1e1e1e; }
        #editor { width: 100%; height: 100%; }
        textarea {
          width: 100%;
          height: 100%;
          background-color: #1e1e1e;
          color: #d4d4d4;
          font-family: monospace;
          font-size: 14px;
          line-height: 1.5;
          padding: 10px;
          border: none;
          outline: none;
          resize: none;
          tab-size: 2;
          white-space: pre-wrap;
          word-wrap: break-word;
        }
      </style>
    </head>
    <body>
      <div id="editor">
        <textarea id="code" spellcheck="false"></textarea>
      </div>
      <script>
        const textarea = document.getElementById('code');
        let currentPath = '';
        
        function openFile(path, content, language) {
          currentPath = path;
          textarea.value = content;
        }
        
        function handleMessage(data) {
          try {
            const message = JSON.parse(data);
            switch (message.type) {
              case 'setTheme':
                // Theme handling
                break;
              case 'setFontSize':
                textarea.style.fontSize = message.size + 'px';
                break;
              case 'setWordWrap':
                textarea.style.whiteSpace = message.enabled ? 'pre-wrap' : 'pre';
                break;
            }
          } catch (e) {
            console.error('Error:', e);
          }
        }
        
        textarea.addEventListener('input', function() {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'change',
            content: textarea.value
          }));
        });
        
        // Tab key support
        textarea.addEventListener('keydown', function(e) {
          if (e.key === 'Tab') {
            e.preventDefault();
            const start = this.selectionStart;
            const end = this.selectionEnd;
            this.value = this.value.substring(0, start) + '  ' + this.value.substring(end);
            this.selectionStart = this.selectionEnd = start + 2;
            
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'change',
              content: textarea.value
            }));
          }
        });
        
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
      </script>
    </body>
    </html>
  `;

  return (
    <View style={styles.container}>
      <WebViewAny
        ref={webViewRef}
        source={{ html: editorHtml }}
        style={styles.webview}
        onMessage={handleWebViewMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        keyboardDisplayRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        scalesPageToFit={false}
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

export default EditorView;
