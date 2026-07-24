# Parses ELF64 DT_NEEDED entries (shared library dependencies) for given files.
param([string[]]$Files)

function Get-Needed([string]$path) {
    $b = [IO.File]::ReadAllBytes($path)
    if ($b.Length -lt 64 -or $b[0] -ne 0x7F -or $b[1] -ne 0x45) { return @("<not-elf>") }
    # ELF64 header offsets
    $e_phoff    = [BitConverter]::ToUInt64($b, 0x20)
    $e_phentsize= [BitConverter]::ToUInt16($b, 0x36)
    $e_phnum    = [BitConverter]::ToUInt16($b, 0x38)

    $dynOff = 0; $dynSz = 0
    $loads = @()  # @{vaddr;off;filesz}
    for ($i = 0; $i -lt $e_phnum; $i++) {
        $ph = [int]$e_phoff + $i * $e_phentsize
        $p_type   = [BitConverter]::ToUInt32($b, $ph)
        $p_offset = [BitConverter]::ToUInt64($b, $ph + 0x08)
        $p_vaddr  = [BitConverter]::ToUInt64($b, $ph + 0x10)
        $p_filesz = [BitConverter]::ToUInt64($b, $ph + 0x20)
        if ($p_type -eq 2) { $dynOff = [int]$p_offset; $dynSz = [int]$p_filesz }   # PT_DYNAMIC
        if ($p_type -eq 1) { $loads += @{ vaddr = $p_vaddr; off = $p_offset; filesz = $p_filesz } } # PT_LOAD
    }
    if ($dynOff -eq 0) { return @("<no-dynamic>") }

    function VtoF([uint64]$v) {
        foreach ($l in $loads) { if ($v -ge $l.vaddr -and $v -lt ($l.vaddr + $l.filesz)) { return [int]($l.off + ($v - $l.vaddr)) } }
        return -1
    }

    # First pass: find DT_STRTAB (tag 5) vaddr and collect DT_NEEDED (tag 1) string offsets
    $strtabV = 0; $needed = @()
    for ($o = $dynOff; $o -lt $dynOff + $dynSz; $o += 16) {
        $tag = [BitConverter]::ToUInt64($b, $o)
        $val = [BitConverter]::ToUInt64($b, $o + 8)
        if ($tag -eq 1) { $needed += $val }
        elseif ($tag -eq 5) { $strtabV = $val }
        elseif ($tag -eq 0) { break }  # DT_NULL
    }
    if ($strtabV -eq 0) { return @("<no-strtab>") }
    $strOff = VtoF $strtabV
    if ($strOff -lt 0) { return @("<strtab-unmapped>") }

    $names = @()
    foreach ($n in $needed) {
        $p = $strOff + [int]$n; $s = ""
        while ($p -lt $b.Length -and $b[$p] -ne 0) { $s += [char]$b[$p]; $p++ }
        $names += $s
    }
    return $names
}

foreach ($f in $Files) {
    Write-Host ("=== " + (Split-Path $f -Leaf) + " ===")
    (Get-Needed $f) | ForEach-Object { Write-Host ("   " + $_) }
}
