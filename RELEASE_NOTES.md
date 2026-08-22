# A Dev Studio 1.3.14

This phone-test beta adds a general Android project import/export model and
repairs the Next.js dev-server ownership bug. It does not patch an individual
npm package or project.

## Fixed in 1.3.14

- Folders on Android shared storage now present explicit **Open in place** and
  **Import to ADEV** choices. Open-in-place remains available for simple
  viewing/editing, with a persistent explanation and one-tap import action.
- Import copies into the real app-private runtime workspace, then switches the
  Explorer and opens a new Terminal in that private path. npm can therefore
  create `node_modules/.bin` symlinks on a filesystem that supports them.
- Source-only and full transfers have independent Git, hidden-file, and secret
  controls plus unique/merge/replace/stop-on-conflict behavior. Imports and SAF
  exports run off the UI thread with file/byte progress, cancellation, staging,
  containment checks, and no-follow symlink handling.
- Private projects can be exported through Android's Storage Access Framework
  to Downloads, Documents, or another user-selected provider. Persisted folder
  permission and project provenance/export metadata live outside projects and
  cannot be included accidentally.
- Shared-storage npm/pnpm/Yarn/Corepack/Next/Vite/native-build and mutating Git
  routes now stop before partial output with an actionable import message.
  Interactive functions, PATH trampolines, `command` execution, and background
  task dispatch use the same physical-path policy.
- The Next.js launcher owns the real project CLI as a child for its complete
  lifetime, inherits terminal I/O, forwards `SIGINT`/`SIGTERM`, propagates exit
  status, and cleans up unexpected-owner exits. Version-aware SWC WASM and
  Webpack selection are unchanged.

## Verification status

- Host tests cover Next.js 13.2.4, 14.2.35, 15.5.2, 15.5.22, and 16.2.12;
  process ownership, long-running behavior, exit/signal handling, and cleanup
  pass.
- Kotlin project-policy/registry/transfer and shared-command-policy tests,
  TypeScript, Jest, ESLint, and phone-test Kotlin compilation pass.
- No ADB device is connected. Real SAF providers, npm install after an imported
  Downloads project, Next dev/HMR/HTTP/Ctrl+C, and export-to-Downloads remain
  connected-device gates rather than claimed successes.
- The API-36 ARM64+x86_64 phone-test APK is 360,839,574 bytes, contains 252 ELF
  files with minimum `PT_LOAD` alignment `0x4000`, and has SHA-256
  `A79DEF8A9FBB4BA69CC0F75C8A9076241FA57F3F88388E0006C5450440ADAA91`.
  It is debug-test signed for direct installation, not a production Play build.

## Previous beta: 1.3.13

This phone-test beta fixes ADEV's platform-wide script interpreter chain. A
normal globally installed npm command can now be launched by name when its
entrypoint uses `#!/usr/bin/env node`; no package-specific launcher or direct
`node "$(command -v <cli>)"` fallback is required.

## Fixed in 1.3.13

- A new dual-ABI, 16 KiB-aligned preload resolves up to eight nested shebang
  levels before handing the final executable to Android's existing noexec and
  linker compatibility layer. It covers `execve`, `execv`, `execvp`,
  `execvpe`, `execl`, `execlp`, and `execle`.
- Missing `/usr/bin/*` and `/bin/*` interpreters are resolved through ADEV's
  PATH. `#!/usr/bin/env node`, `#!/usr/bin/env python`, `#!/system/bin/sh`,
  and script interpreters that are themselves scripts share the same generic
  path. Cycles and more than eight interpreter levels fail with `ELOOP`.
- Python `subprocess(..., shell=True)` and `os.popen()` no longer select
  `/data/data/com.termux/files/usr/bin/sh`. They use ADEV's APK-native shell,
  falling back to `/system/bin/sh`.
- Shipped Git/Python helper scripts and the native-build `paths.h` sysroot no
  longer advertise the stale Termux package shell.
- The Phase 1/5 connected-device matrix now performs an isolated real global
  npm install and launches its bin by command name. It also tests env-Python,
  system-sh, and Python `os.popen()` execution. The fixture is intentionally
  package-neutral and contains no AchSwap-specific handling.
