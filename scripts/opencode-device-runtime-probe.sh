#!/system/bin/sh
set -eu

# Provider-independent regression gate for OpenCode's real Bun bash tool.
# RuntimeDiagnosticsInstrumentationTest supplies RuntimeManager's authoritative
# environment before this script starts. The commands inside `params` must use
# ordinary PATH resolution: no native .so paths or manual environment exports.
result=$("$MOBILEIDE_OPENCODE" debug agent build --tool bash --params '{"command":"echo SHELL=\"${SHELL-}\"; echo PATH=\"${PATH-}\"; echo LD_LIBRARY_PATH=\"${LD_LIBRARY_PATH-}\"; echo LD_PRELOAD=\"${LD_PRELOAD-}\"; echo PREFIX=\"${PREFIX-}\"; command -v node; command -v python; command -v npm; command -v npx; node -e '\''console.log(\"node ok\")'\''; python -c '\''print(\"python ok\")'\''; npm --version; npm root -g; npm prefix -g; npx --version; node \"$PREFIX/lib/adev-runtime-env-test.js\"; node \"$PREFIX/lib/adev-runtime-env-test.js\" --network","description":"Run actual OpenCode ADEV contract","timeout":240000}')
printf '%s\n' "$result"
printf '%s\n' "$result" | grep -q 'node ok'
printf '%s\n' "$result" | grep -q 'python ok'
printf '%s\n' "$result" | grep -q '22/22 runtime environment checks passed'
printf '%s\n' "$result" | grep -q '23/23 runtime environment checks passed'
