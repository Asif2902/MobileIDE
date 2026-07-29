# A Dev Studio 1.3.5

This release adds an Android-native OpenCode CLI path and fixes the terminal
startup loop.

Highlights:

- The terminal no longer retries a failed native session forever. A failed
  shell/PTY startup now ends the spinner, displays the native error, and offers
  one explicit retry.
- Native shell validation has a five-second timeout and forced cleanup, so a
  blocked shell probe cannot leave the terminal loading indefinitely.
- Concurrent terminal opens are deduplicated, existing native sessions regain
  an active tab, and output emitted before session creation resolves is kept.
- OpenCode 1.17.9 is packaged as a verified ARM64 Android/Bionic runtime. Its
  native launcher works from terminal and task command resolution without
  `chmod`, Termux paths, a glibc loader, or global Linux platform spoofing.
- The OpenCode archive and component hashes, Android port source commit,
  upstream OpenCode commit, licenses, PIE/linker requirements, and 16 KiB ELF
  alignment are recorded in the signed runtime lock.
- `adev-doctor` reports OpenCode version/readiness and the x86_64 capability
  boundary. Runtime 1.16.0 refreshes shell wrappers on upgrade.

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
