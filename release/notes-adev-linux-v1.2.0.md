# ADEV optional Linux runtime 1.2.0 (ARM64)

This independent pack enables verified Linux ARM64 static and musl CLI execution through ADEV's Android-native launcher. It does not replace Bionic and is not bundled into the APK.

- QEMU user backend: 11.0.3
- Guest libc: musl 1.2.5-r23
- BusyBox: 1.37.0-r30
- OpenSSL: 3.5.8-r0 with CA and hostname verification
- Archive size: 11,608,197 bytes
- Installed payload: 25,370,844 bytes
- SHA-256: `072e91c00c4794bb8cc3cdf3d8109415bf665980ffd710f12ee463eceb45dc49`

Install from ADEV Studio 1.3.34 or newer:

```sh
adev runtime install linux
adev runtime doctor
```

The installer verifies architecture, Android API, archive size, checksum, safe paths, the full inventory, QEMU version, musl loader, and a real static ARM64 execution probe before activation.
