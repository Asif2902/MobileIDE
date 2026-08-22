# A Dev Studio 1.3.11

This phone-test beta fixes the Next.js 15 launcher regression reported from the
phone and moves all supported OpenCode diagnostics into the APK-native Android
launcher so they cannot fall back to read-only `/tmp`.

## Fixed in 1.3.11

- The Android Next.js launcher now selects Webpack by the installed Next.js
  major version. Next 15.5.2/15.5.22 omit the unsupported `--webpack` flag and
  use their Webpack default; Next 16.2.12 receives exactly one `--webpack` to
  opt out of its Turbopack default. Conflicting Turbo flags are removed without
  modifying the developer's project.
- `opencode --version`, `opencode -v`, help, and `opencode debug paths` now run
  entirely inside the dual-ABI APK-native launcher. They do not start Bun, do
  not execute the pinned payload, and reject inherited `/tmp`/shared-storage
  paths in favor of the app-private runtime.
- The OpenCode version is generated at native build time from the signed
  `adev-opencode.json` manifest instead of being duplicated in C++ source.
  Interactive, agent, run, serve, and web commands retain the tested exit-69
  capability boundary because the available Bun/OpenTUI payload aborts on
  Android/Bionic; no incompatible Linux/glibc binary is substituted.

## Device evidence from 1.3.9

- Pure-JavaScript `npm install` completed successfully.
- `node server.js` started a real HTTP server on port 3000.
- Git HTTPS clone and branch checkout completed successfully.
- node-gyp configured, compiled `bufferutil.o`, and reached module linking.
  This confirms the earlier shell, Python, Make, ARM64 UAPI header, Clang, and
  executable-resolution fixes on the phone.
- `npm run index.js` and `npm run server.js` correctly report missing scripts.
  Direct files use `node index.js` or `node server.js`; npm only runs names
  declared under `package.json` scripts.
- The tested project declares Node 20.x while the bundled runtime is Node 26.4.
  That `EBADENGINE` warning is a project/runtime version mismatch, not an
  Android execution failure.

## Package policy

- `1.3.11-phone-test` installs as `com.mobileide.app.phonetest` and is debug-key
  signed only for direct testing; it is not a production Play release.
- Runtime 1.16.6 forces verified upgrade extraction automatically. Clearing app
  data, running `chmod`, or applying package-specific rebuild steps is not
  intended.
- OpenCode interactive, agent, run, serve, and web modes remain blocked with
  exit 69 because the available Android Bun/OpenTUI payloads abort in native
  Bionic code. Only version/help/path diagnostics are claimed.

## Verification status

- JDK 17, ESLint, TypeScript, 45 Jest tests, license/security/runtime ownership,
  all host compatibility suites, OpenCode/Nano checks, and the bounded
  production audit pass.
- Next.js launcher regressions pass for 15.5.2, 15.5.22, and 16.2.12. The
  host-compiled OpenCode launcher passes both version aliases, help, poisoned
  `/tmp`/XDG path diagnostics, and unsupported-mode exit-69 tests without
  executing the Bun payload.
- Android unit tests, both native ABIs, the main APK, and instrumentation APK
  build successfully on the pinned JDK 17/NDK r29 toolchain.
- `app-phoneTest.apk` is 360,682,699 bytes with SHA-256
  `E68B83EF4C096C9973CEE5C9666DE3B0200DF32AADC9B5CE3A3A70B1AE090081`.
  It targets API 36, includes the exact ARM64/x86_64 ABI set, verifies the
  signed runtime lock and dependency closure, and passes 16 KiB ZIP plus
  248-ELF alignment checks.
- The instrumentation APK is 694,413 bytes with SHA-256
  `004D06B00B9F0514AEF357BA0FE63BFA3B28066F530E4FA6AA679FEBEE00F114`.
- Final native-addon link/load, Vite/Next.js, Git credential operations, and
  terminal UX still require execution on a phone and are not inferred from
  host checks. `adb devices -l` was empty for this build.
