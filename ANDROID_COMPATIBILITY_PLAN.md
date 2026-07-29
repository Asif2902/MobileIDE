# Android Compatibility Audit and Fix Plan

Audit date: 2026-07-30
Application: A Dev Studio / `com.mobileide.app` 1.3.5
Audited target: Android ARM64/x86_64 app, `minSdk 29`, `targetSdk 36`

## Five-phase execution ledger

| Phase | Status | Commit | Evidence / next action |
|---|---|---|---|
| 1. Runtime, native builds, shell, and core CLI | **IMPLEMENTED — DEVICE GATE** | `8c20d06` | Host policy/unit/build/ELF/closure checks pass. `adev-phase5-test` and the Phase 5 ARM64 fresh/upgrade matrix now automate the doctor/native-build/network evidence; connected runner execution remains. |
| 2. Node servers, Next.js, preview, and watching | **IMPLEMENTED — DEVICE GATE** | `ba14e01` | Host launcher/event/type/build/APK checks pass. The Phase 5 device/UI matrix owns Node/Express/Vite/Next/HMR/port/process cleanup evidence; connected runner execution remains. |
| 3. Git, package managers, optional toolchains, and Bun policy | **IMPLEMENTED — DEVICE / FEATURE GATE** | `93b3527` | Keystore-backed Git credentials, strict SSH, proxy/custom-CA policy, offline pnpm/Yarn, and the Bun/tool-pack capability policy pass. Live network auth remains in the device matrix; absent large toolchains and Git LFS remain explicit signed feature boundaries. |
| 4. Android 16, ABI, filesystem, and runtime distribution | **IMPLEMENTED — DEVICE / FEATURE / HOST RELEASE GATES** | `001cc17` | React Native 0.86.2, API 36, NDK r29, Gradle 9.3.1, dual-ABI app/native helpers, signed runtime locking, guided private imports, and 16 KiB checks pass. Phase 5 now automates the connected/release gates; the full x86_64 developer runtime remains a signed feature boundary. |
| 5. Automation, security, production release, and final audit | **IMPLEMENTED — EXTERNAL DEVICE / SIGNING GATES** | `d6b3296` | Test/lint isolation, exact JDK 17, one version source, fail-closed external signing, APK/AAB validation, dependency/license/secret/runtime-ownership policy, and API/ABI/16 KiB CI orchestration pass host checks. Supply approved signing credentials and connected/self-hosted Android runners to execute the production/device gates; no debug-signed artifact is accepted. |

### What “implemented — device gate” means

It means the integration is present in the application, its host/unit/build
checks pass, and the expected device test is automated or documented, but the
final behavior has not yet been observed on a real Android kernel/Bionic/
SELinux combination. It is not another feature to implement and it does not
mean “keep loading.” For example, a PTY can compile and pass unit tests on the
host, while its real `forkpty`, linker, SELinux, keyboard, and process-reaping
behavior still needs an API 29/36 device run before release certification.

### Post-phase compatibility updates

| Update | Status | Commit | Evidence / remaining gate |
|---|---|---|---|
| Terminal startup-loop fix and OpenCode Android CLI | **IMPLEMENTED — ARM64 DEVICE GATE** | Pending local commit | Terminal store tests pass; OpenCode archive/component hashes, Bionic linker, PIE, dependency shape, and 16 KiB alignment pass. Build and connected ARM64 API 29/36 TUI/provider/tool/PTY checks remain before production certification. |

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
- Gradle, npm package metadata, and diagnostics now agree on app version 1.3.5.

This is not an individual-package workaround. It applies to packages using
`node-gyp`, npm's lifecycle runner, shell shims, and native C/C++ compilation.
No post-install `chmod`, `npm rebuild`, or package-specific command is intended
to be necessary.

The Phase 1–3 release APK built successfully and contains the new toolchain.
After the Phase 4 React Native upgrade, a dual-ABI debug APK builds and passes
content, API, signature, ZIP, and ELF checks. This Windows host blocks the
Hermes compiler executable through Device Guard (exit 4551), so the Phase 4
release bundle must be reproduced on the Phase 5 CI host. No physical Android
device or emulator was connected, so the on-device matrix remains a release
gate.

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

