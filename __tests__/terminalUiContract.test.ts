import fs from 'fs';
import path from 'path';
import vm from 'vm';

const readProjectFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('terminal Android UI contract', () => {
  it('keeps the Android terminal above an overlaying IME', () => {
    const ideScreen = readProjectFile('src/screens/IDEScreen.tsx');

    expect(ideScreen).toContain(
      "behavior={Platform.OS === 'ios' ? 'padding' : 'height'}",
    );
  });

  it('does not apply safe-area padding twice inside the terminal WebView', () => {
    const html = readProjectFile(
      'android/app/src/main/assets/terminal/index.html',
    );

    expect(html).not.toContain('env(safe-area-inset-top');
    expect(html).toMatch(/html, body[\s\S]*?padding: 0;/);
  });

  it('joins soft-wrapped rows but preserves ordinary command-output lines', () => {
    const html = readProjectFile(
      'android/app/src/main/assets/terminal/index.html',
    );

    expect(html).toContain('line.isWrapped && logicalLine !== null');
    expect(html).toContain("return logicalLines.join('\\n');");
    expect(html).toContain(
      "logicalLines[logicalLines.length - 1] === ''",
    );

    const functionStart = html.indexOf('function getBufferText()');
    const functionEnd = html.indexOf(
      'function handleCopyCommand()',
      functionStart,
    );
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const rows = [
      { text: 'adev:project$ npm install --', isWrapped: false },
      { text: 'foreground-scripts', isWrapped: true },
      { text: 'compiled native addon', isWrapped: false },
      { text: '', isWrapped: false },
      { text: '', isWrapped: false },
    ];
    const context = {
      term: {
        buffer: {
          active: {
            length: rows.length,
            getLine: (index: number) => ({
              isWrapped: rows[index].isWrapped,
              translateToString: () => rows[index].text,
            }),
          },
        },
      },
      copiedText: '',
    };

    vm.runInNewContext(
      `${html.slice(functionStart, functionEnd)}; copiedText = getBufferText();`,
      context,
    );
    expect(context.copiedText).toBe(
      'adev:project$ npm install --foreground-scripts\ncompiled native addon',
    );
  });

  it('owns Android IME text without duplicating physical xterm input', () => {
    const html = readProjectFile(
      'android/app/src/main/assets/terminal/index.html',
    );

    expect(html).toContain("t === 'insertText'");
    expect(html).toContain("t === 'insertCompositionText'");
    expect(html).toContain("t === 'deleteContentBackward'");
    expect(html).toContain("t === 'insertLineBreak'");
    expect(html).toContain('term.attachCustomKeyEventHandler');
    expect(html).toContain('event.keyCode === 229');
    expect(html).toContain('isMirroredXtermInput(data, Date.now())');

    const functionStart = html.indexOf('function compositionPatch(');
    const functionEnd = html.indexOf(
      'function hardenAndroidInput()',
      functionStart,
    );
    const context = { patch: null as null | { erase: number; insert: string } };
    vm.runInNewContext(
      `${html.slice(functionStart, functionEnd)}; patch = compositionPatch('pri', 'print');`,
      context,
    );
    expect(context.patch).toEqual({ erase: 0, insert: 'nt' });

    vm.runInNewContext(
      `${html.slice(functionStart, functionEnd)}; patch = compositionPatch('printenvv', 'printenv');`,
      context,
    );
    expect(context.patch).toEqual({ erase: 1, insert: '' });
  });

  it('routes complete xterm protocol replies as exact PTY bytes, never keyboard text', () => {
    const html = readProjectFile(
      'android/app/src/main/assets/terminal/index.html',
    );
    const terminalView = readProjectFile(
      'src/components/terminal/TerminalView.tsx',
    );
    const nativeModule = readProjectFile('src/native/PtyNativeModule.ts');

    const functionStart = html.indexOf('function terminalBytesToBase64(');
    const functionEnd = html.indexOf('let ctrlArmed = false', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const bridgeMessages: string[] = [];
    const ordinaryData: Array<{data: string; wasUserInput: boolean}> = [];
    const context = {
      window: {
        btoa: (value: string) => Buffer.from(value, 'latin1').toString('base64'),
        ReactNativeWebView: {
          postMessage: (value: string) => bridgeMessages.push(value),
        },
      },
      terminal: {
        _core: {
          coreService: {
            triggerDataEvent: (data: string, wasUserInput: boolean) => {
              ordinaryData.push({data, wasUserInput});
            },
          },
        },
      },
    };
    vm.runInNewContext(
      `${html.slice(functionStart, functionEnd)};
       installTerminalResponseRouter(terminal);
       terminal._core.coreService.triggerDataEvent('typed', true);
       terminal._core.coreService.triggerDataEvent('\\x1b]4;5;rgb:c5c5/8686/c0c0\\x1b\\\\', false);`,
      context,
    );

    expect(ordinaryData).toEqual([{data: 'typed', wasUserInput: true}]);
    expect(bridgeMessages).toHaveLength(1);
    const response = JSON.parse(bridgeMessages[0]);
    expect(response.type).toBe('terminalResponse');
    expect(Buffer.from(response.base64, 'base64').toString('latin1')).toBe(
      '\x1b]4;5;rgb:c5c5/8686/c0c0\x1b\\',
    );
    expect(terminalView).toContain("case 'terminalResponse':");
    expect(terminalView).toContain('PtyNativeModule.writeBase64');
    expect(nativeModule).toContain('writeBase64(sessionId: number, base64: string)');
  });

  it('renders terminal directions as vectors rather than font glyphs', () => {
    const accessory = readProjectFile(
      'src/components/terminal/TerminalAccessoryBar.tsx',
    );
    const icons = readProjectFile('src/components/icons/index.tsx');

    for (const glyph of ['←', '↑', '↓', '→']) {
      expect(accessory).not.toContain(`label: '${glyph}'`);
    }
    for (const direction of ['left', 'up', 'down', 'right']) {
      expect(accessory).toContain(`icon: 'arrow-${direction}'`);
      expect(icons).toContain(`case 'arrow-${direction}'`);
    }
  });
});
