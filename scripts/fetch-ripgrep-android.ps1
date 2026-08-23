param(
    [string]$ArchivePath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false

# Pinned Android/Bionic package from the official Termux stable repository.
# OpenCode's desktop fallback downloads GNU/musl archives and cannot be used on
# Android. Keep rg in the APK native-library directory so Android 10+ may exec it.
$Package = "ripgrep"
$Version = "15.2.0"
$ArchiveName = "ripgrep_15.2.0_aarch64.deb"
$ArchiveUrl = "https://packages.termux.dev/apt/termux-main/pool/main/r/ripgrep/$ArchiveName"
$ArchiveSha256 = "38e28bc297000517b24702568a483eca7dc3323eb6bdccc9033f031776bdcc6c"
$ArchiveBytes = 1216572
$ExecutableSha256 = "5adfd20e4c350aecd718bbef048a57a3fbabe0402c9c39a25eb40a28f1b19543"
$ExecutableBytes = 4868920
$Pcre2Sha256 = "a6bbeb410e269e50aee795b4fd1b11cbddb8b54959d1cfcd927b55b04dc19f5c"
$CopyrightSha256 = "01c266bced4a434da0051174d6bee16a4c82cf634e2679b6155d40d75012390f"
$CopyrightBytes = 126
$LicenseSha256 = "0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f"
$LicenseBytes = 1081
$MinimumLoadAlignment = 0x4000

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$NativeDestination = Join-Path $RepositoryRoot "android/app/src/main/jniLibs/arm64-v8a"
$RuntimeAssets = Join-Path $RepositoryRoot "android/app/src/main/assets/runtime"
$NativeMapPath = Join-Path $RuntimeAssets "native-map.json"
$ManifestPath = Join-Path $RuntimeAssets "lib/adev-ripgrep.json"
$ExecutableDestination = Join-Path $NativeDestination "libbin_rg.so"
$Pcre2Destination = Join-Path $NativeDestination "liblib_libpcre2_8_so.so"
$LicenseDestination = Join-Path $RuntimeAssets "share/licenses/ripgrep"
$WorkDirectory = Join-Path ([IO.Path]::GetTempPath()) ("adev-ripgrep-" + [Guid]::NewGuid().ToString("N"))

function Get-LowerSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Write-Utf8Json([string]$Path, [object]$Value) {
    $json = ($Value | ConvertTo-Json -Depth 12) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}

function Test-ByteString([byte[]]$Bytes, [string]$Value) {
    $needle = [Text.Encoding]::ASCII.GetBytes($Value)
    for ($offset = 0; $offset -le $Bytes.Length - $needle.Length; $offset++) {
        $matches = $true
        for ($index = 0; $index -lt $needle.Length; $index++) {
            if ($Bytes[$offset + $index] -ne $needle[$index]) {
                $matches = $false
                break
            }
        }
        if ($matches) { return $true }
    }
    return $false
}

function Assert-HashAndSize([string]$Path, [string]$ExpectedHash, [long]$ExpectedBytes) {
    $actualHash = Get-LowerSha256 $Path
    if ($actualHash -ne $ExpectedHash) {
        throw "SHA-256 mismatch for $Path`: expected $ExpectedHash, got $actualHash"
    }
    $actualBytes = (Get-Item -LiteralPath $Path).Length
    if ($actualBytes -ne $ExpectedBytes) {
        throw "Size mismatch for $Path`: expected $ExpectedBytes bytes, got $actualBytes"
    }
}

function Assert-AndroidElf64Aarch64([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or
        $bytes[0] -ne 0x7f -or
        $bytes[1] -ne [byte][char]'E' -or
        $bytes[2] -ne [byte][char]'L' -or
        $bytes[3] -ne [byte][char]'F' -or
        $bytes[4] -ne 2 -or
        $bytes[5] -ne 1 -or
        [BitConverter]::ToUInt16($bytes, 18) -ne 183) {
        throw "$Path is not a little-endian ELF64 AArch64 executable."
    }

    $programHeaderOffset = [BitConverter]::ToUInt64($bytes, 0x20)
    $programHeaderSize = [BitConverter]::ToUInt16($bytes, 0x36)
    $programHeaderCount = [BitConverter]::ToUInt16($bytes, 0x38)
    $loadAlignments = @()
    for ($index = 0; $index -lt $programHeaderCount; $index++) {
        $header = [int]$programHeaderOffset + ($index * $programHeaderSize)
        if ($header + 56 -gt $bytes.Length) { throw "$Path has an invalid program-header table." }
        if ([BitConverter]::ToUInt32($bytes, $header) -eq 1) {
            $loadAlignments += [BitConverter]::ToUInt64($bytes, $header + 48)
        }
    }
    if ($loadAlignments.Count -eq 0 -or
        ($loadAlignments | Measure-Object -Minimum).Minimum -lt $MinimumLoadAlignment) {
        throw "$Path has a PT_LOAD alignment below 0x4000."
    }

    foreach ($required in @("/system/bin/linker64", "libpcre2-8.so", "libdl.so", "libc.so")) {
        if (-not (Test-ByteString $bytes $required)) {
            throw "$Path does not contain required Android dynamic metadata: $required"
        }
    }
}

New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
try {
    $archive = Join-Path $WorkDirectory $ArchiveName
    if ($ArchivePath) {
        Copy-Item -LiteralPath (Resolve-Path -LiteralPath $ArchivePath).Path -Destination $archive
    } else {
        Invoke-WebRequest -UseBasicParsing `
            -Headers @{ "User-Agent" = "ADevStudio-runtime-builder" } `
            -Uri $ArchiveUrl `
            -OutFile $archive
    }
    Assert-HashAndSize $archive $ArchiveSha256 $ArchiveBytes

    $tar = Get-Command tar.exe -ErrorAction Stop
    $debRoot = Join-Path $WorkDirectory "deb"
    $dataRoot = Join-Path $WorkDirectory "data"
    New-Item -ItemType Directory -Path $debRoot,$dataRoot | Out-Null
    & $tar.Source -xf $archive -C $debRoot
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the pinned Termux archive." }
    $dataArchive = Join-Path $debRoot "data.tar.xz"
    if (-not (Test-Path -LiteralPath $dataArchive -PathType Leaf)) {
        throw "The pinned Termux package is missing data.tar.xz."
    }
    & $tar.Source -xf $dataArchive -C $dataRoot `
        "./data/data/com.termux/files/usr/bin/rg" `
        "./data/data/com.termux/files/usr/share/doc/ripgrep/copyright" `
        "./data/data/com.termux/files/usr/share/doc/ripgrep/copyright.1"
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the ripgrep payload." }

    $executable = Join-Path $dataRoot "data/data/com.termux/files/usr/bin/rg"
    $copyright = Join-Path $dataRoot "data/data/com.termux/files/usr/share/doc/ripgrep/copyright"
    $license = Join-Path $dataRoot "data/data/com.termux/files/usr/share/doc/ripgrep/copyright.1"
    Assert-HashAndSize $executable $ExecutableSha256 $ExecutableBytes
    Assert-HashAndSize $copyright $CopyrightSha256 $CopyrightBytes
    Assert-HashAndSize $license $LicenseSha256 $LicenseBytes
    Assert-AndroidElf64Aarch64 $executable
    if (-not (Test-Path -LiteralPath $Pcre2Destination -PathType Leaf) -or
        (Get-LowerSha256 $Pcre2Destination) -ne $Pcre2Sha256) {
        throw "The pinned libpcre2-8.so Android/Bionic dependency is absent or has changed."
    }

    $nativeMap = Get-Content -Raw -LiteralPath $NativeMapPath | ConvertFrom-Json
    if ($nativeMap.'lib/libpcre2-8.so' -ne "liblib_libpcre2_8_so.so") {
        throw "native-map.json does not provide ripgrep's verified PCRE2 closure."
    }
    $mapEntries = [ordered]@{}
    foreach ($property in ($nativeMap.PSObject.Properties | Sort-Object Name)) {
        $mapEntries[$property.Name] = $property.Value
    }
    $mapEntries["bin/rg"] = "libbin_rg.so"
    $sortedMap = [ordered]@{}
    foreach ($key in ($mapEntries.Keys | Sort-Object)) {
        $sortedMap[$key] = $mapEntries[$key]
    }
    Write-Utf8Json $NativeMapPath $sortedMap

    New-Item -ItemType Directory -Force -Path $NativeDestination | Out-Null
    Copy-Item -Force -LiteralPath $executable -Destination $ExecutableDestination
    New-Item -ItemType Directory -Force -Path $LicenseDestination | Out-Null
    Copy-Item -Force -LiteralPath $copyright -Destination (Join-Path $LicenseDestination "copyright")
    Copy-Item -Force -LiteralPath $license -Destination (Join-Path $LicenseDestination "LICENSE-MIT")
    Assert-HashAndSize $ExecutableDestination $ExecutableSha256 $ExecutableBytes

    $manifest = [ordered]@{
        schemaVersion = 1
        id = "termux-ripgrep-android"
        package = $Package
        version = $Version
        platform = "android-bionic"
        supportedAbis = @("arm64-v8a")
        unsupportedAbis = [ordered]@{
            x86_64 = "The signed x86_64 developer-runtime feature pack does not yet include ripgrep."
        }
        license = "MIT"
        source = [ordered]@{
            packageIndex = "https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages"
            archiveUrl = $ArchiveUrl
            archiveSha256 = $ArchiveSha256
            upstreamRepository = "https://github.com/BurntSushi/ripgrep"
            termuxBuildRecipe = "https://github.com/termux/termux-packages/blob/master/packages/ripgrep/build.sh"
        }
        runtime = [ordered]@{
            interpreter = "/system/bin/linker64"
            minimumLoadAlignment = $MinimumLoadAlignment
            needed = @("libpcre2-8.so", "libdl.so", "libc.so")
            closurePolicy = "LD_LIBRARY_PATH resolves the pinned libpcre2-8.so from native-map; libdl.so and libc.so are Android/Bionic system libraries."
            openCodePolicy = "The Android graph validates launcher-provided ADEV_OPENCODE_RG before PATH, cache, or any desktop download fallback."
        }
        dependencies = @(
            [ordered]@{
                package = "pcre2"
                version = "10.47"
                license = "BSD-3-Clause WITH PCRE2-exception"
                packagedName = "liblib_libpcre2_8_so.so"
                sha256 = $Pcre2Sha256
            }
        )
        components = @(
            [ordered]@{
                packagedName = "libbin_rg.so"
                sourcePath = "data/data/com.termux/files/usr/bin/rg"
                runtimePaths = @("bin/rg")
                bytes = $ExecutableBytes
                sha256 = $ExecutableSha256
                license = "MIT"
                role = "ELF64 AArch64 PIE executable"
            },
            [ordered]@{
                runtimePath = "share/licenses/ripgrep/copyright"
                bytes = $CopyrightBytes
                sha256 = $CopyrightSha256
                license = "Unlicense OR MIT"
                role = "Upstream dual-license notice"
            },
            [ordered]@{
                runtimePath = "share/licenses/ripgrep/LICENSE-MIT"
                bytes = $LicenseBytes
                sha256 = $LicenseSha256
                license = "MIT"
                role = "Upstream MIT license text"
            }
        )
    }
    $json = ($manifest | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($ManifestPath, $json + "`n", [Text.UTF8Encoding]::new($false))

    Write-Host "ripgrep $Version Android/Bionic payload verified and staged"
    Write-Host "  executable SHA-256: $ExecutableSha256"
} finally {
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $resolvedWorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
    if ($resolvedWorkDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedWorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
