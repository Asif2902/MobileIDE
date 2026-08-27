# A Dev Studio 1.3.30

This phone-test build improves perceived performance and replaces OpenCode's unsafe desktop self-update path with an ADEV-managed Android compatibility layer.

- Runtime and workspace initialization now run behind a shorter, native-driver splash animation.
- Phone screens are mounted lazily and retained after first use, avoiding repeated Monaco and terminal WebView startup when switching tabs.
- Monaco no longer redraws React editor chrome on every keystroke, and terminal output is batched before crossing the WebView bridge.
- OpenCode's desktop auto-updater is disabled on Android. `opencode upgrade` now checks GitHub dynamically for a newer compatible ADEV APK and opens its Android download through ADEV's secure URL broker.
- The updater never downloads or executes a glibc/musl desktop OpenCode binary from writable Android storage.

# A Dev Studio 1.3.29

This phone-test beta completes the current OpenCode ARM64 baseline and refreshes ADEV Studio's mobile interface for clearer, faster day-to-day use.

## New in 1.3.29

- **OpenCode TUI stabilization.** The source-built OpenCode 1.17.9 graph explicitly registers the spinner component and falls back to a visible text container for unknown non-critical OpenTUI components instead of terminating the whole interface. The real Bash-tool runtime contract remains 22/22 offline and 23/23 with network on the tested ARM64/API-30 phone.
- **Cleaner ADEV interface.** A consistent dark visual system, the real ADEV logo, an app-owned Inter font, simplified four-tab navigation, and redesigned Editor, Explorer, Terminal, Output, Problems, Debug, and Settings surfaces replace the inconsistent legacy chrome.
- **Project creation without Git.** The Projects control now opens a compact bottom sheet, filters internal dot-directories, and can create/open a private ADEV workspace directly.
- **Explorer operations.** Files and folders have confirmed delete actions; deletion updates the visible tree immediately and then reconciles with storage. New/import actions fill the available width and empty states are clearer.
- **Reliable icons and editor actions.** Terminal cursor keys and editor search directions use vectors rather than device-font glyphs. The duplicate editor save button is removed, leaving one contextual save action in the header.
- **Terminal usability.** Improved spacing, readable sizing and colors, deliberate hold-to-copy behavior, and updated accessory controls are included.

## Verified

- Physical Infinix X689B, Android 11/API 30, ARM64: install/upgrade, launch, project sheet, project creation dialog, single-save editor toolbar, vector editor/terminal arrows, and Explorer controls.
- Host checks: TypeScript, ESLint (zero errors), focused UI/store regressions (21/21), and Android `assemblePhoneTest`.
- Remaining release boundary: API 29/API 36 and x86_64 OpenCode payload coverage are not yet certified.

## Previous beta: 1.3.28

# A Dev Studio 1.3.28

This phone-test beta adds the generic CLI platform bridges that GitHub CLI and future tools (Codex, Grok, OpenCode) need: opening links through Android, secure credential storage, and exec-safe Git for foreign processes.

## New in 1.3.28

- **`adev-open-url` — generic ACTION_VIEW bridge.** Any CLI can now open http(s) links in the Android browser: `adev-open-url https://github.com/login/device`. The same ELF also answers as `xdg-open`, and the environment exports `BROWSER=adev-open-url`, so browser-opening libraries discover it the standard way. This fixes GitHub CLI device login failing with `exec: "none": executable file not found in $PATH` (ADEV previously exported `BROWSER=none`; `gh` tried to execute that string). Both names exist as exec-safe symlinks in `bin/adev-shims/` so static binaries that fork/exec PATH entries work without a shell.
- **Secure credentials for any CLI.** New `adev-secret` command backed by an AndroidKeyStore AES/GCM vault inside the app: `printf '%s' "$TOKEN" | adev-secret set gh/token`, then `adev-secret get gh/token` (also `list`/`delete`). Values travel over stdin + a session-authenticated loopback broker only - never argv, shell history, or dotfiles. Git keeps using its existing Keystore-backed credential helper (wired via `credential.helper`), which is what keeps tokens out of remote URLs when `gh` drives git.
- **Foreign CLIs can spawn ADEV Git again.** GitHub CLI's internal git calls died with `fork/exec .../runtime/bin/git: permission denied`: static Go binaries exec a PATH entry directly, and the old `bin/git` shell trampoline lives on Android's noexec storage. A new APK-native launcher (`libbin_adev_git_launcher.so`, symlinked as `bin/adev-shims/git`) now leads PATH resolution: it applies the same shared-storage workspace guard as interactive shells, restores the runtime contract if the parent lost it, and execs the bundled Git ELF in place. The `bin/git` trampoline and shell functions remain for explicit-path callers.
- Honest limits: GitHub CLI still stores *its own* config token in `$XDG_CONFIG_HOME/gh/hosts.yml` plaintext because upstream `gh` has no keyring backend on this platform; that file lives in app-private storage. Use `adev-secret` + `GH_TOKEN=$(adev-secret get gh/token)` if you want the token out of there.

