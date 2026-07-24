$ErrorActionPreference = "Stop"
$base = "c:\Users\Asif\android coder\MobileIDE\android\app\src\main\assets\runtime\lib"
$dl = "c:\Users\Asif\android coder\MobileIDE\runtime\downloads\libs"

# Create directories
New-Item -ItemType Directory -Force -Path $base | Out-Null
New-Item -ItemType Directory -Force -Path $dl | Out-Null

$repo = "https://packages.termux.dev/apt/termux-main/pool/main"

# Package URLs (aarch64) - these are the shared libraries needed by git, bash, node
$packages = @(
    # zlib - needed by git, node
    @{ name = "zlib"; url = "$repo/z/zlib/zlib_1.3.1_aarch64.deb" },
    # libiconv - needed by git, bash
    @{ name = "libiconv"; url = "$repo/l/libiconv/libiconv_1.17_aarch64.deb" },
    # gettext - needed by git, bash (libintl)
    @{ name = "gettext"; url = "$repo/g/gettext/gettext_0.22.5_aarch64.deb" },
    # ncurses - needed by bash (libncursesw)
    @{ name = "ncurses"; url = "$repo/n/ncurses/ncurses_6.4.20240127_aarch64.deb" },
    # readline - needed by bash
    @{ name = "readline"; url = "$repo/r/readline/readline_8.2.13_aarch64.deb" },
    # openssl - needed by git, libcurl
    @{ name = "openssl"; url = "$repo/o/openssl/openssl_3.3.1_aarch64.deb" },
    # libcurl - needed by git (http/https)
    @{ name = "libcurl"; url = "$repo/c/curl/curl_8.9.1_aarch64.deb" },
    # pcre2 - needed by git
    @{ name = "pcre2"; url = "$repo/p/pcre2/pcre2_10.44_aarch64.deb" }
)

Write-Host "Downloading Termux shared library packages..."

foreach ($pkg in $packages) {
    $outFile = Join-Path $dl "$($pkg.name).deb"
    Write-Host "  Downloading $($pkg.name)..."
    try {
        Invoke-WebRequest -Uri $pkg.url -OutFile $outFile -UseBasicParsing -TimeoutSec 60
        Write-Host "    OK: $outFile"
    } catch {
        Write-Host "    WARN: Failed to download $($pkg.name) from primary URL: $_"
        # Try alternative version patterns
        Write-Host "    Trying to find package..."
    }
}

Write-Host "`nExtracting .so files..."

foreach ($pkg in $packages) {
    $debFile = Join-Path $dl "$($pkg.name).deb"
    if (-not (Test-Path $debFile)) {
        Write-Host "  SKIP $($pkg.name) (not downloaded)"
        continue
    }
    
    $extractDir = Join-Path $dl "$($pkg.name)_extracted"
    if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
    
    # Extract .deb (it's an ar archive)
    Push-Location $extractDir
    try {
        # Use tar to extract the deb (works on Windows 10+)
        # .deb = ar archive containing data.tar.xz
        ar x $debFile 2>$null
        if (Test-Path "data.tar.xz") {
            tar xf data.tar.xz 2>$null
        } elseif (Test-Path "data.tar.gz") {
            tar xf data.tar.gz 2>$null
        }
        
        # Find and copy .so files
        $soFiles = Get-ChildItem -Recurse -Filter "*.so*" -Path $extractDir | Where-Object { -not $_.PSIsContainer }
        foreach ($so in $soFiles) {
            $dest = Join-Path $base $so.Name
            Copy-Item $so.FullName $dest -Force
            Write-Host "  $($pkg.name): $($so.Name)"
        }
    } catch {
        Write-Host "  ERROR extracting $($pkg.name): $_"
    }
    Pop-Location
}

Write-Host "`nDone! Libraries in: $base"
Write-Host "Files:"
Get-ChildItem $base | ForEach-Object { Write-Host "  $($_.Name) ($([math]::Round($_.Length/1KB))KB)" }
