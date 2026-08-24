import fs from 'fs';
import path from 'path';

describe('Android Monaco mobile editing contract', () => {
  const editorHtml = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'editor', 'index.html'),
    'utf8',
  );

  it('provides touch selection handles and standard edit actions', () => {
    expect(editorHtml).toContain('selection-handle-start');
    expect(editorHtml).toContain('selection-handle-end');
    expect(editorHtml).toContain('data-edit-action="copy"');
    expect(editorHtml).toContain('data-edit-action="cut"');
    expect(editorHtml).toContain('data-edit-action="paste"');
    expect(editorHtml).toContain('data-edit-action="selectAll"');
    expect(editorHtml).toContain('data-edit-action="delete"');
  });

  it('implements model-backed find, replace, paste, pinch zoom and exact navigation', () => {
    expect(editorHtml).toContain("case 'search':");
    expect(editorHtml).toContain("case 'replace':");
    expect(editorHtml).toContain("case 'replaceAll':");
    expect(editorHtml).toContain("case 'pasteText':");
    expect(editorHtml).toContain("case 'goToLocation':");
    expect(editorHtml).toContain("type: 'fontSizeChanged'");
  });
});
