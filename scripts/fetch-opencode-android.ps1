param(
    [string]$ArchivePath = "",
    [string]$GraphRuntimePath = "",
    [string]$OpenTuiPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = "1.18.23"
$PortTag = "v0.2.1"
$PortCommit = "f63664eaa774b7fb8ff9e043ad735b05ecb7024b"
$OpenCodeCommit = "ef2880f379129aa048be9e9353e30aa168d42c17"
$OpenTuiVersion = "0.4.5"
$OpenTuiCommit = "0c8c4f7cff2927e3df63a9757a45eff9a343611c"
# The Android port archive is retained only as the pinned source for its
# generic Bionic tag-fix preload. OpenCode and OpenTUI are rebuilt from their
# exact upstream commits below.
$ArchiveName = "opencode-1.17.9-android-aarch64.zip"
$ArchiveUrl = "https://github.com/guysoft/opencode-termux/releases/download/$PortTag/$ArchiveName"
$ArchiveSha256 = "0c77d4b8f286e01ba08c9e9aeca8c73a0e0c655342044ab3a59cf1953093a9b0"
$TagfixSha256 = "7899ec6bfce01f0393611e5c9a9a00a83aff218eea55362881ebf0bee3aaacc1"
$GraphRuntimeSha256 = "6d06d366d5627e9f2de7057893f8e04f38fcd82009882479a06d45a6a9d6cfca"
$GraphRuntimeBytes = 173518689
$OpenTuiSha256 = "0b16d269a096ed8f362956c93257b369f68de3c8e846299926cbf51d912e2e4a"
$OpenTuiBytes = 14386712

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Destination = Join-Path $RepositoryRoot "android/app/src/main/jniLibs/arm64-v8a"
$ManifestPath = Join-Path $RepositoryRoot "android/app/src/main/assets/runtime/lib/adev-opencode.json"
$DefaultGraphRuntime = Join-Path $Destination "libbin_opencode_runtime.so"
$DefaultOpenTui = Join-Path $Destination "liblib_opencode_opentui.so"
$GraphRuntime = if ($GraphRuntimePath) {
    (Resolve-Path -LiteralPath $GraphRuntimePath).Path
} elseif (Test-Path -LiteralPath $DefaultGraphRuntime -PathType Leaf) {
    $DefaultGraphRuntime
} else {
    throw "The pinned ARM64 source-built graph payload is required. Supply -GraphRuntimePath."
}
$OpenTui = if ($OpenTuiPath) {
    (Resolve-Path -LiteralPath $OpenTuiPath).Path
} elseif (Test-Path -LiteralPath $DefaultOpenTui -PathType Leaf) {
    $DefaultOpenTui
} else {
    throw "The pinned ARM64 source-built OpenTUI library is required. Supply -OpenTuiPath."
}
$WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("adev-opencode-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null

function Get-LowerSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Assert-AndroidElf([string]$Path, [bool]$RequireInterpreter) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or
        $bytes[0] -ne 0x7f -or
        $bytes[1] -ne [byte][char]'E' -or
        $bytes[2] -ne [byte][char]'L' -or
        $bytes[3] -ne [byte][char]'F') {
        throw "$Path is not an ELF file."
    }
    $machine = [BitConverter]::ToUInt16($bytes, 18)
    if ($machine -ne 183) {
        throw "$Path is not an AArch64 ELF (e_machine=$machine)."
    }

    $sdkRoot = if ($env:ANDROID_SDK_ROOT) {
        $env:ANDROID_SDK_ROOT
    } elseif ($env:ANDROID_HOME) {
        $env:ANDROID_HOME
    } else {
        Join-Path $env:LOCALAPPDATA "Android/Sdk"
    }
    $readelf = Get-ChildItem `
        -Path (Join-Path $sdkRoot "ndk/29.0.14206865/toolchains/llvm/prebuilt") `
        -Filter "llvm-readelf.exe" `
        -Recurse `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $readelf) {
        throw "NDK r29 llvm-readelf is required to verify the OpenCode Android ELF."
    }

    $headers = (& $readelf -hlWd $Path) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "llvm-readelf failed for $Path."
    }
    if ($RequireInterpreter -and $headers -notmatch "Requesting program interpreter: /system/bin/linker64") {
        throw "$Path does not request Android's /system/bin/linker64."
    }
    if ($RequireInterpreter -and $headers -notmatch "FLAGS_1\).*\bPIE\b") {
        throw "$Path is not an Android PIE executable."
    }

    $loadAlignments = [regex]::Matches($headers, "(?m)^\s*LOAD\s+.*\s+(0x[0-9a-fA-F]+)\s*$") |
        ForEach-Object { [Convert]::ToInt64($_.Groups[1].Value.Substring(2), 16) }
    if (-not $loadAlignments -or ($loadAlignments | Measure-Object -Minimum).Minimum -lt 0x4000) {
        throw "$Path has a PT_LOAD alignment below Android's 16 KiB requirement."
    }
}