Phase 4 upgrades the Android platform boundary while retaining the earlier
runtime behavior:

- React Native 0.86.2/React 19.2.3, the matching CLI 20.1.0 stack, API 36,
  NDK 29.0.14206865, Kotlin 2.1.20, Gradle 9.3.1, Hermes, the new architecture,
  and edge-to-edge behavior are configured together.
- The app and its native shell/Git helper build for `arm64-v8a` and `x86_64`.
  The ARM64 developer runtime stays in the base APK; the x86_64 developer
  runtime is an explicit signed feature-pack capability instead of an
  incorrectly advertised or glibc-backed runtime.
- An Ed25519-signed runtime lock inventories 204 ARM64 runtime/app-native
  payloads and three packaged x86_64 helpers by hash, size, runtime path, and
  owner. Runtime 1.16.0 forces upgrade re-extraction and `adev-doctor` verifies
  and reports the lock.
- Shared/FUSE workspaces are assessed before native work. A guided import stages
  them under app-private storage, rejects symlinks and containment escapes, and
  finalizes atomically so failed imports do not leave partial projects.
- The produced APK targets API 36, contains only ARM64/x86_64, passes Android's
  16 KiB ZIP check, and has 225 loadable ELF files with a minimum `PT_LOAD`
  alignment of `0x4000`; six packaged compiler relocatable objects have no load
  segments and are checked separately.

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

### Not yet verifiable on this host

- `adb` is installed, but `adb devices -l` reports no connected device or
  emulator.
- The exact user report cannot be executed against Android SELinux here.
- Loading a newly compiled `.node` file, file-watch behavior, PTY signal/job
  control, Git network authentication, and secondary-user/adoptable-storage
  paths require device tests.
- The Node/Express/Vite/Next.js Terminal and Run/Preview matrices, registry
  ownership/probe timing, nested HMR edits, and process-tree/port cleanup need
  `adev-phase5-test --network` plus UI assertions on the configured API matrix.
- OpenCode still needs ARM64 API 29/36 checks for `--version`, TUI rendering,
  provider authentication, prompt execution, file/tool calls, PTY behavior,
  watcher fallback, and clean exit. No verified Bionic x86_64 payload exists.
- No approved production keystore/certificate digest was supplied. Therefore
  no artifact from this workstation can satisfy the production-signing gate.
