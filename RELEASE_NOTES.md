# A Dev Studio 1.3.8

This phone-test candidate addresses the failures copied from the connected ARM64
phone: terminal startup looping, incomplete Linux commands, native addons using
Termux's unavailable shell, misleading OpenCode behavior, and Git workspaces
that were difficult to locate or operate from the app.

Phone-test package:

- `1.3.8-phone-test` installs as `com.mobileide.app.phonetest` and includes the
  ARM64 developer runtime without requiring Metro.
- It is debug-key signed only for direct device testing; it is not a production
  Play release.
- Runtime 1.16.3 forces a verified upgrade extraction. Developers should not
  need `chmod`, a package-specific rebuild, or app-data clearing.

Runtime and terminal fixes:

- Python's complete standard library, including `zipfile/_path`, is retained in
  the APK so node-gyp can configure native builds.
- The APK-native Make bridge forces Android's `/system/bin/sh`, including for
  recursive Make, so no build can fall back to
  `/data/data/com.termux/files/usr/bin/sh`.
- BusyBox 1.38.0-1 now has a verified ELF64 AArch64 payload and APK-native
  argv-zero dispatcher. Commands such as `vi`, `less`, `more`, `w`, `mktemp`,
  and `grep` are routed through normal PATH lookup; final phone execution is
  pending. Android `w` reports uptime because app UIDs cannot read utmp logins.
- Nano 9.2 is integrated for ARM64 with terminfo, 44 syntax definitions,
  generated prefix-correct configuration, Nano/Git editor defaults, and a
  `cproj <folder>` helper for finding private projects from any directory.
- Terminal environment construction strips invalid bytes from the SELinux
  context before spawning. The startup/prompt correction was observed during
  the earlier API 30 diagnosis; the final 1.3.8 candidate still needs retest.
- The terminal removes duplicate safe-area padding, keeps its shortcut bar
  above the Android keyboard, reconciles IME composition without duplicated
  input, and copies soft-wrapped output as logical lines.

Git and workspace fixes:

These paths pass host unit/security/build checks. Live phone HTTPS/SSH clone,
pull, push, rejection, credential persistence, and PR creation are pending.

- Clones use a visible, validated private-workspace folder and open that folder
  automatically after success. Project and `.env` access are exposed in the
  explorer rather than requiring shell-only discovery.
- Branch refresh/checkout, upstream push, and native pull/fetch behavior are
  completed. Remote and branch arguments are validated before reaching Git.
- HTTPS credentials and PR tokens use Android Keystore-backed references. The
  UI now waits for secure storage to succeed, clears cancelled token input, and
  never returns embedded remote credentials to JavaScript.
- Failed clone/open operations preserve the current repository and surface the
  real error instead of showing a false success state.

OpenCode capability boundary:

- The command is installed on PATH, uses app-private temp directories, and
  supports `--version`, `--help`, and `debug paths` diagnostics on ARM64.
- Real API 30 testing proved that every available Android Bun/OpenTUI payload
  aborts in native Bionic code for TUI, agent `run`, `serve`, or `web` modes.
  Version 1.3.8 blocks those crash paths with an actionable exit-69 message. It
  does not substitute an incompatible Linux/glibc binary or claim full OpenCode
  compatibility.

Known capability boundaries:

- The complete developer/compiler runtime is bundled for ARM64. x86_64 ships
  app helpers but still requires a signed full-runtime feature pack.
- Nano is ARM64-only; x86_64 continues to provide `vi` until a pinned Android/
  Bionic Nano package exists for that ABI.
- General Bun remains unsupported on Android/Bionic.
- Shared storage cannot reliably preserve executable modes, Unix symlinks, or
  case sensitivity. Native builds use the app-private workspace flow.

Dependency security:

- React Native CLI 20.2.0, Nanoid 3.3.18, fast-xml-parser 5.10.1, js-yaml,
  and brace-expansion are pinned to fixed compatible releases.
- Upstream `image-size` has no release fixing its ICNS/JXL/HEIF infinite-loop
  advisories. `npm install` applies a version-pinned parser patch, and the
  release gate runs malformed-input probes with a hard timeout. Only the two
  exact reviewed advisories are accepted until 2026-09-11; any other audit
  finding or patch drift fails the build.

Final 1.3.8 phone-test evidence:

- APK: `app-phoneTest.apk`, 360,650,192 bytes
- SHA-256: `D227A57916822CF090FE6C63F8313A398860EE4B24CD6CE46DE96D2BFA3219AB`
- Test signer SHA-256: `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`
- API/ABI/lock/closure/16 KiB APK checks: PASS (246 ELF files)
- Unit/instrumentation compilation: PASS; test APK 694,409 bytes, SHA-256
  `B006C6952640969B04F07870A6AF2D4959970E1BD2F324F3C34A472CCD9AD014`
- API 30 final-candidate fresh install/upgrade: PENDING — phone disconnected
- Terminal keyboard/UI, npm/node-gyp compile/load, BusyBox/Nano: PENDING
- Git HTTPS/SSH/PR and Node/Express/Vite/Next.js: PENDING
- OpenCode diagnostics/exit-69 final-candidate retest: PENDING; earlier API 30
  evidence established the functional Android/Bionic boundary
