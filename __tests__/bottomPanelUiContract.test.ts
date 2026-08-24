import fs from 'fs';
import path from 'path';

const readProjectFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('bottom panel mobile UI contract', () => {
  const source = readProjectFile('src/components/layout/BottomPanelViews.tsx');

  it('renders registered development tasks instead of permanent demo controls', () => {
    expect(source).toContain('No running development servers');
    expect(source).toContain('managedTasks.map');
    expect(source).toContain('Open :{port.port}');
    expect(source).toContain('Restart');
    expect(source).toContain('Stop');
    expect(source).not.toContain('▶ demo-web');
    expect(source).not.toContain('▶ demo-api');
    expect(source).not.toContain('[5173, 3000, 4173, 8080]');
  });

  it('restarts from the native task argument vector instead of reparsing display text', () => {
    const processStore = readProjectFile('src/stores/processStore.ts');
    const nativeProcess = readProjectFile(
      'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
    );

    expect(processStore).toContain(
      'ProcessNativeModule.restartTask(task.id)',
    );
    expect(nativeProcess).toContain('val args = previous.args.toList()');
    expect(nativeProcess).not.toContain(
      "spawnShell(snapshot.command",
    );
  });

  it('opens diagnostics at their real file and source location', () => {
    expect(source).toContain(
      'revealLocation(prob.filePath, prob.line, prob.column)',
    );
  });

  it('labels Debug as a process snapshot and exposes useful task details', () => {
    expect(source).toContain('Process inspection only');
    expect(source).toContain('PID {task.pid}');
    expect(source).toContain('group {task.processGroupId}');
    expect(source).toContain('cwd: {task.cwd}');
  });
});
