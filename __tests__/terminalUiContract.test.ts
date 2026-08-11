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
});
