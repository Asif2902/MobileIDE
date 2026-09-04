# A Dev Studio 1.3.35 — Agent Execution and Terminal Protocol Fixes

This phone-test beta fixes the remaining split between Linux ARM64 agent processes and ADEV's Android command launcher, and repairs terminal OSC response routing after interactive TUIs.

## Highlights

- Linux guest tools now re-enter ADEV through the real APK-native launcher when they spawn npm, Python, Git, shell scripts, or Node child processes.
- QEMU no longer leaks its virtual `/proc/self/exe` identity into nested ADEV commands.
- Genuine Android seccomp failures are diagnosed with their host syscall number and converted to a Linux-compatible `ENOSYS` result where supported instead of silently terminating with `Bad system call`.
- `adev runtime doctor --json` includes observed host-seccomp syscall diagnostics.
- OSC palette and other terminal-generated responses are sent as byte-exact `ESC/OSC/ST` frames to the requesting PTY, never through the keyboard input stream.
- Active terminal output is delivered immediately for protocol correctness; background terminals retain lightweight batching.

## Validation

- Jest: 17 suites and 93 tests passed.
- TypeScript and ESLint passed (three pre-existing warnings, no errors).
- Android execution, agent environment, runtime environment, runtime policy, and Linux-runtime host suites passed.
- ARM64 and x86_64 native builds passed.
- Phone-test APK and Android-test APK builds passed.
- The connected-device instrumentation gate was not run because no ADB device was available during packaging.

## Install

1. Download `ADevStudio-v1.3.35-arm64-x86_64-phone-test.apk`.
2. Install it over the previous phone-test build.
3. Open Terminal and allow the one-time runtime upgrade to finish.
4. If you use Linux ARM64 CLI tools, verify the optional runtime with:

```sh
adev runtime update linux
adev runtime doctor
```

## Boundaries

- The optional Linux pack remains ARM64-only and separate from the APK.
- ADEV's Linux-user backend is syscall translation, not a root container or full Linux kernel. Privileged kernel features remain unavailable.
- This APK is debug-test signed for direct device testing. Production Play signing and the externally signed runtime-lock update remain credential-controlled release gates.

APK SHA-256 is published as a separate release asset.
