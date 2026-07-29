# Android Compatibility Audit and Fix Plan

Audit date: 2026-07-29
Application: A Dev Studio / `com.mobileide.app` 1.3.4
Audited target: Android ARM64 runtime, `minSdk 29`, `targetSdk 34`

## Five-phase execution ledger

| Phase | Status | Commit | Evidence / next action |
|---|---|---|---|
| 1. Runtime, native builds, shell, and core CLI | **IMPLEMENTED — DEVICE GATE** | `8c20d06` | Host policy/unit/build/ELF/closure checks pass. Run `adev-doctor --self-test --json` and `adev-phase1-test --network` on fresh and upgraded API 29/API 36 ARM64 devices; Phase 2 was authorized separately. |
| 2. Node servers, Next.js, preview, and watching | **IMPLEMENTED — DEVICE GATE** | `ba14e01` | Host launcher/event/type/build/APK checks pass. Run `adev-phase2-test --network` from Terminal and repeat the Run/Preview matrix on API 29/API 36; Phase 3 waits for explicit approval. |
| 3. Git, package managers, optional toolchains, and Bun policy | **IMPLEMENTED — DEVICE / FEATURE GATE** | PENDING | Keystore-backed Git credentials, strict SSH, proxy/custom-CA policy, offline pnpm/Yarn, the Bun capability boundary, and signed tool-pack lifecycle pass host/build/APK checks. Run `adev-phase3-test --network` on API 29/API 36; ABI tool-pack delivery remains an explicit Phase 4 feature gate. |
| 4. Android 16, ABI, filesystem, and runtime distribution | NOT STARTED | — | Wait for explicit approval after the Phase 3 report. |
| 5. Automation, security, production release, and final audit | NOT STARTED | — | Wait for Phase 4. |

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
- Python, Make, Clang/LLVM, LLD, `pkg-config`, Node headers, compiler resources,
  and their complete shared-library closure are bundled.
- All executable tools are installed under Android's executable
  `nativeLibraryDir`; projects and generated npm shims remain writable under
  app data.
- Compiler and linker settings are supplied automatically to every spawned
  process. Addons target Android API 29 and use 16 KiB-compatible ELF
  alignment. The app's remaining React Native/Hermes 16 KiB gap is listed
  separately as a release blocker below.
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
- Gradle, npm package metadata, and diagnostics now agree on app version 1.3.4.

This is not an individual-package workaround. It applies to packages using
`node-gyp`, npm's lifecycle runner, shell shims, and native C/C++ compilation.
No post-install `chmod`, `npm rebuild`, or package-specific command is intended
to be necessary.

The release APK builds successfully and contains the new toolchain. A physical
Android device or emulator was not connected to this audit host, so the final
on-device execution matrix remains a release gate.

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
  matching `@next/swc-wasm-nodejs` outside the project, and forces Webpack for
  `dev` and `build`. Direct `next` and simple/compound npm scripts route through
  the launcher without editing `package.json`, lockfiles, or project modules.
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

## Root cause of `spawn node-gyp EACCES`

There were two consecutive failures.

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

After removing that execution failure, the runtime also lacked Python, Make,
Clang, a linker, sysroot files, and Node headers. A successful spawn would
therefore only have exposed the next `node-gyp` failure.

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
- The APK includes 122 Node header files, 557 Python standard-library files,
  and 313 Clang resource files.
- Independent ELF inspection found zero unresolved non-system `DT_NEEDED`
  names after applying the runtime symlink map.
- `zipalign -c -P 16 -v 4` passed for the release APK.
- All imported developer-runtime ELFs and both app-built native targets are
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
- The Phase 2 host suite passed structured Node listen/close events, a real
  loopback request, exact Next.js version resolution, cache isolation, forced
  `--webpack` arguments (including removal of `--turbopack`), and no project
  metadata mutation.
- npm registry checks confirmed exact `@next/swc-wasm-nodejs` releases for
  Next.js `15.5.22` and `16.2.12`.
- TypeScript `--noEmit` passed with a 4 GiB compiler heap.
- `:app:compileDebugKotlin`, `:app:testReleaseUnitTest`, and
  `:app:assembleRelease` passed with JDK 17 after the Phase 2 changes.
- The release APK contains `adev-next.js`, `adev-server-events.js`,
  `adev-phase2-test.js`, and the rebuilt native npm lifecycle shell. Binary
  inspection confirms the native shell contains the generic Next launcher
  dispatch.

### Not yet verifiable on this host

- `adb` is installed, but `adb devices -l` reports no connected device or
  emulator.
