import fs from 'fs';
import path from 'path';

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
    expect(source).toContain("const FONT_SIZE_KEY = 'adev-terminal-font-size'");
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
  });

  it('offers a movement-cancelled Android long-press selection path', () => {
    expect(source).toContain('longPressTimer = setTimeout');
    expect(source).toContain('Math.abs(touch.clientY - longPressY) > 12');
    expect(source).toContain("type: 'openSelectionModal'");
  });
});
