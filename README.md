# A Dev Studio — MobileIDE

React Native mobile IDE for Android with a bundled ARM64 developer runtime (Node, npm, Python, Git, Clang/LLD, BusyBox) that runs entirely on-device. The app ships a Monaco editor + xterm terminals in WebViews and a PTY + background-task manager for `npm run dev` / `next dev` / `opencode` on the phone.

**Package:** `com.mobileide.app` (production) / `com.mobileide.app.phonetest` (phone-test) · **Current:** 1.3.25 (runtime 1.17.4) · **ABIs:** `arm64-v8a`, `x86_64` (runtime is ARM64) · **minSdk 29**, **targetSdk 36**, **JDK 17**, **NDK r29**

## What it does

- File explorer + Monaco editor (WebView)
- Multi-session PTY terminal (`mobileide-pty` JNI, `ProcessBuilder` fallback)
- Bundled runtime under `filesDir/runtime` — Node 26.4.0 / npm 11.16.0, Python 3.14, Git 2.55, curl, Nano, ripgrep, OpenCode 1.17.9 (ARM64/Bionic)
- Git panel (JGit) + CLI Git over the same runtime + Keystore-backed credentials
- Workspaces in `runtime/workspaces` (private, symlink-capable) with guided import from shared storage

## Project structure

```
src/                          # RN UI (screens, stores, components, native bridges)
android/app/src/main/java/    # native modules, RuntimeManager, PTY, Git, Process
android/app/src/main/assets/  # terminal/editor HTML, runtime support JS
android/app/src/main/jniLibs/ # relocated ELFs as lib*.so (only exec-safe location)
android/app/src/main/cpp/     # PTY, exec compat, opencode launcher, npm/busybox shims
scripts/                      # fetch-runtime, host test suites
runtime/                      # local download/extract work area (not the APK assets)
```

Important paths: `AdevEnvironment.kt` (single env contract), `RuntimeManager.kt` (extract + symlink farm + `native-map.json`), `adev-node-preload.js` (sole `NODE_OPTIONS --require`), `adev-next-swc.js` (WASM cache), `PtySessionManager.kt`.

## Getting started

```sh
npm ci
npm start          # Metro
npm run android    # or open android/ in Android Studio
```

The runtime is extracted on first launch into `filesDir/runtime`. `version.json` is the single version authority (`app` + `runtime`).

## Building phone-test

```sh
# JDK 17 is required — Gradle rejects 25
npm run release:check
cd android
./gradlew :app:assemblePhoneTest :app:assemblePhoneTestAndroidTest
adb install -r app/build/outputs/apk/phoneTest/app-phoneTest.apk
adb install -r app/build/outputs/apk/androidTest/phoneTest/app-phoneTest-androidTest.apk
```

Phone-test APKs are **debug-test signed** (`com.mobileide.app.phonetest`), not Play signed.

## Runtime contract

`AdevEnvironment` is the single source for `HOME`/`PREFIX`/`PATH`/`TMPDIR`/`XDG_*`/`LD_LIBRARY_PATH`/`LD_PRELOAD`/`NODE_PATH`/`SHELL`/`PYTHON*`/`TERMUX_*`/`SSL_CERT_FILE`. It is published as `etc/adev-env.conf` (native recovery) and `etc/adev-env.sh` (shell). Every shell, PTY, Node, Python, Git, Next.js, OpenCode and their children see the same values.

Docs:

- `ANDROID_COMPATIBILITY_PLAN.md` — five-phase ledger + post-phase updates (current: 1.3.25 / 1.17.4)
- `RELEASE_NOTES.md` — per-beta notes (current: 1.3.25)
- `CONTEXT.md` — living working memory (not committed)
- `release/README.md` — production signing & artifact gates

## Verification

```sh
npm run release:check          # JDK, lint, TS, licenses, secrets, runtime-lock, host suites
node scripts/test-runtime-env-host.mjs
node scripts/test-opencode-android-host.mjs
```

Device matrix (`adev-runtime-env-test.js` 22/22 offline / 24/24 network, Next 13/14/15, Vite, `demo-api`, `opencode serve`) is exercised via `RuntimeDiagnosticsInstrumentationTest` on a connected phone.

## Troubleshooting

See [React Native Troubleshooting](https://reactnative.dev/docs/troubleshooting) for Metro issues. For ADEV-specific issues run `adev-doctor` in the in-app terminal.
