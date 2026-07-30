# A Dev Studio 1.3.7

This phone-test release fixes the two Android execution failures reported from
version 1.3.6: OpenCode trying to create read-only `/tmp`, and native addon
builds invoking Termux's unavailable shell path from GNU Make.

Phone-test package:

- The standalone `1.3.7-phone-test` APK bundles the application and ARM64
  developer runtime and runs without Metro.
- It installs beside the production app under `com.mobileide.app.phonetest`
  and is Android-debug-key signed solely for direct device testing.
- Installing over version 1.3.6 upgrades runtime 1.16.1 to 1.16.2 and
  automatically re-extracts the corrected launchers. Clearing app data,
  `chmod`, `npm rebuild`, or package-specific recovery is not required.

Fixes:

- The APK-native OpenCode launcher now validates the app-private temp directory
  and maps `BUN_TMPDIR`, `SQLITE_TMPDIR`, `TMPDIR`, `TMP`, and `TEMP` to it.
  The private patched Bun runtime can no longer fall back to read-only `/tmp`.
- A new APK-native Make launcher replaces GNU Make's compiled
  `/data/data/com.termux/files/usr/bin/sh` default with the bundled Bash. The
  command-line `SHELL` setting propagates to recursive Make, so the fix covers
  direct Make, npm lifecycle, node-gyp, node-pre-gyp, prebuild fallback, and
  other native source builds.
- npm 11's deprecated/unknown Android config injection was removed. Python and
  Node headers use the supported node-gyp package-config variables; compiler
  and linker flags remain normal environment variables.
- The earlier 1.3.6 fixes remain: complete Python/runtime assets, a real
  `opencode` PATH command, corrected fallback prompt, and logical-line terminal
  copying.

Verification:

- Both ARM64 and x86_64 native launchers compile and are covered by the signed
  runtime lock.
- TypeScript, Jest, ESLint, host policy, OpenCode, and tracked-secret checks
  pass.
- The final APK contains both ABIs and 243 ELF files. All 237 loadable ELF
  files have at least `0x4000` alignment; six compiler objects are relocatable.
- APK SHA-256:
  `5D979BB9495815820F11B95F878C67F17533827D836CF8EA771BBC6D68C24FDE`.

Known capability boundaries:

- The full developer runtime is bundled for ARM64. x86_64 application/native
  helpers are present, while the full x86_64 compiler/runtime remains a signed
  feature-pack requirement.
- OpenCode uses the independently source-built Android/Bionic port because its
  official installer does not publish an Android package. ARM64 TUI/provider/
  prompt/tool/PTY behavior still requires the phone retest.
- The general `bun` command remains unsupported; OpenCode's private patched
  runtime is not exposed as a system-wide Bun installation.
- Shared storage cannot reliably provide Unix executable modes, symlinks, or
  case sensitivity. Native builds use a guided private-workspace import.
