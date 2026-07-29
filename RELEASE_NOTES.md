# A Dev Studio 1.3.6

This phone-test release fixes the reported `node-gyp` Python failure, makes
OpenCode discoverable as a real terminal command, and improves phone-terminal
output and copying.

Phone-test package:

- A standalone `1.3.6-phone-test` APK bundles the JavaScript application and
  runtime, so it runs without Metro.
- It installs beside the production app under `com.mobileide.app.phonetest`
  and is Android-debug-key signed solely for direct device testing.
- Installing over the prior phone-test package upgrades runtime 1.16.0 to
  1.16.1 and automatically re-extracts the corrected files. Clearing data,
  `chmod`, `npm rebuild`, or another manual recovery step is not required.

Highlights:

- Android's default asset rules were removing Python's `zipfile/_path`, most
  modular libc++ headers, pnpm `.bin` commands, and other functional runtime
  files. The APK now retains all underscore and dot-prefixed runtime entries.
- The final APK is compared file-for-file with the runtime source tree; a
  future silently omitted Python/compiler/package-manager asset fails the
  release gate.
- `node-gyp` can import the complete Python 3.14 standard library instead of
  failing at `ModuleNotFoundError: zipfile._path`.
- `opencode` now has a real `$PREFIX/bin/opencode` PATH trampoline in addition
  to its interactive wrapper, making it resolvable by terminals and child
  processes without using the unsupported official Android installer.
- The fallback shell prompt now expands the working-directory name instead of
  printing `adev:${PWD##*/}$` literally.
- Narrow phones use a slightly smaller terminal font, and copied output joins
  xterm visual wraps instead of inserting artificial newlines into npm logs.
- The APK passed complete runtime-asset, signed-lock, ARM64/x86_64 content,
  native dependency, API 36, 16 KiB ZIP, and 16 KiB ELF checks.

Known capability boundaries:

- The full developer runtime is bundled for ARM64. x86_64 application/native
  helpers are present, while the full x86_64 compiler/runtime remains a signed
  feature-pack requirement.
- OpenCode's official installer still does not publish an Android package. This
  release pins the independently source-built Bionic port and must complete the
  ARM64 API 29/36 device gate before production certification.
- OpenCode is available on ARM64. The x86_64 launcher reports that no verified
  Bionic runtime is installed instead of attempting the ARM64 or Linux binary.
- The general `bun` command remains unsupported. OpenCode's private patched
  runtime is not exposed as a system-wide Bun installation.
- Shared storage cannot reliably provide Unix executable modes, symlinks, or
  case sensitivity. Native builds use a guided private-workspace import.
