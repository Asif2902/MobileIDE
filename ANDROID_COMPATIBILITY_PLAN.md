# Android Compatibility Audit and Fix Plan

Audit date: 2026-08-23
Application: A Dev Studio 1.3.16 / production `com.mobileide.app` / test `com.mobileide.app.phonetest`
Runtime: 1.16.11
Audited target: Android ARM64/x86_64 app, `minSdk 29`, `targetSdk 36`

## Five-phase execution ledger

| Phase | Status | Commit | Evidence / next action |
|---|---|---|---|
| 1. Runtime, native builds, shell, and core CLI | **ARM64 API 30 BASELINE VERIFIED — MATRIX GATE** | `8c20d06` + `aef4986` | A physical ARM64/API-30 upgrade runs a normal globally installed `#!/usr/bin/env node` CLI, env-Python, system-sh, Python `os.popen`, N-API C/C++ install/rebuild/direct-node-gyp/load/uninstall/reinstall, and a C++20 V8 addon build/load without chmod or project patches. API 29/34/35/36, strict-16-KiB and x86_64 developer-runtime coverage remain. |
| 2. Node servers, Next.js, preview, and watching | **IMPLEMENTED — DEVICE GATE** | `ba14e01` | Host launcher/event/type/build/APK checks pass. The Phase 5 device/UI matrix owns Node/Express/Vite/Next/HMR/port/process cleanup evidence; connected runner execution remains. |
| 3. Git, package managers, optional toolchains, and Bun policy | **IMPLEMENTED — DEVICE / FEATURE GATE** | `93b3527` | Keystore-backed Git credentials, strict SSH, proxy/custom-CA policy, offline pnpm/Yarn, and the Bun/tool-pack capability policy pass. Live network auth remains in the device matrix; absent large toolchains and Git LFS remain explicit signed feature boundaries. |
| 4. Android 16, ABI, filesystem, and runtime distribution | **IMPLEMENTED — DEVICE / FEATURE / HOST RELEASE GATES** | `001cc17` | React Native 0.86.2, API 36, NDK r29, Gradle 9.3.1, dual-ABI app/native helpers, signed runtime locking, guided private imports, and 16 KiB checks pass. Phase 5 now automates the connected/release gates; the full x86_64 developer runtime remains a signed feature boundary. |
| 5. Automation, security, production release, and final audit | **IMPLEMENTED — DEVICE / PROVENANCE / SIGNING GATES** | `d6b3296` | Test/lint isolation, exact JDK 17, one version source, fail-closed external signing, APK/AAB validation, dependency/license/secret/runtime-ownership policy, and API/ABI/16 KiB CI orchestration pass host checks. The 1.3.14 phone-test APK and instrumentation APK build and verify; connected execution, 196 legacy hash-only provenance mappings, and external production signing remain gates. |

### What “implemented — device gate” means

It means the integration is present and its host/unit/build checks pass, while
some required device combinations are not yet certified. API 30 evidence was
collected from the user's ARM64 phone for the terminal startup/prompt, the
Python-to-Make node-gyp failure progression, and OpenCode diagnostics/crash
boundaries. That partial evidence does not certify the final 1.3.14 candidate,
API 29/34/35/36, strict 16 KiB devices, x86_64, secondary users, work profiles,
or fresh/upgrade matrices. Those remain explicit release gates.

### Post-phase compatibility updates

| Update | Status | Commit | Evidence / remaining gate |
|---|---|---|---|
| Terminal startup-loop and prompt correction | **API 30 OBSERVED — FINAL CANDIDATE RETEST** | `9c8cf13` | The invalid SELinux-context bytes that made `ProcessBuilder` reject terminal startup are stripped, and the prompt was observed on API 30. The 1.3.8 keyboard/accessory/IME/copy and PTY cleanup changes pass host tests; final-candidate device stress and API 29/36 checks remain. |
| Runtime asset completeness and Make shell bridge | **FIXED — FINAL ARM64 DEVICE RETEST** | `cf4afc7` + `d2d8adc` | The copied API 30 logs proved Python progressed past the missing `zipfile._path` module and then exposed GNU Make's compiled `/data/data/com.termux/files/usr/bin/sh`. Runtime 1.16.3 retains every source asset and routes direct, npm, recursive, and node-gyp Make through an APK-native launcher that forces `/system/bin/sh`. The original npm install/rebuild/compile/load still needs final-candidate device execution. |
| OpenCode Android command | **DIAGNOSTICS VERIFIED — FUNCTIONAL MODES UNSUPPORTED** | `d2d8adc` | API 30 testing verified command discovery and diagnostics, but available Android Bun/OpenTUI payloads abort in TUI, agent, run, serve, and web modes. Version 1.3.8 blocks those modes with actionable exit 69 instead of crashing or substituting a glibc binary. API 29/36 boundary retests and x86_64 payload support remain. |
| BusyBox, Nano, terminal UX, Git workspace, and dependency security correction | **HOST/APK VERIFIED — DEVICE GATE** | `d2d8adc` | BusyBox 1.38.0-1 is a pinned ELF64 AArch64/Bionic payload behind an APK-native argv-zero dispatcher; `w` exposes the Android uptime boundary. Nano 9.2, terminfo, syntax data, editor defaults, `cproj`, Git clone/workspace UI, terminal layout/input fixes, clean-install security patching, and constrained audit gates are integrated. Both APKs compile; command/UI/network execution awaits a connected phone. |
| Shell environment and ARM64 sysroot correction | **FIXED — 1.3.11 DEVICE RETEST** | `0ffebd2` | The 1.3.8 phone logs proved node-gyp reached Clang, then exposed two platform defects: Kotlin emitted a literal `${'$'}{NODE_OPTIONS:-}` into `.adev-agent-env`, and Clang could not search the packaged target-specific `asm/types.h`. Runtime 1.16.4 emits valid POSIX expansion, adds the ARM64 UAPI include directory plus `CPATH`, gates header completeness, and adds permanent host regressions. Final Vite execution remains pending; native compilation is now observed through object generation. |
| Unix LLD personality and OpenCode short-version correction | **FIXED — 1.3.11 DEVICE RETEST** | `8054295` | The 1.3.9 phone run compiled `bufferutil.o` and then proved relocated generic `lld` could not select the Unix driver. Runtime 1.16.5 routes Clang, `$LD`, PATH, shell, and Java execution through a dual-ABI APK-native bridge that supplies `argv[0] = ld.lld`. Runtime 1.16.6 supersedes the former OpenCode short-option forwarding with fully native diagnostics. Final addon link/load and diagnostic retest remain pending because ADB has no device. |
| Next.js version routing and native OpenCode diagnostics | **HOST/APK VERIFIED — 1.3.11 DEVICE RETEST** | `fbfe48d` | The phone proved Next 15.5.2 rejects the launcher's forced `--webpack`; exact package inspection confirmed Next 15 uses Webpack when Turbo flags are absent and Next 16 requires `--webpack`. Runtime 1.16.6 implements that split and tests 15.5.2/15.5.22/16.2.12. OpenCode version/help/path diagnostics now terminate natively without Bun or `/tmp`; unsafe modes retain exit 69. Full host, dual-ABI build, APK, closure, and 16 KiB gates pass. ADB is empty, so real framework and CLI execution remains pending. |
| OpenCode real-runtime `/tmp` compatibility | **HOST/NATIVE VERIFIED — 1.3.12 DEVICE RETEST** | `b925fd2` | Direct ARM64 payload evidence proved every mode failed first at literal `mkdir("/tmp")`; the pinned upstream tagfix only disables Bionic heap tagging. Runtime 1.16.7 adds an OpenCode-process-only libc path shim that maps exact `/tmp` paths to canonical app-private temp, rejects traversal, restores the upstream tagfix/OpenTUI/library environment, and forwards every standard mode to the real payload. Host forwarding/remap tests and dual-ABI 16 KiB native builds pass. ADB is empty, so version/help/paths/run/serve/web/TUI remain explicitly uncertified. |
| Recursive shebang and Python shell compatibility | **ARM64 API 30 VERIFIED — MATRIX GATE** | `b2b017d` + `aef4986` | The resolver now treats virtual `/usr/bin/env` specially instead of selecting Android Toybox from system-first PATH, then executes an APK-native `env` which locates Node/Python/Bash beside itself. On the connected phone, untouched `@achswap/mcp-sdk` runs as `achswap --help`; the package-neutral global npm CLI, env-Python, system-sh, virtual `/bin/sh`, and Python `os.popen()` regressions also pass. No AchSwap-specific branch exists. Other API/ABI combinations remain. |
| libc++ / V8 native-addon completion | **ARM64 API 30 VERIFIED — MATRIX GATE** | `aef4986` | The compiler now orders libc++ before target-specific/generic Bionic headers so libc++ `include_next` reaches Bionic types. The Node 26 fixture uses its required C++20 mode. Physical-phone evidence shows the V8 addon compiling, linking, and loading; N-API C and C++ completed the full install/rebuild/direct-build/load/consumer cycle. |
| Project import/export and Next process ownership | **IMPLEMENTED — 1.3.14 DEVICE GATE** | `8a0fa9d` | Android shared folders now offer open-in-place or cancellable private import; private projects export through persisted SAF tree permissions. Source/full filters, independent Git/hidden/secret controls, conflict policies, external project metadata, containment/no-follow cleanup, progress, and terminal/workspace switching pass Kotlin/Jest/compile checks. The shared-command preflight stops normal npm/pnpm/Yarn/Corepack/Next/Vite/native/Git mutation paths before partial output. Next 13.2.4/14.2.35/15.5.2/15.5.22/16.2.12 host lifecycle ownership tests pass. ADB is empty, so real SAF providers, imported-project npm symlink creation, Next HTTP/HMR/Ctrl+C, and export destinations remain device gates. |

## Executive result

The reported `Error: spawn node-gyp EACCES` was a platform execution-layer
failure, not a `bufferutil` failure.

The platform-wide fix is now implemented:

- npm lifecycle commands are launched by an APK-installed native shell.
- Direct `node-gyp` lifecycle commands are dispatched to npm's real
  `node-gyp.js` entrypoint through the APK-installed Node ELF.
- The complete environment contract required by `termux-exec` 2.x is exported,
  so generic `spawn`, `exec`, and shebang execution can translate app-data
  scripts instead of falling back to hard-coded `com.termux` paths.
- An ADEV-owned preload now runs before termux-exec and recursively resolves
  interpreters that are themselves scripts. This permanently covers global npm
  bins using `#!/usr/bin/env node` without package-specific command patches.
- Python, Make, Clang/LLVM, LLD, `pkg-config`, Node headers, compiler resources,
  and their complete shared-library closure are bundled.
- All executable tools are installed under Android's executable
  `nativeLibraryDir`; projects and generated npm shims remain writable under
  app data.
- Compiler and linker settings are supplied automatically to every spawned
  process. Addons target Android API 29 and use 16 KiB-compatible ELF
  alignment.
- The runtime version was bumped, so existing installations re-extract the
  corrected runtime automatically.
- The global Linux platform spoof was removed. The capability policy now keeps
  Android/Bionic identity and resolves Android artifacts, exact hash-approved
  static/musl artifacts, source builds, or an explicit unsupported boundary.
- A real ARM64 `curl` executable and its CA/shared-library integration are
  packaged. `adev-doctor --json`, `--verbose`, and `--self-test` report the
  runtime, command suite, compiler, execution, SELinux, TLS, and package policy.
- Java background tasks use a child-reported supported PID, their own process
  group, and group termination. PTY close signals before changing state and
  reaps the child.
- Filesystem access now uses canonical segment-aware containment, rejects
  sibling-prefix/traversal escapes, removes broad `/data` and `/mnt` grants,
  and makes `/system`/`/apex` read-only.
- Gradle, npm package metadata, diagnostics, and release notes agree on app version 1.3.14/runtime 1.16.9.

This is not an individual-package workaround. It applies to packages using
`node-gyp`, npm's lifecycle runner, shell shims, and native C/C++ compilation.
No post-install `chmod`, `npm rebuild`, or package-specific command is intended
to be necessary.

The 1.3.14 phone-test target and its instrumentation APK build successfully on
the pinned Windows JDK 17/NDK r29 toolchain. The 360,839,574-byte candidate is
API 36, dual ABI, debug-test signed, and passes source-asset completeness,
signed runtime-lock, dependency-closure, ZIP alignment, and all-ELF 16 KiB
checks. A phone was used for earlier API 30 diagnosis but is disconnected for
the final candidate, so the automated offline/network/project matrices remain
release gates and are not reported as passing.

