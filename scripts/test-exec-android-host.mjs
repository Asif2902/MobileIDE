import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const resolver = read('android/app/src/main/cpp/adev_exec_compat.c');
const resolverMap = read('android/app/src/main/cpp/adev_exec_compat.map');
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
const environmentHarness = read(
  'android/app/src/main/assets/runtime/lib/adev-runtime-env-test.js',
);
const urlBroker = read(
  'android/app/src/main/java/com/mobileide/app/runtime/ExternalUrlBroker.kt',
);
const xdgOpen = read('android/app/src/main/cpp/adev_xdg_open.cpp');
const gitLauncher = read('android/app/src/main/cpp/adev_git_launcher.cpp');
const secretCli = read('android/app/src/main/cpp/adev_secret_cli.cpp');
const credentialBroker = read(
  'android/app/src/main/java/com/mobileide/app/git/GitCredentialBroker.kt',
);
const secretVault = read(
  'android/app/src/main/java/com/mobileide/app/security/CliSecretVault.kt',
);
const envLauncher = read('android/app/src/main/cpp/adev_env.cpp');
const nodePreload = read('android/app/src/main/assets/runtime/lib/adev-node-preload.js');
const childProcessCompat = read(
  'android/app/src/main/assets/runtime/lib/adev-child-process-compat.js',
);

