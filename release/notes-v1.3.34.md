# A Dev Studio 1.3.34 — Linux CLI compatibility beta

This phone-test beta adds an optional, independently downloadable Linux ARM64 execution runtime without replacing ADEV's Android/Bionic developer environment.

## Highlights

- Install the optional pack with `adev runtime install linux`; manage it with `update`, `remove`, `list`, and `doctor`.
- Detect ARM64 ELF type, interpreter, static/dynamic linking, Android/Bionic, glibc, and musl before selecting a backend.
- Restore only validated, declared Linux ARM64 optional payloads for CLI-owning npm packages while keeping ordinary Android native addons on the Bionic path.
- Publish guest DNS, hosts, NSS, and CA configuration and verify execution, DNS, TCP, and TLS through `adev runtime doctor`.
- Prevent Android seccomp from killing safe same-identity UID/GID calls in QEMU; privilege changes still fail with `EPERM`, and unsupported guest syscalls return Linux errors such as `ENOSYS`.
- Keep Node, npm, Python, Git, Next.js, Vite, OpenCode, terminal sessions, and background/agent tasks on the existing shared ADEV launcher and environment contract.

## Device evidence

On the connected ARM64/API-30 phone:

- Muse starts normally and remains alive in a real PTY.
- `codex login --device-auth` reaches the OpenAI device flow.
- `grok login` reaches xAI OAuth.
- `codex --version`, `grok --version`, and `muse --version` exit successfully.
- The Linux runtime doctor passes real execution, DNS, TCP 443, and TLS 1.3 CA/hostname verification.

## Install

1. Download and install `ADevStudio-v1.3.34-arm64-x86_64-phone-test.apk`.
2. Open the terminal and allow the first runtime initialization to finish.
3. For Linux ARM64 CLIs, run:

```sh
adev runtime install linux
adev runtime doctor
```

## Boundaries

- The Linux pack is ARM64-only and remains separate from the 356 MiB APK.
- This is user-mode syscall translation, not a root container or complete Linux kernel. Privileged namespaces, mounts, kernel modules, device access, and some uncommon syscalls remain unavailable.
- The APK is debug-test signed for direct phone testing. A production-signed release still requires the owner's external Ed25519 runtime-lock signing key; no replacement key or signature bypass is included.
- The current npm production audit also reports an upstream, presently unpatched React Navigation `decode-uri-component` denial-of-service advisory. The audit policy remains fail-closed instead of silently accepting it.

APK SHA-256 is published with the release asset.
