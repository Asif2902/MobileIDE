import fs from 'fs';
import path from 'path';

const readProjectFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('primary navigation surface', () => {
  it('shows four balanced phone tabs without a redundant Git UI', () => {
    const bottomTabs = readProjectFile(
      'src/components/layout/BottomTabBar.tsx',
    );
    const tabIDs = [...bottomTabs.matchAll(/\{ id: '([^']+)'/g)].map(
      match => match[1],
    );

    expect(tabIDs).toEqual(['files', 'editor', 'terminal', 'settings']);
    expect(bottomTabs).not.toContain("label: 'Git'");
    expect(bottomTabs).toMatch(/tab:\s*\{[\s\S]*?flex: 1,/);
  });

  it('removes Git from phone and tablet navigation state and routing', () => {
    const ideScreen = readProjectFile('src/screens/IDEScreen.tsx');
    const uiStore = readProjectFile('src/stores/uiStore.ts');
    const activityBar = readProjectFile(
      'src/components/layout/ActivityBar.tsx',
    );
    const sidebar = readProjectFile('src/components/layout/Sidebar.tsx');
    const topBar = readProjectFile(
      'src/components/layout/MobileTopBar.tsx',
    );

    expect(ideScreen).not.toContain("case 'git'");
    expect(ideScreen).not.toContain("components/git");
    expect(uiStore).not.toMatch(/MobileView[^\n]*'git'/);
    expect(uiStore).not.toMatch(/SidebarView[^\n]*'git'/);
    expect(activityBar).not.toContain("id: 'git'");
    expect(sidebar).not.toContain("case 'git'");
    expect(topBar).not.toContain("git: 'Source Control'");
  });

  it('keeps Git execution infrastructure available outside the removed tab', () => {
    expect(
      readProjectFile('src/native/GitNativeModule.ts'),
    ).toContain('GitNative');
    expect(readProjectFile('src/stores/gitStore.ts')).toContain('useGitStore');
    expect(readProjectFile('src/components/git/GitPanel.tsx')).toContain(
      'GitPanel',
    );
  });

  it('exposes confirmed deletion for both files and folders in Explorer', () => {
    const treeItem = readProjectFile(
      'src/components/explorer/FileTreeItem.tsx',
    );

    expect(treeItem).toContain('state => state.deleteItem');
    expect(treeItem).toContain('name="trash"');
    expect(treeItem).toContain("style: 'destructive'");
    expect(treeItem).toContain('and everything inside it');
  });

  it('keeps one save action and renders editor search directions as vectors', () => {
    const editorPanel = readProjectFile(
      'src/components/editor/EditorPanel.tsx',
    );
    const topBar = readProjectFile(
      'src/components/layout/MobileTopBar.tsx',
    );

    expect(editorPanel).not.toContain('name="save"');
    expect(topBar).toContain('name="save"');
    expect(editorPanel).toContain('name="arrow-up"');
    expect(editorPanel).toContain('name="arrow-down"');
    expect(editorPanel).not.toContain('>↑</Text>');
    expect(editorPanel).not.toContain('>↓</Text>');
  });

  it('provides a modern project picker and creates projects without Git', () => {
    const explorer = readProjectFile(
      'src/components/explorer/FileExplorer.tsx',
    );
    const fileStore = readProjectFile('src/stores/fileStore.ts');

    expect(explorer).toContain('style={styles.projectSheet}');
    expect(explorer).toContain('New project');
    expect(explorer).toContain('createWorkspace(name)');
    expect(explorer).not.toContain('workspaceActionScroller');
    expect(fileStore).toContain('createWorkspace: async (name: string)');
    expect(fileStore).toContain('Remove the target from the visible tree immediately');
  });

  it('uses a shared readable visual system instead of the device decorative font', () => {
    const app = readProjectFile('App.tsx');
    const theme = readProjectFile('src/theme/uiTheme.ts');
    const androidTheme = readProjectFile(
      'android/app/src/main/res/values/styles.xml',
    );

    expect(app).toContain('DefaultText.defaultProps');
    expect(theme).toContain("regular: Platform.OS === 'android' ? 'Inter'");
    expect(theme).toContain("mono: Platform.OS === 'android' ? 'monospace'");
    expect(androidTheme).toContain(
      '<item name="android:fontFamily">Roboto</item>',
    );
    expect(
      fs.existsSync(
        path.join(
          __dirname,
          '..',
          'android/app/src/main/assets/fonts/Inter.ttf',
        ),
      ),
    ).toBe(true);
    expect(
      readProjectFile('android/app/src/main/assets/fonts/OFL-Inter.txt'),
    ).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(
      readProjectFile('src/components/layout/MobileTopBar.tsx'),
    ).toContain("require('../../assets/logo.jpg')");
  });
});