## Previous beta: 1.3.27

# A Dev Studio 1.3.27

This phone-test beta makes long installs visible again and turns the Android port-permission dead end into working tooling.

## Fixed in 1.3.27

- **npm install animates again.** The environment contract forced NPM_CONFIG_PROGRESS=false, which disabled npm's spinner everywhere � including real terminals, so 
pm install looked dead for minutes. The override is gone: npm now shows its spinner/reify progress on any TTY and keeps piped (agent/background) runs quiet automatically.
- **
etstat / ss / lsof work on Android 10+.** These commands always died with Permission denied because SELinux hides /proc/net from apps on every version since 10. They are now A Dev Studio shims that render the verified task-port registry ($PREFIX/tmp/adev-ports.json, mirrored by TaskRegistry on every change): listening servers started inside the app, with PID/task columns; lsof -i :PORT filters and -t prints kill-ready PIDs. Installed into in/adev-shims/ so they win over the broken toybox variants.
- **Agent environment guide shipped** at $PREFIX/share/adev/SKILL.md: layout, hard platform truths (noexec, single env contract, /proc/net block), what works, what is impossible, and self-check commands. Refreshed automatically on upgrade via the runtime content fingerprint.
- Regression-tested on device: new TaskRegistryPortsTest proves listen-event ? loopback probe ? published port ? snapshot ? unpublish without /proc/net; contract suite stays 22/22 offline / 23/23 network on Infinix X689B.

## Previous beta: 1.3.26
# A Dev Studio 1.3.26

This phone-test beta fixes the last OpenCode tool failure: the `bash`/`shell` tools' Bun fast path that sanitized the child environment, and the one remaining sysroot retarget.

## Fixed in 1.3.26

- **OpenCode shell tools use the broker.** `packages/core/src/tool/bash.ts` always routes through `libbin_adev_env.so --adev-opencode-shell-v1` and `packages/opencode/src/tool/shell.ts` (`shell` tool, id `bash`) does the same via `ChildProcess.make(broker, ...)`. The broker `adev_env --adev-opencode-shell-v1` restores the signed `adev-env.conf` contract (`PATH`/`LD_PRELOAD`/`PREFIX`/etc.) inside the APK-native executable before `execv("/system/bin/sh", ["-c", command])`, so `node`/`python`/`npm`/`npx` and `#!/usr/bin/env` shebangs work from the sanitized Bun child. `include/paths.h`/`pwd.h`/`termux-auth.h` are now retargeted via the base ` /data/data/com.termux/files` (not just `/usr`), so `adev-runtime-env-test` is 22/22 offline / 23/23 network from `debug agent build --tool bash`.
- Verified on Infinix X689B via `opencode-device-runtime-probe.sh` (`debug agent build --tool bash`): `SHELL`/`PATH`/`LD_PRELOAD`/`PREFIX` correctly restored, `node`/`python`/`npm`/`npx` found, `22/22` and `23/23` pass.

## Previous beta: 1.3.25

# A Dev Studio 1.3.25

This phone-test beta fixes the 8 OpenCode sandbox failures that remained after the runtime contract work.

## Fixed in 1.3.25

- **OpenCode now shares the full ADEV contract.** `AdevEnvironment` is the single authority for `LD_PRELOAD` (recursive shebang + `termux-exec`), `PYTHON`/`PYTHONHOME`/`PYTHONPATH` and the `TERMUX_*` family. They are published to `etc/adev-env.conf`/`etc/adev-env.sh` and restored by the native `adev_runtime_env` layer, so every OpenCode child sees the same `HOME`/`PREFIX`/`PATH`/`XDG`/`LD_LIBRARY_PATH`/`SSL_CERT_FILE`/`NODE_OPTIONS` as the interactive terminal. The native layer now merges `LD_PRELOAD` instead of only setting it when missing, and the OpenCode launcher builds the full `tagfix + opencode-compat + exec-compat + termux-exec` chain and falls back to a discovered Python for upgrades. `python`, `python3`, `node`, `npm`/`npx`, `env` and standard `#!/usr/bin/env node|python` plus chained-interpreter scripts run by direct path on noexec storage; `python -c "import os;os.popen(...)"` and `subprocess(...,shell=True)` use the APK-native shell; `npm root -g`/`prefix -g` and `NODE_OPTIONS` (exactly one `--require`) survive without manual exports.
- Verified on Infinix X689B as `HOME=workspaces` (the OpenCode picker home): `adev-runtime-env-test.js` 22/22 offline and 24/24 with network, plus direct `node`/`python`/`npm`/`npx`, shebang and `env` checks, and `demo-api` dual-stack `::` on 3000. Runtime 1.17.4 upgrades existing phone-test installs.