- Windows Device Guard still blocks `hermesc.exe`; the signed AAB/APK,
  bundletool validation, two-clean-build comparison, and Play upload checks
  must run on the configured Ubuntu release job.

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
| node-gyp | ⚠️ Fixed; device gate | node-gyp 12.3.0 is bundled. Direct PATH/Java/lifecycle dispatch, generic `termux-exec`, Python, Make, Clang, LLD, Node headers, `npm_config_node_gyp`, and `npm_config_nodedir` are integrated. `adev-phase1-test` covers install/rebuild/direct build/load/uninstall/reinstall; the original device reproduction is still required. |
| Python | ⚠️ Integrated; device gate | Python 3.14.6, its standard library, native modules, `PYTHONHOME`, `PYTHONPATH`, `PYTHON`, `NODE_GYP_FORCE_PYTHON`, and `npm_config_python` are packaged/configured. Relocation must be smoke-tested on-device. |
| Clang / Make / build tools | ⚠️ Integrated; device gate | Clang/LLVM 21.1.8, Make 4.4.1, LLD, `llvm-ar`, `pkg-config`, compiler resources, development headers, CRT objects, and libraries are present. A real addon compile/link/load is the acceptance test. |
| Build target | ✅ Fully integrated | Generated native addons target `aarch64-linux-android29`, matching `minSdk`, rather than the SDK level of the phone doing the build. |
| 16 KiB pages | ⚠️ Integrated; strict-device gate | React Native/Hermes and native dependencies were upgraded. `test:phase4-apk` checks the final APK with `zipalign -P 16` and scans every packaged ELF: all 225 loadable files have `PT_LOAD >= 0x4000`; six compiler `ET_REL` objects correctly have no load segments. A strict 16 KiB device run remains required. |
| PATH resolution | ⚠️ Integrated; device gate | System tools are first; executable APK libraries and app trampolines follow. Java spawns resolve Node/npm/npx/node-gyp, Python, Make, Clang, LLVM, Git, curl, Bash, and BusyBox to executable APK paths. Generic npm `.bin` and shebang resolution uses the corrected `termux-exec` contract and needs the device matrix. |
| Executable permissions | ✅ Fully integrated | Executable ELFs are packaged in `nativeLibraryDir`. App-data scripts are interpreted or translated; `chmod` is not treated as a fix for SELinux/noexec. |
| Child process: Java spawn | ⚠️ Integrated; device gate | `ProcessManager` clears inherited host state, installs the runtime environment, resolves core/runtime/build commands, launches each task under `setsid`, obtains the PID from the child instead of reflection, streams output, and terminates the process group with a `/proc` descendant fallback. Device process-tree tests remain. |
| Child process: Node `spawn` / `exec` / `fork` | ⚠️ Integrated; automated device gate | The preload and complete Termux variables are inherited by Node children. Literal npm shims and `#!/usr/bin/env` scripts translate through the native shell/`termux-exec`; the Phase 5 ARM64 API matrix runs `spawn`, `execFile`, `exec`, and `fork` fixtures before release. Connected runner evidence is still required. |
| Shell execution | ⚠️ Integrated; automated device gate | Native Bash is preferred; `/system/bin/sh` is the fallback. `BASH_ENV` loads noninteractive wrappers, compound lifecycle commands use bundled Bash, and nested/shebang tests are in the Phase 5 device harness. Connected runner evidence is still required. |
| npm lifecycle scripts | ⚠️ Fixed; device gate | `NPM_CONFIG_SCRIPT_SHELL` points to the APK-installed `adev-npm-shell`; direct JS and `node-gyp` scripts bypass app-data execution. Complex commands fall back to Bash plus `termux-exec`. |
| Optional dependencies | ⚠️ Policy integrated; device gate | Optional dependencies stay enabled while npm sees Android/ARM64. The global Linux spoof is gone. `adev-resolve-package` permits only Android/Bionic, exact hash-approved static/musl, source-build, or an explicit unsupported decision; the verified static/musl list is intentionally empty until artifacts are tested and locked. |
| Native addons | ⚠️ Integrated; device/feature gate | Standard ARM64 C/C++ `node-gyp` source builds have a complete base toolchain. Bundled N-API C/C++, V8, NAN, `prebuild-install` fallback, and `node-pre-gyp` fallback fixtures exercise install/rebuild/direct build/load/uninstall/reinstall. Optional tool packs and the full x86_64 developer runtime have signed capability boundaries but still require production feature payloads. |
| `.node` loading | ⚠️ Device gate | ARM64 build output is Android/Bionic and Node-version-matched. API 29/34/35/36 device tests must prove `dlopen()` plus transitive library lookup from private projects; x86_64 addon builds wait for the signed x86_64 developer-runtime feature. |
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
| OpenCode CLI | ⚠️ Integrated on ARM64; device/security/x86_64 gate | OpenCode 1.17.9 uses the independently source-built Android/Bionic port pinned to port commit `f63664e` and upstream OpenCode commit `5c23e88`. The real PIE runtime, OpenTUI library, pointer-tag compatibility library, and an app-built launcher are APK-native executables with exact hashes in the signed runtime lock; they require no `chmod`, Termux prefix, writable executable, glibc loader, or Linux spoof. `opencode` is resolved through terminal/task/doctor paths. The official npm package still has no Android artifact, the port does not publish a signed release, ARM64 API 29/36 TUI/provider/prompt/tool/PTY tests remain a device gate, and x86_64 reports an explicit unsupported payload boundary. The private patched engine is not exposed as general Bun support. |
| Optional tool packs | ⚠️ Explicit feature boundary | An Ed25519-signed catalog and verified installer/status/uninstaller cover CMake/Ninja, Rust/Cargo, NASM, Autotools/Libtool, Java, development libraries, and Git LFS. Signature tampering, dependencies, missing payloads, lifecycle, and diagnostics are tested. Production ABI feature payloads are not yet present, so the resolver returns an actionable unavailable capability instead of installing into noexec app data. |
| File watching: Node | ⚠️ Integrated; device gate | Global polling is removed. Private workspaces leave Chokidar/Watchpack on native watching; shared `/storage`, `/sdcard`, and `/mnt/media_rw` paths receive polling variables from the working-directory capability policy. Interactive `cd` refreshes the policy. Nested HMR remains an on-device gate. |
| File watching: editor | ⚠️ Integrated; device gate | Private workspaces use recursive per-directory `FileObserver` registration with UUID IDs, new-directory registration, symlink containment, and inotify-overflow rebuilds. Shared/FUSE workspaces use a recursive one-second snapshot watcher. Device overflow and OEM storage behavior remain. |
| Symlinks | ✅ Integrated with explicit Android boundary | Runtime symlinks are rebuilt automatically on private app storage. Shared/FUSE/SAF cannot faithfully represent Unix symlinks, case sensitivity, modes, or execution, so the guided copy refuses links/escapes; developers must clone or extract the source directly into private storage when project symlinks must be preserved. No unsafe dereference fallback is offered. |
| Environment variables | ⚠️ Integrated; device gate | App-scoped HOME/TMP/npm/TLS/Git/Termux/toolchain/package-policy values are comprehensive. Global `CI`, no-color, Linux spoofing, and watcher polling are absent. Working-directory watch mode, structured server preload, and Next launcher/cache paths are inherited by Java, PTY, shell, and npm lifecycle children. Locale and interactive shared-storage transitions still need device checks. |
| TTY / terminal | ⚠️ Fixed; device gate | Native `forkpty`, resize, process-group signals, and job-control plumbing exist. Close is idempotent, signals TERM/KILL before changing state, always closes the master FD, and starts a child reaper. Terminal creation is now deduplicated; failed auto-start is not retried in a render loop, the error/retry action is visible, early PTY output is preserved, existing native sessions regain an active tab, and the Bash usability probe times out and reaps after five seconds. Repeated-close/job-control and the reported startup path remain in the API 29/36 device matrix. |
| Android private filesystem | ✅ Fully integrated | Runtime, caches, global npm installs, temp data, and default workspaces are under private storage, which supports Unix metadata and protects project data. |
| Android shared filesystem | ⚠️ Restricted by Android; guided import integrated | The app reports shared-storage capability limits and can atomically copy a project into the private execution workspace without shell commands. Android still requires the user to grant all-files access; shared storage remains noexec and `Android/data` restrictions still apply. |
| Filesystem path sandbox | ✅ Fully integrated | Canonical `Path` containment is segment-aware. Traversal and sibling-prefix escapes are rejected, `/data/data`, `/data/user`, and broad `/mnt` access are removed, runtime bin/lib writes are protected, system/APEX paths are read-only, and explicit user-visible storage roots are bounded. Private imports also reject source symlinks/escapes and clean failed staging directories. |
| SELinux / execution restrictions | ⚠️ Correct design; device gate | APK-native placement handles direct executables; `termux-exec` receives actual app/rootfs/SDK/SELinux variables for generated scripts. Validate without AVC denials on API 29, 34, 35, and 36 devices. |
| Secondary users / work profiles / adoptable storage | ⚠️ Integrated; automated device gate | Runtime/workspace roots come from `ApplicationInfo.dataDir`/`filesDir`, and shared/adoptable projects have a guided private import. The Phase 5 device matrix and instrumentation fixture validate private filesystem semantics; non-user-0/work-profile devices remain required external evidence for the Termux-derived payload relocation. |
| CPU architectures | ⚠️ App integrated; x86_64 runtime feature boundary | Gradle, React Native, Hermes, PTY, npm lifecycle shell, and Git credential helper build/package for `arm64-v8a` and `x86_64`; obsolete 32-bit ABIs are intentionally excluded. The full developer runtime/compiler sysroot remains ARM64, and x86_64 reports the required signed runtime feature rather than pretending native builds work. |
| Android 16 / Play targeting | ⚠️ Integrated; automated device/release gate | The project compiles and targets API 36 with RN 0.86.2, Gradle 9.3.1, NDK r29, new architecture, Hermes, and edge-to-edge enabled. APK manifest checks pass; CI now requires API 35/36 and strict 16 KiB device jobs plus bundletool validation before production release. |
| Release signing | ⚠️ Integrated; external credential gate | Release never uses `signingConfigs.debug`. Gradle fails closed unless all four external keystore values exist, rejects repository-local keystores, and the artifact gate rejects the Android debug certificate and requires the approved SHA-256 signer identity. No production key was supplied locally, so the production APK/AAB is intentionally a CI/owner gate. |
| Runtime supply-chain reproducibility | ⚠️ Integrated; external provenance/signing gate | The Ed25519-signed runtime 1.15 lock records ABI/API/page policy, each native payload hash/size/path/owner, and package-manager/tool-pack hashes. Reviewed source/license/ownership policy is recorded in `release/runtime-provenance.json`; LFS integrity is mandatory. Regeneration and a changed lock require the external release key and retained package-index/version/URL/license/SONAME evidence. |
| Runtime update cleanup | ✅ Fully integrated | Runtime fingerprinting forces device reinitialization on map changes. Before relocation, Gradle verifies the Ed25519 runtime-lock signature and prunes only stale `libbin_`/`liblib_` JNI outputs and map entries absent from that signed ownership manifest; unrelated files cannot be removed. |
| APK/install footprint | ✅ Policy integrated | The Phase 5 debug APK is 257,619,039 bytes and remains below the enforced 285,000,000-byte APK/AAB budget. Size is rechecked for both production artifacts; optional large toolchains remain signed feature capabilities rather than unsafe writable-storage installs. |
| Host Android build toolchain | ⚠️ Integrated; external release-host gate | Gradle 9.3.1, AGP 8.12.0, exact JDK 17, Kotlin 2.1.20, API/build tools 36, and NDK 29.0.14206865 build tests/instrumentation/debug successfully. Gradle rejects this host's default JDK 25. The Windows Device Guard Hermes restriction is routed to the clean Ubuntu release job, which must execute twice. |
| Dependency security | ✅ Fully integrated with reviewed dev boundary | `npm audit --omit=dev --audit-level=low` reports zero production findings and blocks release on any future finding. The full build/test graph currently reports 40 findings (7 moderate, 33 high); the reviewed, expiring boundary documents why incompatible automatic downgrades are forbidden and CI uploads the complete report every run. |
| Test automation | ⚠️ Integrated; external runner/signing gate | Repository-isolated Jest/ESLint, TypeScript, Java/Kotlin unit tests, instrumentation compilation, runtime policy/phase suites, license/secret/audit gates, signed ownership, APK ABI/API/content/dependency/alignment checks, x86_64 emulators, ARM64 API 29/34/35/36 fresh/upgrade, strict 16 KiB, and two clean production builds are defined. Connected ARM64 runners and approved signing secrets are still required to execute the external jobs. |

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

Acceptance: all 209 (or replacement) APK native libraries have `PT_LOAD`
alignment of at least `0x4000`.

Phase 4 result: implemented for the packaged artifact. React Native 0.86.2 and
NDK r29 replace the 4 KiB-aligned dependencies. `test:phase4-apk` inspected 231
packaged ELF files: all 225 loadable files have a minimum alignment of
`0x4000`; the other six are compiler `ET_REL` inputs with no load segments.
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
- This Windows host cannot provide the production artifact because Device
  Guard blocks the RN Hermes compiler. That restriction cannot be bypassed by
  application code and is now an explicit clean-Linux release-host gate.

OpenCode compatibility basis:

- The official npm/install path has no published `opencode-android-arm64`
  package: [upstream Android installer issue](https://github.com/anomalyco/opencode/issues/12515).
- The official Linux ARM64 ELF uses the wrong runtime ABI for native Android:
  [upstream linker/PIE issue](https://github.com/anomalyco/opencode/issues/10504).
- The pinned Bionic build and its patch/build pipeline are published at
  [guysoft/opencode-termux](https://github.com/guysoft/opencode-termux).

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
