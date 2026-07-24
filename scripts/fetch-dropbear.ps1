<#
.SYNOPSIS
  Fetch an ARM64 (aarch64) 'dropbearmulti' binary and embed it into the runtime
  assets so the APK build packages it (ssh/scp for the mobile IDE).

.DESCRIPTION
  Windows-native companion to scripts/fetch-runtime.sh. Uses the built-in
  tar.exe (bsdtar) to extract the Termux .deb (an 'ar' archive whose data.tar
  payload is .xz/.zst). Places ONLY bin/dropbearmulti into the assets tree; the
  app (RuntimeManager.createDropbearAliases) wires dbclient/scp/dropbearkey on
  first launch, and an 'ssh' shell shim maps to dbclient.

  After running this once, build the app normally:
      $env:JAVA_HOME = "C:\Users\Asif\jdk17\jdk-17.0.19+10"; .\gradlew installDebug
  The Gradle task 'prepareRuntimeNativeLibs' relocates dropbearmulti into
  jniLibs/arm64-v8a/lib*.so automatically.

.PARAMETER Base
  Termux repository base URL. Default: https://packages.termux.dev/apt/termux-main

.PARAMETER DropbearUrl
  Optional direct URL to a prebuilt aarch64 'dropbearmulti' binary. If set, the
  Termux resolution is skipped.

.EXAMPLE
  .\scripts\fetch-dropbear.ps1
.EXAMPLE
  .\scripts\fetch-dropbear.ps1 -DropbearUrl "https://example/dropbearmulti-arm64"
#>
param(
    [string]$Base = "https://packages.termux.dev/apt/termux-main",
    [string]$DropbearUrl = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$proj = Split-Path $PSScriptRoot -Parent
$bin  = Join-Path $proj "android\app\src\main\assets\runtime\bin"
$dest = Join-Path $bin "dropbearmulti"
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$tmp = Join-Path $env:TEMP ("dropbear_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    if ($DropbearUrl) {
        Write-Host "Downloading dropbearmulti from override URL..." -ForegroundColor Cyan
        Invoke-WebRequest -UseBasicParsing $DropbearUrl -OutFile $dest
    }
    else {
        Write-Host "Resolving dropbear from $Base ..." -ForegroundColor Cyan
        # apt repos always publish a gzipped Packages.gz; the plain 'Packages'
        # is often missing (CDN returns a soft-404 HTML page). Try .gz first,
        # decompress with built-in GZip, then fall back to the plain file.
        $idxUrls = @(
            "$Base/dists/stable/main/binary-aarch64/Packages.gz",
            "$Base/dists/stable/main/binary-aarch64/Packages"
        )
        $pkgs = $null
        foreach ($u in $idxUrls) {
            try {
                Write-Host "  index: $u"
                $raw = Join-Path $tmp "idx.bin"
                Invoke-WebRequest -UseBasicParsing $u -OutFile $raw
                if ($u.EndsWith(".gz")) {
                    $inF = [IO.File]::OpenRead($raw)
                    $gz  = New-Object IO.Compression.GZipStream($inF, [IO.Compression.CompressionMode]::Decompress)
                    $sr  = New-Object IO.StreamReader($gz)
                    $pkgs = $sr.ReadToEnd()
                    $sr.Close(); $gz.Close(); $inF.Close()
                } else {
                    $pkgs = [IO.File]::ReadAllText($raw)
                }
                if ($pkgs -match '(?m)^Package:\s*dropbear\s*$') { break } else { $pkgs = $null }
            } catch {
                Write-Host "    failed: $($_.Exception.Message)"
            }
        }
        if (-not $pkgs) {
            throw "Could not retrieve a Packages index containing dropbear. Check your network, or pass -DropbearUrl with a direct aarch64 dropbearmulti URL."
        }

        $rel = $null
        $inPkg = $false
        foreach ($line in ($pkgs -split "`n")) {
            if ($line -match '^Package:\s*dropbear\s*$') { $inPkg = $true; continue }
            if ($inPkg -and $line -match '^Filename:\s*(.+?)\s*$') { $rel = $Matches[1]; break }
            if ($inPkg -and $line -match '^Package:\s') { $inPkg = $false }
        }
        if (-not $rel) { throw "Could not find 'dropbear' in the Termux Packages index." }

        $debUrl = "$Base/$rel"
        Write-Host "Downloading $rel" -ForegroundColor Cyan
        $deb = Join-Path $tmp "dropbear.deb"
        Invoke-WebRequest -UseBasicParsing $debUrl -OutFile $deb

        # .deb is an 'ar' archive: extract to get data.tar.{xz,zst}, then that.
        Push-Location $tmp
        try {
            & tar.exe -xf $deb
            $data = Get-ChildItem -Path $tmp -Filter "data.tar*" | Select-Object -First 1
            if (-not $data) { throw "No data.tar found inside the .deb." }
            & tar.exe -xf $data.FullName
        }
        finally { Pop-Location }

        $found = Get-ChildItem -Path $tmp -Recurse -Filter "dropbearmulti" -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $found) { throw "dropbearmulti not found in the extracted package." }
        Copy-Item $found.FullName $dest -Force
    }

    # Sanity: confirm it is an aarch64 ELF (magic 0x7F 'E' 'L' 'F', e_machine=0xB7).
    $fs = [IO.File]::OpenRead($dest)
    try {
        $hdr = New-Object byte[] 20
        [void]$fs.Read($hdr, 0, 20)
    }
    finally { $fs.Close() }
    $isElf = ($hdr[0] -eq 0x7F -and $hdr[1] -eq 0x45 -and $hdr[2] -eq 0x4C -and $hdr[3] -eq 0x46)
    $machine = [BitConverter]::ToUInt16($hdr, 18)  # e_machine (little-endian)
    if (-not $isElf) { throw "Downloaded file is not an ELF binary." }
    if ($machine -ne 0xB7) { Write-Warning "e_machine=0x$($machine.ToString('X')) (expected 0xB7 aarch64). Verify the source arch." }

    $size = (Get-Item $dest).Length
    Write-Host ""
    Write-Host "Embedded: $dest ($size bytes, aarch64 ELF)" -ForegroundColor Green
    Write-Host "Next: build the app. Gradle relocates it into lib*.so; the app wires ssh/scp/dbclient." -ForegroundColor Green
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
