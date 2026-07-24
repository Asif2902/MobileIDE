<#
.SYNOPSIS
  Fetch the full Termux shared-library dependency closure for the embedded
  aarch64 tools (node, git, bash, dropbear) and place the .so files into the
  runtime assets so the APK bundles them.

.DESCRIPTION
  The embedded binaries (libbin_node.so, libbin_git.so, ...) are Termux builds.
  They are dynamically linked against Termux shared libraries (libc++_shared.so,
  libicuuc.so.NN, libcrypto.so.3, libcurl.so, libreadline.so.8, ...) that are
  NOT present on stock Android. Without them the linker fails with
  "CANNOT LINK EXECUTABLE / library ... not found" and node/git/npm/ssh do nothing.

  This script:
    1. Downloads the Termux Packages index (Packages.gz).
    2. Resolves the recursive Depends closure of the root packages.
    3. Downloads each package .deb and extracts every usr/lib/*.so* file.
    4. Copies each real ELF shared object into assets/runtime/lib/ using its
       DT_SONAME (e.g. a libz.so.1.3.1 real file is written as libz.so.1),
       so the on-device symlink farm + LD_LIBRARY_PATH resolve every DT_NEEDED.
    5. Verifies the closure: reports any SONAME still unsatisfied.

  No patchelf and no Kotlin changes are needed. The Gradle task
  'prepareRuntimeNativeLibs' relocates each .so into jniLibs/arm64-v8a/lib*.so,
  and RuntimeManager.buildSymlinkFarm recreates the exact-named symlink in
  runtimeRoot/lib/ (which is on LD_LIBRARY_PATH).

  After running this once, build the standalone APK:
      $env:JAVA_HOME = "C:\Users\Asif\jdk17\jdk-17.0.19+10"; .\gradlew assembleRelease

.PARAMETER Base
  Termux repository base URL. Default: https://packages.termux.dev/apt/termux-main

.PARAMETER Roots
  Package names whose dependency closure we bundle. Defaults cover node/git/bash/ssh.

.EXAMPLE
  .\scripts\fetch-runtime-libs.ps1
#>
param(
    [string]$Base = "https://packages.termux.dev/apt/termux-main",
    [string[]]$Roots = @("nodejs", "git", "bash", "dropbear", "openssh")
)

$ErrorActionPreference = "Stop"
# tar.exe returns non-zero when it can't create Termux symlink entries on Windows;
# that is harmless for us (we only want the .so files). Stop PowerShell 7 from
# turning those non-zero exits into terminating errors, and silence the
# Invoke-WebRequest progress bar (which is very slow for large .deb downloads).
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$proj    = Split-Path $PSScriptRoot -Parent
$libDest = Join-Path $proj "android\app\src\main\assets\runtime\lib"
$binDir  = Join-Path $proj "android\app\src\main\assets\runtime\bin"
New-Item -ItemType Directory -Force -Path $libDest | Out-Null

# Clean any shared libraries from a previous run so the bundle is reproducible.
# Only touch flat *.so* files directly in lib/ - never the node_modules/ npm tree.
Get-ChildItem -Path $libDest -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.so($|\.)' } | Remove-Item -Force -ErrorAction SilentlyContinue

$tmp = Join-Path $env:TEMP ("termuxlibs_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# Libraries provided by Android itself - never need bundling.
$systemLibs = @(
    "libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so",
    "libEGL.so", "libGLESv2.so", "libGLESv1_CM.so", "libOpenSLES.so",
    "libjnigraphics.so", "libmediandk.so", "libnativewindow.so",
    "libvulkan.so", "libaaudio.so", "libcamera2ndk.so", "libneuralnetworks.so"
) | ForEach-Object { $_.ToLower() }

# --- ELF64 dynamic-section reader: returns @{ SONAME=..; NEEDED=@(..) } -------
function Get-ElfDynamic {
    param([string]$Path)
    try {
        $b = [IO.File]::ReadAllBytes($Path)
    } catch { return $null }
    if ($b.Length -lt 64) { return $null }
    if (-not ($b[0] -eq 0x7F -and $b[1] -eq 0x45 -and $b[2] -eq 0x4C -and $b[3] -eq 0x46)) { return $null }
    if ($b[4] -ne 2) { return $null }  # not ELF64

    $e_phoff     = [BitConverter]::ToUInt64($b, 0x20)
    $e_phentsize = [BitConverter]::ToUInt16($b, 0x36)
    $e_phnum     = [BitConverter]::ToUInt16($b, 0x38)

    $dynOff = 0; $dynSize = 0
    $loads  = @()  # @{ vaddr; off; filesz }
    for ($i = 0; $i -lt $e_phnum; $i++) {
        $ph = [int]$e_phoff + $i * $e_phentsize
        if ($ph + 56 -gt $b.Length) { break }
        $p_type   = [BitConverter]::ToUInt32($b, $ph)
        $p_offset = [BitConverter]::ToUInt64($b, $ph + 8)
        $p_vaddr  = [BitConverter]::ToUInt64($b, $ph + 16)
        $p_filesz = [BitConverter]::ToUInt64($b, $ph + 32)
        if ($p_type -eq 2) { $dynOff = [int]$p_offset; $dynSize = [int]$p_filesz }        # PT_DYNAMIC
        elseif ($p_type -eq 1) { $loads += @{ vaddr = $p_vaddr; off = $p_offset; filesz = $p_filesz } }  # PT_LOAD
    }
    if ($dynOff -eq 0) { return @{ SONAME = $null; NEEDED = @() } }

    # First pass: DT_STRTAB vaddr, plus collect NEEDED/SONAME string offsets.
    $strtabVaddr = 0
    $neededOffs  = @()
    $sonameOff   = -1
    $n = [math]::Floor($dynSize / 16)
    for ($j = 0; $j -lt $n; $j++) {
        $e = $dynOff + $j * 16
        if ($e + 16 -gt $b.Length) { break }
        $tag = [BitConverter]::ToUInt64($b, $e)
        $val = [BitConverter]::ToUInt64($b, $e + 8)
        switch ($tag) {
            1  { $neededOffs += $val }         # DT_NEEDED
            5  { $strtabVaddr = $val }          # DT_STRTAB
            14 { $sonameOff  = $val }           # DT_SONAME
            0  { $j = $n }                      # DT_NULL -> stop
        }
    }
    if ($strtabVaddr -eq 0) { return @{ SONAME = $null; NEEDED = @() } }

    # Translate a vaddr in the string table to a file offset via PT_LOAD map.
    $strFileOff = -1
    foreach ($ld in $loads) {
        if ($strtabVaddr -ge $ld.vaddr -and $strtabVaddr -lt ($ld.vaddr + $ld.filesz)) {
            $strFileOff = [int]($ld.off + ($strtabVaddr - $ld.vaddr)); break
        }
    }
    if ($strFileOff -lt 0) { return @{ SONAME = $null; NEEDED = @() } }

    function Read-CStr([byte[]]$buf, [int]$base, [long]$rel) {
        $p = $base + [int]$rel
        if ($p -lt 0 -or $p -ge $buf.Length) { return $null }
        $sb = New-Object Text.StringBuilder
        while ($p -lt $buf.Length -and $buf[$p] -ne 0) { [void]$sb.Append([char]$buf[$p]); $p++ }
        return $sb.ToString()
    }

    $soname = $null
    if ($sonameOff -ge 0) { $soname = Read-CStr $b $strFileOff $sonameOff }
    $needed = @()
    foreach ($o in $neededOffs) { $s = Read-CStr $b $strFileOff $o; if ($s) { $needed += $s } }
    return @{ SONAME = $soname; NEEDED = $needed }
}

# --- 1. Download + parse the Packages index -----------------------------------
Write-Host "Resolving Termux package index from $Base ..." -ForegroundColor Cyan
$idxUrls = @(
    "$Base/dists/stable/main/binary-aarch64/Packages.gz",
    "$Base/dists/stable/main/binary-aarch64/Packages"
)
$pkgsText = $null
foreach ($u in $idxUrls) {
    try {
        Write-Host "  index: $u"
        $raw = Join-Path $tmp "idx.bin"
        Invoke-WebRequest -UseBasicParsing $u -OutFile $raw
        if ($u.EndsWith(".gz")) {
            $inF = [IO.File]::OpenRead($raw)
            $gz  = New-Object IO.Compression.GZipStream($inF, [IO.Compression.CompressionMode]::Decompress)
            $sr  = New-Object IO.StreamReader($gz)
            $pkgsText = $sr.ReadToEnd()
            $sr.Close(); $gz.Close(); $inF.Close()
        } else {
            $pkgsText = [IO.File]::ReadAllText($raw)
        }
        if ($pkgsText -match '(?m)^Package:\s') { break } else { $pkgsText = $null }
    } catch { Write-Host "    failed: $($_.Exception.Message)" }
}
if (-not $pkgsText) { throw "Could not retrieve the Termux Packages index. Check your network." }

# Parse stanzas into records: name -> @{ Filename; Depends=@(); Provides=@() }
$byName   = @{}
$provides = @{}   # virtual name -> real package name
$cur = $null
foreach ($line in ($pkgsText -split "`n")) {
    $line = $line.TrimEnd("`r")
    if ($line -eq "") {
        if ($cur -and $cur.Name) {
            $byName[$cur.Name] = $cur
            foreach ($p in $cur.Provides) { if (-not $provides.ContainsKey($p)) { $provides[$p] = $cur.Name } }
        }
        $cur = $null; continue
    }
    if ($line -match '^Package:\s*(.+?)\s*$') { $cur = @{ Name = $Matches[1]; Filename = $null; Depends = @(); Provides = @() }; continue }
    if (-not $cur) { continue }
    if ($line -match '^Filename:\s*(.+?)\s*$') { $cur.Filename = $Matches[1]; continue }
    if ($line -match '^Depends:\s*(.+?)\s*$') {
        foreach ($d in ($Matches[1] -split ',')) {
            $alt = ($d -split '\|')[0].Trim()          # take first alternative
            $alt = ($alt -replace '\(.*?\)', '').Trim() # strip version constraint
            if ($alt) { $cur.Depends += $alt }
        }
        continue
    }
    if ($line -match '^Provides:\s*(.+?)\s*$') {
        foreach ($p in ($Matches[1] -split ',')) {
            $pv = ($p -replace '\(.*?\)', '').Trim()
            if ($pv) { $cur.Provides += $pv }
        }
        continue
    }
}
if ($cur -and $cur.Name) { $byName[$cur.Name] = $cur; foreach ($p in $cur.Provides) { if (-not $provides.ContainsKey($p)) { $provides[$p] = $cur.Name } } }
Write-Host "  parsed $($byName.Count) packages." -ForegroundColor DarkGray

# --- 2. Resolve the recursive Depends closure ---------------------------------
function Resolve-Name([string]$name) {
    if ($byName.ContainsKey($name)) { return $name }
    if ($provides.ContainsKey($name)) { return $provides[$name] }
    return $null
}

$closure = New-Object System.Collections.Generic.HashSet[string]
$queue   = New-Object System.Collections.Generic.Queue[string]
foreach ($r in $Roots) {
    $rn = Resolve-Name $r
    if ($rn) { [void]$queue.Enqueue($rn) } else { Write-Warning "root package not found in index: $r" }
}
while ($queue.Count -gt 0) {
    $name = $queue.Dequeue()
    if ($closure.Contains($name)) { continue }
    [void]$closure.Add($name)
    $rec = $byName[$name]
    if (-not $rec) { continue }
    foreach ($d in $rec.Depends) {
        $dn = Resolve-Name $d
        if ($dn -and -not $closure.Contains($dn)) { [void]$queue.Enqueue($dn) }
    }
}
Write-Host "  dependency closure: $($closure.Count) packages." -ForegroundColor DarkGray

# --- 3+4. Download each package and extract usr/lib/*.so* ----------------------
$written = @{}   # target filename -> source basename (for summary)
$pkgNum = 0
foreach ($name in ($closure | Sort-Object)) {
    $pkgNum++
    $rec = $byName[$name]
    if (-not $rec -or -not $rec.Filename) { continue }
    $debUrl = "$Base/$($rec.Filename)"
    $ex = Join-Path $tmp ("ex_" + $name.Replace('/', '_'))
    New-Item -ItemType Directory -Force -Path $ex | Out-Null
    $deb = Join-Path $ex "p.deb"
    try {
        Invoke-WebRequest -UseBasicParsing $debUrl -OutFile $deb
    } catch {
        Write-Host "  [$pkgNum/$($closure.Count)] $name : download failed ($($_.Exception.Message))" -ForegroundColor DarkYellow
        Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
        continue
    }
    # Extraction is best-effort. tar fails to create the symlink entries
    # (libz.so -> libz.so.1.3.2, libicuuc.so.78 -> libicuuc.so.78.3, ...) on
    # Windows, but those failures are non-fatal: the REAL fully-versioned files
    # still extract. We must do a FULL extract (NOT tar --include): --include
    # aborts the archive on the first failed symlink, which for many packages is
    # stored *before* the real file, so the real file would be lost.
    Push-Location $ex
    # tar.exe writes symlink-creation warnings to stderr; under ErrorActionPreference
    # 'Stop' PowerShell 7 turns the FIRST such line into a terminating error and
    # aborts extraction before the real (versioned) file is reached. Force
    # 'Continue' locally so tar always runs the archive to completion.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # .deb is an 'ar' archive -> extract data.tar (no symlinks at this level).
        & tar.exe -xf $deb 2>&1 | Out-Null
        $data = Get-ChildItem -Path $ex -Filter "data.tar*" | Select-Object -First 1
        if ($data) { & tar.exe -xf $data.FullName 2>&1 | Out-Null }
    } finally { $ErrorActionPreference = $eap; Pop-Location }

    # Collect shared objects that live DIRECTLY in usr/lib (parent dir == 'lib').
    # This skips dlopen-only plugin trees like lib/krb5/plugins/*.so, which are
    # not DT_NEEDED by our tools and would drag in a phantom krb5 dependency web.
    $sos = Get-ChildItem -Path $ex -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '\.so($|\.)' -and $_.Directory.Name -eq 'lib' }
    $cnt = 0
    foreach ($f in $sos) {
        $dyn = Get-ElfDynamic $f.FullName
        if (-not $dyn) { continue }   # not a real ELF (failed symlink stub, etc.)
        # DT_SONAME of a real file (libz.so.1.3.2) is the exact truncated name a
        # DT_NEEDED references (libz.so.1), so copy under BOTH SONAME and basename.
        $target = if ($dyn.SONAME) { $dyn.SONAME } else { $f.Name }
        if ($systemLibs -contains $target.ToLower()) { continue }
        Copy-Item $f.FullName (Join-Path $libDest $target) -Force
        $written[$target] = $name
        if ($f.Name -ne $target) { Copy-Item $f.FullName (Join-Path $libDest $f.Name) -Force; $written[$f.Name] = $name }
        $cnt++
    }
    Write-Host ("  [{0}/{1}] {2}: {3} lib(s)" -f $pkgNum, $closure.Count, $name, $cnt) -ForegroundColor DarkGray
    Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
}

# --- 5. Verify the closure ----------------------------------------------------
Write-Host ""
Write-Host "Verifying dependency closure ..." -ForegroundColor Cyan

# Available SONAMEs = every .so we just wrote + Android system libs.
$available = New-Object System.Collections.Generic.HashSet[string]
foreach ($k in $written.Keys) { [void]$available.Add($k.ToLower()) }
foreach ($s in $systemLibs) { [void]$available.Add($s) }
# also index by actual SONAME of written files
Get-ChildItem -Path $libDest -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '\.so($|\.)' } | ForEach-Object {
        $d = Get-ElfDynamic $_.FullName
        if ($d -and $d.SONAME) { [void]$available.Add($d.SONAME.ToLower()) }
        [void]$available.Add($_.Name.ToLower())
    }

# Gather DT_NEEDED across every embedded binary + every bundled lib. The real
# node/git/bash binaries may already have been relocated by a prior build into
# jniLibs/arm64-v8a/libbin_*.so, so scan there too for a complete check.
$jniLibs = Join-Path $proj "android\app\src\main\jniLibs\arm64-v8a"
$scanTargets = @()
if (Test-Path $binDir)  { $scanTargets += Get-ChildItem -Path $binDir  -Recurse -File -ErrorAction SilentlyContinue }
if (Test-Path $jniLibs) { $scanTargets += Get-ChildItem -Path $jniLibs -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.so$' } }
$scanTargets += Get-ChildItem -Path $libDest -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.so($|\.)' }

$missing = @{}
foreach ($t in $scanTargets) {
    $d = Get-ElfDynamic $t.FullName
    if (-not $d) { continue }
    foreach ($nd in $d.NEEDED) {
        if (-not $available.Contains($nd.ToLower())) {
            if (-not $missing.ContainsKey($nd)) { $missing[$nd] = @() }
            $missing[$nd] += $t.Name
        }
    }
}

# Safety pass: satisfy any still-missing truncated SONAME (e.g. libfoo.so.1) by
# copying a longer real file that starts with it (libfoo.so.1.2.3), for the rare
# case a real object carries no usable DT_SONAME.
$libFiles = Get-ChildItem -Path $libDest -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.so($|\.)' }
foreach ($need in @($missing.Keys)) {
    $cand = $libFiles | Where-Object { $_.Name -like ($need + '.*') } | Select-Object -First 1
    if ($cand) {
        Copy-Item $cand.FullName (Join-Path $libDest $need) -Force
        [void]$available.Add($need.ToLower())
        $missing.Remove($need)
    }
}

$libCount = (Get-ChildItem -Path $libDest -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.so($|\.)' }).Count
Write-Host ""
Write-Host "Bundled $libCount shared-library files into:" -ForegroundColor Green
Write-Host "  $libDest" -ForegroundColor Green
if ($missing.Count -eq 0) {
    Write-Host "Closure is COMPLETE - every DT_NEEDED is satisfied." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Warning "Still-missing shared libraries ($($missing.Count)):"
    foreach ($m in ($missing.Keys | Sort-Object)) {
        Write-Host ("  {0}  <- needed by {1}" -f $m, (($missing[$m] | Select-Object -Unique) -join ', ')) -ForegroundColor Yellow
    }
    Write-Host "Re-run with -Roots including the package(s) that provide the above." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Next: build a standalone APK (no PC needed to run):" -ForegroundColor Green
Write-Host '  $env:JAVA_HOME = "C:\Users\Asif\jdk17\jdk-17.0.19+10"; .\gradlew assembleRelease' -ForegroundColor Green

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
