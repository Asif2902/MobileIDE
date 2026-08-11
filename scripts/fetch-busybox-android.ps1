param(
    [string]$ArchivePath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false

$Package = "busybox"
$Version = "1.38.0-1"
$ArchiveName = "busybox_1.38.0-1_aarch64.deb"
$ArchiveUrl = "https://packages.termux.dev/apt/termux-main/pool/main/b/busybox/$ArchiveName"
$ArchiveSha256 = "1bb7f1d4c00cadd0e1117b6dd7110311b8bf749ef00b486e96cfdc11c98f8fd9"
$ArchiveBytes = 471928
$ExecutableSha256 = "db7f2a847ab051086c71d1c8c367e71adf59a3c39c8323ff801126ff11c84058"
$LibrarySha256 = "b8153ac191754afcd6dd1896f961c7ecf3965cafd727a2690f648fdd9ba57cc1"
$ExecutableBytes = 4320
$LibraryBytes = 876576
$MinimumLoadAlignment = 0x4000

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$NativeDestination = Join-Path $RepositoryRoot "android/app/src/main/jniLibs/arm64-v8a"
$RuntimeAssets = Join-Path $RepositoryRoot "android/app/src/main/assets/runtime"
$NativeMapPath = Join-Path $RuntimeAssets "native-map.json"
$ManifestPath = Join-Path $RuntimeAssets "lib/adev-busybox.json"
$WorkDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("adev-busybox-" + [Guid]::NewGuid().ToString("N"))
$ExecutableDestination = Join-Path $NativeDestination "libbin_busybox.so"
$LibraryDestination = Join-Path $NativeDestination "liblib_libbusybox_so_1_38_0.so"
$SelinuxDestination = Join-Path $NativeDestination "liblib_libandroid_selinux_so.so"

function Get-LowerSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
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
        if ($matches) {
            return $true
        }
    }
    return $false
}

function Assert-AndroidElf64Aarch64(
    [string]$Path,
    [string[]]$RequiredStrings
) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or
        $bytes[0] -ne 0x7f -or
        $bytes[1] -ne [byte][char]'E' -or
        $bytes[2] -ne [byte][char]'L' -or
        $bytes[3] -ne [byte][char]'F') {
        throw "$Path is not an ELF file."
    }
    if ($bytes[4] -ne 2 -or $bytes[5] -ne 1) {
        throw "$Path is not a little-endian ELF64 file."
    }
    $machine = [BitConverter]::ToUInt16($bytes, 18)
    if ($machine -ne 183) {
        throw "$Path is not an AArch64 ELF (e_machine=$machine)."
    }

    $programHeaderOffset = [BitConverter]::ToUInt64($bytes, 0x20)
    $programHeaderSize = [BitConverter]::ToUInt16($bytes, 0x36)
    $programHeaderCount = [BitConverter]::ToUInt16($bytes, 0x38)
    $loadAlignments = @()
    for ($index = 0; $index -lt $programHeaderCount; $index++) {
        $header = [int]$programHeaderOffset + ($index * $programHeaderSize)
        if ($header + 56 -gt $bytes.Length) {
            throw "$Path has an invalid ELF program-header table."
        }
        $programType = [BitConverter]::ToUInt32($bytes, $header)
        if ($programType -eq 1) {
            $loadAlignments += [BitConverter]::ToUInt64($bytes, $header + 48)
        }
    }
    if ($loadAlignments.Count -eq 0 -or
        ($loadAlignments | Measure-Object -Minimum).Minimum -lt $MinimumLoadAlignment) {
        throw "$Path has a PT_LOAD alignment below 0x4000."
    }

    foreach ($required in $RequiredStrings) {
        if (-not (Test-ByteString $bytes $required)) {
            throw "$Path does not contain required Android dynamic metadata: $required"
        }
    }
}

function Assert-HashAndSize(
    [string]$Path,
    [string]$ExpectedHash,
    [long]$ExpectedBytes
) {
    $actualHash = Get-LowerSha256 $Path
    if ($actualHash -ne $ExpectedHash) {
        throw "SHA-256 mismatch for $Path`: expected $ExpectedHash, got $actualHash"
    }
    $actualBytes = (Get-Item -LiteralPath $Path).Length
    if ($actualBytes -ne $ExpectedBytes) {
        throw "Size mismatch for $Path`: expected $ExpectedBytes bytes, got $actualBytes"
    }
}

New-Item -ItemType Directory -Path $WorkDirectory | Out-Null

