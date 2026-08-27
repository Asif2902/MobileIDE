import fs from 'fs';
import path from 'path';
import vm from 'vm';

describe('Android terminal interaction contract', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'android',
      'app',
      'src',
      'main',
      'assets',
      'terminal',
      'index.html',
    ),
    'utf8',
  );

  it('persists user font zoom instead of replacing it during every fit', () => {
    expect(source).toContain("const FONT_SIZE_KEY = 'adev-terminal-font-size-v2'");
    expect(source).toContain('window.localStorage.setItem(FONT_SIZE_KEY');
    expect(source).toContain('hasSavedFontSize ? term.options.fontSize : pickFontSize()');
  });

  it('preserves a scrolled-up viewport while output continues', () => {
    expect(source).toContain('buffer.viewportY >= buffer.baseY - 1');
    expect(source).toContain('if (shouldFollow)');
    expect(source).not.toContain('// Keep cursor in view when lots of npm output scrolls');
  });

  it('separates screen clearing from full local scrollback clearing', () => {
    expect(source).toContain("case 'clearScreen':");
    expect(source).toContain("case 'clearScrollback':");
    expect(source).toContain("type: 'bufferCleared'");
    expect(source).toContain('term.clear()');
    expect(source).toContain("submittedInputLine.trim() === 'clear'");
    expect(source).toContain("term.parser.registerCsiHandler({ final: 'J' }");

    const fullClearStart = source.indexOf('function finishFullClear()');
    const fullClearEnd = source.indexOf('function scheduleFullClear()', fullClearStart);
    const fullClearBody = source.slice(fullClearStart, fullClearEnd);
    expect(fullClearBody).toContain('term.clear()');
    expect(fullClearBody).toContain('notifyBufferCleared()');
    expect(fullClearBody).not.toContain('sendInput(');
    expect(fullClearBody).not.toContain("type: 'input'");
  });

  it('recognizes only an exact submitted clear command', () => {
    const functionStart = source.indexOf('function observeSubmittedInput(');
    const functionEnd = source.indexOf('function sendInput(', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const context = {
      submittedInputLine: '',
      awaitingClearSequence: false,
      observed: false,
    };
    vm.runInNewContext(
      `${source.slice(functionStart, functionEnd)}; observeSubmittedInput('clear\\r'); observed = awaitingClearSequence;`,
      context,
    );
    expect(context.observed).toBe(true);

    context.submittedInputLine = '';
    context.awaitingClearSequence = false;
    vm.runInNewContext(
      `${source.slice(functionStart, functionEnd)}; observeSubmittedInput('echo clear\\r'); observed = awaitingClearSequence;`,
      context,
    );
    expect(context.observed).toBe(false);
  });

  it('requires a live selection plus a full hold before any copy affordance', () => {
    const holdStart = source.indexOf('--- Hold-to-copy');
    const holdEnd = source.indexOf('</script>', holdStart);
    expect(holdStart).toBeGreaterThanOrEqual(0);
    const block = source.slice(holdStart, holdEnd);

    expect(block).toContain('HOLD_COPY_DELAY_MS = 600');
    expect(block).toContain('dx * dx + dy * dy > HOLD_COPY_MOVE_CANCEL_PX_SQ');
    expect(block).toContain('if (!selected) return;');
    expect(block).toContain('flashSelectionThen(showHoldCopyBar)');
    expect(block).toContain('term.onSelectionChange');
    // Haptics and accidental popups are gone from the hold path entirely.
    expect(block).not.toContain('navigator.vibrate');
    expect(block).not.toContain("'openSelectionModal'");
    // The select/copy sheet stays reachable through deliberate toolbar paths.
    expect(source).toContain("case 'copy': handleCopyCommand(); break;");
    expect(source).toContain("case 'openSelectModal':");
  });
});