Phase 5 turns those remaining guarantees into enforced release policy:

- `version.json` is the application/runtime version authority consumed by
  Gradle, package validation, artifact names, diagnostics, and release notes.
- Gradle rejects every JDK except 17 and rejects `assembleRelease`/
  `bundleRelease` unless all external signing values are supplied. The release
  build no longer has any debug-signing fallback.
- Jest is limited to the repository test root and has the required React Native
  mocks. ESLint is launched from the repository's pinned configuration and
  cannot inherit a parent flat config.
- Production dependency audit, generated license inventory, tracked-secret
  scan, signed runtime ownership/pruning, final APK dependency closure, exact
  ABIs/APIs, 16 KiB ZIP/ELF alignment, artifact size, signer identity,
  `jarsigner`, `apksigner`, and bundletool validation are release gates.
- CI defines x86_64 emulator smoke tests plus ARM64 API 29/34/35/36 fresh/
  upgrade, strict 16 KiB, instrumentation, runtime-network, and two-clean-build
  reproducibility matrices. Production artifacts are created only after those
  jobs and only with external secrets.

Phase 2 now adds the server/framework layer without changing the working
Phase 1 native-build path:

- One native task registry tracks background tasks and PTY sessions, task
  types, process/group ownership, bounded logs, exit/failure state, and ports.
- A Node preload emits structured `listen`, `close`, and listen-error events.
  Log messages can only suggest a candidate; a preview URL is published only
  after task ownership and a successful `127.0.0.1` connection probe.
- `/proc/net/tcp*`, socket-inode ownership, descendants, and process groups
  discover arbitrary non-Node ports and retain ownership if a shell reparents
  a child. Stop waits for verified ports to close.
- Run/Preview exposes task type/source/state and uses the registry's verified
  URL. Terminal-launched servers share the same registry and continue across
  ordinary UI navigation.
- `adev-next` resolves the project's installed Next.js, caches the exact
  matching `@next/swc-wasm-nodejs` outside the project, and selects Webpack for
  `dev` and `build` using the installed major's actual CLI contract: no selector
  for Next 15 and earlier, exactly one `--webpack` for Next 16 and later. Direct
  `next` and simple/compound npm scripts route through the launcher without
  editing `package.json`, lockfiles, or project modules.
- Private workspaces use native watchers. Editor watches are recursive,
  collision-free, symlink-bounded, and recover after inotify overflow. Shared
  or FUSE paths alone use recursive polling.
- Runtime 1.13.0 forces upgrade re-extraction of the new launcher, server
  preload, diagnostics, test harness, wrappers, and watcher policy.

Phase 3 completes the ecosystem-policy layer without weakening the Phase 1
execution boundary:

- UI network operations and the Git CLI now share native Git 2.55, the same
  canonical repository policy, proxy/custom-CA configuration, redirect policy,
  submodule behavior, and Android runtime environment.
- HTTPS credentials, SSH private keys, and passphrases are encrypted with an
  Android Keystore AES/GCM key. Git receives HTTPS credentials through an
  app-private loopback broker and APK-native credential helper; JavaScript
  receives only credential metadata and never stored tokens or private keys.
- SSH uses managed key leases, strict known-host verification, fingerprint
  confirmation, Dropbear key generation/import, and app-private cleanup.
- Corepack 0.35.0, pnpm 11.18.0, and Yarn 4.18.0 are pinned. The exact pnpm and
  Yarn payloads and hashes are bundled, so declared matching versions work
  offline and use the Phase 1 lifecycle layer.
- `bun` now returns an explicit Android/Bionic unsupported capability instead
  of attempting to execute a glibc Linux artifact.
- An Ed25519-signed tool-pack index supplies status, dependency, uninstall, and
  failure diagnostics for CMake/Ninja, Rust/Cargo, NASM, Autotools/Libtool,
  Java, development libraries, and Git LFS. Android's noexec model requires
  their production native payloads to arrive as ABI-specific APK feature
  content, which is an explicit Phase 4 distribution boundary.
- Runtime 1.14.0 re-extracts the package-manager, Git/SSH, diagnostics, Bun,
  tool-pack, and Phase 3 device-test assets on upgrade.

Phase 4 upgrades the Android platform boundary while retaining the earlier
runtime behavior:

- React Native 0.86.2/React 19.2.3, the matching CLI 20.2.0 stack, API 36,
  NDK 29.0.14206865, Kotlin 2.1.20, Gradle 9.3.1, Hermes, the new architecture,
  and edge-to-edge behavior are configured together.
- The app and its native shell/Git helper build for `arm64-v8a` and `x86_64`.
  The ARM64 developer runtime stays in the base APK; the x86_64 developer
  runtime is an explicit signed feature-pack capability instead of an
  incorrectly advertised or glibc-backed runtime.
- An Ed25519-signed runtime lock inventories 208 ARM64 runtime/app-native
  payloads and six packaged x86_64 helpers by hash, size, runtime path, and
  owner. Runtime 1.16.6 forces upgrade re-extraction and `adev-doctor` verifies
  and reports the lock.
- Shared/FUSE workspaces are assessed before native work. A guided import stages
  them under app-private storage, rejects symlinks and containment escapes, and
  finalizes atomically so failed imports do not leave partial projects.
- The 1.3.11 phone-test APK targets API 36, contains only ARM64/x86_64, passes Android's
  16 KiB ZIP check, and has 248 packaged ELF files with a minimum `PT_LOAD`
  alignment of `0x4000`; six packaged compiler relocatable objects have no load
  segments and are checked separately.

## Root cause of `spawn node-gyp EACCES`

There were six consecutive failures.

1. npm prepends its private `node-gyp-bin` directory to lifecycle `PATH`. Its
   `node-gyp` entry is a small POSIX shell script under writable app data:

   ```sh
   #!/usr/bin/env sh
   node "$npm_config_node_gyp" "$@"
   ```

   Apps targeting API 29 or newer cannot directly `execve()` files in their
   writable home directory. Changing Unix mode bits cannot remove this Android
   W^X/SELinux restriction. This is the immediate source of `EACCES`.

2. The APK already bundled `termux-exec`, but only configured `LD_PRELOAD` and
   the intercept switch. `termux-exec` 2.x also requires the real app-data,
   rootfs, prefix, Android SDK, and SELinux context variables. Without them it
   falls back to paths compiled for `com.termux`, so it could not translate the
   npm shim for `com.mobileide.app`.

3. After the toolchain was added, Android's default AAPT asset-ignore pattern
   silently removed underscore-prefixed directories. The repository contained
   Python's `zipfile/_path`, but the APK did not, producing the observed
   `ModuleNotFoundError: No module named 'zipfile._path'`. The same rule omitted
   most modular libc++ headers, and the dot-entry rule omitted package-manager
   `.bin` commands and `.npmrc`. Version 1.3.6 removes both unsafe exclusions,
   bumps the runtime so upgrades re-extract automatically, and compares every
   runtime source file with the final APK.

4. GNU Make was compiled with `/data/data/com.termux/files/usr/bin/sh`, which
   does not exist inside A Dev Studio. Runtime 1.16.3 routes direct, npm,
   recursive, and node-gyp Make through an APK-native launcher that forces
   `/system/bin/sh`.

5. Once compilation started, Bionic's `linux/types.h` imported
   `<asm/types.h>`. The required file was already packaged below
   `include/aarch64-linux-android`, but the compiler searched only generic
   `include`. Runtime 1.16.4 places the target-specific UAPI directory first in
   `CC`/`CXX`, exports it through `CPATH`, and refuses to report native builds
   ready if this header chain is incomplete.

6. After the UAPI fix, the phone compiled `bufferutil.o` and reached linking.
   Android relocation had renamed LLVM's multi-call executable to
   `libbin_lld.so`, so it could not infer the Unix `ld.lld` personality from
   its executable name and exited as a generic driver. Runtime 1.16.5 adds an
   executable APK-native bridge that launches the same verified payload with
   `argv[0] = ld.lld`; Clang, `$LD`, PATH, Java, and shell entry points all use
   this bridge.

Before the Phase 1 integration, the runtime also lacked Python, Make, Clang, a
linker, sysroot files, and Node headers. Those tools are now bundled; the final
APK completeness gate prevents their support trees from being partially
packaged again.

Relevant platform references:

