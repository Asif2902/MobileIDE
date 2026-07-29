# A Dev Studio 1.3.4

This release completes the Android compatibility program across the execution,
development-server, ecosystem, platform, and release-gating layers.

Highlights:

- Android-native Node.js, npm, `node-gyp`, Python, Clang, Make, Bash, Git, and
  curl execution without project-specific permission repair.
- Managed Node, Express, Vite, and Next.js development tasks with verified
  preview ports, process-tree cleanup, and Android-aware Next.js Webpack/WASM
  selection.
- Keystore-backed Git credentials, strict SSH handling, offline pnpm/Yarn
  payloads, signed optional-tool capability records, and an explicit Bun
  boundary.
- React Native 0.86.2, API 36, NDK r29, ARM64/x86_64 application packaging,
  signed runtime inventories, and 16 KiB ELF/ZIP release checks.
- Fail-closed external production signing, pinned JDK 17, isolated test/lint
  execution, dependency policy, device/ABI CI matrices, and release artifact
  verification.

Known capability boundaries:

- The full developer runtime is bundled for ARM64. x86_64 application/native
  helpers are present, while the full x86_64 compiler/runtime remains a signed
  feature-pack requirement.
- Bun does not publish Android/Bionic builds; the app reports that boundary and
  recommends Node/npm.
- Shared storage cannot reliably provide Unix executable modes, symlinks, or
  case sensitivity. Native builds use a guided private-workspace import.
