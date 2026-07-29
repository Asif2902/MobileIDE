# Android release process

`version.json` is the single application/runtime version authority. A release
must pass `npm run release:check` before Gradle is allowed to create artifacts.

Production signing is external. Store the keystore outside this repository and
set these values only in the release runner's secret store:

- `ADEV_RELEASE_STORE_FILE`
- `ADEV_RELEASE_STORE_PASSWORD`
- `ADEV_RELEASE_KEY_ALIAS`
- `ADEV_RELEASE_KEY_PASSWORD`
- `ADEV_RELEASE_CERT_SHA256` (expected signer certificate digest)
- `BUNDLETOOL_JAR` (reviewed bundletool all-in-one JAR)

Build with JDK 17:

```sh
npm ci
npm run release:check
cd android
./gradlew --no-daemon clean assembleRelease bundleRelease
cd ..
node scripts/package-release-artifacts.mjs
```

The packaging command writes versioned files under ignored `release/out/`,
rejects Android debug certificates, validates the AAB with bundletool, checks
the APK with `apksigner`, and reruns the ABI, runtime-lock, dependency-closure,
API-36, 16 KiB alignment, license, secret, and size gates.

Never put a keystore, password, decoded CI secret, APK, AAB, or generated
release output in Git. Key rotation and Play App Signing operations require
release-owner approval and are intentionally outside the application runtime.
