import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(
  root,
  'android',
  'app',
  'src',
  'main',
  'assets',
  'runtime',
);
const include = path.join(runtime, 'include');
const targetTriple = 'aarch64-linux-android';
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

const requiredHeaders = [
  'linux/types.h',
  `${targetTriple}/asm/types.h`,
  'asm-generic/types.h',
  'node/node.h',
  'c++/v1/memory',
];
for (const header of requiredHeaders) {
  assert.ok(
    fs.statSync(path.join(include, header)).isFile(),
    `packaged native sysroot is missing include/${header}`,
  );
}

assert.match(
  fs.readFileSync(path.join(include, 'linux/types.h'), 'utf8'),
  /#include <asm\/types\.h>/,
  'fixture must exercise the architecture-specific include used by Bionic',
);
assert.match(
  fs.readFileSync(
    path.join(include, targetTriple, 'asm', 'types.h'),
    'utf8',
  ),
  /#include <asm-generic\/types\.h>/,
  'ARM64 asm/types.h must resolve through the generic UAPI headers',
);

const runtimeManager = source(
  'android/app/src/main/java/com/mobileide/app/runtime/RuntimeManager.kt',
);
assert.match(
  source('android/app/src/main/assets/runtime/fixtures/phase1/v8/binding.gyp'),
  /-std=c\+\+20/,
  'Node 26 V8 headers require the C++20 language mode',
);
assert.match(
  runtimeManager,
  /private const val NATIVE_BUILD_TRIPLE = "aarch64-linux-android"/,
);
assert.match(
  runtimeManager,
  /listOf\(File\(includeRoot, NATIVE_BUILD_TRIPLE\), includeRoot\)/,
  'the target-specific include directory must precede generic Bionic headers',
);
assert.match(
  runtimeManager,
  /--target=\$NATIVE_BUILD_TRIPLE\$NATIVE_BUILD_API/,
);
assert.match(
  runtimeManager,
  /--sysroot=\$prefix \$cxxIncludes \$systemIncludes/,
  'libc++ must precede Bionic so include_next reaches the C provider headers',
);
assert.match(runtimeManager, /env\["CPATH"\] = nativeSysrootIncludePath\(\)/);
assert.match(runtimeManager, /env\["CPLUS_INCLUDE_PATH"\] = nativeCxxIncludeDir\(\)\.absolutePath/);
assert.match(runtimeManager, /-isystem \$it/);
assert.match(runtimeManager, /nativeSysrootHeadersReady\(\)/);
assert.match(
  runtimeManager,
  /private fun findUnixLinkerCommand\(\): File\?[\s\S]*libbin_adev_ld_lld\.so/,
);
assert.match(
  runtimeManager,
  /--ld-path=\$it/,
  'Clang must receive the APK-native Unix linker personality launcher',
);
assert.match(runtimeManager, /env\["LD"\] = it\.absolutePath/);

const linkerLauncher = source('android/app/src/main/cpp/adev_ld_lld.cpp');
assert.match(linkerLauncher, /libbin_lld\.so/);
assert.match(linkerLauncher, /const_cast<char\*>\("ld\.lld"\)/);
assert.match(linkerLauncher, /execv\(runtime\.c_str\(\)/);

const processManager = source(
  'android/app/src/main/java/com/mobileide/app/process/ProcessManager.kt',
);
assert.match(processManager, /"ld\.lld" to "libbin_adev_ld_lld\.so"/);

const fetcher = source('scripts/fetch-runtime-libs.ps1');
for (const header of [
  'include\\linux\\types.h',
  'include\\aarch64-linux-android\\asm\\types.h',
  'include\\asm-generic\\types.h',
]) {
  assert.ok(
    fetcher.includes(`"${header}"`),
    `runtime fetch must fail when ${header} is absent`,
  );
}

const doctor = source(
  'android/app/src/main/assets/runtime/lib/adev-doctor.js',
);
assert.match(doctor, /const nativeSysrootReady = nativeSysrootHeaders\.every/);
assert.match(doctor, /nativeSysrootReady,/);

process.stdout.write(
  'native sysroot host checks passed: ARM64 UAPI headers and the Unix LLD personality are packaged, selected, and diagnosed\n',
);