- The exact user report cannot be executed against Android SELinux here.
- Loading a newly compiled `.node` file, file-watch behavior, PTY signal/job
  control, Git network authentication, and secondary-user/adoptable-storage
  paths require device tests.
- The Node/Express/Vite/Next.js Terminal and Run/Preview matrices, registry
  ownership/probe timing, nested HMR edits, and process-tree/port cleanup need
  `adev-phase2-test --network` plus UI assertions on API 29 and API 36.

### Existing project checks that fail independently of this fix

- A full scan of all 209 native libraries inside the APK found 10 older React
  Native/Hermes/image-pipeline libraries with 4 KiB ELF segments:
  `libc++_shared.so`, `libfbjni.so`, `libhermes.so`,
  `libhermestooling.so`, `libimagepipeline.so`, `libjsi.so`,
  `libnative-filters.so`, `libnative-imagetranscoder.so`,
  `libreactnative.so`, and `librnscreens.so`.
- Jest stops before tests because `RNGestureHandlerModule` is not mocked for the
  React Native test environment.
- ESLint inherits `C:\Users\Asif\eslint.config.mjs` from outside the repository;
  that config imports an unavailable `eslint-config-next`. The project does not
  isolate its lint configuration from parent directories.

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
| node-gyp | ⚠️ Fixed; device gate | node-gyp 12.3.0 is bundled. Direct PATH/Java/lifecycle dispatch, generic `termux-exec`, Python, Make, Clang, LLD, Node headers, `npm_config_node_gyp`, and `npm_config_nodedir` are integrated. `adev-phase1-test` covers install/rebuild/direct build/load/uninstall/reinstall; the original device reproduction is still required. |
| Python | ⚠️ Integrated; device gate | Python 3.14.6, its standard library, native modules, `PYTHONHOME`, `PYTHONPATH`, `PYTHON`, `NODE_GYP_FORCE_PYTHON`, and `npm_config_python` are packaged/configured. Relocation must be smoke-tested on-device. |
| Clang / Make / build tools | ⚠️ Integrated; device gate | Clang/LLVM 21.1.8, Make 4.4.1, LLD, `llvm-ar`, `pkg-config`, compiler resources, development headers, CRT objects, and libraries are present. A real addon compile/link/load is the acceptance test. |
| Build target | ✅ Fully integrated | Generated native addons target `aarch64-linux-android29`, matching `minSdk`, rather than the SDK level of the phone doing the build. |
| 16 KiB pages | ❌ Incomplete | APK ZIP alignment passes. The developer runtime, app-built PTY/lifecycle shell, and future generated addons are aligned, but 10 packaged React Native/Hermes/image-pipeline libraries still have 4 KiB ELF segments. |
| PATH resolution | ⚠️ Integrated; device gate | System tools are first; executable APK libraries and app trampolines follow. Java spawns resolve Node/npm/npx/node-gyp, Python, Make, Clang, LLVM, Git, curl, Bash, and BusyBox to executable APK paths. Generic npm `.bin` and shebang resolution uses the corrected `termux-exec` contract and needs the device matrix. |
| Executable permissions | ✅ Fully integrated | Executable ELFs are packaged in `nativeLibraryDir`. App-data scripts are interpreted or translated; `chmod` is not treated as a fix for SELinux/noexec. |
| Child process: Java spawn | ⚠️ Integrated; device gate | `ProcessManager` clears inherited host state, installs the runtime environment, resolves core/runtime/build commands, launches each task under `setsid`, obtains the PID from the child instead of reflection, streams output, and terminates the process group with a `/proc` descendant fallback. Device process-tree tests remain. |
| Child process: Node `spawn` / `exec` / `fork` | ⚠️ Partially integrated | The preload and complete Termux variables are inherited by Node children. Literal npm shims and `#!/usr/bin/env` scripts should translate generically, but `spawn`, `execFile`, `exec`, and `fork` need device tests. |
| Shell execution | ⚠️ Partially integrated | Native Bash is preferred; `/system/bin/sh` is the fallback. `BASH_ENV` loads noninteractive wrappers, and compound lifecycle commands use bundled Bash. Device tests are still required for nested scripts and unusual shebangs. |
| npm lifecycle scripts | ⚠️ Fixed; device gate | `NPM_CONFIG_SCRIPT_SHELL` points to the APK-installed `adev-npm-shell`; direct JS and `node-gyp` scripts bypass app-data execution. Complex commands fall back to Bash plus `termux-exec`. |
| Optional dependencies | ⚠️ Policy integrated; device gate | Optional dependencies stay enabled while npm sees Android/ARM64. The global Linux spoof is gone. `adev-resolve-package` permits only Android/Bionic, exact hash-approved static/musl, source-build, or an explicit unsupported decision; the verified static/musl list is intentionally empty until artifacts are tested and locked. |
| Native addons | ⚠️ Integrated; device/feature gate | Standard C/C++ `node-gyp` source builds have a complete base toolchain. Bundled N-API C/C++, V8, NAN, `prebuild-install` fallback, and `node-pre-gyp` fallback fixtures exercise install/rebuild/direct build/load/uninstall/reinstall. The signed capability index now reports Rust, CMake/Ninja, NASM, Java, Autotools, and extra-library packs; production ABI payload delivery is a Phase 4 feature gate. |
| `.node` loading | ⚠️ Device gate | Build output will be Android ARM64 and Node-version-matched. A target-34 device test must prove `dlopen()` plus transitive library lookup from a project directory. |
| Development task registry | ⚠️ Integrated; device gate | Background tasks and PTY sessions share typed task/status/log/port records. PIDs, process groups, descendants, sources, persistence, exit/failure state, and bounded logs are exposed through task APIs. Stop signals the group and waits for verified ports to close; device orphan/process-tree tests remain. |
| Node / Express / Vite servers | ⚠️ Integrated; device gate | Structured Node listen/close/error events and `/proc` socket ownership discover arbitrary ports. Run/Preview has first-class Node, Express, Vite, Next, build, test, shell, and generic task types. The bundled device harness covers plain Node, Express, and Vite nested edits; it still needs a connected device. |
| Next.js | ⚠️ Integrated; device gate | `adev-next` resolves the project version, caches exact matching `@next/swc-wasm-nodejs` outside the project, forces `--webpack` for dev/build even when a script requests Turbopack, and routes direct commands plus npm lifecycle scripts without project mutation. Exact packages 15.5.22 and 16.2.12 exist; the App/Pages dev/HMR/build/start device matrix is bundled but not yet executed. |
| Preview / ports | ⚠️ Integrated; device gate | Console text no longer creates an active port. Structured events and log text create candidates; ownership plus a successful `127.0.0.1` socket probe is required before UI publication. URLs carry task/PID/group/source/state and update through native events. Android timing and OEM `/proc` restrictions remain device gates. |
| Git core operations | ✅ Fully integrated | JGit 6.7 remains the local repository engine, while UI network operations and Terminal commands now share native Git 2.55.0, one canonical path policy, runtime templates, and default branch configuration. |
| Git HTTPS | ⚠️ Integrated; device gate | Native `git-remote-http`, redirects, protocol v2, proxy settings, the assembled CA bundle, validated custom X.509 CAs, and the native credential helper are configured. Host source/build/APK checks pass; live clone/fetch/pull/push, rejection, proxy, redirect, and custom-CA cases require the Phase 3 device matrix. |
| curl | ⚠️ Integrated; device gate | The real Termux ARM64 curl executable is packaged in `nativeLibraryDir`, mapped through PATH/Java/shell wrappers, shares the assembled Android CA bundle, has a verified dependency closure, and is 16 KiB aligned. `adev-doctor --self-test` performs the device HTTPS probe. |
| Git SSH | ⚠️ Integrated; device gate | Dropbear 2026.94 is wrapped with managed key leases, Keystore-backed passphrases, strict host checking, known-host fingerprint confirmation/removal, key generation/import, and SCP/`ssh://` command support. The lease is the Android-safe agent equivalent; live auth, passphrase, rejection, and host-key-change cases need a device. |
| Git credentials | ⚠️ Integrated; device gate | HTTPS credentials, SSH private keys, and passphrases are Keystore-encrypted. The native ARM64 credential helper talks to an app-private loopback broker; commands/logs are redacted and JavaScript receives metadata only. Persistence/process-death and live rejection tests remain in the device matrix. |
| Git LFS | ⚠️ Explicit feature boundary | LFS use is detected and reports the missing signed `git-lfs` feature pack instead of silently failing. The signed index defines the capability, dependency, version, and diagnostics; ABI payload delivery is part of Phase 4 runtime distribution. |
| Corepack | ✅ Fully integrated | Corepack 0.35.0 is pinned and bundled. Runtime selection reports whether the version came from an exact offline payload, project `packageManager` declaration, warmed Corepack cache, or network; integrity/source metadata is committed. |
| pnpm | ⚠️ Integrated; device gate | pnpm 11.18.0 and its worker/node-gyp payload are bundled with SHA-256 verification. Exact declarations and direct commands install/run lifecycle/build/test fixtures from an empty network cache on the host; Android execution remains in the Phase 3 device gate. |
| Yarn | ⚠️ Integrated; device gate | Yarn 4.18.0 is bundled with SHA-256 verification. Exact declarations and direct commands install/run lifecycle/build/test fixtures offline without mutating project metadata; Android execution remains in the Phase 3 device gate. |
| Bun | ✅ Explicit capability boundary | Bun's supported platform list has no Android target. `bun` exits with an actionable Android/Bionic unsupported result and directs developers to Node/npm/pnpm/Yarn; no glibc Linux binary is installed or spoofed. |
| Optional tool packs | ⚠️ Explicit feature boundary | An Ed25519-signed catalog and verified installer/status/uninstaller cover CMake/Ninja, Rust/Cargo, NASM, Autotools/Libtool, Java, development libraries, and Git LFS. Signature tampering, dependencies, missing payloads, lifecycle, and diagnostics are tested. Production native payloads must be delivered as ABI-specific APK features in Phase 4 because app-data storage is noexec. |
| File watching: Node | ⚠️ Integrated; device gate | Global polling is removed. Private workspaces leave Chokidar/Watchpack on native watching; shared `/storage`, `/sdcard`, and `/mnt/media_rw` paths receive polling variables from the working-directory capability policy. Interactive `cd` refreshes the policy. Nested HMR remains an on-device gate. |
| File watching: editor | ⚠️ Integrated; device gate | Private workspaces use recursive per-directory `FileObserver` registration with UUID IDs, new-directory registration, symlink containment, and inotify-overflow rebuilds. Shared/FUSE workspaces use a recursive one-second snapshot watcher. Device overflow and OEM storage behavior remain. |
| Symlinks | ⚠️ Partially integrated | Runtime symlinks are rebuilt automatically on private app storage. Android shared/external storage does not reliably support symlinks, case sensitivity, modes, or execution; projects using those features must stay in private workspaces. |
| Environment variables | ⚠️ Integrated; device gate | App-scoped HOME/TMP/npm/TLS/Git/Termux/toolchain/package-policy values are comprehensive. Global `CI`, no-color, Linux spoofing, and watcher polling are absent. Working-directory watch mode, structured server preload, and Next launcher/cache paths are inherited by Java, PTY, shell, and npm lifecycle children. Locale and interactive shared-storage transitions still need device checks. |
| TTY / terminal | ⚠️ Fixed; device gate | Native `forkpty`, resize, process-group signals, and job-control plumbing exist. Close is idempotent, signals TERM/KILL before changing state, always closes the master FD, and starts a child reaper. Repeated-close/job-control behavior remains in the device matrix. |
| Android private filesystem | ✅ Fully integrated | Runtime, caches, global npm installs, temp data, and default workspaces are under private storage, which supports Unix metadata and protects project data. |
| Android shared filesystem | ⚠️ Manual / restricted | The app has an all-files settings flow, but Android requires the user to grant this special access. Shared storage remains noexec and lacks reliable symlinks/permissions; `Android/data` restrictions still apply. |
| Filesystem path sandbox | ✅ Fully integrated | Canonical `Path` containment is segment-aware. Traversal and sibling-prefix escapes are rejected, `/data/data`, `/data/user`, and broad `/mnt` access are removed, runtime bin/lib writes are protected, system/APEX paths are read-only, and explicit user-visible storage roots are bounded. Host unit coverage passes; symlink/device storage cases continue in Phase 4. |
| SELinux / execution restrictions | ⚠️ Correct design; device gate | APK-native placement handles direct executables; `termux-exec` receives actual app/rootfs/SDK/SELinux variables for generated scripts. Validate without AVC denials on API 29, 34, 35, and 36 devices. |
| Secondary users / work profiles / adoptable storage | ⚠️ Partially integrated | `ApplicationInfo.dataDir` is used for the real path, but hosted Termux packages were compiled for `com.termux` and primary-user paths. Environment overrides cover the exec layer, not every possible compiled-in package path. |
| CPU architectures | ❌ Missing beyond ARM64 | Gradle and the runtime are restricted to `arm64-v8a`. No `x86_64` emulator/Chromebook build or 32-bit ABI is available. |
| Android 16 / Play targeting | ❌ Incomplete | The project compiles with API 35 and targets API 34. Starting 2026-08-31, normal phone/tablet app updates must target API 36 for Google Play. Android 15/16 behavior-change testing has not been done. |
| Release signing | ❌ Broken for production | The release build uses the debug signing configuration. It is buildable but is not a production release/signing integration. |
| Runtime supply-chain reproducibility | ⚠️ Partially integrated | Corepack/pnpm/Yarn payload versions, sources, and SHA-256 hashes are locked, and the optional tool-pack catalog is Ed25519-signed. Termux runtime versions still follow the live package index, two LLVM files require `git lfs pull`, and the complete ABI runtime lock remains Phase 4. |
| Runtime update cleanup | ⚠️ Partially integrated | Fingerprinting forces device reinitialization when the map changes. The build map and generated JNI source directory merge historical entries, so removed runtime files are not automatically pruned from source control. |
| APK/install footprint | ⚠️ Partially integrated | Shipping Clang/LLVM and Python removes first-run setup, but the audited release APK is about 200 MB versus the prior 79 MB artifact, and extracted native libraries increase installed size further. |
| Host Android build toolchain | ⚠️ Partially integrated | Gradle 8.10.2 builds successfully with JDK 17, while the same wrapper fails when it inherits JDK 25.0.3. The supported JDK is not pinned or checked, so success currently depends on the caller's `JAVA_HOME`/PATH. |
| Test automation | ⚠️ Partially integrated | Phase 1 covers runtime policy/native addons; Phase 2 covers servers/Next/watchers; Phase 3 adds host credential-policy, offline manager, signed tool-pack/tamper, Bun-boundary tests plus a Git/package-manager device harness. Connected API/ABI orchestration, Jest/lint isolation, and production release gates remain Phase 5. |

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