try {
    $archive = Join-Path $WorkDirectory $ArchiveName
    if ($ArchivePath) {
        $resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
        Copy-Item -LiteralPath $resolvedArchive -Destination $archive
    } else {
        Invoke-WebRequest -UseBasicParsing `
            -Headers @{ "User-Agent" = "ADevStudio-runtime-builder" } `
            -Uri $ArchiveUrl `
            -OutFile $archive
    }
    Assert-HashAndSize $archive $ArchiveSha256 $ArchiveBytes

    $tar = Get-Command tar.exe -ErrorAction Stop
    $expanded = Join-Path $WorkDirectory "expanded"
    $dataRoot = Join-Path $WorkDirectory "data"
    New-Item -ItemType Directory -Path $expanded,$dataRoot | Out-Null
    & $tar.Source -xf $archive -C $expanded
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed to extract the pinned Termux Debian archive."
    }
    $dataArchive = Join-Path $expanded "data.tar.xz"
    if (-not (Test-Path -LiteralPath $dataArchive -PathType Leaf)) {
        throw "The pinned Termux package is missing data.tar.xz."
    }
    & $tar.Source -xf $dataArchive -C $dataRoot `
        "./data/data/com.termux/files/usr/bin/busybox" `
        "./data/data/com.termux/files/usr/lib/libbusybox.so.1.38.0"
    if ($LASTEXITCODE -ne 0) {
        throw "tar failed to extract the Termux BusyBox payload."
    }

    $termuxPrefix = Join-Path $dataRoot "data/data/com.termux/files/usr"
    $executable = Join-Path $termuxPrefix "bin/busybox"
    $library = Join-Path $termuxPrefix "lib/libbusybox.so.1.38.0"
    Assert-HashAndSize $executable $ExecutableSha256 $ExecutableBytes
    Assert-HashAndSize $library $LibrarySha256 $LibraryBytes
    Assert-AndroidElf64Aarch64 $executable @(
        "/system/bin/linker64",
        "libbusybox.so.1.38.0",
        "libc.so"
    )
    Assert-AndroidElf64Aarch64 $library @(
        "libbusybox.so.1.38.0",
        "libandroid-selinux.so",
        "libm.so",
        "libc.so"
    )

    $nativeMap = Get-Content -Raw -LiteralPath $NativeMapPath | ConvertFrom-Json
    if ($nativeMap.'bin/busybox' -ne "libbin_busybox.so" -or
        $nativeMap.'lib/libbusybox.so.1.38.0' -ne "liblib_libbusybox_so_1_38_0.so" -or
        $nativeMap.'lib/libandroid-selinux.so' -ne "liblib_libandroid_selinux_so.so") {
        throw "native-map.json does not provide the verified BusyBox dynamic closure."
    }
    if (-not (Test-Path -LiteralPath $SelinuxDestination -PathType Leaf)) {
        throw "BusyBox closure is incomplete: libandroid-selinux.so is not staged."
    }

    New-Item -ItemType Directory -Force -Path $NativeDestination | Out-Null
    Copy-Item -Force -LiteralPath $executable -Destination $ExecutableDestination
    Copy-Item -Force -LiteralPath $library -Destination $LibraryDestination
    Assert-HashAndSize $ExecutableDestination $ExecutableSha256 $ExecutableBytes
    Assert-HashAndSize $LibraryDestination $LibrarySha256 $LibraryBytes

    $manifest = [ordered]@{
        schemaVersion = 1
        id = "termux-busybox-android"
        package = $Package
        version = $Version
        platform = "android-bionic"
        supportedAbis = @("arm64-v8a")
        license = "GPL-2.0-only"
        source = [ordered]@{
            packageIndex = "https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages"
            archiveUrl = $ArchiveUrl
            archiveSha256 = $ArchiveSha256
            upstreamRepository = "https://git.busybox.net/busybox/"
        }
        runtime = [ordered]@{
            interpreter = "/system/bin/linker64"
            pie = $true
            minimumLoadAlignment = $MinimumLoadAlignment
            executableNeeded = @("libbusybox.so.1.38.0", "libc.so")
            librarySoname = "libbusybox.so.1.38.0"
            libraryNeeded = @("libandroid-selinux.so", "libm.so", "libc.so")
            closurePolicy = "LD_LIBRARY_PATH resolves native-map SONAMEs; libc.so and libm.so are Android system libraries"
        }
        components = @(
            [ordered]@{
                packagedName = "libbin_busybox.so"
                sourcePath = "data/data/com.termux/files/usr/bin/busybox"
                runtimePaths = @("bin/busybox")
                bytes = $ExecutableBytes
                sha256 = $ExecutableSha256
                role = "ELF64 AArch64 PIE executable"
            },
            [ordered]@{
                packagedName = "liblib_libbusybox_so_1_38_0.so"
                sourcePath = "data/data/com.termux/files/usr/lib/libbusybox.so.1.38.0"
                runtimePaths = @("lib/libbusybox.so.1.38.0")
                bytes = $LibraryBytes
                sha256 = $LibrarySha256
                role = "ELF64 AArch64 shared library"
            }
        )
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ManifestPath) | Out-Null
    $manifestJson = ($manifest | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText(
        $ManifestPath,
        $manifestJson + "`n",
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host "BusyBox $Version Android/Bionic payload verified and staged in $NativeDestination"
    Write-Host "  executable SHA-256: $ExecutableSha256"
    Write-Host "  shared library SHA-256: $LibrarySha256"
} finally {
    $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedWorkDirectory = [System.IO.Path]::GetFullPath($WorkDirectory)
    if ($resolvedWorkDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedWorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
