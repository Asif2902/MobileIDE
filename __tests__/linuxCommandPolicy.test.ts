import fs from 'fs';
import path from 'path';

const readProjectFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('Android terminal Linux command policy', () => {
  const runtime = readProjectFile(
    'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
  );
  const processManager = readProjectFile(
    'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
  );
  const phase1DeviceMatrix = readProjectFile(
    'android/app/src/main/assets/runtime/lib/adev-phase1-test.js',
  );

  it('dispatches BusyBox applets with the requested applet as argv[0]', () => {
    const launcher = readProjectFile('android/app/src/main/cpp/adev_busybox.cpp');
    const cmake = readProjectFile('android/app/src/main/cpp/CMakeLists.txt');
    const gradle = readProjectFile('android/app/build.gradle');

    expect(launcher).toContain('libbin_busybox.so');
    expect(launcher).toContain('argv[1]');
    expect(launcher).toContain('execv(');
    expect(cmake).toContain('adev_busybox');
    expect(cmake).toContain('OUTPUT_NAME "bin_adev_busybox"');
    expect(gradle).toContain('libbin_adev_busybox.so');
    expect(runtime).toContain('libbin_adev_busybox.so');
    expect(launcher).toContain('control_mode ? "busybox" : (android_w ? "uptime" : argv[1])');
    expect(launcher).toContain('android_w ? "uptime" : argv[1]');
    expect(launcher).toContain('Android does not expose system login sessions');
    expect(runtime).toContain('"vi", "less", "more"');

    // Calling the renamed ELF as `libbin_busybox.so vi` does not work: that
    // BusyBox build dispatches from argv[0]. Every applet must use the launcher.
    expect(runtime).not.toContain('\\"$busybox\\" $ap');
    expect(processManager).toContain(
      'File(runtimeManager.getNativeLibDir(), "libbin_adev_busybox.so")',
    );
    expect(processManager).toContain('File(native, "libbin_adev_busybox.so")');
    expect(processManager).toContain('File(native, "libbin_busybox.so")');
    expect(processManager).toContain('busybox.isFile && busyboxPayload.isFile');
    expect(processManager).toContain('val busyboxReady = busybox.isFile && busyboxPayload.isFile');
  });

  it('exposes the essential shell command set through the dispatcher', () => {
    const appletBlock = runtime.match(
      /val applets = listOf\(([\s\S]*?)\)\.filter \{ it !in skipAsFunction \}/,
    )?.[1];

    expect(appletBlock).toBeDefined();
    const essential = [
      'ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'ln', 'chmod',
      'touch', 'find', 'realpath', 'readlink', 'stat', 'mktemp',
      'grep', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr',
      'cut', 'xargs', 'tee', 'diff', 'patch', 'base64', 'md5sum',
      'sha256sum', 'tar', 'gzip', 'gunzip', 'xz', 'zcat', 'ps',
      'killall', 'pgrep', 'pkill', 'du', 'df', 'id', 'whoami', 'env',
      'printenv', 'clear', 'sleep', 'date', 'timeout', 'nohup', 'wget',
      'nc', 'ping', 'vi', 'less', 'more', 'w',
    ];

    essential.forEach(command => {
      expect(appletBlock).toContain(`"${command}"`);
    });
  });

  it('clears viewport, saved lines, and replay state without signaling the PTY', () => {
    expect(runtime).toContain(
      "clear() { printf '\\\\033[H\\\\033[2J\\\\033[3J'; }",
    );
    expect(runtime).toContain('writeScript(\n                "clear"');
    expect(runtime).toContain("printf '\\\\033[H\\\\033[2J\\\\033[3J'");
  });

  it('materializes non-system applets for direct child-process PATH lookup', () => {
    const trampolineBlock = runtime.match(
      /if \(busyboxRuntime\.exists\(\) && busyboxDispatcher\.exists\(\)\) \{([\s\S]*?)\n            \}/,
    )?.[1];
    expect(trampolineBlock).toBeDefined();
    [
      'vi', 'less', 'more', 'nc', 'timeout', 'nohup', 'mktemp',
      'realpath', 'readlink', 'stat', 'w',
    ].forEach(command => {
      expect(trampolineBlock).toContain(`"${command}"`);
    });
  });

  it('runs the verified Nano ELF directly and keeps its terminal data app-private', () => {
    expect(runtime).toContain('nano() { \\"${nano.absolutePath}\\"');
    expect(runtime).toContain('libbin_nano.so');
    expect(runtime).toContain('writeScript("nano"');
    expect(runtime).toContain('"TERMINFO" to File(runtimeRoot, "share/terminfo").absolutePath');
    expect(runtime).toContain('if (!userNanorc.exists())');
    expect(runtime).toContain('export EDITOR=nano VISUAL=nano');
    expect(runtime).toContain('"EDITOR" to preferredEditor');
    expect(runtime).toContain('cproj <folder>');
    expect(runtime).not.toMatch(/alias\s+nano=/);
    expect(processManager).toContain('"nano" to "libbin_nano.so"');
  });

  it('never bypasses the Android Make shell bridge in managed tasks', () => {
    expect(processManager).toContain('"make" to "libbin_adev_make.so"');
    expect(processManager).not.toContain('"make" to "libbin_make.so"');
  });

  it('device-tests the exact websocket native packages reported by the user', () => {
    expect(phase1DeviceMatrix).toContain("bufferutil: '4.1.0'");
    expect(phase1DeviceMatrix).toContain("'utf-8-validate': '5.0.10'");
    expect(phase1DeviceMatrix).toContain("'websocket native dependencies: npm rebuild'");
    expect(phase1DeviceMatrix).toContain("'websocket native dependencies: reinstall'");
  });
});