## Previous beta: 1.3.24

# A Dev Studio 1.3.24

This phone-test beta restores `http://localhost` for on-device preview.

## Fixed in 1.3.24

- **Localhost preview.** `HOST=0.0.0.0` made Vite/Next listen IPv4-only.
  Android Chrome often connects to `localhost` as `::1`, which that socket
  never accepted, so the page failed while `http://127.0.0.1` still worked.
  Node servers now bind dual-stack `::` (`ipv6Only: false`). `HOSTNAME` is
  `127.0.0.1` so printed URLs are not `http://0.0.0.0`. Phone-test/release
  also allow cleartext HTTP to local dev servers.

## Previous beta: 1.3.23

# A Dev Studio 1.3.23

This phone-test beta makes Next 14 use the WebAssembly compiler on Android
instead of hanging after a 404 for the unpublished native `@next/swc-android-arm64`
package.

## Fixed in 1.3.23

- **Next 14 no longer hangs on first HTTP request.** Next 15 already loads WASM
  first on `aarch64-linux-android`. Next 14.x still required
  `experimental.useWasmBinary`, then tried to download
  `@next/swc-android-arm64`, which has never been published. The 404 left
  `loadBindings()` unsettled, so `next dev` accepted TCP and never answered.
  The Node preload now rewrites that Next 14 condition to Next 15's. It does
  not patch Next's getter-only `download-swc` exports: assigning those threw
  and prevented Next from starting at all.

## Previous beta: 1.3.21

This phone-test beta replaces the per-tool Android workarounds with one
runtime environment contract, and makes the Next.js WebAssembly compiler
resolve for every Next process instead of only the CLI.

## Fixed in 1.3.21

- **One authoritative environment.** `AdevEnvironment` is now the single
  source for `HOME`, `PREFIX`, `ADEV_RUNTIME`, `PATH`, `TMPDIR`/`TMP`/`TEMP`,
  every XDG base directory, `LD_LIBRARY_PATH`, `NODE_PATH`, `SHELL` and the
  TLS trust store. Shells, PTY sessions, Node, npm/npx, Python, Git, Next.js,
  OpenCode, build workers and their subprocesses all read the same values.
  It is published as `etc/adev-env.sh` for shells and `etc/adev-env.conf`
  for the native layer.
- **XDG directories exist.** `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` were previously
  unset, which is what produced `Unsupported platform: android` from
  Next.js. They are now created and exported for every process.
- **Next.js build workers no longer die on startup.** `NODE_OPTIONS` carried
  two `--require` flags. Next parses `NODE_OPTIONS`, joins repeated option
  values with a space and re-serialises them for its workers, so the pair
  became one unresolvable module path and every worker exited with
  `MODULE_NOT_FOUND`. The runtime now preloads a single entry module.
- **SWC WebAssembly resolves everywhere.** Next resolves
  `@next/swc-wasm-nodejs` as a bare ESM specifier, which ignores `NODE_PATH`;
  that is why an external cache worked for the CLI but not for dev and build
  workers. The exact matching version is cached under the ADEV runtime and
  mapped into `node_modules/@next/swc-wasm-nodejs`, keeping the scoped
  package layout. `package.json` and the lockfile are never modified.
- **`env` is ADEV’s, not Toybox’s.** A shim directory now leads `PATH`, so
  `env node script.js` works from system binaries and from processes that do
  not load ADEV’s exec layer.
