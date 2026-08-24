param(
    [string]$ArchivePath = "",
    [string]$GraphRuntimePath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Version = "1.17.9"
$PortTag = "v0.2.1"
$PortCommit = "f63664eaa774b7fb8ff9e043ad735b05ecb7024b"
$OpenCodeCommit = "5c23e88419c4743b9be42cea132f2fb1e6cb63ff"
$ArchiveName = "opencode-$Version-android-aarch64.zip"
$ArchiveUrl = "https://github.com/guysoft/opencode-termux/releases/download/$PortTag/$ArchiveName"
$ArchiveSha256 = "0c77d4b8f286e01ba08c9e9aeca8c73a0e0c655342044ab3a59cf1953093a9b0"
$ComponentHashes = @{
    "opencode.bin" = "5609e288519cac6ad6dc0eddb4bd99fb77564e82d878e9a54915c565c75f0402"
    "libopentui.so" = "4f9c16e90496fa457321fb17a2bf64a0e67535077a7763d0feb836e95e9c0f44"
    "libtagfix.so" = "7899ec6bfce01f0393611e5c9a9a00a83aff218eea55362881ebf0bee3aaacc1"
}
$GraphRuntimeSha256 = "db2f90e9b044543c5983e2d0c3e3e20cf3a59c1f9206342ff3519a95e2a7b2c3"
$GraphRuntimeBytes = 206540686

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Destination = Join-Path $RepositoryRoot "android/app/src/main/jniLibs/arm64-v8a"
$ManifestPath = Join-Path $RepositoryRoot "android/app/src/main/assets/runtime/lib/adev-opencode.json"
$DefaultGraphRuntime = Join-Path $Destination "libbin_opencode_runtime.so"
$GraphRuntime = if ($GraphRuntimePath) {
    (Resolve-Path -LiteralPath $GraphRuntimePath).Path
} elseif (Test-Path -LiteralPath $DefaultGraphRuntime -PathType Leaf) {
    $DefaultGraphRuntime
} else {
    throw "The pinned ARM64 source-built graph payload is required. Supply -GraphRuntimePath."
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
    foreach ($entry in $ComponentHashes.GetEnumerator()) {
        $component = Join-Path $Expanded $entry.Key
        if (-not (Test-Path -LiteralPath $component -PathType Leaf)) {
            throw "OpenCode archive is missing $($entry.Key)."
        }
        $actual = Get-LowerSha256 $component
        if ($actual -ne $entry.Value) {
            throw "$($entry.Key) SHA-256 mismatch: expected $($entry.Value), got $actual"
        }
    }

    Assert-AndroidElf (Join-Path $Expanded "opencode.bin") $true
    Assert-AndroidElf (Join-Path $Expanded "libopentui.so") $false
    Assert-AndroidElf (Join-Path $Expanded "libtagfix.so") $false
    Assert-AndroidElf $GraphRuntime $true
    if ((Get-Item -LiteralPath $GraphRuntime).Length -ne $GraphRuntimeBytes) {
        throw "Source-built OpenCode graph payload size mismatch."
    }
    $actualGraphHash = Get-LowerSha256 $GraphRuntime
    if ($actualGraphHash -ne $GraphRuntimeSha256) {
        throw "Source-built OpenCode graph payload SHA-256 mismatch: expected $GraphRuntimeSha256, got $actualGraphHash"
    }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $runtimeDestination = Join-Path $Destination "libbin_opencode_runtime.so"
    if ([IO.Path]::GetFullPath($GraphRuntime) -ne [IO.Path]::GetFullPath($runtimeDestination)) {
        Copy-Item -Force -LiteralPath $GraphRuntime -Destination $runtimeDestination
    }
    Copy-Item -Force -LiteralPath (Join-Path $Expanded "libopentui.so") `
        -Destination (Join-Path $Destination "liblib_opencode_opentui.so")
    Copy-Item -Force -LiteralPath (Join-Path $Expanded "libtagfix.so") `
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
            androidBunPrefixSha256 = "a209437cd7afe24f0c5654f097e9a3558cba9b67fd9d5d5b8cfdd3f3bd165bde"
            graphBuildBunVersion = "1.3.2"
            graphBuildBunArchiveSha256 = "5e73b4eba0cc09085df141e1167609b100570f1a0d538d87f9b9c0da54af58d6"
            modelsSnapshotSha256 = "a524cf9fbd30c0086b57e4aff18ebe3bd81947d6132fb3e33546f5e6b1ee98b1"
            graphBuildTarget = "bun-linux-arm64"
            graphPatchFile = "scripts/patches/opencode-1.17.9-android.patch"
            graphRuntimeSha256 = $GraphRuntimeSha256
            graphRuntimeBytes = $GraphRuntimeBytes
            androidGraphPatches = @(
                "use the launcher-provided app-private XDG cache for OpenCode temporary files",
                "skip background plugin dependency installation on Android",
                "compile the module graph for ARM64 and route OpenTUI through OPENTUI_LIB_PATH",
                "resolve the sibling APK-native ripgrep before environment, PATH, cache, or desktop downloads"
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
            tempPathPolicy = "process-scoped /tmp remap to canonical app-private ADEV_OPENCODE_TMPDIR"
            preloadOrder = "upstream tagfix, ADEV /tmp compatibility shim, inherited termux-exec"
        }
        capabilities = [ordered]@{
            version = "enabled through the real pinned payload; device retest required after /tmp remap"
            help = "enabled through the real pinned payload; device retest required after /tmp remap"
            debugPaths = "enabled through the real pinned payload; device retest required after /tmp remap"
            interactiveTui = "enabled through the real pinned payload; device retest required after /tmp remap"
            agentRun = "enabled through the real pinned payload; device retest required after /tmp remap"
            serve = "enabled through the real pinned payload; device retest required after /tmp remap"
            web = "enabled through the real pinned payload; device retest required after /tmp remap"
            policy = "all standard modes reach the Android/Bionic payload; no Linux/glibc binary is substituted"
        }
        components = @(
            [ordered]@{
                packagedName = "libbin_opencode_runtime.so"
                sourceName = "source-rebuilt OpenCode 1.17.9 ARM64 module graph plus pinned Android Bun prefix"
                sha256 = $GraphRuntimeSha256
                bytes = $GraphRuntimeBytes
                license = "MIT plus embedded dependency notices"
            },
            [ordered]@{
                packagedName = "liblib_opencode_opentui.so"
                sourceName = "libopentui.so"
                sha256 = $ComponentHashes["libopentui.so"]
                license = "MIT"
            },
            [ordered]@{
                packagedName = "liblib_opencode_tagfix.so"
                sourceName = "libtagfix.so"
                sha256 = $ComponentHashes["libtagfix.so"]
                license = "MIT"
            }
        )
        deviceGate = "Pending ARM64 retest after the process-scoped /tmp remap, in order: version, help, debug paths, run help, run hello, serve, web, and TUI. API 29 and API 36 remain required."
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ManifestPath) | Out-Null
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -NoNewline $ManifestPath
    Add-Content -Encoding UTF8 -LiteralPath $ManifestPath -Value ""

    Write-Host "OpenCode $Version Android/Bionic payload verified and staged in $Destination"
} finally {
    Remove-Item -LiteralPath $WorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
