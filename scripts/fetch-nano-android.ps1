param(
    [string]$NanoArchivePath = "",
    [string]$NcursesArchivePath = "",
    [string]$InReleasePath = "",
    [string]$PackagesGzipPath = "",
    [string]$TermuxKeyringPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false

# These package records were read from the official, clearsigned Termux stable
# aarch64 index dated 2026-08-09. The script re-verifies that index signature
# before it accepts either archive; local archive parameters are only a cache.
$NanoVersion = "9.2"
$NanoArchiveName = "nano_9.2_aarch64.deb"
$NanoArchiveRelativePath = "pool/main/n/nano/$NanoArchiveName"
$NanoArchiveSha256 = "59de33ebd2774625d8d8fd7855307a2d9e0bfdea45b9f5b1e95e78d8a5801fb4"
$NanoArchiveBytes = 240716
$NanoExecutableSha256 = "ee689aa27847d10a91a596e90590070c046b4f829f875a4e4ec71a25f8ad7682"
$NanoExecutableBytes = 432008
$NanoNanorcSha256 = "bbdb6ef791eb8648576d48276b2e8862cdbf5534af6fb580a06d794a6d65bb9e"
$NanoNanorcBytes = 61
$NanoSyntaxCount = 44
$NanoSyntaxBytes = 55036
$NanoSyntaxTreeSha256 = "9ef9463f09be6a7868179f3f4f352374c51dcfa35ea7720f1d637afe65583370"

$NcursesVersion = "6.6.20260307+really6.5.20250830"
$NcursesArchiveName = "ncurses_6.6.20260307+really6.5.20250830_aarch64.deb"
$NcursesArchiveRelativePath = "pool/main/n/ncurses/$NcursesArchiveName"
$NcursesArchiveSha256 = "f44bbfdc3d42ec0217bffa978309390e59cea5a48a9a83226d4a496c42ad0b99"
$NcursesArchiveBytes = 557792
$NcursesLibrarySha256 = "795f855f5a988d9e89116847b2c9aa03720cedbc02026259ca735be25398c4c5"
$NcursesLibraryBytes = 384496
$TerminfoCount = 40
$TerminfoBytes = 105154
$TerminfoTreeSha256 = "2f91f3649f9d2a1bb73b32b976d256268b2c55eb085c49d39ffb6ec27a4c317f"
$Xterm256Sha256 = "d99d67da666c615e66948bf5998e2f0b90db569dc4a3fed13cabd7dfd5a91aa9"
$Xterm256Bytes = 4074
$NcursesLicenseSha256 = "708999f95527e1ffa670c6fce288c6c600cb477dd04afcc1171422b3dd4ee226"
$NcursesLicenseBytes = 1447

$AndroidSupportVersion = "29-1"
$AndroidSupportArchiveSha256 = "f2f145d6135ad4843ac9670153be3e3944dc1e6f1736d46d2306c28f2b86f517"
$AndroidSupportLibrarySha256 = "739cf829511d71dafd6c67fdbb70f3f0c6048642ea2e1967790ee961fde14430"
$AndroidSupportLibraryBytes = 20736

$RepositoryBase = "https://packages.termux.dev/apt/termux-main"
$InReleaseUrl = "$RepositoryBase/dists/stable/InRelease"
$PackagesGzipUrl = "$RepositoryBase/dists/stable/main/binary-aarch64/Packages.gz"
$TermuxKeyringUrl = "https://raw.githubusercontent.com/termux/termux-packages/master/packages/termux-keyring/termux-autobuilds.gpg"
$TermuxKeyringSha256 = "21c385d5a30107453bd60582d64e2f6e5f5ce11e340ac05e57f943f9c0235420"
$TermuxSigningFingerprint = "CC72CF8BA7DBFA0182877D045A897D96E57CF20C"
$MinimumLoadAlignment = 0x4000

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$RuntimeAssets = Join-Path $RepositoryRoot "android/app/src/main/assets/runtime"
$NativeDestination = Join-Path $RepositoryRoot "android/app/src/main/jniLibs/arm64-v8a"
$NativeMapPath = Join-Path $RuntimeAssets "native-map.json"
$ManifestPath = Join-Path $RuntimeAssets "lib/adev-nano.json"
$NanoDestination = Join-Path $NativeDestination "libbin_nano.so"
$NcursesDestination = Join-Path $NativeDestination "liblib_libncursesw_so_6.so"
$AndroidSupportDestination = Join-Path $NativeDestination "liblib_libandroid_support_so.so"
$SyntaxDestination = Join-Path $RuntimeAssets "share/nano"
$TerminfoDestination = Join-Path $RuntimeAssets "share/terminfo"
$NanorcDestination = Join-Path $RuntimeAssets "etc/nanorc.termux"
$LicenseDestination = Join-Path $RuntimeAssets "share/licenses/nano/COPYING"
$NcursesLicenseDestination = Join-Path $RuntimeAssets "share/licenses/ncurses/COPYRIGHT"
$WorkDirectory = Join-Path ([IO.Path]::GetTempPath()) ("adev-nano-" + [Guid]::NewGuid().ToString("N"))

function Get-LowerSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
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

function Copy-Or-Download(
    [string]$InputPath,
    [string]$Url,
    [string]$Destination
) {
    if ($InputPath) {
        Copy-Item -LiteralPath (Resolve-Path -LiteralPath $InputPath).Path -Destination $Destination
    } else {
        Invoke-WebRequest -UseBasicParsing `
            -Headers @{ "User-Agent" = "ADevStudio-runtime-builder" } `
            -Uri $Url `
            -OutFile $Destination
    }
}

function Get-PackageFields(
    [string]$PackagesText,
    [string]$PackageName,
    [string]$Version
) {
    $match = [regex]::Split($PackagesText, "\r?\n\r?\n") |
        Where-Object {
            $_ -match "(?m)^Package: $([regex]::Escape($PackageName))$" -and
            $_ -match "(?m)^Version: $([regex]::Escape($Version))$"
        } |
        Select-Object -First 1
    if (-not $match) {
        throw "The verified Termux index does not contain $PackageName $Version for aarch64."
    }
    $fields = @{}
    foreach ($line in ($match -split "\r?\n")) {
        if ($line -match "^([^:]+):\s*(.*)$") {
            $fields[$Matches[1]] = $Matches[2]
        }
    }
    return $fields
}

function Assert-PackageFields(
    [hashtable]$Fields,
    [string]$PackageName,
    [string]$Version,
    [string]$Filename,
    [long]$Bytes,
    [string]$Sha256
) {
    $expected = @{
        "Package" = $PackageName
        "Version" = $Version
        "Architecture" = "aarch64"
        "Filename" = $Filename
        "Size" = $Bytes.ToString()
        "SHA256" = $Sha256
    }
    foreach ($entry in $expected.GetEnumerator()) {
        if ($Fields[$entry.Key] -ne $entry.Value) {
            throw "Signed index mismatch for $PackageName $($entry.Key): expected '$($entry.Value)', got '$($Fields[$entry.Key])'."
        }
    }
}

function Expand-GzipToText([string]$Path) {
    $input = [IO.File]::OpenRead($Path)
    try {
        $gzip = [IO.Compression.GZipStream]::new(
            $input,
            [IO.Compression.CompressionMode]::Decompress
        )
        try {
            $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
            try {
                return $reader.ReadToEnd()
            } finally {
                $reader.Dispose()
            }
        } finally {
            $gzip.Dispose()
        }
    } finally {
        $input.Dispose()
    }
}

function Get-NdkReadElf {
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
        throw "NDK r29 llvm-readelf is required to verify the Nano Android ELF closure."
    }
    return $readelf
}

function Assert-AndroidElf(
    [string]$ReadElf,
    [string]$Path,
    [bool]$RequireInterpreter,
    [string[]]$ExpectedNeeded
) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -lt 64 -or
        $bytes[0] -ne 0x7f -or
        $bytes[1] -ne [byte][char]'E' -or
        $bytes[2] -ne [byte][char]'L' -or
        $bytes[3] -ne [byte][char]'F' -or
        $bytes[4] -ne 2 -or
        $bytes[5] -ne 1 -or
        [BitConverter]::ToUInt16($bytes, 18) -ne 183) {
        throw "$Path is not a little-endian ELF64 AArch64 file."
    }

    $headers = (& $ReadElf -hlWd $Path) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "llvm-readelf failed for $Path."
    }
    if ($headers -notmatch "(?m)^\s*Type:\s+DYN\b") {
        throw "$Path is not an ET_DYN Android executable/shared library."
    }
    if ($RequireInterpreter -and
        $headers -notmatch "Requesting program interpreter: /system/bin/linker64") {
        throw "$Path does not request Android's /system/bin/linker64."
    }

    $loads = [regex]::Matches($headers, "(?m)^\s*LOAD\s+.*\s+(0x[0-9a-fA-F]+)\s*$")
    if ($loads.Count -eq 0) {
        throw "$Path has no PT_LOAD segments."
    }
    foreach ($load in $loads) {
        $alignment = [Convert]::ToInt64($load.Groups[1].Value.Substring(2), 16)
        if ($alignment -lt $MinimumLoadAlignment) {
            throw "$Path has a PT_LOAD alignment below 0x4000."
        }
    }

    $needed = [regex]::Matches($headers, "Shared library: \[([^\]]+)\]") |
        ForEach-Object { $_.Groups[1].Value }
    if (($needed -join "|") -ne ($ExpectedNeeded -join "|")) {
        throw "$Path NEEDED closure mismatch: expected $($ExpectedNeeded -join ', '), got $($needed -join ', ')."
    }
    if ($headers -match "ld-linux|GLIBC_") {
        throw "$Path contains a Linux/glibc loader or symbol dependency."
    }
}

function Get-TreeDigest([string]$Root) {
    $lines = [Collections.Generic.List[string]]::new()
    $bytes = [long]0
    $files = Get-ChildItem -LiteralPath $Root -Recurse -File |
        Sort-Object { [IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/') }
    foreach ($file in $files) {
        $relative = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $hash = Get-LowerSha256 $file.FullName
        $lines.Add("$relative`t$($file.Length)`t$hash`n")
        $bytes += $file.Length
    }
    $digestBytes = [Text.Encoding]::UTF8.GetBytes(($lines -join ""))
    $digest = [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($digestBytes)
    ).ToLowerInvariant()
    return [ordered]@{
        files = $files.Count
        bytes = $bytes
        treeSha256 = $digest
    }
}

function Assert-TreeDigest(
    [hashtable]$Digest,
    [int]$ExpectedFiles,
    [long]$ExpectedBytes,
    [string]$ExpectedHash,
    [string]$Label
) {
    if ($Digest.files -ne $ExpectedFiles -or
        $Digest.bytes -ne $ExpectedBytes -or
        $Digest.treeSha256 -ne $ExpectedHash) {
        throw "$Label tree mismatch: expected $ExpectedFiles files/$ExpectedBytes bytes/$ExpectedHash, got $($Digest.files) files/$($Digest.bytes) bytes/$($Digest.treeSha256)."
    }
}

function Write-Utf8Json([string]$Path, [object]$Value) {
    $json = ($Value | ConvertTo-Json -Depth 10) -replace "`r`n", "`n"
    [IO.File]::WriteAllText($Path, $json + "`n", [Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Path $WorkDirectory | Out-Null

try {
    $inRelease = Join-Path $WorkDirectory "InRelease"
    $packagesGzip = Join-Path $WorkDirectory "Packages.gz"
    $keyring = Join-Path $WorkDirectory "termux-autobuilds.gpg"
    Copy-Or-Download $InReleasePath $InReleaseUrl $inRelease
    Copy-Or-Download $PackagesGzipPath $PackagesGzipUrl $packagesGzip
    Copy-Or-Download $TermuxKeyringPath $TermuxKeyringUrl $keyring
    Assert-HashAndSize $keyring $TermuxKeyringSha256 2458

    $gpgv = Get-Command gpgv -ErrorAction Stop
    & $gpgv.Source --keyring $keyring $inRelease
    if ($LASTEXITCODE -ne 0) {
        throw "The official Termux InRelease signature could not be verified."
    }
    $gpg = Get-Command gpg -ErrorAction Stop
    $fingerprints = (& $gpg.Source --show-keys --with-colons $keyring) |
        Where-Object { $_ -like "fpr:*" } |
        ForEach-Object { ($_ -split ':')[9] }
    if ($TermuxSigningFingerprint -notin $fingerprints) {
        throw "The pinned Termux autobuild key fingerprint is absent from the verified keyring."
    }

    $packagesHash = Get-LowerSha256 $packagesGzip
    $packagesBytes = (Get-Item -LiteralPath $packagesGzip).Length
    $releaseText = Get-Content -Raw -LiteralPath $inRelease
    $packagesRecord = "(?m)^\s+$packagesHash\s+$packagesBytes\s+main/binary-aarch64/Packages\.gz\s*$"
    if ($releaseText -notmatch $packagesRecord) {
        throw "Packages.gz is not the aarch64 index named by the verified Termux InRelease manifest."
    }
    $packagesText = Expand-GzipToText $packagesGzip
    $nanoFields = Get-PackageFields $packagesText "nano" $NanoVersion
    $ncursesFields = Get-PackageFields $packagesText "ncurses" $NcursesVersion
    Assert-PackageFields $nanoFields "nano" $NanoVersion $NanoArchiveRelativePath $NanoArchiveBytes $NanoArchiveSha256
    Assert-PackageFields $ncursesFields "ncurses" $NcursesVersion $NcursesArchiveRelativePath $NcursesArchiveBytes $NcursesArchiveSha256

    $nanoArchive = Join-Path $WorkDirectory $NanoArchiveName
    $ncursesArchive = Join-Path $WorkDirectory $NcursesArchiveName
    Copy-Or-Download $NanoArchivePath "$RepositoryBase/$NanoArchiveRelativePath" $nanoArchive
    Copy-Or-Download $NcursesArchivePath "$RepositoryBase/$NcursesArchiveRelativePath" $ncursesArchive
    Assert-HashAndSize $nanoArchive $NanoArchiveSha256 $NanoArchiveBytes
    Assert-HashAndSize $ncursesArchive $NcursesArchiveSha256 $NcursesArchiveBytes

    $tar = Get-Command tar.exe -ErrorAction Stop
    $nanoDeb = Join-Path $WorkDirectory "nano-deb"
    $nanoRoot = Join-Path $WorkDirectory "nano-root"
    $ncursesDeb = Join-Path $WorkDirectory "ncurses-deb"
    $ncursesRoot = Join-Path $WorkDirectory "ncurses-root"
    New-Item -ItemType Directory -Path $nanoDeb,$nanoRoot,$ncursesDeb,$ncursesRoot | Out-Null
    & $tar.Source -xf $nanoArchive -C $nanoDeb
    if ($LASTEXITCODE -ne 0) { throw "tar failed to open the pinned Nano package." }
    & $tar.Source -xf (Join-Path $nanoDeb "data.tar.xz") -C $nanoRoot `
        "./data/data/com.termux/files/usr/bin/nano" `
        "./data/data/com.termux/files/usr/etc/nanorc" `
        "./data/data/com.termux/files/usr/share/nano"
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the Nano runtime payload." }
    & $tar.Source -xf $ncursesArchive -C $ncursesDeb
    if ($LASTEXITCODE -ne 0) { throw "tar failed to open the pinned ncurses package." }
    & $tar.Source -xf (Join-Path $ncursesDeb "data.tar.xz") -C $ncursesRoot `
        "./data/data/com.termux/files/usr/share/terminfo" `
        "./data/data/com.termux/files/usr/share/doc/ncurses/copyright"
    if ($LASTEXITCODE -ne 0) { throw "tar failed to extract the ncurses terminfo payload." }

    $nanoPrefix = Join-Path $nanoRoot "data/data/com.termux/files/usr"
    $ncursesPrefix = Join-Path $ncursesRoot "data/data/com.termux/files/usr"
    $nanoExecutable = Join-Path $nanoPrefix "bin/nano"
    $nanoNanorc = Join-Path $nanoPrefix "etc/nanorc"
    $nanoSyntax = Join-Path $nanoPrefix "share/nano"
    $terminfo = Join-Path $ncursesPrefix "share/terminfo"
    $ncursesLicense = Join-Path $ncursesPrefix "share/doc/ncurses/copyright"
    Assert-HashAndSize $nanoExecutable $NanoExecutableSha256 $NanoExecutableBytes
    Assert-HashAndSize $nanoNanorc $NanoNanorcSha256 $NanoNanorcBytes
    $syntaxDigest = Get-TreeDigest $nanoSyntax
    $terminfoDigest = Get-TreeDigest $terminfo
    Assert-TreeDigest $syntaxDigest $NanoSyntaxCount $NanoSyntaxBytes $NanoSyntaxTreeSha256 "Nano syntax"
    Assert-TreeDigest $terminfoDigest $TerminfoCount $TerminfoBytes $TerminfoTreeSha256 "ncurses terminfo"
    Assert-HashAndSize (Join-Path $terminfo "x/xterm-256color") $Xterm256Sha256 $Xterm256Bytes
    Assert-HashAndSize $ncursesLicense $NcursesLicenseSha256 $NcursesLicenseBytes

    $readelf = Get-NdkReadElf
    Assert-AndroidElf $readelf $nanoExecutable $true @(
        "libandroid-support.so",
        "libncursesw.so.6",
        "libc.so"
    )
    Assert-HashAndSize $AndroidSupportDestination $AndroidSupportLibrarySha256 $AndroidSupportLibraryBytes
    Assert-HashAndSize $NcursesDestination $NcursesLibrarySha256 $NcursesLibraryBytes
    Assert-AndroidElf $readelf $AndroidSupportDestination $false @("libc.so")
    Assert-AndroidElf $readelf $NcursesDestination $false @("libc.so")

    $nativeMap = Get-Content -Raw -LiteralPath $NativeMapPath | ConvertFrom-Json
    if ($nativeMap.'lib/libandroid-support.so' -ne "liblib_libandroid_support_so.so" -or
        $nativeMap.'lib/libncursesw.so.6' -ne "liblib_libncursesw_so_6.so" -or
        $nativeMap.'lib/libncursesw.so.6.5' -ne "liblib_libncursesw_so_6.so") {
        throw "native-map.json does not expose Nano's verified libandroid-support/ncurses SONAME closure."
    }

    New-Item -ItemType Directory -Force -Path $NativeDestination | Out-Null
    Copy-Item -Force -LiteralPath $nanoExecutable -Destination $NanoDestination
    Assert-HashAndSize $NanoDestination $NanoExecutableSha256 $NanoExecutableBytes

    foreach ($destination in @($SyntaxDestination, $TerminfoDestination)) {
        $resolvedAssets = [IO.Path]::GetFullPath($RuntimeAssets)
        $resolvedDestination = [IO.Path]::GetFullPath($destination)
        if (-not $resolvedDestination.StartsWith($resolvedAssets, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to replace generated runtime data outside $RuntimeAssets."
        }
        if (Test-Path -LiteralPath $resolvedDestination) {
            Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null
    }
    Copy-Item -Path (Join-Path $nanoSyntax "*") -Destination $SyntaxDestination -Recurse -Force
    Copy-Item -Path (Join-Path $terminfo "*") -Destination $TerminfoDestination -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NanorcDestination) | Out-Null
    Copy-Item -LiteralPath $nanoNanorc -Destination $NanorcDestination -Force
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LicenseDestination) | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot "LICENSE") -Destination $LicenseDestination -Force
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $NcursesLicenseDestination) | Out-Null
    Copy-Item -LiteralPath $ncursesLicense -Destination $NcursesLicenseDestination -Force
    $licenseSha256 = Get-LowerSha256 $LicenseDestination
    Assert-HashAndSize $NcursesLicenseDestination $NcursesLicenseSha256 $NcursesLicenseBytes

    $stagedSyntaxDigest = Get-TreeDigest $SyntaxDestination
    $stagedTerminfoDigest = Get-TreeDigest $TerminfoDestination
    Assert-TreeDigest $stagedSyntaxDigest $NanoSyntaxCount $NanoSyntaxBytes $NanoSyntaxTreeSha256 "Staged Nano syntax"
    Assert-TreeDigest $stagedTerminfoDigest $TerminfoCount $TerminfoBytes $TerminfoTreeSha256 "Staged ncurses terminfo"
    Assert-HashAndSize $NanorcDestination $NanoNanorcSha256 $NanoNanorcBytes

    $mapEntries = [ordered]@{}
    foreach ($property in ($nativeMap.PSObject.Properties | Sort-Object Name)) {
        $mapEntries[$property.Name] = $property.Value
    }
    $mapEntries["bin/nano"] = "libbin_nano.so"
    $sortedMap = [ordered]@{}
    foreach ($key in ($mapEntries.Keys | Sort-Object)) {
        $sortedMap[$key] = $mapEntries[$key]
    }
    Write-Utf8Json $NativeMapPath $sortedMap

    $inReleaseSha256 = Get-LowerSha256 $inRelease
    $releaseDate = if ($releaseText -match "(?m)^Date:\s*(.+)$") {
        $Matches[1].Trim()
    } else {
        "unknown"
    }
    $manifest = [ordered]@{
        schemaVersion = 1
        id = "termux-nano-android"
        package = "nano"
        version = $NanoVersion
        platform = "android-bionic"
        supportedAbis = @("arm64-v8a")
        unsupportedAbis = [ordered]@{
            x86_64 = "No pinned and verified Android/Bionic x86_64 Nano payload is bundled. Use vi until an x86_64 package is staged and tested."
        }
        license = "GPL-3.0-only"
        source = [ordered]@{
            repository = $RepositoryBase
            packageIndex = $PackagesGzipUrl
            signedManifest = $InReleaseUrl
            signedManifestDate = $releaseDate
            signedManifestSha256 = $inReleaseSha256
            packageIndexSha256 = $packagesHash
            signingKeyFingerprint = $TermuxSigningFingerprint
            signingKeySha256 = $TermuxKeyringSha256
            signatureVerified = $true
            nanoArchiveUrl = "$RepositoryBase/$NanoArchiveRelativePath"
            nanoArchiveSha256 = $NanoArchiveSha256
            nanoUpstreamSourceSha256 = "05ecb99247b782e8a5b3a25ed4101dd034b0236902f7449bc9795b717642f7e9"
            ncursesArchiveUrl = "$RepositoryBase/$NcursesArchiveRelativePath"
            ncursesArchiveSha256 = $NcursesArchiveSha256
            libandroidSupportArchiveSha256 = $AndroidSupportArchiveSha256
        }
        runtime = [ordered]@{
            interpreter = "/system/bin/linker64"
            pie = $true
            minimumLoadAlignment = $MinimumLoadAlignment
            needed = @("libandroid-support.so", "libncursesw.so.6", "libc.so")
            closurePolicy = "LD_LIBRARY_PATH resolves the two pinned native-map libraries; libc.so is supplied by Android/Bionic."
            terminfoEnvironment = "TERMINFO=`$PREFIX/share/terminfo"
            configPolicy = "RuntimeManager generates a prefix-correct user .nanorc only when the user has no existing configuration."
        }
        dependencies = @(
            [ordered]@{
                package = "libandroid-support"
                version = $AndroidSupportVersion
                packagedName = "liblib_libandroid_support_so.so"
                soname = "libandroid-support.so"
                bytes = $AndroidSupportLibraryBytes
                sha256 = $AndroidSupportLibrarySha256
            },
            [ordered]@{
                package = "ncurses"
                version = $NcursesVersion
                packagedName = "liblib_libncursesw_so_6.so"
                soname = "libncursesw.so.6"
                bytes = $NcursesLibraryBytes
                sha256 = $NcursesLibrarySha256
            }
        )
        components = @(
            [ordered]@{
                packagedName = "libbin_nano.so"
                sourcePath = "data/data/com.termux/files/usr/bin/nano"
                runtimePaths = @("bin/nano")
                bytes = $NanoExecutableBytes
                sha256 = $NanoExecutableSha256
                license = "GPL-3.0-only"
                role = "ELF64 AArch64 PIE executable"
            },
            [ordered]@{
                runtimePath = "etc/nanorc.termux"
                bytes = $NanoNanorcBytes
                sha256 = $NanoNanorcSha256
                license = "GPL-3.0-only"
                role = "Unmodified package nanorc source; RuntimeManager rewrites its Termux prefix before use"
            },
            [ordered]@{
                runtimePath = "share/nano"
                files = $NanoSyntaxCount
                bytes = $NanoSyntaxBytes
                treeSha256 = $NanoSyntaxTreeSha256
                license = "GPL-3.0-only"
                role = "Nano syntax definitions"
            },
            [ordered]@{
                runtimePath = "share/terminfo"
                package = "ncurses"
                version = $NcursesVersion
                files = $TerminfoCount
                bytes = $TerminfoBytes
                treeSha256 = $TerminfoTreeSha256
                license = "MIT"
                role = "Complete minimal Termux ncurses terminal database"
            },
            [ordered]@{
                runtimePath = "share/licenses/nano/COPYING"
                sha256 = $licenseSha256
                license = "GPL-3.0-only"
                role = "GNU GPL version 3 license text"
            },
            [ordered]@{
                runtimePath = "share/licenses/ncurses/COPYRIGHT"
                bytes = $NcursesLicenseBytes
                sha256 = $NcursesLicenseSha256
                license = "MIT"
                role = "ncurses copyright and license notice"
            }
        )
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ManifestPath) | Out-Null
    Write-Utf8Json $ManifestPath $manifest

    Write-Host "Nano $NanoVersion Android/Bionic payload verified and staged."
    Write-Host "  executable SHA-256: $NanoExecutableSha256"
    Write-Host "  NEEDED: libandroid-support.so, libncursesw.so.6, libc.so"
    Write-Host "  syntax: $NanoSyntaxCount files, tree SHA-256 $NanoSyntaxTreeSha256"
    Write-Host "  terminfo: $TerminfoCount files, tree SHA-256 $TerminfoTreeSha256"
} finally {
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $resolvedWorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
    if ($resolvedWorkDirectory.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedWorkDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