Root cause/risk: React Native 0.76.9, Hermes, fbjni, the C++ runtime, screens,
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

Acceptance: all 209 (or replacement) APK native libraries have `PT_LOAD`
alignment of at least `0x4000`.

Reference:
[Android 16 KiB page-size support](https://developer.android.com/guide/practices/page-sizes).

#### P0.3 Migrate compile/target SDK to Android 16

Root cause/risk: `targetSdk 34` is outside the 2026 Google Play update
requirement for normal mobile apps.

Proper integration:

- Move compile and target SDK to API 36.
- Upgrade Android Gradle Plugin, React Native, and NDK as required.
- Test edge-to-edge, predictive back, large screens, local-network access for
  dev servers, foreground execution, storage, native-library namespaces, and
  all Android 15/16 compatibility changes.
- Re-run the complete execution/SELinux/native-addon matrix after the target
  bump.

Reference:
[Google Play target API requirements](https://developer.android.com/google/play/requirements/target-sdk).

#### P0.4 Add production release signing

Root cause/risk: `release` currently uses the debug keystore.

Proper integration:

- Load release credentials from CI/secure local properties.
- Produce a signed AAB/APK without committing secrets.
- Verify with `apksigner`, preserve the upgrade key, and document key rotation.

Acceptance: release artifacts are not signed by the Android debug certificate.

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

#### P2.6 Additional ABI support

Add `x86_64` if emulator/Chromebook support is a product requirement. Every
runtime executable, dependency closure, compiler sysroot, native map, and test
must be ABI-specific. Do not advertise unsupported 32-bit ABIs.

#### P2.7 Pin the host Android build JDK

- Declare JDK 17 as the supported build JDK in project and CI configuration.
- Add an early Gradle version check with a direct remediation message.
- Do not silently use an unrelated system JDK from `PATH`; make local and CI
  builds resolve the same toolchain.

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

- `npm run test:runtime-policy`: pass.
- `:app:testReleaseUnitTest`: pass.
- `:app:assembleRelease`: pass.
- Termux package SHA-256 and 80-package dependency closure: pass.
- `curl` AArch64/linker/`DT_NEEDED`/`0x4000` inspection: pass.
- Release APK content check for curl, doctor, and fixtures: pass.
- No APK, signing credential, build cache, or existing
  `ADevStudio-v1.3.3-arm64.apk` is included in the Phase 1 commit.

Blocked device evidence:

- `adb` is available, but no Android emulator or physical target is connected.
- Fresh install and upgrade on ARM64 API 29/API 36, SELinux/AVC inspection,
  TLS network probes, PTY/process-tree stress, and native `.node` load remain
  required before removing the Phase 1 device gate.

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

Framework basis: Next.js documents `--webpack` for both `next dev` and
`next build`, and documents WebAssembly as the compiler's cross-platform path:
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

Next phase after explicit approval: Phase 4 — Android 16, ARM64/x86_64,
filesystem policy, deterministic runtime locks, and ABI feature-pack
distribution. Phase 4 has not started.

## Definition of done for Android-native npm installs

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