- Runtime 1.16.8 forces upgrade installs to re-extract the corrected Python and
  shell assets automatically. No data clear, `chmod`, rebuild, or reinstall of
  an individual global CLI is intended.

## Verification status

- Host resolver/policy regressions and NDK r29 native builds pass for ARM64 and
  x86_64.
- No ADB device is connected, so the shipped global npm CLI/device harness is
  present but not claimed as executed on a phone yet.

## Previous beta: 1.3.12

This phone-test beta restores the real pinned OpenCode Android runtime and fixes
its first verified startup blocker: the payload's literal `mkdir("/tmp")` call
on Android's read-only root filesystem.

## Fixed in 1.3.12

- A new ADEV-owned Android preload library maps only exact `/tmp` paths into the
  canonical app-private runtime temp directory. It covers directory, open,
  metadata, rename, link-read, and removal operations and rejects `..` escapes.
  The shim is scoped to the OpenCode child process; it does not create `/tmp`,
  spoof Linux globally, or modify the pinned upstream payload.
- The OpenCode launcher again follows the pinned upstream Android wrapper:
  upstream heap-tag fix, `OPENTUI_LIB_PATH`, APK-native `LD_LIBRARY_PATH`, Bun
  self-executable variables, file-watcher policy, and the real payload. The ADEV
  temp shim is added before inherited `termux-exec` in `LD_PRELOAD`.
- Bare TUI, `--version`, help, `debug paths`, `run`, `serve`, and `web` are no
  longer blocked by the former blanket exit-69 capability gate. Every standard
  argument reaches the real ARM64 Android/Bionic payload.
- `adev-doctor` distinguishes installed launch capability from device
  certification. It reports the payload, tagfix, OpenTUI, and temp shim
  separately and does not claim TUI/run/serve/web success until phone tests pass.
- The runtime is bumped to 1.16.7 so upgrades regenerate the PATH trampoline
  and use the new launcher automatically. No `chmod`, app-data clearing, or
  package-specific reinstall step is intended.

## Retained compatibility fixes

- Next.js routing remains version-aware: Next 15.5.2/15.5.22 use their Webpack
  default without the unsupported `--webpack` option; Next 16.2.12 receives one
  supported `--webpack` opt-out from default Turbopack.
- The platform-wide Python asset, GNU Make shell bridge, ARM64 UAPI headers,
  Clang, Unix LLD personality, Node/npm lifecycle, Git, curl, BusyBox, Nano,
  terminal, and workspace fixes from the earlier betas remain included.

## Verification status

- Host execution proves all standard OpenCode arguments reach a child payload
  with private temp variables and the required preload order. `/tmp/../...` is
  rejected, while non-`/tmp` paths are unchanged.
- The pinned OpenCode 1.17.9 payload and upstream component hashes remain exact.
  The new compatibility library builds for ARM64 and x86_64 and passes the
  16 KiB ELF alignment policy.
- Next.js 15.5.2, 15.5.22, and 16.2.12 launcher regressions continue to pass.
- `adb devices -l` is empty for this build. Real OpenCode checks must therefore
  run on ARM64 in this order: version, help, debug paths, `run --help`, a real
  `run` request, `serve`, `web`, then TUI. Node/Vite/Next.js/Git/native-addon and
  terminal UX device checks also remain pending and are not inferred from host
  or APK verification.

## Package policy

- `1.3.12-phone-test` installs as `com.mobileide.app.phonetest` and is debug-key
  signed only for direct phone testing; it is not a production Play release.
- The OpenCode functional payload is ARM64-only. x86_64 keeps an explicit
  unsupported payload boundary and never installs a Linux/glibc binary.
- The APK is 360,699,232 bytes with SHA-256
  `96FC78D8A7F01905F1932EEBF96458A32682815FEE575D34E351AC292EF10234`.
  It targets API 36, contains the exact ARM64/x86_64 ABI set, and passes the
  signed runtime-lock, dependency-closure, 16 KiB ZIP, and 250-ELF gates.
