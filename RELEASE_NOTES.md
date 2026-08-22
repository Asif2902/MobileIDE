# A Dev Studio 1.3.10

This phone-test release completes the next native-addon stage exposed by the
1.3.9 ARM64 device run.

## Fixed in 1.3.10

- Clang now launches LLVM through an APK-native `ld.lld` personality bridge.
  Android relocation renamed the Termux multi-call driver to `libbin_lld.so`,
  so generic LLD could not infer its Unix/ELF personality and refused to link
  `bufferutil.node` after compilation succeeded.
- The bridge supplies `argv[0] = ld.lld` exactly as LLVM's upstream symlink
  would. It is used by Clang's `--ld-path`, the exported `LD`, interactive
  wrappers, PATH trampolines, Java command resolution, and both app ABIs. This
  is a platform integration for all native builds, not a bufferutil workaround.
- `opencode -v` is normalized to the verified `--version` diagnostic before
  launching the Android payload. The upstream short option entered unsupported
  initialization and attempted to create read-only `/tmp`.

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

- `1.3.10-phone-test` installs as `com.mobileide.app.phonetest` and is debug-key
  signed only for direct testing; it is not a production Play release.
- Runtime 1.16.5 forces verified upgrade extraction automatically. Clearing app
  data, running `chmod`, or applying package-specific rebuild steps is not
  intended.
- OpenCode interactive, agent, run, serve, and web modes remain blocked with
  exit 69 because the available Android Bun/OpenTUI payloads abort in native
  Bionic code. Only version/help/path diagnostics are claimed.

## Verification status

- JDK 17, ESLint, TypeScript, 45 Jest tests, license/security/runtime ownership,
  all host compatibility suites, OpenCode/Nano checks, and the bounded
  production audit pass.
- Android unit tests, both native ABIs, the main APK, and instrumentation APK
  build successfully on the pinned JDK 17/NDK r29 toolchain.
- `app-phoneTest.apk` is 360,685,255 bytes with SHA-256
  `E87B6DA311435F5E08DBD8C0D2C7F8F14BA551211B7A8DF0761D23D2EF5C4E9B`.
  It targets API 36, includes the exact ARM64/x86_64 ABI set, verifies the
  signed runtime lock and dependency closure, and passes 16 KiB ZIP plus
  248-ELF alignment checks.
- The instrumentation APK is 694,413 bytes with SHA-256
  `B9A8EC728A5A07C0D842984B6BC004D5FD81B3BB2A3F586BA80F212E3D121F82`.
- Final native-addon link/load, Vite/Next.js, Git credential operations, and
  terminal UX still require execution on the connected phone and are not
  inferred from host checks.