- [Android 10: removed execute permission for app home](https://developer.android.com/about/versions/10/behavior-changes-10)
- [Termux execution environment and Android execution restrictions](https://github.com/termux/termux-packages/wiki/Termux-execution-environment)
- [Termux 0.118.2 environment contract for termux-exec 2.x](https://github.com/termux/termux-app/releases)

## Verification performed

### Passed

- PowerShell staging script parses successfully.
- Termux dependency resolution completed for 80 packages.
- 129 shared-library files were staged before Android relocation.
- The staging closure check reported every `DT_NEEDED` dependency satisfied.
- 565 runtime/toolchain paths were staged, including the real `curl` CLI.
- The Gradle relocation step installed 224 ELF files and produced a 237-entry
  native path map.
- Packaged tool executables include Node, Python 3.14, Make, Clang 21, LLD,
  `llvm-ar`, `pkg-config`, and the native npm lifecycle shell.
- The APK includes 122 Node header files, 589 Python standard-library files,
  and 313 Clang resource files.
- Independent ELF inspection found zero unresolved non-system `DT_NEEDED`
  names after applying the runtime symlink map.
- `zipalign -c -P 16 -v 4` passed for the release APK.
- All imported developer-runtime ELFs and all app-built native targets are
  16 KiB ELF-aligned.
- Runtime capability-policy tests passed, including no global platform
  mutation and all four resolver decisions.
- The canonical-path sibling/traversal unit test passed.
- `:app:testReleaseUnitTest` passed.
- `:app:assembleRelease` passed and the APK contains `libbin_curl.so`,
  `adev-doctor.js`, and the native-addon fixtures.
- `libbin_curl.so` is AArch64, uses `/system/bin/linker64`, has a complete
  `DT_NEEDED` closure, and all `PT_LOAD` segments use `0x4000` alignment.
- The exported PTY library contains the native process-group signal entrypoint.
- `git diff --check` passed.
- The runtime fetcher now rejects missing required packages, verifies each
  downloaded `.deb` against the repository's SHA-256, and fails on an
  incomplete dependency closure or missing tool.
- The original Phase 2 host suite passed structured Node listen/close events,
  a real loopback request, exact Next.js version resolution, cache isolation,
  and no project metadata mutation. The 1.3.11 regression corrects its former
  version-blind `--webpack` expectation and covers Next 15.5.2/15.5.22 without
  a selector plus Next 16.2.12 with the required selector.
- npm registry checks confirmed exact `@next/swc-wasm-nodejs` releases for
  Next.js `15.5.22` and `16.2.12`.
- TypeScript `--noEmit` passed with a 4 GiB compiler heap.
- `:app:compileDebugKotlin`, `:app:testReleaseUnitTest`, and
  `:app:assembleRelease` passed with JDK 17 after the Phase 2 changes.
- The release APK contains `adev-next.js`, `adev-server-events.js`,
  `adev-phase2-test.js`, and the rebuilt native npm lifecycle shell. Binary
  inspection confirms the native shell contains the generic Next launcher
  dispatch.
- `npm run release:check` passes JDK, repository-isolated lint/Jest, TypeScript,
  generated licenses, tracked-secret scan, signed runtime ownership, all host
  phase regressions, and the production dependency audit.
- Terminal store regression tests pass concurrent-create deduplication,
  failure-without-loading-loop, and restoration of an active native session.
- The native PTY shell probe is bounded to five seconds and terminates/reaps a
  timed-out candidate before falling back.
- The pinned OpenCode 1.17.9 archive and all staged component hashes verify.
  The runtime requests `/system/bin/linker64`, is PIE, and the runtime,
  OpenTUI/tag-fix libraries, and dual-ABI launcher all have `PT_LOAD >= 0x4000`.
- `:app:compileDebugKotlin` and `:app:testDebugUnitTest` pass with the terminal,
  runtime capability, process resolution, and OpenCode launcher changes.
- JDK 17 passes Android unit tests, instrumentation-test compilation, and the
  dual-ABI debug build. The default JDK 25 is rejected with the intended
  remediation message.
- The Phase 5 APK gate passes API 29/36 metadata, exact ARM64/x86_64 ABIs,
  required runtime harnesses, Ed25519 lock verification, runtime-map-aware
  `DT_NEEDED` closure, 16 KiB ZIP/ELF alignment, and the 390 MB size policy.
- `assembleRelease --dry-run` fails closed before build when external signing
  credentials are absent; there is no debug-signing fallback.
- The GitHub Actions workflow parses successfully and defines APIs
  29/34/35/36, x86_64, ARM64 fresh/upgrade, strict 16 KiB, production signing,
  bundletool, and two-clean-build reproducibility jobs.
- The 1.3.11 host suite passes 10 Jest suites/45 tests, TypeScript, ESLint with
  zero errors/13 warnings, Phases 2–5, runtime policy, Nano, and OpenCode checks.
- `:app:testPhoneTestUnitTest`, `:app:assemblePhoneTest`, and
  `:app:assemblePhoneTestAndroidTest` pass. Instrumentation targets the
  non-debuggable phone-test application and no longer relies on `run-as`.
- `app-phoneTest.apk` is 360,682,699 bytes with SHA-256
  `E68B83EF4C096C9973CEE5C9666DE3B0200DF32AADC9B5CE3A3A70B1AE090081`.
  It is version 1.3.11-phone-test/API 36, has the exact ARM64/x86_64 ABI set,
  verifies with the test certificate, retains every runtime source asset, and
  passes signed-lock, dependency-closure, 16 KiB ZIP, and 248-ELF checks.
- The 694,413-byte instrumentation APK builds with SHA-256
  `004D06B00B9F0514AEF357BA0FE63BFA3B28066F530E4FA6AA679FEBEE00F114`
  and the same test certificate digest.

### Remaining gates after partial API 30 phone testing

- `adb` is installed, but `adb devices -l` reports no connected device or
  emulator.
- Earlier API 30 logs reproduced the Python and Make failures and terminal/
  OpenCode behavior. The final 1.3.11 candidate cannot be executed now because
  the phone is disconnected; no final device result is inferred from the APK.
- Loading a newly compiled `.node` file, file-watch behavior, PTY signal/job
  control, Git network authentication, and secondary-user/adoptable-storage
  paths require device tests.
- The Node/Express/Vite/Next.js Terminal and Run/Preview matrices, registry
  ownership/probe timing, nested HMR edits, and process-tree/port cleanup need
  `adev-phase5-test --network` plus UI assertions on the configured API matrix.
- OpenCode needs API 29/36 retesting of the verified diagnostic commands and
  exit-69 unsupported-mode UX. TUI, provider, agent, run, serve, and web are
  tested Android/Bionic capability boundaries, not pending success claims. No
  verified Bionic x86_64 payload exists.
- No approved production keystore/certificate digest was supplied. Therefore
  no artifact from this workstation can satisfy the production-signing gate.
- The signed production AAB/APK, bundletool validation, two-clean-build
  comparison, and Play upload checks require the protected CI release job and
  external credentials. The complete phone-test build now succeeds locally;
  the old Hermes/Device Guard failure is historical, not a current phone-test blocker.

### Previously independent failures now resolved

- The React Native 0.86.2/Hermes upgrade replaced the 4 KiB libraries; the
  final dual-ABI APK scan now finds a minimum load alignment of `0x4000`.
- The repository-scoped Jest configuration and React Native mocks pass without
  scanning Android runtime/build fixtures.
- The local ESLint launcher forces the repository's legacy configuration
  boundary, scopes source inputs, and prevents inheritance from
  `C:\Users\Asif\eslint.config.mjs`.

## Component audit

Status meanings:

- ✅ Fully integrated: source and packaged-artifact checks pass.
- ⚠️ Partially integrated: useful implementation exists, but a known gap or
  device-only release gate remains.
- ❌ Broken: an implemented path is demonstrably incorrect.
- ❌ Missing: no integration exists.
- ⚠️ Manual: Android requires a user/system action or the app has no automatic
  path yet.

| Area | Status | Verified configuration and finding |
|---|---|---|
| Node.js | ✅ Fully integrated | Termux Node 26.4.0 is packaged as an ARM64 ELF in `nativeLibraryDir`; headers match 26.4.0. Runtime wrappers use the absolute executable path. |
| npm / npx | ✅ Fully integrated | npm 11.16.0 and both JS entrypoints are bundled and launched through the native Node executable. Cache, prefix, user config, optional dependency, and noninteractive settings are app-scoped. |
| node-gyp | ✅ ARM64/API-30 baseline verified | node-gyp 12.3.0, Python, APK-native Make/Clang/LLD and Node headers are bundled. The connected phone completed N-API C/C++ install, rebuild, direct `node-gyp rebuild`, load, consumer install/uninstall/reinstall, plus a C++20 V8 addon compile/link/load. Remaining certification is the API/ABI/storage matrix, not the original EACCES path. |
| Python | ✅ ARM64/API-30 baseline verified | Python 3.14.6 includes all 589 standard-library files and native modules. The connected Phase 1 run passed env-Python and `os.popen()` through ADEV's exec-safe shell; no stale `com.termux` shell was used. Other API/ABI combinations remain release gates. |
| Clang / Make / build tools | ✅ ARM64/API-30 baseline verified | Clang/LLVM 21.1.8, GNU Make 4.4.1, Unix LLD bridge, `llvm-ar`, headers, CRT objects, Bionic and libc++ include order, and libraries compiled and linked real N-API/V8 addons on the connected phone. Optional tool packs and x86_64 developer compilation remain explicit feature/matrix gates. |
| BusyBox / Linux CLI | ⚠️ Integrated; final device retest | Pinned Termux BusyBox 1.38.0-1 is ELF64 AArch64/Bionic, not the previously staged ELF32 payload. Executable SHA-256 is `db7f2a847ab051086c71d1c8c367e71adf59a3c39c8323ff801126ff11c84058`; its exact SONAME closure and `0x4000` alignment pass. The argv-zero dispatcher covers the essential command suite; `w` explicitly maps to Android uptime because app UIDs have no utmp login-session access. |
| Nano | ⚠️ Integrated; final device retest | Nano 9.2 is a signed-index-verified ARM64/Bionic PIE with exact dependencies, 40 terminfo entries, 44 syntax definitions, generated prefix-correct `.nanorc`, and Nano/Git/editor defaults. Host, lock, license, closure, and final-APK content checks pass; interactive phone editing remains. x86_64 honestly falls back to `vi`. |
| Build target | ✅ Fully integrated | Generated native addons target `aarch64-linux-android29`, matching `minSdk`, rather than the SDK level of the phone doing the build. |
| 16 KiB pages | ⚠️ Integrated; strict-device gate | React Native/Hermes and native dependencies were upgraded. The 1.3.11 verifier checks the final APK with `zipalign -P 16` and scans all 248 packaged ELF files: every loadable file has `PT_LOAD >= 0x4000`; six compiler `ET_REL` objects correctly have no load segments. A strict 16 KiB device run remains required. |
| PATH resolution | ✅ ARM64/API-30 baseline verified | System tools stay first, but virtual `/usr/bin/env` is deliberately routed to ADEV's native interpreter before Toybox. The connected phone runs both the untouched AchSwap global CLI and the isolated package-neutral global npm fixture by command name. Recursive Node/Python/system-sh resolution passes without bad-ELF or EACCES. |
| Executable permissions | ✅ Fully integrated | Executable ELFs are packaged in `nativeLibraryDir`. App-data scripts are interpreted or translated; `chmod` is not treated as a fix for SELinux/noexec. |
| Child process: Java spawn | ⚠️ Integrated; device gate | `ProcessManager` clears inherited host state, installs the runtime environment, resolves core/runtime/build commands, launches each task under `setsid`, obtains the PID from the child instead of reflection, streams output, and terminates the process group with a `/proc` descendant fallback. Device process-tree tests remain. |
| Child process: Node `spawn` / `exec` / `fork` | ⚠️ Fixed; automated 1.3.13 device gate | The preload and complete Termux variables are inherited by Node children. ADEV now intercepts `execve`, `execv`, `execvp`, `execvpe`, `execl`, `execlp`, and `execle` before termux-exec, so PATH-based child launches and nested shebangs share one resolver. Phase 5 executes spawn/execFile/exec/fork plus a globally installed npm CLI by command name. Connected runner evidence is still required. |
| Shell execution | ⚠️ Fixed; 1.3.13 device retest | Native Bash is preferred; `/system/bin/sh` is the fallback. Runtime 1.16.8 exports that choice as `ADEV_PYTHON_SHELL`, removes the stale Termux shell from Python/Git helper text and `paths.h`, and remaps legacy compiled requests at the exec boundary. Existing POSIX `NODE_OPTIONS` generation tests remain. Connected Vite/Python shell execution is still required. |
| npm lifecycle scripts | ⚠️ Fixed; device retest | `NPM_CONFIG_SCRIPT_SHELL` points to the APK-installed `adev-npm-shell`; direct JS and `node-gyp` scripts bypass app-data execution. Complex commands fall back to Bash plus `termux-exec`, and native builds enter Make through `adev_make`. Unsupported npm 11 `optional`, platform, architecture, Python, nodedir, target, and ldflags config injection was removed in favor of real host identity, normal environment variables, and supported node-gyp package config. |
| Optional dependencies | ⚠️ Policy integrated; device gate | Optional dependencies stay enabled while npm sees Android/ARM64. The global Linux spoof is gone. `adev-resolve-package` permits only Android/Bionic, exact hash-approved static/musl, source-build, or an explicit unsupported decision; the verified static/musl list is intentionally empty until artifacts are tested and locked. |
| Native addons | ⚠️ ARM64 baseline verified; extended matrix gate | N-API C/C++ and V8 fixtures build and load on ARM64/API 30; the N-API fixtures also pass rebuild, direct node-gyp and consumer uninstall/reinstall. Network-only NAN/prebuild/node-pre-gyp fallbacks and other API levels remain in the extended matrix. |
| `.node` loading | ⚠️ ARM64 baseline verified; matrix gate | ARM64 Android/Bionic, Node-version-matched N-API and V8 outputs load on the physical phone. API 29/34/35/36, strict-page and x86_64 feature-pack cases remain. |
| Development task registry | ⚠️ Integrated; device gate | Background tasks and PTY sessions share typed task/status/log/port records. PIDs, process groups, descendants, sources, persistence, exit/failure state, and bounded logs are exposed through task APIs. Stop signals the group and waits for verified ports to close; device orphan/process-tree tests remain. |
| Node / Express / Vite servers | ⚠️ Integrated; device gate | Structured Node listen/close/error events and `/proc` socket ownership discover arbitrary ports. Run/Preview has first-class Node, Express, Vite, Next, build, test, shell, and generic task types. The bundled device harness covers plain Node, Express, and Vite nested edits; it still needs a connected device. |
| Next.js | ⚠️ Fixed; 1.3.14 device gate | Version routing keeps Next 15 and earlier on their Webpack default and gives Next 16+ exactly one supported `--webpack` selector. Runtime 1.16.9 also replaces in-process `require(next.bin)` with an owned real child CLI that inherits stdio/cwd/env, remains attached for the server lifetime, forwards signals and exit status, and kills the child if its owner disappears. Host regressions cover 13.2.4, 14.2.35, 15.5.2, 15.5.22, and 16.2.12, including PID/PPID ownership, long-lived supervision, signal/exit/cleanup, and direct/lifecycle routing without project mutation. Real App/Pages dev/HMR/build/start/Ctrl+C remains a device gate. |
| Preview / ports | ⚠️ Integrated; device gate | Console text no longer creates an active port. Structured events and log text create candidates; ownership plus a successful `127.0.0.1` socket probe is required before UI publication. URLs carry task/PID/group/source/state and update through native events. Android timing and OEM `/proc` restrictions remain device gates. |
| Git core operations | ⚠️ Integrated; final device retest | JGit 6.7 remains the local repository engine, while UI network operations and Terminal commands share native Git 2.55.0 and one canonical path policy. Clone now chooses a visible private-project destination, opens/registers it only after verification, preserves the old workspace on failure, exposes branch fetch/checkout/upstream push and native PR creation, and gives Files direct Projects/`.env` access. Host security/store tests pass; final device/UI/network execution remains. |
| Git HTTPS | ⚠️ Integrated; device gate | Native `git-remote-http`, redirects, protocol v2, proxy settings, the assembled CA bundle, validated custom X.509 CAs, and the native credential helper are configured. Host source/build/APK checks pass; live clone/fetch/pull/push, rejection, proxy, redirect, and custom-CA cases require the Phase 3 device matrix. |
| curl | ⚠️ Integrated; device gate | The real Termux ARM64 curl executable is packaged in `nativeLibraryDir`, mapped through PATH/Java/shell wrappers, shares the assembled Android CA bundle, has a verified dependency closure, and is 16 KiB aligned. `adev-doctor --self-test` performs the device HTTPS probe. |
| Git SSH | ⚠️ Integrated; device gate | Dropbear 2026.94 is wrapped with managed key leases, Keystore-backed passphrases, strict host checking, known-host fingerprint confirmation/removal, key generation/import, and SCP/`ssh://` command support. The lease is the Android-safe agent equivalent; live auth, passphrase, rejection, and host-key-change cases need a device. |
| Git credentials | ⚠️ Integrated; device gate | HTTPS credentials, SSH private keys, and passphrases are Keystore-encrypted. The native ARM64 credential helper talks to an app-private loopback broker; commands/logs are redacted and JavaScript receives metadata only. Persistence/process-death and live rejection tests remain in the device matrix. |
| Git LFS | ⚠️ Explicit feature boundary | LFS use is detected and reports the missing signed `git-lfs` feature pack instead of silently failing. The signed index defines the capability, dependency, version, and diagnostics; ABI payload delivery is part of Phase 4 runtime distribution. |
| Corepack | ✅ Fully integrated | Corepack 0.35.0 is pinned and bundled. Runtime selection reports whether the version came from an exact offline payload, project `packageManager` declaration, warmed Corepack cache, or network; integrity/source metadata is committed. |
| pnpm | ⚠️ Integrated; device retest | pnpm 11.18.0 and its worker/node-gyp payload are bundled with SHA-256 verification. Version 1.3.6 retains its previously AAPT-omitted `.bin` commands and `.package-map.json`; the final APK contains the complete source payload. Android execution remains in the Phase 3 device gate. |
| Yarn | ⚠️ Integrated; device gate | Yarn 4.18.0 is bundled with SHA-256 verification. Exact declarations and direct commands install/run lifecycle/build/test fixtures offline without mutating project metadata; Android execution remains in the Phase 3 device gate. |
| Bun | ✅ Explicit capability boundary | Bun's supported platform list has no Android target. `bun` exits with an actionable Android/Bionic unsupported result and directs developers to Node/npm/pnpm/Yarn; no glibc Linux binary is installed or spoofed. |
| OpenCode CLI | ⚠️ Real runtime integrated; 1.3.12 ARM64 device gate | The first common payload failure was literal `mkdir("/tmp")`, not a proven per-mode Bun/OpenTUI crash. Runtime 1.16.7 restores the exact upstream tagfix/OpenTUI/library launch contract and preloads a separate ADEV shim that maps only `/tmp` paths into canonical app-private temp while rejecting traversal. Bare TUI, version/help/paths, agent-run, serve, and web now reach the real pinned ARM64 payload; host tests prove argument/environment forwarding, mapping, exit propagation, hashes, and 16 KiB alignment. No connected device is available, so none of those real modes is yet certified. x86_64 remains an honest missing-payload boundary; no glibc binary is substituted. |
| Optional tool packs | ⚠️ Explicit feature boundary | An Ed25519-signed catalog and verified installer/status/uninstaller cover CMake/Ninja, Rust/Cargo, NASM, Autotools/Libtool, Java, development libraries, and Git LFS. Signature tampering, dependencies, missing payloads, lifecycle, and diagnostics are tested. Production ABI feature payloads are not yet present, so the resolver returns an actionable unavailable capability instead of installing into noexec app data. |
| File watching: Node | ⚠️ Integrated; device gate | Global polling is removed. Private workspaces leave Chokidar/Watchpack on native watching; shared `/storage`, `/sdcard`, and `/mnt/media_rw` paths receive polling variables from the working-directory capability policy. Interactive `cd` refreshes the policy. Nested HMR remains an on-device gate. |
| File watching: editor | ⚠️ Integrated; device gate | Private workspaces use recursive per-directory `FileObserver` registration with UUID IDs, new-directory registration, symlink containment, and inotify-overflow rebuilds. Shared/FUSE workspaces use a recursive one-second snapshot watcher. Device overflow and OEM storage behavior remain. |
| Symlinks | ✅ Integrated with explicit Android boundary | Runtime symlinks are rebuilt automatically on private app storage. Shared/FUSE/SAF cannot faithfully represent Unix symlinks, case sensitivity, modes, or execution, so the guided copy refuses links/escapes; developers must clone or extract the source directly into private storage when project symlinks must be preserved. No unsafe dereference fallback is offered. |
| Environment variables | ⚠️ Fixed; device gate | App-scoped HOME/TMP/npm/TLS/Git/Termux/toolchain/package-policy values are comprehensive. Runtime 1.16.8 adds the exec-safe `ADEV_PYTHON_SHELL` contract and orders the recursive ADEV preload before termux-exec; corrected `NODE_OPTIONS`, target-specific ARM64 `CPATH`, Unix-personality `$LD`, and OpenCode's process-scoped `/tmp` remap remain. Global `CI`, no-color, Linux spoofing, and watcher polling are absent. Locale and interactive shared-storage transitions still need device checks. |
| TTY / terminal | ⚠️ Startup observed; final UX/device retest | API 30 observed the terminal startup/prompt after invalid SELinux-context bytes were removed. Native `forkpty`, resize, process-group signals, reaping, and bounded fallback exist. Version 1.3.8 removes double safe-area padding, keeps shortcuts above the IME, reconciles Android composition without duplicate text, and copies soft wraps as logical lines. Keyboard/accessory/copy, repeated close, job control, and final-candidate behavior remain device gates. |
| Android private filesystem | ✅ Fully integrated | Runtime, caches, global npm installs, temp data, and default workspaces are under private storage, which supports Unix metadata and protects project data. Runtime 1.16.12 exposes the project root at `~/workspaces` without merging shell/npm configuration into project storage; the API-30 `ls → cd → ls` upgrade regression passes. |
| Android shared filesystem | ⚠️ Android boundary with complete transfer UX; device gate | Shared folders remain available for viewing/editing, but ADEV now offers explicit open-in-place or private-import choices and keeps a visible Import action. Imports/exports use cancellable background plans with file/byte progress, source/full filters, independent Git/hidden/secret choices, conflict policies, transfer-owned staging, canonical containment, no-follow symlink cleanup, external metadata, and persisted SAF destination permissions. Successful import switches Explorer and a new Terminal to the private path. Normal package-manager/framework/native/Git mutation routes stop early with the exact import guidance. Android shared storage still cannot supply Unix symlinks/modes/execution, and real document providers remain a connected-device gate. |
| Filesystem path sandbox | ✅ Fully integrated | Canonical `Path` containment is segment-aware. Traversal and sibling-prefix escapes are rejected, `/data/data`, `/data/user`, and broad `/mnt` access are removed, runtime bin/lib writes are protected, system/APEX paths are read-only, and explicit user-visible storage roots are bounded. Private imports also reject source symlinks/escapes and clean failed staging directories. |
| SELinux / execution restrictions | ⚠️ Correct design; device gate | APK-native placement handles direct executables; `termux-exec` receives actual app/rootfs/SDK/SELinux variables for generated scripts. Validate without AVC denials on API 29, 34, 35, and 36 devices. |
| Secondary users / work profiles / adoptable storage | ⚠️ Integrated; automated device gate | Runtime/workspace roots come from `ApplicationInfo.dataDir`/`filesDir`, and shared/adoptable projects have a guided private import. The Phase 5 device matrix and instrumentation fixture validate private filesystem semantics; non-user-0/work-profile devices remain required external evidence for the Termux-derived payload relocation. |
| CPU architectures | ⚠️ App integrated; x86_64 runtime feature boundary | Gradle, React Native, Hermes, PTY, npm lifecycle shell, and Git credential helper build/package for `arm64-v8a` and `x86_64`; obsolete 32-bit ABIs are intentionally excluded. The full developer runtime/compiler sysroot remains ARM64, and x86_64 reports the required signed runtime feature rather than pretending native builds work. |
| Android 16 / Play targeting | ⚠️ Integrated; automated device/release gate | The project compiles and targets API 36 with RN 0.86.2, Gradle 9.3.1, NDK r29, new architecture, Hermes, and edge-to-edge enabled. APK manifest checks pass; CI now requires API 35/36 and strict 16 KiB device jobs plus bundletool validation before production release. |
| Release signing | ⚠️ Integrated; external credential gate | Release never uses `signingConfigs.debug`. Gradle fails closed unless all four external keystore values exist, rejects repository-local keystores, and the artifact gate rejects the Android debug certificate and requires the approved SHA-256 signer identity. No production key was supplied locally, so the production APK/AAB is intentionally a CI/owner gate. |
| Runtime supply-chain reproducibility | ⚠️ Incomplete production provenance/signing gate | The Ed25519-signed runtime 1.16.9 lock records 210 ARM64 plus 8 x86_64 native payloads by ABI/API/page policy, hash, size, path, and owner, including both ABI builds of the recursive exec resolver. The legacy hash-only count remains 196. BusyBox and Nano retain exact signed-index/archive/license/SONAME evidence. The bootstrap key is permitted only for this debug-key phone-test candidate; complete retained provenance and an external release key are production blockers. |
| Runtime update cleanup | ✅ Fully integrated | Runtime fingerprinting forces device reinitialization on map changes. Before relocation, Gradle verifies the Ed25519 runtime-lock signature and prunes only stale `libbin_`/`liblib_` JNI outputs and map entries absent from that signed ownership manifest; unrelated files cannot be removed. |
| APK/install footprint | ✅ Phone-test policy integrated | The final 1.3.14 phone-test APK is 360,839,574 bytes and remains below the enforced 390,000,000-byte APK/AAB budget. SHA-256: `A79DEF8A9FBB4BA69CC0F75C8A9076241FA57F3F88388E0006C5450440ADAA91`. Size is rechecked for production artifacts; optional large toolchains remain signed feature capabilities rather than unsafe writable-storage installs. |
| Host Android build toolchain | ⚠️ Integrated; external production-release gate | Gradle 9.3.1, AGP 8.12.0, exact JDK 17, Kotlin 2.1.20, API/build tools 36, and NDK 29.0.14206865 build phone-test unit tests, the complete non-debuggable phone-test APK, and its instrumentation APK successfully. Gradle rejects unsupported host JDKs. Externally signed AAB/APK and two-clean-build production evidence remain CI/owner gates. |
| Dependency security | ⚠️ Integrated mitigation; upstream release boundary | `npm run audit:production` rejects every advisory except the two exact `image-size` parser advisories that upstream still has no patched release for. A version-pinned install script rejects non-advancing ICNS/JXL/HEIF boxes, and the gate runs malicious-input probes with a two-second kill timeout before accepting the eight transitive report nodes. Nanoid 3.3.18, React Native CLI 20.2.0, fast-xml-parser 5.10.1, js-yaml, and brace-expansion are on fixed compatible releases. The reviewed exception expires 2026-09-11; any new advisory, source drift, missing patch, timeout, or count increase fails. |
| Test automation | ⚠️ Host/build complete; connected/signing gate | Repository-isolated Jest/ESLint, TypeScript, Java/Kotlin unit tests, phone-test instrumentation compilation, runtime policy/phase/Nano/OpenCode suites, license/secret/audit gates, signed ownership, and APK ABI/API/content/dependency/alignment checks pass. The built instrumentation runs offline/network/existing-project matrices inside the target UID. x86_64 emulators, connected ARM64 API 29/34/35/36 fresh/upgrade, strict 16 KiB, and two externally signed clean production builds remain. |

## Prioritized integration plan

### P0 — release blockers

#### P0.1 Run the on-device node-gyp acceptance matrix

Root cause/risk: host builds cannot reproduce Android's linker, SELinux policy,
mount flags, or Node `dlopen()` behavior.

Proper integration:

1. Run the bundled `adev-phase1-test --network` device harness, which creates
   fresh private workspaces and installs the native fixture matrix from source.
2. Exercise:
   `npm install`, `npm rebuild`, direct `node-gyp rebuild`,
   `child_process.spawn("node-gyp")`, `execFile`, `exec`, and `fork`.
3. Load the produced `.node`, invoke one exported function, uninstall the
   dependency, and reinstall it without any `chmod` or manual rebuild.
4. Repeat on API 29, 34, 35, and 36, including a strict 16 KiB-page ARM64 image.
5. Fail if logcat contains relevant `avc: denied`, `EACCES`, missing interpreter,
   missing `DT_NEEDED`, or namespace errors.

Acceptance: all commands and addon load pass in a fresh project and after an app
upgrade that replaces runtime 1.10.x/1.11.x with current runtime 1.13.0.

#### P0.2 Finish whole-APK 16 KiB page support

Root cause/risk before Phase 4: React Native 0.76.9, Hermes, fbjni, the C++ runtime, screens,
and image-pipeline prebuilts include 4 KiB-aligned ELF segments. ZIP alignment
alone does not make those libraries loadable on strict 16 KiB-page devices.

Proper integration:

- Upgrade React Native/Hermes and affected dependencies to releases that ship
  16 KiB-aligned ARM64 libraries.
- Move the Android build to NDK r28 or newer where supported.
- Keep the explicit linker flags for app-built native code and on-device
  addons.
- Scan every `.so` extracted from the final APK, not only source `jniLibs`.
- Run the app and native-addon matrix on a strict 16 KiB device/image with
  compatibility mode disabled.

Acceptance: every loadable ELF packaged in the final APK has `PT_LOAD`
alignment of at least `0x4000`.

Phase 4 result: implemented for the packaged artifact. React Native 0.86.2 and
NDK r29 replace the 4 KiB-aligned dependencies. The 1.3.11 phone-test gate
inspected 248 packaged ELF files: every loadable file has a minimum alignment
of `0x4000`; six compiler `ET_REL` inputs have no load segments.
Execution on a strict 16 KiB device remains the acceptance gate.

Reference:
[Android 16 KiB page-size support](https://developer.android.com/guide/practices/page-sizes).

#### P0.3 Migrate compile/target SDK to Android 16

Root cause/risk before Phase 4: `targetSdk 34` is outside the 2026 Google Play update
requirement for normal mobile apps.

Proper integration:

- Move compile and target SDK to API 36.
- Upgrade Android Gradle Plugin, React Native, and NDK as required.
- Test edge-to-edge, predictive back, large screens, local-network access for
  dev servers, foreground execution, storage, native-library namespaces, and
  all Android 15/16 compatibility changes.
- Re-run the complete execution/SELinux/native-addon matrix after the target
  bump.

Phase 4 result: compile and target API 36, RN 0.86.2, Gradle 9.3.1, AGP 8.12,
NDK r29, Hermes/new architecture, and edge-to-edge are integrated. The
generated manifest confirms API 36. Connected API 29/34/35/36 behavior testing
and the production Play artifact are now enforced external Phase 5 CI gates.

Reference:
[Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk).

#### P0.4 Add production release signing

Root cause/risk before Phase 5: `release` used the debug keystore.

Proper integration:

- Load release credentials from CI/secure local properties.
- Produce a signed AAB/APK without committing secrets.
- Verify with `apksigner`, preserve the upgrade key, and document key rotation.

Acceptance: release artifacts are not signed by the Android debug certificate.

Phase 5 result: implemented fail-closed external signing. Missing/partial values
or a repository-local keystore stop Gradle, and final verification requires the
approved certificate SHA-256 plus `apksigner`, `jarsigner`, and bundletool.
Producing the artifact remains an external release-owner credential gate.

### P1 — high-impact compatibility

#### P1.1 Replace unconditional Linux platform spoofing

Root cause: reporting every Node process as `linux/arm64` enables more optional
packages but can select glibc binaries that are incompatible with Bionic.

Proper integration:

- Introduce a resolver that prefers, in order: Android ARM64, compatible
  Bionic/Termux artifact, musl/static artifact proven on Android, source build.
- Make Linux spoofing opt-in per known-compatible tool rather than global
  `NODE_OPTIONS`.
- Force source builds for native packages when an installed Linux prebuild
  cannot be validated.
- Record package decisions in `adev-doctor`.

Acceptance: esbuild/SWC-style optional packages either execute successfully or
fall back cleanly; installs do not leave an unloadable glibc binary.

Phase 1 result: implemented with an honest Android/Bionic default, a
machine-readable policy, an empty-by-default exact-hash static/musl allowlist,
source-build readiness checks, and an actionable unsupported result. Device
fixtures remain the acceptance gate.

#### P1.2 Build hosted packages for this app's package name/rootfs

Root cause: official Termux packages are compiled for `com.termux` and its
prefix. Environment and driver overrides cover known paths but cannot guarantee
that every dependency is relocatable, especially on secondary users, work
profiles, or adoptable storage.

Proper integration:

- Use Termux's build infrastructure to produce a pinned repository for
  `com.mobileide.app` and the selected runtime prefix, or patch every package
  with a documented relocation test.
- Test primary/secondary user and work-profile `dataDir` values.
- Eliminate dependence on hard-coded Termux RUNPATHs where practical.

Acceptance: a scan finds no unexpected `/data/data/com.termux` dependency in
runtime behavior, and device tests pass outside user 0.

Phase 4 result: private workspace/runtime paths derive from the current app
context, and shared/adoptable projects can be staged and atomically imported
without following symlinks. The upstream Termux-derived ARM64 binaries were not
rebuilt for every secondary-user prefix, so this row remains a documented
device/repository gate rather than a false complete result.

#### P1.3 Make the runtime bundle reproducible and size-controlled

Root causes:

- The fetch script follows the latest live package index.
- Repository SHA-256 values are verified, but versions are not locked and the
  index itself is not signature-verified.
- The current fetch copies development-only headers/libraries and historical
  generated JNI files are not automatically pruned.

Proper integration:

- Commit a lock manifest containing package, version, URL, SHA-256, license,
  runtime path ownership, and expected SONAMEs.
- Verify a signed repository index or a reviewed committed lock.
- Compute the reachable ELF closure from actual executable roots and Python
  extension roots; omit unused `libclang` APIs, test modules, sanitizer
  runtimes, and static development archives unless selected.
- Give generated JNI files an ownership manifest and delete only stale,
  generator-owned paths before regeneration.
- Consider an automatic, signed, on-demand compiler feature pack if base APK
  size/install space is unacceptable. First native install may download it, but
  must not require shell commands or configuration.

Acceptance: identical inputs produce identical runtime files; stale files
disappear; CI reports size deltas and license inventory.

Phase 4 result: the deterministic generator and Ed25519-signed runtime lock now
inventory ABI delivery, API/page policy, hashes, sizes, runtime paths, and
owners, and the APK gate verifies the bundled signature. Complete pinned
Termux URL/license/SONAME provenance, stale generator-owned pruning, external
production lock signing, and the compiler feature-pack/size decision remain
Phase 5 release gates.

#### P1.4 Complete native-addon coverage

Proper integration:

- Maintain fixtures for N-API C, N-API C++, NAN/V8 ABI, Python-assisted gyp,
  packages with `prebuild-install`, and packages with
  `node-pre-gyp || node-gyp`.
- Verify Debug/Release addons, parallel Make, exceptions/RTTI, C++ shared
  runtime, `pkg-config`, transitive libraries, and 16 KiB alignment.
- Add explicit diagnostics for missing Rust/Cargo, CMake/Ninja, NASM, Java, or
  system packages instead of reporting a generic node-gyp error.

Phase 1 result: the base fixture set and `adev-phase1-test` runner are bundled.
Optional non-node-gyp tool packs remain Phase 3.

#### P1.5 Fix PTY/process lifecycle correctness

Root cause: `PtyProcess.close()` sets `isAlive = false` before calling `kill()`;
`kill()` delegates to `signal()`, which only signals while `isAlive` is true.
Background process-tree killing also depends on reflection for the PID.

Proper integration:

- Signal the process/group before changing state and always close the master FD.
- Reap children and test repeated close, terminal destruction, SIGINT, SIGTERM,
  SIGKILL, job control, and process trees.
- Use supported process/PID APIs where available.

Phase 1 result: implemented using child-reported PIDs, `setsid`, native
process-group signals, a `/proc` descendant fallback, signal-before-state PTY
close, idempotent FD close, and asynchronous reaping. Device stress tests remain.

#### P1.6 Harden Git authentication

Proper integration:

- Store tokens/keys with Android Keystore-backed encryption.
- Add a native Git credential helper that can request credentials through app
  UI without placing secrets in command lines or logs.
- Add known-host verification UX, key import/generation, passphrase handling,
  `ssh-agent` or equivalent, and Git `ssh://`/SCP-form URL tests.
- Test HTTPS, SSH, proxy, custom CA, redirects, submodules, LFS policy, and
  credential rejection.

Phase 3 result: implemented with Keystore AES/GCM storage, credential
references, a loopback broker and native ARM64 Git credential helper, URL/log
redaction, strict known-host confirmation, app-private SSH key leases,
Dropbear key generation/import, proxy/custom-CA APIs, redirects, submodules,
and an explicit signed Git LFS feature boundary. Host policy/build/APK tests
pass; live network and process-death cases remain the device gate.

#### P1.7 Use filesystem-aware watching and workspace policy

Proper integration:

- Use inotify/native watch on private ext4/f2fs workspaces.
- Fall back to polling only for shared/FUSE storage or after a detected watch
  failure; expose interval/battery controls.
- Make editor watches recursive with collision-free IDs and overflow recovery.
- Warn or copy projects into a private workspace when they require symlinks,
  executable tools, case-sensitive names, or native builds.

Phase 2 result: native recursive editor/Node watching is the default for
private workspaces. Shared/FUSE projects receive polling only through a
working-directory capability decision. Editor watcher IDs are UUIDs, newly
created directories are registered, symlink traversal is bounded, and inotify
overflow rebuilds the tree. The guided private import/copy flow remains
Phase 4 because it also governs execution, symlinks, and native-build policy.

#### P1.8 Correct filesystem boundary validation

Proper integration:

- Compare canonical `Path` objects using segment-aware containment, not raw
  string prefixes.
- Restrict `/data` access to the app's own canonical roots.
- Treat `/system` as read-only and require explicit granted roots for shared
  storage.
- Add traversal, symlink escape, sibling-prefix, and deleted-path tests.

Phase 1 result: canonical segment-aware boundaries and host traversal/prefix
tests are implemented. Adoptable-storage and work-profile cases remain Phase 4.

### P2 — completeness and developer experience

#### P2.1 Package-manager lifecycle

- Update and pin Corepack; test current signing keys.
- Optionally pre-cache approved Yarn and pnpm versions for offline first use.
- Show whether a manager came from a project `packageManager` declaration,
  Corepack cache, or network.

Phase 3 result: Corepack 0.35.0, pnpm 11.18.0, and Yarn 4.18.0 are pinned.
Exact pnpm/Yarn payloads are bundled with SHA-256 locks and run offline
install/lifecycle/build/test fixtures. Other declared versions use verified
Corepack cache/network resolution and fail actionably when unavailable.

#### P2.2 Bun

Bun has no supported Android target. Phase 3 implements an honest capability
gate: `bun` identifies Android/Bionic as unsupported, exits nonzero, and offers
the working Node/npm/pnpm/Yarn path. No glibc Linux binary is downloaded or
relabeled. Revisit only if Bun publishes a maintained Android/Bionic artifact
with the required execution, dependency, 16 KiB, and device guarantees.

#### P2.3 Optional build-tool packs

Provide automatically installable, signed packs for common non-node-gyp build
systems: CMake/Ninja, Rust/Cargo, NASM, Autoconf/Automake/Libtool, Java, and
package-specific development libraries. Keep the base node-gyp C/C++ path
working without these optional packs.

Phase 3 result: an Ed25519-signed catalog plus verified status/install/uninstall
runtime covers those capabilities and Git LFS. A signed host fixture proves
the lifecycle and catalog-tamper rejection. Production native pack payloads
must be APK/feature-delivered because Android private writable storage is
noexec; their ABI-specific delivery and dependency closure are explicitly
assigned to Phase 4.

#### P2.4 Environment policy

- Stop forcing `CI=true`, polling, no-color, and Linux spoofing globally.
- Apply settings by process purpose and filesystem capability.
- Preserve user overrides safely and expose the final effective environment in
  `adev-doctor --verbose`.
- Validate locale availability instead of assuming `en_US.UTF-8`.

#### P2.5 Test and CI isolation

- Add the missing React Native Jest mocks.
- Commit an ESLint configuration boundary that does not inherit unrelated
  parent-directory flat configs.
- Add APK checks for signature, native map integrity, dependency closure,
  duplicate/stale files, 16 KiB ZIP/ELF alignment, target SDK, ABI set, licenses,
  and size budgets.
- Run device tests on every runtime/toolchain update.

Phase 5 result: implemented. Repository-scoped lint/Jest, Android unit and
instrumentation fixtures, host regression suites, production audit, licenses,
secrets, signed ownership, APK/AAB policy, x86_64 emulator, ARM64 API, 16 KiB,
fresh/upgrade, and reproducibility jobs are release gates.

#### P2.6 Additional ABI support

Phase 4 result: the application, React Native/Hermes libraries, PTY, npm
lifecycle shell, and Git credential helper now build and package for ARM64 and
x86_64, while obsolete 32-bit ABIs remain excluded. The signed runtime lock
marks the ARM64 developer runtime as bundled and the x86_64 developer runtime
as a required signed feature. Until that payload/sysroot is produced, x86_64
native builds are an actionable capability boundary rather than advertised as
working.

#### P2.7 Pin the host Android build JDK

- Declare JDK 17 as the supported build JDK in project and CI configuration.
- Add an early Gradle version check with a direct remediation message.
- Do not silently use an unrelated system JDK from `PATH`; make local and CI
  builds resolve the same toolchain.

Phase 5 result: implemented. JDK 17 builds successfully; the host default JDK
25 is rejected during settings evaluation with a direct `JAVA_HOME`
remediation.

## Required device test commands

These belong in automation; they are not end-user recovery steps.

```sh
adev-doctor
adev-doctor --verbose
adev-doctor --self-test --json
adev-phase1-test
adev-phase1-test --network
node -p "process.version + ' ' + process.arch + ' ' + process.platform"
python --version
make --version
clang --version
curl --fail --head https://registry.npmjs.org/
npm install
npx node-gyp rebuild
node -e "require('child_process').spawn('node-gyp',['--version'],{stdio:'inherit'}).on('exit',c=>process.exit(c||0))"
```

The native fixture must then be loaded with Node and its result asserted.

## Phase 1 acceptance record

Host evidence on 2026-07-29:

- Implementation commit: `8c20d06`
  (`phase-1: complete Android execution and native-build baseline`).
- `npm run test:runtime-policy`: pass.
- `:app:testReleaseUnitTest`: pass.
- `:app:assembleRelease`: pass.
- Termux package SHA-256 and 80-package dependency closure: pass.
- `curl` AArch64/linker/`DT_NEEDED`/`0x4000` inspection: pass.
- Release APK content check for curl, doctor, and fixtures: pass.
- No APK, signing credential, build cache, or existing
  `ADevStudio-v1.3.3-arm64.apk` is included in the Phase 1 commit.

Connected ARM64/API-30 evidence on 2026-08-23:

- Upgrade installation and terminal startup: pass.
- Untouched `@achswap/mcp-sdk` global command through `#!/usr/bin/env node`:
  `achswap --help` pass.
- Isolated package-neutral global npm CLI, env-Python, system-sh, virtual
  `/bin/sh`, and Python `os.popen()`: pass in `adev-phase1-test`.
- N-API C and C++ install, load, rebuild, direct node-gyp, consumer install,
  uninstall and reinstall: pass.
- Node 26 C++20 V8 addon compile, link and `node test.js` load: pass.

Remaining device evidence:

- Fresh install plus API 29/34/35/36, strict 16 KiB, x86_64 developer-runtime,
  SELinux/AVC, TLS/network fallbacks and PTY/process-tree stress remain before
  removing the cross-device Phase 1 gate.

## Phase 2 acceptance record

Host evidence on 2026-07-29:

- `npm run test:phase2-host`: pass.
- `node_modules/.bin/tsc --noEmit` with
  `NODE_OPTIONS=--max-old-space-size=4096`: pass.
- `:app:compileDebugKotlin`: pass with JDK 17.
- `:app:testReleaseUnitTest`: pass with JDK 17.
- `:app:assembleRelease`: pass with JDK 17.
- Exact npm packages `@next/swc-wasm-nodejs@15.5.22` and
  `@next/swc-wasm-nodejs@16.2.12`: available.
- Release APK content check for the Next launcher, structured server preload,
  Phase 2 device harness, and rebuilt native npm shell: pass.
- No APK, signing credential, cache, generated release artifact, or existing
  `ADevStudio-v1.3.3-arm64.apk` is included in the Phase 2 commit.

Blocked device evidence:

- The Android SDK's `adb` is installed, but `adb devices -l` reports no
  connected emulator or physical device.
- Run `adev-phase2-test --network` on fresh and upgraded ARM64 API 29 and API
  36 installations. It covers plain Node, Express, Vite nested edits, Next.js
  15.5.22/16.2.12 App+Pages routers, direct and npm-script launch paths,
  development/HMR, production build/start, and port cleanup.
- From Run/Preview, assert that arbitrary ports appear only after a successful
  probe, Terminal-launched servers share ownership/status, crashes are
  actionable, navigation preserves persistent tasks, and stop leaves no child
  or listening port.

Framework basis: Next.js 16 documents `--webpack` for both `next dev` and
`next build`; Next 15's CLI instead uses Webpack when Turbo flags are absent.
Next.js also documents WebAssembly as the compiler's cross-platform path:
[Next.js CLI](https://nextjs.org/docs/app/api-reference/cli/next) and
[Next.js Compiler](https://nextjs.org/docs/architecture/nextjs-compiler).

## Phase 3 acceptance record

Host evidence on 2026-07-29:

- `npm run test:runtime-policy`: pass.
- `npm run test:phase2-host`: pass (regression gate).
- `npm run test:phase3-host`: pass for the protected Git bridge, strict SSH
  policy, exact offline package-manager selection, pnpm/Yarn
  install/lifecycle/build/test fixtures, signed tool-pack install/uninstall,
  catalog-tamper rejection, and Bun capability result.
- JavaScript syntax checks and `node_modules/.bin/tsc --noEmit`: pass.
- `:app:testReleaseUnitTest` and `:app:assembleRelease`: pass with JDK 17.
- Corepack 0.35.0, pnpm 11.18.0, and Yarn 4.18.0 payload/hash checks: pass.
- The release APK contains the native Git credential helper, generic broker
  client, strict SSH wrapper, package-manager payloads/lock, signed tool-pack
  catalog/signature/key, Bun gate, and Phase 3 device harness. It does not
  contain the obsolete JavaScript Git credential helper.
- `libbin_adev_git_credential.so` is AArch64, requests
  `/system/bin/linker64`, and every `PT_LOAD` segment is aligned to `0x4000`.
- The release APK is 206,006,239 bytes with SHA-256
  `C9B708D62063E7F89215974528BB8A7A435C2D6923C39C7BA02298E329C480D5`.
  It verifies with APK Signature Scheme v2, but its Android debug certificate
  remains the explicit Phase 5 production-signing blocker.
- No APK, signing credential, package-manager cache, build cache, or existing
  `ADevStudio-v1.3.3-arm64.apk` is included in the Phase 3 commit.

Blocked device and feature evidence:

- The Android SDK's `adb` is installed, but `adb devices -l` reports no
  connected emulator or physical device.
- Run `adev-phase3-test --network` on fresh and upgraded ARM64 API 29 and API
  36 installations. Verify HTTPS and SSH clone/fetch/pull/push, rejection,
  key passphrases, unknown/changed host keys, redirects, proxy, custom CA,
  submodules, process-death credential persistence, and that logs/commands
  contain no credentials.
- Repeat npm/npx/pnpm/Yarn online and warmed-offline lifecycle fixtures through
  Terminal and background tasks on those devices.
- Git LFS and the large optional native build packs intentionally stop at the
  signed feature capability. Android's noexec boundary requires their
  ARM64/x86_64 APK feature payloads, dependency closure, and uninstall tests
  in Phase 4.

Bun platform basis: Bun's official installation documentation lists supported
macOS, Linux, and Windows targets but no Android target:
[Bun installation](https://bun.sh/docs/installation).

## Phase 4 acceptance record

Host evidence on 2026-07-29:

- Implementation commit: `001cc17`
  (`phase-4: complete Android 16 and multi-ABI platform support`).
- React Native 0.86.2/React 19.2.3/CLI 20.1.0, Gradle 9.3.1,
  AGP 8.12.0, Kotlin 2.1.20, API/build tools 36, NDK 29.0.14206865, JDK 17,
  Hermes, and new architecture: configured.
- `npm run test:runtime-policy`, `test:phase2-host`, `test:phase3-host`, and
  `test:phase4-host`: pass.
- `node_modules/.bin/tsc --noEmit` and JavaScript syntax checks: pass.
- `:app:testDebugUnitTest` and `:app:assembleDebug`: pass with JDK 17.
- `aapt2 dump badging`: `minSdk 29`, compile/target API 36, version 1.3.5.
- `test:phase4-apk`: pass for exact ARM64/x86_64 ABI content, required native
  helpers/runtime-lock/device harness, valid Ed25519 lock signature, 16 KiB ZIP
  alignment, and all packaged ELF files.
- Final debug APK: 256,405,243 bytes, SHA-256
  `28B5DE290CCDFD75D90C3312B962242D4556A236029C4FCDF6F6E1996F5480ED`. It verifies
  with APK Signature Scheme v2 and the expected debug certificate; it is test
  evidence, not the Phase 5 production release artifact.
- The signed runtime lock inventories 204 ARM64 developer/app-native payloads
  and three x86_64 app-native helpers. The private workspace import rejects
  symlinks/escapes, stages safely, and atomically finalizes.
- No APK, private signing key, cache, generated release artifact, or existing
  `ADevStudio-v1.3.3-arm64.apk` is included in the Phase 4 commit.

Blocked device, feature, and host-release evidence:

- `adb devices -l` reports no connected emulator or physical device. Run the
  fresh-install/upgrade/runtime/storage matrix on ARM64 and x86_64 APIs
  29/34/35/36, including a strict 16 KiB image, secondary user, work profile,
  private/shared/adoptable storage, traversal, and symlink cases.
- This Windows host's Device Guard blocks the RN 0.86 Hermes compiler at
  `hermesc.exe` with exit 4551 during release bundling. Debug compilation and
  APK gates pass; Phase 5 CI must run release bundling on a host where the
  checked-in Hermes compiler is permitted.
- The complete x86_64 developer runtime/sysroot and large optional tool-pack
  payloads are not bundled. Their signed capability records prevent unsafe
  glibc/noexec fallbacks, but production feature delivery and device lifecycle
  tests remain required.
- At this checkpoint, Termux-derived ARM64 provenance, signed-manifest cleanup,
  production signing, reproducibility, size budgets, CI matrices, and
  dependency triage were assigned to Phase 5. The Phase 5 acceptance record
  below records their implemented policy and remaining external evidence.

Platform basis: React Native 0.86 includes current Android compatibility work;
React Native 0.81 introduced Android 16/API 36 and 16 KiB support; AGP 8.11+
documents API 36/JDK 17 requirements:
[React Native 0.86](https://reactnative.dev/blog/2026/06/11/react-native-0.86),
[React Native 0.81](https://reactnative.dev/blog/2025/08/12/react-native-0.81),
and [AGP 8.11 release notes](https://developer.android.com/build/releases/agp-8-11-0-release-notes).

Phase 5 implementation is recorded below. No additional implementation phase
is authorized by this five-phase plan; only external runner, device, feature,
and signing evidence remains.

## Phase 5 acceptance record

### 1.3.12 OpenCode `/tmp` compatibility beta evidence — 2026-08-22

- Implementation commit: `b925fd2`
  (`fix: restore OpenCode Android runtime with private tmp remap`).
- App/runtime version: 1.3.12 / 1.16.7; phone-test package
  `com.mobileide.app.phonetest`, version code 18, compile/target API 36.
- Direct execution evidence from the prior phone build showed the pinned
  OpenCode/Bun payload failed first at `mkdir("/tmp")` for version, help, paths,
  run, serve, web, and TUI, even when `TMPDIR`, `TMP`, `TEMP`, and `BUN_TMPDIR`
  were app-private. That common first failure did not prove each mode had a
  separate native crash.
- Exact inspection of `guysoft/opencode-termux` v0.2.1 shows its wrapper
  preloads `libtagfix.so`, configures `LD_LIBRARY_PATH` and
  `OPENTUI_LIB_PATH`, and launches the payload. Its tagfix source only calls
  Bionic `mallopt` to disable heap pointer tagging; it cannot redirect `/tmp`.
- The pinned payload dynamically imports libc `mkdir`, `mkdirat`, `open`,
  `openat`, metadata, rename, and removal functions. A new ADEV-owned preload
  shim maps only exact `/tmp` and `/tmp/...` paths to canonical app-private
  `ADEV_OPENCODE_TMPDIR`, rejects `..` traversal, and leaves every other path
  unchanged. Android's root `/tmp` is never created or requested.
- The APK-native launcher restores the upstream tagfix/OpenTUI/library
  contract, supplies every Bun/POSIX/XDG temp spelling plus real-executable
  variables, preloads the ADEV shim before inherited `termux-exec`, and forwards
  all standard arguments. The former blanket exit-69 mode gate is removed.
- Host execution passes bare, version, short-version, help, paths, run-help,
  real-run, serve, and web forwarding against a child fixture. It also verifies
  temp replacement, preload order, child exit propagation, traversal rejection,
  exact upstream component hashes, Bionic PIE/interpreter policy, exported shim
  symbols, and `PT_LOAD >= 0x4000`.
- JDK 17 builds `testPhoneTestUnitTest`, `assemblePhoneTest`, and
  `assemblePhoneTestAndroidTest`. The main APK contains 250 ELF files; 244
  loadable files pass 16 KiB alignment and six compiler relocatables correctly
  have no load segments. The signed runtime lock records 209 ARM64 plus seven
  x86_64 payloads; the legacy hash-only provenance count remains 196.
- Main APK: `ADevStudio-v1.3.12-phone-test.apk`, 360,699,232 bytes, SHA-256
  `96FC78D8A7F01905F1932EEBF96458A32682815FEE575D34E351AC292EF10234`.
  It is version 1.3.12-phone-test/API 36, exact ARM64/x86_64, signed with the
  phone-test debug certificate, and passes the signed-lock, source-asset,
  dependency-closure, ZIP alignment, and ELF alignment gates.
- Instrumentation APK: 694,413 bytes, SHA-256
  `566189259B6E79E03A843FD96A3A05AC9CBA7269D9B6A7C753C8E7E673C0FE46`.
- `adb devices -l` is empty. The real ARM64 payload must be exercised in this
  order: version, help, debug paths, `run --help`, real `run`, serve, web, then
  TUI. Node/Vite/Next/Git/native-addon and terminal UX checks also remain
  device gates; none is inferred from host or APK success.

### 1.3.11 Next.js/OpenCode corrective beta evidence — 2026-08-22

- Implementation commit: `fbfe48d`
  (`fix: correct Next and OpenCode Android launchers`).
- App/runtime version: 1.3.11 / 1.16.6; phone-test package
  `com.mobileide.app.phonetest`, version code 17, compile/target API 36.
- The copied ARM64 phone transcript proves Next 15.5.2 installation succeeded,
  then both `npm run dev` and `npx next dev` reached `adev-next` and failed on
  its injected `unknown option '--webpack'`. Exact 15.5.2 and 15.5.22 package
  inspection shows Webpack is their default when Turbo selectors are absent;
  exact 16.2.12 inspection shows Turbopack is its default and `--webpack` is
  the supported opt-out. The launcher now applies those distinct contracts.
- Next host regressions cover 15.5.2, 15.5.22, and 16.2.12; default dev,
  explicit Turbo removal, duplicate Webpack normalization, build, start,
  malformed versions, cache isolation, no project mutation, and source routing
  through direct commands, npm lifecycle scripts, npx's shell, and Java tasks.
- `opencode --version`, `-v`, help, and `debug paths` now return from the
  APK-native launcher and cannot execute the Bun payload. The version comes
  from the signed `adev-opencode.json` manifest through a generated CMake
  header. A host-compiled launcher test poisons every temp/XDG variable with
  `/tmp`, verifies app-private output, proves both version aliases, and proves
  TUI/run/server/agent/web modes return exit 69.
- The transcript's empty grep for the OpenCode gate is expected: the message is
  compiled into `/data/app/.../lib/arm64/libbin_opencode.so`, not extracted
  under `/data/user/0/.../files/runtime`. The grep result did not show that the
  launcher was missing.
- Full host gates pass: exact JDK 17, ESLint with zero errors/13 warnings,
  10 Jest suites/45 tests, TypeScript, the 911-package/214-native license
  inventory, secrets, signed ownership, build-tool security, runtime policy,
  Phases 2–5, OpenCode, Nano, and the bounded production audit.
- Android gates pass under JDK 17/NDK r29:
  `testPhoneTestUnitTest`, `assemblePhoneTest`, and
  `assemblePhoneTestAndroidTest`. The manifest-derived OpenCode launcher builds
  and is packaged for both ARM64 and x86_64.
- Main APK: `ADevStudio-v1.3.11-phone-test.apk`, 360,682,699 bytes, SHA-256
  `E68B83EF4C096C9973CEE5C9666DE3B0200DF32AADC9B5CE3A3A70B1AE090081`.
  It is API 36, exact ARM64/x86_64, signed-lock and dependency-closure verified,
  16 KiB ZIP aligned, and all 248 ELF files pass the alignment policy.
- Instrumentation APK: 694,413 bytes, SHA-256
  `004D06B00B9F0514AEF357BA0FE63BFA3B28066F530E4FA6AA679FEBEE00F114`.
- The beta is intentionally signed with the phone-test debug certificate
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`;
  it is for direct device testing, not a production/Play release.
- `adb devices -l` reports no connected device. Real Next 15/16 App and Pages
  dev/HMR/build/start, OpenCode native diagnostics, Node/Vite/Git flows, and the
  final native-addon link/load therefore remain **PENDING ON 1.3.11** and are
  not inferred from host or APK verification. OpenCode functional modes remain
  an explicit upstream/payload capability boundary rather than a pending claim.

### 1.3.10 corrective candidate evidence — 2026-08-22

- Implementation commit: `8054295`
  (`fix: add Android Unix linker bridge`).
- App/runtime version: 1.3.10 / 1.16.5; phone-test package
  `com.mobileide.app.phonetest`, version code 16, compile/target API 36.
- The 1.3.9 ARM64 phone transcript verifies pure-JS `npm install`, a Node HTTP
  server on port 3000, HTTPS Git clone, branch checkout, node-gyp configuration,
  Make recursion, ARM64 header resolution, and compilation of `bufferutil.o`.
- The remaining native failure was platform-wide linker dispatch: the verified
  LLVM payload is stored as `libbin_lld.so`, and generic LLD cannot infer the
  Unix/ELF personality from that Android relocation name. The new dual-ABI
  APK-native launcher supplies `argv[0] = ld.lld` and is used consistently by
  Clang `--ld-path`, `$LD`, PATH, shell functions, and Java command resolution.
- `opencode -v` is now normalized to the verified `--version` diagnostic. This
  prevents upstream short-option parsing from entering unsupported startup and
  attempting to create read-only `/tmp`; full functional modes remain the
  explicit Android Bun/OpenTUI crash boundary.
- Host gates: JDK 17, 10 Jest suites/45 tests, TypeScript, ESLint with zero
  errors/13 warnings, license/secret/ownership/build-tool security, runtime
  policy, shell/sysroot/linker regressions, Phases 2–5, OpenCode, Nano, and the
  bounded production audit pass.
- Android gates: `testPhoneTestUnitTest`, `assemblePhoneTest`, and
  `assemblePhoneTestAndroidTest` pass under JDK 17/NDK r29.
- Main APK: `app-phoneTest.apk`, 360,685,255 bytes, SHA-256
  `E87B6DA311435F5E08DBD8C0D2C7F8F14BA551211B7A8DF0761D23D2EF5C4E9B`.
  It is API 36, exact ARM64/x86_64, signed-lock and dependency-closure verified,
  16 KiB ZIP aligned, and all 248 ELF files pass the alignment policy.
- Instrumentation APK: 694,413 bytes, SHA-256
  `B9A8EC728A5A07C0D842984B6BC004D5FD81B3BB2A3F586BA80F212E3D121F82`.
- `adb devices -l` currently reports no connected device. Final native-addon
  linking/loading and `opencode -v` execution remain **PENDING** on 1.3.10 and
  are not inferred from source, host, or APK verification.

### 1.3.9 corrective candidate evidence — 2026-08-22

- Implementation commit: `0ffebd2`
  (`fix: repair Android shell and native sysroot`).
- App/runtime version: 1.3.9 / 1.16.4; phone-test package
  `com.mobileide.app.phonetest`, version code 15, compile/target API 36.
- Latest copied device logs show the earlier Python `zipfile._path` and compiled
  Termux Make-shell failures are resolved far enough for node-gyp to enter
  Clang. The next root cause was `linux/types.h` importing the packaged but
  unreachable `aarch64-linux-android/asm/types.h`.
- RuntimeManager now orders the ARM64 target UAPI directory before generic
  Bionic headers in `CC`/`CXX`, exports the same paths through `CPATH`, and
  requires the full UAPI chain before reporting native builds ready. Runtime
  generation and `adev-doctor` enforce the same condition.
- The Vite failure was independent: the generated `.adev-agent-env` contained
  literal `${'$'}{NODE_OPTIONS:-}`. It now emits valid POSIX
  `${NODE_OPTIONS:-}`; focused tests decode the Kotlin generator, syntax-check
  and source the exact shell snippet under sh/Bash, and preserve unset/custom
  `NODE_OPTIONS`.
- Project-aware doctor schema 5 reports scripts, nested Node projects, direct
  entry commands, Node/npm engine compatibility, native-script approval, Git/
  SSH usage, OpenCode's capability boundary, compiler target, `CPATH`, and
  sysroot readiness. It does not mutate project manifests or auto-approve
  dependency scripts.
- Host gates: JDK 17, 10 Jest suites/45 tests, TypeScript, ESLint with zero
  errors/13 warnings, license/secret/ownership/build-tool security, runtime
  policy, generated shell, native sysroot, Phases 2–5, OpenCode, Nano, and the
  bounded production audit pass.
- Android gates: `testPhoneTestUnitTest`, `assemblePhoneTest`, and
  `assemblePhoneTestAndroidTest` pass under JDK 17/NDK r29.
- Main APK: `app-phoneTest.apk`, 360,654,460 bytes, SHA-256
  `35B0106F3B755901C722251A98D7E3DB9D667C190E550509F05E907DF2D37A14`.
  It is API 36, exact ARM64/x86_64, signed-lock and dependency-closure verified,
  16 KiB ZIP aligned, and all 246 ELF files pass the alignment policy.
- Instrumentation APK: 694,409 bytes, SHA-256
  `870CA39117F9C908ECBC71E2195006C029D5A52B972B60A41E9BE43920B08AD3`.
- `adb devices -l` reports no connected device. Vite startup and a real native
  addon install/rebuild/compile/load remain **PENDING** on 1.3.9; Git network/
  credential flows and the other device matrices likewise are not inferred
  from host or APK checks.
- OpenCode diagnostics remain integrated, while interactive/run/server modes
  remain the verified upstream Android Bun/OpenTUI crash boundary. This release
  does not claim those unsafe modes work.

### 1.3.8 current candidate evidence — 2026-08-11

- App/runtime version: 1.3.8 / 1.16.3; phone-test package
  `com.mobileide.app.phonetest`, version code 14, compile/target API 36.
- Host gates: 10 Jest suites/45 tests, TypeScript, ESLint with zero errors and
  13 warnings, runtime policy, Phases 2–5, OpenCode, Nano, Git/security, license,
  signed ownership, and `git diff --check` pass.
- `npm run release:check` passes with the 911-package license inventory. The
  full and production npm reports contain eight high-severity transitive nodes,
  all attributable to the two `image-size` advisories that have no upstream
  release fix. The pinned install patch and timeout-based malformed ICNS/JXL/
  HEIF regression probes pass; every other advisory is eliminated and any new
  leaf or severity-count increase fails the release gate. The reviewed boundary
  expires 2026-09-11.
- Android gates: `testPhoneTestUnitTest`, `assemblePhoneTest`, and
  `assemblePhoneTestAndroidTest` pass under exact JDK 17/NDK r29. The test APK
  targets the same non-debuggable phone-test package and runs through
  AndroidJUnitRunner without `run-as`.
- Main APK: `app-phoneTest.apk`, 360,650,192 bytes, SHA-256
  `D227A57916822CF090FE6C63F8313A398860EE4B24CD6CE46DE96D2BFA3219AB`.
  It passes `apksigner`, `zipalign -P 16`, exact dual ABI, complete source-asset
  retention, signed-lock, runtime-map-aware dependency closure, and 246-ELF
  alignment; six compiler relocatable objects correctly have no load segments.
- Instrumentation APK: `app-phoneTest-androidTest.apk`, 694,409 bytes,
  SHA-256 `B006C6952640969B04F07870A6AF2D4959970E1BD2F324F3C34A472CCD9AD014`.
  Both APKs use the phone-test certificate digest
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`;
  this is explicitly a debug test key, not production signing.
- The signed runtime lock covers 207 ARM64 and 5 x86_64 native artifacts.
  BusyBox 1.38.0-1 and Nano 9.2 have exact provenance; 196 legacy Termux
  records remain hash-only and block a production provenance claim.
- The final candidate was not installed or instrumented because no device is
  connected. Offline/network/project npm/node-gyp, Node/Express/Vite/Next.js,
  Git HTTPS/SSH/PR, terminal keyboard/IME/copy, BusyBox/Nano, and upgrade data
  preservation are therefore **PENDING**, not inferred from the successful APK.
- OpenCode's diagnostic commands and unsafe-mode failure were observed during
  earlier API 30 diagnosis. The final candidate packages an exit-69 capability
  gate for TUI/agent/run/serve/web modes, which upstream Android Bun/OpenTUI
  payloads demonstrably abort. Full OpenCode operation is not claimed.

Host evidence on 2026-07-30:

- Implementation commit: `d6b3296`
  (`phase-5: complete compatibility audit and production release gates`).
- `npm run release:check`: pass for exact JDK 17, isolated ESLint/Jest,
  TypeScript, the 908-package license inventory, tracked-secret scanning,
  signed runtime ownership, all host regression suites, and production audit.
- Jest: one suite/one test passed. ESLint: zero errors with 14 bounded existing
  warnings; it no longer inherits configuration outside the repository.
- `npm audit --omit=dev --audit-level=low`: zero vulnerabilities. The complete
  development/build graph reports 40 findings (7 moderate, 33 high) and is
  governed by the reviewed exception in
  `release/development-audit-boundary.json`, expiring 2026-10-30.
- JDK 17 `testDebugUnitTest`, `compileDebugAndroidTestKotlin`, and
  `assembleDebug`: pass (289 tasks). The test covers canonical paths/Git policy
  and the instrumentation fixture compiles private-storage case, executable
  mode, symlink-containment, and version assertions.
- The default host JDK 25 is rejected by settings evaluation with an actionable
  JDK 17 message.
- Unsigned `assembleRelease --dry-run` is rejected with an actionable external
  signing message. Release never falls back to the debug key.
- `test:phase4-apk`: pass for ARM64+x86_64, 231 ELF files (six relocatable),
  minimum load alignment `0x4000`, complete runtime-map-aware dependency
  closure, signed runtime lock, phase 1–5 harness content, API 29/36 metadata,
  and 16 KiB ZIP alignment.
- Final debug evidence APK: 257,619,039 bytes, SHA-256
  `2718C5E013B1406B5F270011D726EFA7C9D8E611285722B556C1A873C6F720E8`.
  It remains ignored test output and is not a production release artifact.
- Corrected standalone phone-test APK: 357,840,069 bytes, SHA-256
  `C66A6BAFA3C4067BF508FE2F3AA7FF914038AF99F673981267C40D391F147846`.
  The first phone-test artifact exposed that MobileIDE's helper-only CMake
  project had replaced React Native's required New Architecture application
  CMake entrypoint. It omitted `libappmodules.so` and generated/autolinked
  component registration, causing an immediate `PlatformConstants` startup
  crash. The fixed build nests the existing helpers beneath
  `ReactNative-application.cmake`, requires `libappmodules.so` for both ABIs,
  pins Android SDK CMake 3.31.6 for Windows long-path support, and preserves
  the signed non-LTO helper hashes. On an Infinix X689B ARM64 device running
  Android 11/API 30, a cold launch remained alive and resumed with an empty
  crash buffer; the terminal rendered and produced a working prompt. The APK
  remains intentionally test-signed and is not a production/Play artifact.
- Version 1.3.7/runtime 1.16.2 phone-test APK: 360,951,889 bytes, SHA-256
  `5D979BB9495815820F11B95F878C67F17533827D836CF8EA771BBC6D68C24FDE`.
  The copied 1.3.6 phone log showed OpenCode attempting a read-only `/tmp` and
  Make invoking `/data/data/com.termux/files/usr/bin/sh`. Commit `cf4afc7`
  fixes both in APK-native launchers for all OpenCode and native-addon
  invocations, not for an individual npm dependency. Host policy, OpenCode,
  TypeScript, Jest, ESLint, secret, signed-lock, dual-ABI, dependency-closure,
  and 16 KiB gates pass. No ADB device was connected during this rebuild, so
  the two reported commands remain the explicit ARM64 upgrade-device retest.
- The signed ownership check reports zero stale JNI/map outputs. Gradle invokes
  the signature-verifying pruner automatically and can delete only manifest-
  owned generated names.
- The CI workflow parses and pins Node 22.13.1, JDK 17, API/build tools 36,
  NDK 29.0.14206865, and bundletool 1.18.3 with SHA-256
  `A099CFA1543F55593BC2ED16A70A7C67FE54B1747BB7301F37FDFD6D91028E29`.
- No APK/AAB, private key, decoded secret, build cache, generated release
  output, or the existing untracked `ADevStudio-v1.3.3-arm64.apk` is included
  in the Phase 5 implementation commit.

External release/device/feature evidence still required:

- Supply the approved keystore secrets and certificate SHA-256 to the protected
  release environment. The Ubuntu job must build twice from clean outputs,
  compare hashes, reject a debug/incorrect signer, run `jarsigner`,
  `apksigner`, and bundletool, and then retain the verified AAB/APK.
- Attach or provision ARM64 API 29/34/35/36 fresh/upgrade runners, a strict
  16 KiB runner, secondary user/work profile/adoptable-storage coverage, and
  run `adev-phase5-test --network` plus connected instrumentation/UI assertions.
- The full x86_64 developer runtime, Git LFS, and large optional toolchain
  payloads remain explicit signed feature capabilities. The x86_64 emulator
  matrix tests the application/native helpers and never advertises those
  absent developer tools.
- This workstation produced the complete phone-test and instrumentation APKs,
  but cannot provide a production artifact without the external keystore,
  approved signer digest, complete provenance, and two-clean-build CI gate.

OpenCode compatibility basis:

- The official npm/install path has no published `opencode-android-arm64`
  package: [upstream Android installer issue](https://github.com/anomalyco/opencode/issues/12515).
- The official Linux ARM64 ELF uses the wrong runtime ABI for native Android:
  [upstream linker/PIE issue](https://github.com/anomalyco/opencode/issues/10504).
- The pinned Bionic build and its patch/build pipeline are published at
  [guysoft/opencode-termux](https://github.com/guysoft/opencode-termux).

### 1.3.13 recursive shebang compatibility beta evidence — 2026-08-22

- Root cause: termux-exec performed one shebang rewrite, resolved
  `/usr/bin/env` to ADEV's `runtime/bin/env`, and then treated that shell script
  as the final ELF. The reported magic `23212f73` decodes to `#!/s`, confirming
  an interpreter-chain failure rather than a broken AchSwap installation.
- Integration: `liblib_adev_exec_compat.so` is packaged for ARM64 and x86_64,
  placed first in global `LD_PRELOAD`, follows at most eight interpreter
  levels, handles PATH/FHS resolution and stale Termux shell requests, detects
  cycles, and delegates the final target to termux-exec.
- Generic device regressions: Phase 1 creates a local npm package with a normal
  bin entry, performs an isolated `npm install --global`, and invokes the CLI
  by command name. It also invokes `#!/usr/bin/env python`,
  `#!/system/bin/sh`, and Python `os.popen()`. Phase 5 always includes Phase 1.
  No fixture or resolver branch references AchSwap.
- Host/build evidence: resolver and runtime policy tests pass; TypeScript,
  ESLint (0 errors/13 pre-existing warnings), 45 Jest tests, Phase 4/5 host
  policy, runtime ownership, and dual-ABI NDK r29 builds pass.
- APK evidence: `app-phoneTest.apk` is 360,711,085 bytes with SHA-256
  `A51A24511E47E7C5CC3A57DDDFB308BC15FECAF72DD3929083C0D71784384573`.
  It contains 252 ELF files, exact ARM64/x86_64 ABIs, minimum `0x4000` LOAD
  alignment, the signed runtime 1.16.8 lock (210 ARM64/8 x86_64 payloads), and
  both resolver libraries. The phone-test instrumentation APK also builds.
- Remaining evidence: `adb devices -l` is empty. Global CLI execution,
  Python popen, fresh/upgrade extraction, and the original installed package
  must run on ARM64 before this row can be promoted from device retest.

### 1.3.16 ARM64 execution/native-build evidence — 2026-08-23

- Device: Infinix X689B, ARM64, Android 11/API 30, package
  `com.mobileide.app.phonetest`, upgraded in place with the 1.3.16 phone-test
  APK.
- The global-CLI failure was traced past the original recursive resolver:
  virtual `/usr/bin/env` incorrectly selected `/system/bin/env` because ADEV's
  PATH intentionally places system tools first. Toybox then attempted the
  writable app-data `bin/node` script and returned EACCES.
- The permanent correction routes virtual env to a dual-ABI APK-native
  executable. It resolves Node, Python and Bash from executable APK siblings,
  independent of interactive shell functions or bootstrap variables.
- Exact reproduction passes: `npm install -g @achswap/mcp-sdk` followed by
  untouched `achswap --help`. The generic isolated global npm CLI and Python
  shell regressions also pass; no package name appears in the resolver.
- Native compilation progressed through N-API C/C++ and exposed libc++ search
  ordering. ADEV now supplies the Android order: libc++ first, then the target
  ARM64 and generic Bionic headers. The Node 26 V8 fixture uses C++20 because
  those headers contain C++20 constraints.
- Physical-phone V8 evidence: `npm install --foreground-scripts` compiled and
  linked `Release/addon.node` in 11 seconds; `node test.js` exited zero. Host
  exec/sysroot/Phase-5 policy checks and the 277-task phone-test APK build pass.
- Final APK verification: 361,646,760 bytes, SHA-256
  `0A13DF899091DEB5B3EB481EEF0EC998A34227D0FED7F08EFC68E83D5F6704C4`, exact
  ARM64+x86_64 app ABIs, 257 ELF files and minimum load alignment `0x4000`.
- OpenCode CLI version/help/debug/run/serve and web HTTP paths reached the real
  ARM64 runtime during this cycle. Automatic foreground browser handoff for
  `opencode web` did not pass and is intentionally abandoned for this release;
  it is not reported as complete.

### Runtime 1.16.12 shell-navigation hotfix evidence — 2026-08-23

- Reproduced on the connected Infinix X689B/API 30: from `my-project`, the
  sequence `ls`, `cd`, `ls` entered the isolated runtime home but displayed
  only `ADEV-RUNTIME.md`. The documented `~/workspaces` path did not exist,
  even though Git/imported projects were stored under `runtime/workspaces`.
- Root cause: ADEV correctly separated shell/package-manager configuration
  from executable project storage, but never created the advertised navigation
  link between them. This was a platform layout defect, not an `ls` or `cd`
  implementation failure.
- Runtime 1.16.12 creates and repairs an app-owned `~/workspaces` symlink on
  fresh install and upgrade. A real user-created path is preserved rather than
  overwritten. Standard no-argument `cd` semantics remain unchanged.
- The new host regression is included in `release:check`. The signed runtime
  lock, Phase-4 policy, workspace policy, recursive execution tests, Kotlin/
  Java/native compilation, and the 277-task phone-test APK build pass.
- Physical upgrade evidence: RuntimeManager logged the exact link from
  `runtime/home/workspaces` to `runtime/workspaces`; `ls → cd → ls` then showed
  `ADEV-RUNTIME.md  workspaces`, and `cd workspaces; ls` showed `demo-api`,
  `demo-web`, and `my-project`.

## Definition of done for Android-native npm installs

Current status: **MET FOR THE ARM64/API-30 BASELINE; FULL MATRIX NOT YET MET**.
The original global-CLI path and local native fixtures now execute on a physical
phone. The following definition still requires the other supported API/ABI,
storage and strict-page combinations before production-wide certification.

- A fresh install on every supported Android/API/ABI combination can run
  `npm install` for the fixture matrix without `chmod`, `npm rebuild`, manual
  environment exports, or package-specific patches.
- A source-built `.node` loads and runs.
- Generated ELF files are Android/Bionic ARM64, API-29 compatible, and
  16 KiB-aligned.
- No relevant SELinux denial, app-data `EACCES`, missing interpreter, missing
  library, or dynamic-linker namespace error appears.
- Repeating the install and upgrading the APK are idempotent.
- Failures for unsupported toolchains name the missing capability and offer an
  automatic signed tool-pack installation where one exists.