try {
    $Archive = Join-Path $WorkDirectory $ArchiveName
    if ($ArchivePath) {
        Copy-Item -LiteralPath (Resolve-Path $ArchivePath) -Destination $Archive
    } else {
        Invoke-WebRequest -Headers @{ "User-Agent" = "ADevStudio-runtime-builder" } `
            -Uri $ArchiveUrl `
            -OutFile $Archive
    }
    $actualArchiveHash = Get-LowerSha256 $Archive
    if ($actualArchiveHash -ne $ArchiveSha256) {
        throw "OpenCode archive SHA-256 mismatch: expected $ArchiveSha256, got $actualArchiveHash"
    }

    $Expanded = Join-Path $WorkDirectory "expanded"
    Expand-Archive -LiteralPath $Archive -DestinationPath $Expanded
    $Tagfix = Join-Path $Expanded "libtagfix.so"
    if (-not (Test-Path -LiteralPath $Tagfix -PathType Leaf)) {
        throw "Android port archive is missing libtagfix.so."
    }
    $actualTagfixHash = Get-LowerSha256 $Tagfix
    if ($actualTagfixHash -ne $TagfixSha256) {
        throw "libtagfix.so SHA-256 mismatch: expected $TagfixSha256, got $actualTagfixHash"
    }

    Assert-AndroidElf $Tagfix $false
    Assert-AndroidElf $GraphRuntime $true
    Assert-AndroidElf $OpenTui $false
    if ((Get-Item -LiteralPath $GraphRuntime).Length -ne $GraphRuntimeBytes) {
        throw "Source-built OpenCode graph payload size mismatch."
    }
    $actualGraphHash = Get-LowerSha256 $GraphRuntime
    if ($actualGraphHash -ne $GraphRuntimeSha256) {
        throw "Source-built OpenCode graph payload SHA-256 mismatch: expected $GraphRuntimeSha256, got $actualGraphHash"
    }
    if ((Get-Item -LiteralPath $OpenTui).Length -ne $OpenTuiBytes) {
        throw "Source-built OpenTUI payload size mismatch."
    }
    $actualOpenTuiHash = Get-LowerSha256 $OpenTui
    if ($actualOpenTuiHash -ne $OpenTuiSha256) {
        throw "Source-built OpenTUI SHA-256 mismatch: expected $OpenTuiSha256, got $actualOpenTuiHash"
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $runtimeDestination = Join-Path $Destination "libbin_opencode_runtime.so"
    if ([IO.Path]::GetFullPath($GraphRuntime) -ne [IO.Path]::GetFullPath($runtimeDestination)) {
        Copy-Item -Force -LiteralPath $GraphRuntime -Destination $runtimeDestination
    }
    $openTuiDestination = Join-Path $Destination "liblib_opencode_opentui.so"
    if ([IO.Path]::GetFullPath($OpenTui) -ne [IO.Path]::GetFullPath($openTuiDestination)) {
        Copy-Item -Force -LiteralPath $OpenTui -Destination $openTuiDestination
    }
    Copy-Item -Force -LiteralPath $Tagfix `
        -Destination (Join-Path $Destination "liblib_opencode_tagfix.so")

    $manifest = [ordered]@{
        schemaVersion = 1
        id = "opencode-android"
        version = $Version
        platform = "android-bionic"
        supportedAbis = @("arm64-v8a")
        unsupportedAbis = [ordered]@{
            x86_64 = "No verified Android/Bionic x86_64 OpenCode runtime is available."
        }
        delivery = "base-apk-native-library"
        source = [ordered]@{
            openCodeRepository = "https://github.com/anomalyco/opencode"
            openCodeCommit = $OpenCodeCommit
            androidPortRepository = "https://github.com/guysoft/opencode-termux"
            androidPortTag = $PortTag
            androidPortCommit = $PortCommit
            archiveUrl = $ArchiveUrl
            archiveSha256 = $ArchiveSha256
            archivePurpose = "pinned source for the generic Bionic libtagfix.so preload only"
            androidBunPrefixSha256 = "a209437cd7afe24f0c5654f097e9a3558cba9b67fd9d5d5b8cfdd3f3bd165bde"
            graphBuildBunVersion = "1.3.2"
            graphBuildBunArchiveSha256 = "5e73b4eba0cc09085df141e1167609b100570f1a0d538d87f9b9c0da54af58d6"
            modelsSnapshotSha256 = "d6a5ad68b1772eecb1fdc135f8c73995a2b0dfad29162fb84a3fa1d8320c7141"
            graphBuildTarget = "bun-linux-arm64"
            graphPatchFile = "scripts/patches/opencode-1.18.23-android.patch"
            graphRuntimeSha256 = $GraphRuntimeSha256
            graphRuntimeBytes = $GraphRuntimeBytes
            openTuiRepository = "https://github.com/anomalyco/opentui"
            openTuiVersion = $OpenTuiVersion
            openTuiCommit = $OpenTuiCommit
            openTuiPatchFile = "scripts/patches/opentui-0.4.5-android.patch"
            openTuiSha256 = $OpenTuiSha256
            openTuiBytes = $OpenTuiBytes
            androidGraphPatches = @(
                "use the launcher-provided app-private XDG cache for OpenCode temporary files",
                "skip background plugin dependency installation on Android",
                "embed the OpenCode TUI worker and route OpenTUI through the external Android/Bionic library via OPENTUI_LIB_PATH (setRenderLibPath)",
                "retain upstream spinner registration and degrade unknown non-critical OpenTUI components to a visible text fallback instead of terminating the TUI",
                "replace bundled glibc/musl OpenTUI entries with the matching external Android/Bionic OpenTUI 0.4.5 renderer",
                "pin OpenTUI's parser worker to its explicit bunfs entrypoint because grafted Android Bun file imports do not publish a default path",
                "resolve the sibling APK-native ripgrep before environment, PATH, cache, or any desktop download"
                "launch web URLs through the verified sibling APK-native Android URL broker helper using an owner-only app-private rotating capability file"
                "route the core Bash tool through ADEV's APK-native environment-restoring shell broker instead of Bun's sanitized /bin/sh child"
            )
            upstreamSignature = "not-published; exact SHA-256 and source commits are pinned"
        }
        runtime = [ordered]@{
            interpreter = "/system/bin/linker64"
            pie = $true
            minimumLoadAlignment = 16384
            requiresWritableExecutable = $false
            globalLinuxSpoof = $false
            fileWatcher = "disabled for the bundled host-only @parcel/watcher binding"
            tempPathPolicy = "source-built graph uses canonical app-private XDG cache temp; exact /tmp remap remains a scoped fallback"
            heapPointerTaggingPolicy = "API 29/30 child startup uses Bionic android_mallopt opcode 8; API 31+ falls back to public mallopt(-204, NONE)"
            preloadOrder = "upstream tagfix, ADEV Android-version heap-tag and /tmp compatibility shim, inherited termux-exec"
        }
        capabilities = [ordered]@{
            version = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            help = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            debugPaths = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            interactiveTui = "host ABI and 342-symbol OpenTUI contract verified; device validation pending"
            agentRun = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            serve = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            web = "host and ABI verified for the pinned ARM64 payload; device validation pending"
            policy = "all standard modes reach the Android/Bionic payload; no Linux/glibc binary is substituted"
        }
        components = @(
            [ordered]@{
                packagedName = "libbin_opencode_runtime.so"
                sourceName = "source-rebuilt OpenCode 1.18.23 ARM64 module graph plus pinned Android Bun prefix"
                sha256 = $GraphRuntimeSha256
                bytes = $GraphRuntimeBytes
                license = "MIT plus embedded dependency notices"
            },
            [ordered]@{
                packagedName = "liblib_opencode_opentui.so"
                sourceName = "source-rebuilt OpenTUI 0.4.5 Android/Bionic ARM64 libopentui.so"
                sha256 = $OpenTuiSha256
                bytes = $OpenTuiBytes
                license = "MIT"
            },
            [ordered]@{
                packagedName = "liblib_opencode_tagfix.so"
                sourceName = "libtagfix.so"
                sha256 = $TagfixSha256
                license = "MIT"
            }
        )
        deviceGate = "OpenCode 1.18.23 and OpenTUI 0.4.5 pass host provenance, ARM64 Bionic ABI, dependency, 16 KiB alignment, and 342-symbol contract checks. On-device mode validation is pending; API 29/API 36 and x86_64 payload coverage remain."
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ManifestPath) | Out-Null
    # UTF8 WITHOUT BOM: downstream JSON parsers (host tests) reject a BOM.
    $manifestJson = $manifest | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($ManifestPath, $manifestJson + "`n", (New-Object System.Text.UTF8Encoding($false)))

    Write-Host "OpenCode $Version Android/Bionic payload verified and staged in $Destination"
} finally {
    Remove-Item -LiteralPath $WorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
