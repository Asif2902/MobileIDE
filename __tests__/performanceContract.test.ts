import fs from 'fs';
import path from 'path';

const source = (relative: string) =>
  fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

describe('mobile performance contract', () => {
  it('initializes the IDE behind a short native-driver splash', () => {
    const app = source('App.tsx');
    const splash = source('src/components/SplashScreen.tsx');
    expect(app.indexOf('<IDEScreen />')).toBeLessThan(app.indexOf('showSplash &&'));
    expect(splash).toContain('duration = 650');
    expect(splash).toContain('useNativeDriver: true');
    expect(splash).not.toContain('useNativeDriver: false');
  });

  it('keeps expensive phone screens mounted after their first visit', () => {
    const screen = source('src/screens/IDEScreen.tsx');
    expect(screen).toContain('mountedMobileViews');
    expect(screen).toContain("display: 'none'");
    expect(screen).toContain("<TerminalPanel visible={validActiveView === 'terminal'} />");
  });

  it('batches terminal output before crossing the WebView bridge', () => {
    const terminal = source('src/components/terminal/TerminalView.tsx');
    expect(terminal).toContain('queueBridgeOutput');
    expect(terminal).toContain('64 * 1024');
    expect(terminal).toContain('activeRef.current ? 16 : 64');
  });

  it('does not subscribe Monaco to the entire editor store', () => {
    const editor = source('src/components/editor/EditorView.tsx');
    expect(editor).not.toContain('} = useEditorStore();');
    expect(editor).toContain('useEditorStore(state => state.updateContent)');
  });
});