assert.match(resolver, /ADEV_MAX_SHEBANG_DEPTH 8/);
assert.match(resolver, /for \(size_t depth = 0; depth < ADEV_MAX_SHEBANG_DEPTH; \+\+depth\)/);
assert.match(resolver, /adev_read_shebang\(current_path/);
assert.match(resolver, /current_path = resolved_paths\[depth\]/);
assert.match(resolver, /RTLD_NEXT, "execve"/);
assert.match(resolver, /adev_runtime_env_prepare_exec\(envp, &prepared_environment\)/);
assert.match(resolver, /adev_shell_fallback\(\(char \*const \*\)effective_envp/);
assert.match(resolver, /adev_next_execve\([\s\S]*?effective_envp/);
assert.match(resolver, /static bool adev_resolve_apk_native_symlink\(/);
assert.match(resolver, /lstat\(path, &link_metadata\)/);
assert.match(resolver, /!S_ISLNK\(link_metadata\.st_mode\)/);
assert.match(resolver, /adev_env_value\(envp, "MOBILEIDE_NATIVE_LIB"\)/);
assert.match(resolver, /destination\[native_length\] != '\/'/);
assert.match(
  resolver,
  /adev_resolve_apk_native_symlink\([\s\S]*?executable_path = native_target;[\s\S]*?adev_next_execve\(\s*executable_path/,
);
for (const symbol of [
  'execve',
  'execv',
  'execvp',
  'execvpe',
  'execl',
  'execlp',
  'execle',
  'posix_spawn',
  'posix_spawnp',
]) {
  assert.match(resolver, new RegExp(`int ${symbol}\\(`));
  assert.match(
    resolverMap,
    new RegExp(`\\b${symbol};`),
    `${symbol} must be exported at Bionic's LIBC symbol version`,
  );
}
for (const symbol of ['readlink', 'readlinkat']) {
  assert.match(resolver, new RegExp(`ssize_t ${symbol}\\(`));
  assert.match(
    resolverMap,
    new RegExp(`\\b${symbol};`),
    `${symbol} must be exported at Bionic's LIBC symbol version`,
  );
}
assert.match(resolver, /TERMUX_EXEC__PROC_SELF_EXE/);
assert.match(resolver, /strcmp\(path, "\/proc\/self\/exe"\)/);
assert.match(resolver, /adev_virtual_self_exe/);
assert.match(resolver, /RTLD_NEXT, "posix_spawn"/);
assert.match(resolver, /adev_runtime_env_prepare_exec\(envp, &prepared_environment\)/);
assert.match(resolver, /static int adev_spawn_via_broker\(/);
assert.match(resolver, /"--adev-spawn-v1"/);
assert.match(resolver, /search_path \? "path" : "direct"/);
assert.match(resolver, /broker_argv\[index \+ 5\] = argv\[index\]/);
assert.match(
  resolver,
  /adev_next_posix_spawn\([\s\S]*?broker,[\s\S]*?file_actions,[\s\S]*?attributes,[\s\S]*?broker_argv,[\s\S]*?broker_environment/,
  'spawn interception must apply caller actions and attributes to the native broker',
);
assert.match(resolver, /F_DUPFD, 64/);
assert.match(resolver, /ADEV_SPAWN_ERROR_FD=/);
assert.match(resolver, /adev_spawn_wait_for_broker/);
assert.match(resolver, /waitpid\(child/);
assert.match(resolver, /return errno == 0 \? ENOMEM : errno/);
assert.doesNotMatch(resolver, /adev_prepare_spawn_plan/);
assert.match(resolver, /realpath\(candidate, destination\)/);
assert.match(resolver, /strncmp\(destination, "\/data\/app\/", 10\) == 0/);
assert.match(envLauncher, /"--adev-spawn-v1"/);
assert.match(envLauncher, /"--adev-opencode-shell-v1"/);
assert.match(
  envLauncher,
  /char\* shell_argv\[\] = \{[\s\S]*?"\/system\/bin\/sh"[\s\S]*?"-c"[\s\S]*?argv\[3\]/,
);
assert.match(envLauncher, /adev_runtime_env_apply\(\);[\s\S]*?execv\("\/system\/bin\/sh", shell_argv\)/);
assert.match(envLauncher, /std::strcmp\(mode, "path"\)[\s\S]*?execvp\(target, original_argv\)/);
assert.match(envLauncher, /std::strcmp\(mode, "direct"\)[\s\S]*?execv\(target, original_argv\)/);
assert.match(envLauncher, /execv\("\/system\/bin\/sh", original_argv\)/);
assert.match(envLauncher, /fcntl\(error_descriptor, F_SETFD, FD_CLOEXEC\)/);
assert.match(envLauncher, /char\*\* original_argv = argv \+ 5/);
assert.match(resolver, /if \(path == NULL\) path = "\/system\/bin"/);
assert.doesNotMatch(resolver, /path == NULL \|\| path\[0\] == '\\0'/);
assert.match(resolverMap, /^LIBC\s*\{/);
assert.match(cmake, /--version-script=\$\{CMAKE_CURRENT_SOURCE_DIR\}\/adev_exec_compat\.map/);
assert.match(resolver, /\/data\/data\/com\.termux\/files\/usr\/bin\/sh/);
assert.match(resolver, /strcmp\(path, "\/bin\/sh"\)/);
assert.match(resolver, /adev_is_virtual_shell\(filename\)/);
assert.match(resolver, /initial_path = direct_shell_path/);
assert.match(resolver, /strncmp\(interpreter, "\/usr\/bin\/", 9\)/);

assert.match(cmake, /add_library\(adev_exec_compat SHARED adev_exec_compat\.c/);
assert.match(cmake, /OUTPUT_NAME "lib_adev_exec_compat"/);
assert.match(gradle, /"liblib_adev_exec_compat\.so"/);
assert.match(cmake, /add_executable\(adev_xdg_open adev_xdg_open\.cpp\)/);
assert.match(gradle, /"libbin_adev_xdg_open\.so"/);
assert.match(cmake, /add_executable\([\s\S]*?adev_env[\s\S]*?adev_env\.cpp[\s\S]*?adev_exec_compat\.c[\s\S]*?adev_runtime_env\.c[\s\S]*?\)/);
assert.match(cmake, /OUTPUT_NAME "bin_adev_env"/);
assert.match(gradle, /"libbin_adev_env\.so"/);
assert.match(nodePreload, /load\('adev-child-process-compat\.js'\)/);
assert.match(childProcessCompat, /childProcess\.spawn =/);
assert.match(childProcessCompat, /childProcess\.spawnSync =/);
assert.match(childProcessCompat, /childProcess\.execFile =/);
assert.match(childProcessCompat, /childProcess\.execFileSync =/);
assert.match(childProcessCompat, /childProcess\.exec =/);
assert.match(childProcessCompat, /childProcess\.execSync =/);
assert.match(childProcessCompat, /\/proc\/self\/maps/);
assert.match(childProcessCompat, /nativeResolverLoaded\(\)/);
assert.match(childProcessCompat, /'\/storage\/self\/primary\/'/);
assert.match(childProcessCompat, /'\/mnt\/runtime\/'/);
assert.match(childProcessCompat, /'\/mnt\/media_rw\/'/);
assert.match(runtimeManager, /File\(libDir, "adev-child-process-compat\.js"\)/);

const preloadAssignment = runtimeManager.match(
  /env\["LD_PRELOAD"\] = listOfNotNull\(([\s\S]*?)\)\.joinToString\(":"\)/,
);
assert.ok(preloadAssignment, 'RuntimeManager must construct the preload chain explicitly');
assert.ok(
  preloadAssignment[1].indexOf('recursiveShebangPreload') <
    preloadAssignment[1].indexOf('termuxExecPreload'),
  'recursive shebang resolver must precede termux-exec',
);
const adevEnvironment = read(
  'android/app/src/main/java/com/mobileide/app/runtime/AdevEnvironment.kt',
);
// Python's shell=True, GNU make and the exec resolver all read this one
// value, and it comes from the single environment authority.
assert.match(adevEnvironment, /"ADEV_PYTHON_SHELL" to executableShell/);
assert.match(runtimeManager, /env\.putAll\(adevEnv\.contract\(\)\)/);
assert.match(runtimeManager, /"recursive-shebang"/);
assert.match(runtimeManager, /writeScript\(\s*"xdg-open"/);
assert.match(runtimeManager, /"xdg-open" to File\(nativeLibDir, "libbin_adev_xdg_open\.so"\)\.isFile/);
// ADEV owns `env` ahead of Toybox's, as a real ELF symlink in both the
// runtime bin directory and the shim directory that leads PATH.
assert.match(
  runtimeManager,
  /listOf\(File\(binDir, "env"\), File\(adevEnv\.shimDir, "env"\)\)/,
);
assert.match(runtimeManager, /Os\.symlink\(envLauncher\.absolutePath, link\.absolutePath\)/);
assert.match(runtimeManager, /"MOBILEIDE_ENV" to File\(nativeLibDir, "libbin_adev_env\.so"\)/);

assert.match(envLauncher, /std::strcmp\(command, "node"\)/);
assert.match(envLauncher, /verified_env_path\("MOBILEIDE_NODE"\)/);
assert.match(envLauncher, /SYS_readlinkat/);
assert.match(envLauncher, /actual_self_executable/);
assert.match(envLauncher, /sibling\("libbin_node\.so"\)/);
assert.match(envLauncher, /std::strcmp\(command, "python"\)/);
assert.match(envLauncher, /verified_env_path\("PYTHON"\)/);
assert.match(envLauncher, /execvp\(command_argv\[0\], command_argv\)/);
assert.doesNotMatch(envLauncher, /system\(|popen\(/);
assert.match(resolver, /adev_is_virtual_env/);
assert.match(resolver, /adev_env_value\(envp, "MOBILEIDE_ENV"\)/);
assert.match(resolver, /libbin_adev_env\.so/);

assert.match(urlBroker, /ServerSocket\(0, 16, InetAddress\.getByName\("127\.0\.0\.1"\)\)/);
assert.match(urlBroker, /SecureRandom\(\)\.nextBytes/);
assert.match(urlBroker, /MessageDigest\.isEqual/);
assert.match(urlBroker, /scheme == "http" \|\| scheme == "https"/);
assert.match(urlBroker, /require\(appVisible\)/);
assert.match(urlBroker, /Intent\(Intent\.ACTION_VIEW, uri\)/);
assert.doesNotMatch(urlBroker, /Runtime\.getRuntime|ProcessBuilder\(/);
assert.match(xdgOpen, /ADEV_URL_OPENER_PORT/);
assert.match(xdgOpen, /ADEV_URL_OPENER_SESSION/);
assert.match(xdgOpen, /INADDR_LOOPBACK/);
assert.match(xdgOpen, /json_escape\(url\)/);
assert.doesNotMatch(xdgOpen, /system\(|popen\(/);

// Generic CLI platform bridges (PLAN-009).
// The URL opener must be exposed under its generic name and through the
// standard $BROWSER discovery mechanism, never "none" anymore.
assert.match(runtimeManager, /writeScript\(\s*"adev-open-url"/);
assert.match(runtimeManager, /listOf\("adev-open-url", "xdg-open"\)/);
assert.match(runtimeManager, /"BROWSER" to "adev-open-url"/);
assert.doesNotMatch(runtimeManager, /"BROWSER" to "none"/);
assert.doesNotMatch(runtimeManager, /export BROWSER=none/);
assert.match(
  runtimeManager,
  /Os\.symlink\(xdgOpen\.absolutePath, link\.absolutePath\)/,
);
// Foreign static binaries fork/exec PATH entries directly; git must resolve
// to the exec-safe launcher ELF ahead of the noexec shell trampoline.
assert.match(runtimeManager, /File\(adevEnv\.shimDir, "git"\)/);
assert.match(
  runtimeManager,
  /Os\.symlink\(gitLauncher\.absolutePath, link\.absolutePath\)/,
);
assert.match(gitLauncher, /adev_runtime_env_apply\(\)/);
assert.match(gitLauncher, /libbin_git\.so/);
assert.match(gitLauncher, /MOBILEIDE_GIT/);
assert.match(gitLauncher, /\/storage\/", "\/sdcard\/", "\/mnt\/media_rw\/"/);
assert.match(gitLauncher, /return 73;/);
assert.doesNotMatch(gitLauncher, /system\(|popen\(/);
// The secret vault stays inside the app sandbox: Keystore AES/GCM records and
// a session-authenticated loopback broker; the CLI reads values on stdin.
assert.match(secretCli, /ADEV_GIT_CREDENTIAL_PORT/);
assert.match(secretCli, /read_all_stdin/);
assert.doesNotMatch(secretCli, /system\(|popen\(/);
assert.match(secretVault, /AndroidKeyStore/);
assert.match(secretVault, /AES\/GCM\/NoPadding/);
assert.match(secretVault, /SHA-256/);
for (const action of ['secret-get', 'secret-set', 'secret-delete', 'secret-list']) {
  assert.match(credentialBroker, new RegExp(`"${action}" ->`));
}

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
assert.match(deviceHarness, /'virtual \/bin\/sh direct path'/);
assert.match(deviceHarness, /androidShell\.stdout\.trim\(\) !== virtualShell\.stdout\.trim\(\)/);
assert.match(deviceHarness, /'python subprocess shell'/);
assert.doesNotMatch(deviceHarness, /achswap/i);
assert.match(environmentHarness, /'shebang-arg'/);
assert.match(environmentHarness, /loop\.error\?\.code === 'ELOOP'/);
assert.match(environmentHarness, /invalid\.error\?\.code === 'ENOEXEC'/);

// Exercise the actual exported Node APIs in a fresh process. process.execPath
// stands in for the native env launcher on the host: it accepts a shebang JS
// path as its first argument just as adev_env ultimately resolves it to Node.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'adev-child-process-host-'));
try {
  const fixture = path.join(scratch, 'writable shebang.js');
  fs.writeFileSync(
    fixture,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
    {mode: 0o755},
  );
  const compatPath = path.join(
    root,
    'android/app/src/main/assets/runtime/lib/adev-child-process-compat.js',
  );
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert=require('node:assert/strict');\n` +
        `process.env.MOBILEIDE_ENV=process.execPath;\n` +
        `const compat=require(${JSON.stringify(compatPath)});\n` +
        `const cp=require('node:child_process');\n` +
        `const fixture=${JSON.stringify(fixture)};\n` +
        `const expected='["one","two"]';\n` +
        `for (const method of ['spawnSync','execFileSync']) {\n` +
        `  const r=cp[method](fixture,['one','two'],{encoding:'utf8'});\n` +
        `  const output=method==='spawnSync'?r.stdout:r;\n` +
        `  assert.equal(String(output),expected,method);\n` +
        `}\n` +
        `Promise.all([\n` +
        `  new Promise((resolve,reject)=>{let out='';const p=cp.spawn(fixture,['one','two']);p.stdout.on('data',v=>out+=v);p.on('error',reject);p.on('close',code=>{try{assert.equal(code,0);assert.equal(out,expected);resolve()}catch(e){reject(e)}})}),\n` +
        `  new Promise((resolve,reject)=>cp.execFile(fixture,['one','two'],(error,stdout)=>{if(error)reject(error);else{try{assert.equal(stdout,expected);resolve()}catch(e){reject(e)}}})),\n` +
        `]).then(()=>{\n` +
        `  const envPlan=compat.route('/usr/bin/env');\n` +
        `  assert.equal(envPlan.target,null);\n` +
        `  const shellPlan=compat.route('/bin/sh');\n` +
        `  assert.equal(shellPlan.target,'/system/bin/sh');\n` +
        `  assert.equal(compat.route(process.execPath),null);\n` +
        `  process.stdout.write('child-process bridge ok');\n` +
        `}).catch(error=>{console.error(error);process.exitCode=1});`,
    ],
    {encoding: 'utf8'},
  );
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  assert.match(probe.stdout, /child-process bridge ok/);
} finally {
  fs.rmSync(scratch, {recursive: true, force: true});
}

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
