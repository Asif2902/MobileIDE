# A Dev Studio 1.3.9

This phone-test release fixes the two platform defects exposed by the latest
ARM64 device logs after the earlier Python and Make repairs allowed node-gyp to
reach compilation.

## Fixed in 1.3.9

- Generated `.adev-agent-env` now contains the valid POSIX expansion
  `${NODE_OPTIONS:-}`. Version 1.3.8 accidentally emitted the literal Kotlin
  escape `${'$'}{NODE_OPTIONS:-}`, which made Android `sh` stop npm/Vite with
  `bad substitution`.
- Clang now searches `$PREFIX/include/aarch64-linux-android` before the generic
  Bionic headers. This resolves the packaged `asm/types.h` imported by
  `linux/types.h` and applies to node-gyp plus packages that invoke Clang
  directly through the exported `CPATH`.
- Runtime generation, readiness, and `adev-doctor` fail clearly if the Linux,
  ARM64 ASM, or generic ASM UAPI header chain is incomplete.
- `adev-doctor` now explains the current package scripts, finds bounded nested
  Node projects, suggests the correct runnable command, reports Node/npm engine
  mismatches, and explains npm's native-script approval security policy.

## Correct command behavior

- `npm run dev` works only in a package whose `package.json` declares `dev`.
  In the copied AchMarket logs that package was `AchMarket/frontend`, not either
  parent directory.
- Run a direct entry file with `node index.js`; `npm run index.js` is valid only
  if a script named `index.js` is declared.
- Bare `git` and bare `ssh` printing usage means both executables resolved. Live
  clone/push/auth and host-key behavior still require device/network testing.
- AchMarket declares Node 22.x/npm 10.x while the bundled runtime is Node 26.4/
  npm 11.16. That warning is a project engine mismatch, not an Android EACCES
  failure.
- OpenCode remains a diagnostic-only Android command. `--version`, `--help`,
  and debug paths are supported; functional TUI/run/server modes remain blocked
  with exit 69 because the available Android Bun/OpenTUI payloads abort in
  native Bionic code.

## Package and upgrade behavior

- `1.3.9-phone-test` installs as `com.mobileide.app.phonetest` and is debug-key
  signed for direct phone testing; it is not a production Play release.
- Runtime 1.16.4 forces upgrade re-extraction, so existing installations receive
  the corrected shell file and compiler environment automatically. No `chmod`,
  package-specific workaround, app-data clearing, or manual rebuild is intended.
- The complete ARM64 developer/compiler runtime remains in the base APK. The
  full x86_64 developer runtime and optional large toolchains remain explicit
  signed feature-pack boundaries.
- Bun and full OpenCode functional modes remain explicit upstream Android/Bionic
  capability boundaries rather than unsafe glibc fallbacks.

## Verification status

- JDK 17, ESLint, TypeScript, 45 Jest tests, runtime/security/license gates, the
  generated-agent POSIX shell regression, ARM64 sysroot regression, and Phase
  2–5 host checks pass.
- `testPhoneTestUnitTest`, `assemblePhoneTest`, and the instrumentation APK
  build pass on the pinned JDK 17/NDK r29 toolchain.
- `app-phoneTest.apk` is 360,654,460 bytes with SHA-256
  `35B0106F3B755901C722251A98D7E3DB9D667C190E550509F05E907DF2D37A14`.
  It targets API 36, has the exact ARM64/x86_64 ABI set, verifies the signed
  runtime lock and dependency closure, and passes 16 KiB ZIP plus 246-ELF
  alignment checks.
- The instrumentation APK is 694,409 bytes with SHA-256
  `870CA39117F9C908ECBC71E2195006C029D5A52B972B60A41E9BE43920B08AD3`.
- A phone is not connected. Native-addon compile/load, Node/Express/Vite/
  Next.js, Git HTTPS/SSH, terminal UX, and fresh/upgrade execution remain device
  tests and are not inferred from host or APK verification.
