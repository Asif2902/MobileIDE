#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}"
PACKAGE="com.mobileide.app"
ACTIVITY="${PACKAGE}/.MainActivity"
APK="${ADEV_APK:-android/app/build/outputs/apk/debug/app-debug.apk}"
ADB=(adb)
if [[ -n "${ANDROID_SERIAL:-}" ]]; then
  ADB+=( -s "$ANDROID_SERIAL" )
fi

"${ADB[@]}" wait-for-device
api="$("${ADB[@]}" shell getprop ro.build.version.sdk | tr -d '\r')"
abi="$("${ADB[@]}" shell getprop ro.product.cpu.abi | tr -d '\r')"
pagesize="$("${ADB[@]}" shell getconf PAGESIZE | tr -d '\r')"
[[ "$api" =~ ^(29|34|35|36)$ ]] || {
  echo "Unsupported matrix API: $api" >&2
  exit 1
}
if [[ -n "${ADEV_EXPECTED_API:-}" && "$api" != "$ADEV_EXPECTED_API" ]]; then
  echo "Runner/device API mismatch: expected $ADEV_EXPECTED_API, detected $api" >&2
  exit 1
fi
if [[ "${ADEV_REQUIRE_16K:-0}" == "1" && "$pagesize" -lt 16384 ]]; then
  echo "Strict 16 KiB runner has page size $pagesize" >&2
  exit 1
fi

if [[ "$MODE" == "upgrade" ]]; then
  : "${ADEV_UPGRADE_BASE_APK:?ADEV_UPGRADE_BASE_APK is required for upgrade mode}"
  "${ADB[@]}" install -r "$ADEV_UPGRADE_BASE_APK"
  "${ADB[@]}" shell am start -W -n "$ACTIVITY" >/dev/null
elif [[ "$MODE" == "fresh" ]]; then
  "${ADB[@]}" uninstall "$PACKAGE" >/dev/null 2>&1 || true
fi
"${ADB[@]}" install -r "$APK"
"${ADB[@]}" shell am force-stop "$PACKAGE"
"${ADB[@]}" shell am start -W -n "$ACTIVITY" >/dev/null
"${ADB[@]}" shell pidof "$PACKAGE" >/dev/null

if [[ "$MODE" != "app-smoke" ]]; then
  [[ "$abi" == "arm64-v8a" ]] || {
    echo "Full developer runtime is an ARM64 signed capability; detected $abi" >&2
    exit 1
  }
  network=()
  [[ "${ADEV_NETWORK_TESTS:-0}" == "1" ]] && network=(--network)
  for _ in $(seq 1 30); do
    if "${ADB[@]}" shell run-as "$PACKAGE" test -f files/runtime/.runtime_version; then
      break
    fi
    sleep 1
  done
  "${ADB[@]}" shell run-as "$PACKAGE" test -f files/runtime/.runtime_version
  "${ADB[@]}" shell run-as "$PACKAGE" \
    files/runtime/bin/node files/runtime/lib/adev-phase5-test.js "${network[@]}"
fi

"${ADB[@]}" shell am force-stop "$PACKAGE"
if "${ADB[@]}" shell pidof "$PACKAGE" >/dev/null 2>&1; then
  echo "Application process remained after force-stop" >&2
  exit 1
fi
echo "Device matrix passed: mode=$MODE api=$api abi=$abi pageSize=$pagesize"