- **TLS verification is never disabled.** The CA bundle is assembled from
  both the legacy and Conscrypt APEX trust stores, certificate blocks only,
  and published as `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`,
  `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `PIP_CERT`.
- **Termux paths retired.** The packaged sysroot (headers, `pkg-config`
  metadata, node `config.gypi`) is retargeted from
  `/data/data/com.termux/files/usr` to this installation at extraction, and
  the native recovery layer repairs any inherited value that still names it.
- **Next.js version ownership.** Published advisories for the installed
  version are reported; A Dev Studio never rewrites a project’s dependency.
- **Packaged runtime JavaScript upgrades with the app.** Runtime readiness was
  keyed only to `native-map.json`, so a new APK that shipped changed runtime
  JavaScript under an unchanged runtime version kept running the previously
  extracted copy. The readiness fingerprint now includes the package version.
- **Next releases with no published WASM compiler still run.** Vercel does not
  publish `@next/swc-wasm-nodejs` for every Next release — the 14.2 line stops
  at 14.2.33 — so `next@14.2.35` had no matching compiler at all and Next’s own
  on-demand download fails there too. A Dev Studio now falls back to the nearest
  published build in the same minor line and says exactly what it substituted.
- **BusyBox applet wrappers stop re-running commands.** Each wrapper chained
  BusyBox, `/system/bin` and `/system/xbin` with `||`, so `grep` finding no
  match or `diff` reporting a difference ran the command up to three times and
  ended with a misleading “/system/xbin/... No such file or directory”. The
  fallback now applies only when the applet could not be executed at all.
- Runtime 1.17.3 upgrades existing phone-test installs automatically.

## Verification status

- Verified on a physical Infinix X689B (Android 11, arm64) through the
  release-mode phone-test package.
- The APK is phone-test signed, not Play/production signed. OpenCode’s
  functional payload remains ARM64-only.

## Previous beta: 1.3.17

This phone-test beta makes OpenCode's **Open project** picker start on real
ADEV projects. It does not patch OpenCode itself or merge shell configuration
into project storage.

## Fixed in 1.3.17

- OpenCode's web directory picker always starts at the process `HOME` and
  skips directory symlinks, so the `~/workspaces` shell link never appeared
  there. The OpenCode process now reports `HOME` as the canonical private
  workspace root (`runtime/workspaces`).
- XDG, global Git config, npm config, credentials, and agent bootstrap stay
  under `runtime/home` through `ADEV_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, and
  the existing XDG variables.
- Runtime 1.16.13 upgrades existing phone-test installs automatically.

## Verification status

- The launcher contract is in source and the dual-ABI phone-test APK was
  rebuilt. Physical picker listing is left for on-device confirmation.
- The APK is phone-test signed, not Play/production signed. OpenCode's
  functional payload remains ARM64-only.

## Previous beta: 1.3.16

This phone-test beta completes the current OpenCode Android repair cycle. It
fixes the Android/Bionic process layer and bundles generic developer tooling;
it does not patch an individual OpenCode project or dependency.

## Fixed in 1.3.16

- OpenCode 1.17.9 uses the real pinned ARM64 Android/Bionic payload for version,
  help, paths, agent runs, servers, web, and TUI paths.
- API 29/30 OpenCode children disable Bionic heap pointer tags during early
  process startup, preventing Bun's uSockets pointer truncation abort. API 31+
  uses the public Bionic operation.
- Literal `/tmp` access remains scoped to OpenCode and maps into canonical,
  writable app-private cache storage.
- Direct `/bin/sh`, `/usr/bin/sh`, and stale Termux shell paths now resolve
  recursively to an executable Android shell. OpenCode itself defaults to
  `/system/bin/sh`, eliminating the reproduced `/bin/sh[3]` parse failure.
- A pinned Termux ripgrep 15.2.0 ARM64/Bionic PIE and its existing PCRE2 closure
  are exposed through an exec-safe `rg` trampoline. OpenCode therefore never
  downloads the wrong x86_64 musl artifact on ARM64.
- Standard global npm CLIs now resolve virtual `/usr/bin/env` to ADEV's native
  interpreter instead of Android Toybox. Untouched `#!/usr/bin/env node` and
  Python entrypoints therefore execute by command name without EACCES, bad ELF,
  package-specific wrappers, or shell bootstrap state.
- The native compiler uses Android's required libc++ → target Bionic → generic
  Bionic header order. Node 26 C++20 V8 addons can compile and load alongside
  the existing N-API C/C++ paths.
- Runtime 1.16.11 upgrades existing installs automatically; no cache deletion,
  `chmod`, project edit, or manual OpenCode reinstall is required.

## Verification status

- Host resolver, OpenCode, ripgrep, provenance, native-build, and signed-lock
  contracts pass. Both ARM64 and x86_64 ADEV compatibility helpers build with
  NDK r29 and 16 KiB alignment.
- Physical ARM64/API-30 verification passes for the exact AchSwap global CLI,
  the package-neutral global npm fixture, env-Python/system-sh/Python popen,
  N-API C/C++ install/rebuild/direct-node-gyp/load/consumer cycles, and a
  C++20 V8 addon compile/link/load.
- OpenCode version/help/debug/run/serve and web HTTP paths reach the real ARM64
  runtime. Automatic foreground browser handoff for `opencode web` remains
  unresolved and is explicitly abandoned in this beta rather than claimed.
- The final dual-ABI phone-test APK is 361,646,760 bytes with SHA-256
  `0A13DF899091DEB5B3EB481EEF0EC998A34227D0FED7F08EFC68E83D5F6704C4`.
  Its 257 packaged ELF files pass dependency/ABI checks and every loadable ELF
  has at least `0x4000` segment alignment. It is a test-signed beta APK, not a
  production/Play-signed artifact.
- The OpenCode functional payload remains ARM64-only. x86_64 reports an explicit
  unsupported boundary and never substitutes a Linux/glibc payload.

## Previous beta: 1.3.14

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
