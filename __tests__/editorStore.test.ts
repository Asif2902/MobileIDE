jest.mock('../src/native', () => ({
  FileSystemNativeModule: {
    readFile: jest.fn(async () => ''),
    writeFile: jest.fn(async () => true),
    exists: jest.fn(async () => false),
  },
  MobileIDENativeModule: {
    getRuntimePaths: jest.fn(async () => ({ home: '/runtime/home' })),
  },
}));

import {FileSystemNativeModule} from '../src/native';
import {getLanguageFromPath, useEditorStore} from '../src/stores/editorStore';

const fsMock = FileSystemNativeModule as jest.Mocked<typeof FileSystemNativeModule>;

describe('mobile editor state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useEditorStore.setState({
      openFiles: [],
      activeFilePath: null,
      fontSize: 14,
      wordWrap: true,
      diagnostics: {},
      cursorLine: 1,
      cursorColumn: 1,
      revealRequest: null,
    });
  });

  it.each([
    ['next.config.mjs', 'javascript'],
    ['eslint.config.cjs', 'javascript'],
    ['vite.config.mts', 'typescript'],
    ['src/view.tsx', 'typescript'],
    ['.env', 'ini'],
    ['.env.local', 'ini'],
    ['Dockerfile', 'dockerfile'],
    ['Dockerfile.dev', 'dockerfile'],
  ])('detects %s as %s', (path, language) => {
    expect(getLanguageFromPath(`/workspace/${path}`)).toBe(language);
  });

  it('clamps and persists the editor font size', async () => {
    useEditorStore.getState().setFontSize(100);

    expect(useEditorStore.getState().fontSize).toBe(32);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fsMock.writeFile).toHaveBeenCalledWith(
      '/runtime/home/.adev-editor-settings.json',
      JSON.stringify({fontSize: 32, wordWrap: true}),
    );
  });

  it('restores persisted font and wrap preferences', async () => {
    fsMock.exists.mockResolvedValueOnce(true);
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify({fontSize: 18, wordWrap: false}));

    await useEditorStore.getState().loadPreferences();

    expect(useEditorStore.getState().fontSize).toBe(18);
    expect(useEditorStore.getState().wordWrap).toBe(false);
  });

  it('opens a problem file and publishes an exact reveal request', async () => {
    fsMock.readFile.mockResolvedValueOnce('const broken = ;');

    await useEditorStore.getState().revealLocation('/workspace/src/app.ts', 9, 4);

    expect(useEditorStore.getState().activeFilePath).toBe('/workspace/src/app.ts');
    expect(useEditorStore.getState().revealRequest).toMatchObject({
      path: '/workspace/src/app.ts',
      line: 9,
      column: 4,
    });
  });
});
