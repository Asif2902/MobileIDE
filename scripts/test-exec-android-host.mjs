import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const resolver = read('android/app/src/main/cpp/adev_exec_compat.c');
const cmake = read('android/app/src/main/cpp/CMakeLists.txt');
const gradle = read('android/app/build.gradle');
const runtimeManager = read(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
const subprocess = read(
  'android/app/src/main/assets/runtime/lib/python3.14/subprocess.py',
);
const pathsHeader = read('android/app/src/main/assets/runtime/include/paths.h');
const deviceHarness = read(
  'android/app/src/main/assets/runtime/lib/adev-phase1-test.js',
);

assert.match(resolver, /ADEV_MAX_SHEBANG_DEPTH 8/);
assert.match(resolver, /for \(size_t depth = 0; depth < ADEV_MAX_SHEBANG_DEPTH; \+\+depth\)/);
assert.match(resolver, /adev_read_shebang\(current_path/);
assert.match(resolver, /current_path = resolved_paths\[depth\]/);
assert.match(resolver, /RTLD_NEXT, "execve"/);
for (const symbol of ['execve', 'execv', 'execvp', 'execvpe', 'execl', 'execlp', 'execle']) {
  assert.match(resolver, new RegExp(`int ${symbol}\\(`));
}
assert.match(resolver, /\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
assert.match(resolver, /strcmp\(interpreter, "\/bin\/sh"\)/);
assert.match(resolver, /strncmp\(interpreter, "\/usr\/bin\/", 9\)/);

assert.match(cmake, /add_library\(adev_exec_compat SHARED adev_exec_compat\.c\)/);
assert.match(cmake, /OUTPUT_NAME "lib_adev_exec_compat"/);
assert.match(gradle, /"liblib_adev_exec_compat\.so"/);

const preloadAssignment = runtimeManager.match(
  /env\["LD_PRELOAD"\] = listOfNotNull\(([\s\S]*?)\)\.joinToString\(":"\)/,
);
assert.ok(preloadAssignment, 'RuntimeManager must construct the preload chain explicitly');
assert.ok(
  preloadAssignment[1].indexOf('recursiveShebangPreload') <
    preloadAssignment[1].indexOf('termuxExecPreload'),
  'recursive shebang resolver must precede termux-exec',
);
assert.match(runtimeManager, /"ADEV_PYTHON_SHELL" to shell/);
assert.match(runtimeManager, /"recursive-shebang"/);

assert.match(subprocess, /os\.environ\.get\('ADEV_PYTHON_SHELL'\)/);
assert.doesNotMatch(subprocess, /\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
assert.match(pathsHeader, /#define _PATH_BSHELL "\/system\/bin\/sh"/);

assert.match(deviceHarness, /'global npm CLI: install'/);
assert.match(deviceHarness, /'--global', '--prefix', globalPrefix/);
assert.match(deviceHarness, /'global npm CLI: env node shebang'/);
assert.match(deviceHarness, /'adev-global-cli-fixture'/);
assert.match(deviceHarness, /#!\/usr\/bin\/env node/);
assert.match(deviceHarness, /#!\/usr\/bin\/env python/);
assert.match(deviceHarness, /#!\/system\/bin\/sh/);
assert.match(deviceHarness, /'python subprocess shell'/);
assert.doesNotMatch(deviceHarness, /achswap/i);

const textRuntimeFiles = [
  'android/app/src/main/assets/runtime/bin/git-core/git-difftool--helper',
  'android/app/src/main/assets/runtime/bin/git-core/git-merge-octopus',
  'android/app/src/main/assets/runtime/bin/git-core/git-merge-resolve',
  'android/app/src/main/assets/runtime/bin/git-core/git-merge-one-file',
  'android/app/src/main/assets/runtime/lib/python3.14/ctypes/macholib/fetch_macholib',
  'android/app/src/main/assets/runtime/lib/python3.14/config-3.14-aarch64-linux-android/makesetup',
  'android/app/src/main/assets/runtime/lib/python3.14/config-3.14-aarch64-linux-android/install-sh',
];
for (const file of textRuntimeFiles) {
  const contents = read(file);
  assert.match(contents, /^#!\/system\/bin\/sh/);
  assert.doesNotMatch(contents, /com\.termux\/files\/usr\/bin\/sh/);
}

process.stdout.write('Android recursive exec/shebang host contracts passed\n');
