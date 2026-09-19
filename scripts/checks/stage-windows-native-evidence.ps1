# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Accidental-runnable hygiene for bounded diagnostics. This does not isolate a
# deliberately hostile same-user process; protected-environment review is the
# trust boundary for approved credentialed candidates. Sources are copied from
# locked handles, revalidated in a fresh root and sealed with a hash inventory.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SourceBase,
    [Parameter(Mandatory)][string[]]$InputPath,
    [Parameter(Mandatory)][string]$OutputRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceBasePath = [IO.Path]::GetFullPath($SourceBase)
$sourcePrefix = [IO.Path]::TrimEndingDirectorySeparator($sourceBasePath) + [IO.Path]::DirectorySeparatorChar
$outputPath = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $outputPath) { throw 'The evidence staging root must be fresh.' }
[void][IO.Directory]::CreateDirectory($outputPath)

$allowedExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.csv', '.etl', '.jpeg', '.jpg', '.json', '.log', '.md', '.png', '.txt', '.xml') |
    ForEach-Object { [void]$allowedExtensions.Add($_) }
$stagedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$manifestRows = [Collections.Generic.List[object]]::new()
$oleHeader = [byte[]](0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)

function Get-BoundedEvidenceFiles([IO.FileSystemInfo]$Item) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Evidence input contains a reparse point: $($Item.FullName)"
    }
    if ($Item -is [IO.FileInfo]) { return @($Item) }
    $files = [Collections.Generic.List[IO.FileInfo]]::new()
    $pending = [Collections.Generic.Queue[IO.DirectoryInfo]]::new()
    $pending.Enqueue([IO.DirectoryInfo]$Item)
    while ($pending.Count -gt 0) {
        foreach ($child in $pending.Dequeue().EnumerateFileSystemInfos()) {
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Evidence input contains a reparse point: $($child.FullName)"
            }
            if ($child -is [IO.DirectoryInfo]) { $pending.Enqueue($child) }
            else { $files.Add([IO.FileInfo]$child) }
        }
    }
    return $files.ToArray()
}

function Assert-NonRunnableHeader([byte[]]$Header, [int]$Read, [string]$DisplayPath) {
    $portableExecutable = $Read -ge 2 -and $Header[0] -eq 0x4D -and $Header[1] -eq 0x5A
    $compoundBinary = $Read -ge 8
    if ($compoundBinary) {
        for ($index = 0; $index -lt $oleHeader.Length; $index += 1) {
            if ($Header[$index] -ne $oleHeader[$index]) { $compoundBinary = $false; break }
        }
    }
    if ($portableExecutable -or $compoundBinary) {
        throw "Evidence input contains PE or MSI/OLE runnable content: $DisplayPath"
    }
}

function Copy-ValidatedEvidence([IO.FileInfo]$File, [string]$Relative, [string]$Destination) {
    if (-not $allowedExtensions.Contains($File.Extension)) {
        throw "Evidence input has a non-allowlisted extension: $($File.FullName)"
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    $source = [IO.FileStream]::new($File.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read,
        [IO.FileShare]::Read, 1MB, [IO.FileOptions]::SequentialScan)
    try {
        [byte[]]$header = [byte[]]::new(8)
        $read = $source.Read($header, 0, $header.Length)
        Assert-NonRunnableHeader $header $read $File.FullName
        $source.Position = 0
        if ($File.Extension -ieq '.json') {
            $reader = [IO.StreamReader]::new($source, [Text.UTF8Encoding]::new($false), $true, 4096, $true)
            try { $json = $reader.ReadToEnd() } finally { $reader.Dispose() }
            try { $null = $json | ConvertFrom-Json }
            catch { throw "Evidence input is not valid JSON: $($File.FullName)" }
            $source.Position = 0
        }
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { $sourceHash = [Convert]::ToHexString($sha256.ComputeHash($source)).ToLowerInvariant() }
        finally { $sha256.Dispose() }
        $source.Position = 0
        $destinationStream = [IO.FileStream]::new($Destination, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $source.CopyTo($destinationStream); $destinationStream.Flush($true) }
        finally { $destinationStream.Dispose() }
    } finally { $source.Dispose() }
    $copied = Get-Item -LiteralPath $Destination -Force
    $copiedHash = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copied.Length -ne $File.Length -or $copiedHash -cne $sourceHash) {
        throw 'A staged evidence file changed while it was copied.'
    }
    $manifestRows.Add([ordered]@{ path = $Relative.Replace('\', '/'); bytes = $copied.Length; sha256 = $copiedHash })
}

foreach ($input in $InputPath) {
    $inputFullPath = [IO.Path]::GetFullPath($input)
    if (-not $inputFullPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'An evidence input escaped its declared source base.'
    }
    if (-not (Test-Path -LiteralPath $inputFullPath)) { continue }
    $item = Get-Item -LiteralPath $inputFullPath -Force
    foreach ($file in @(Get-BoundedEvidenceFiles $item)) {
        $relative = [IO.Path]::GetRelativePath($sourceBasePath, $file.FullName)
        if ($relative -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($relative)) {
            throw 'An evidence file escaped its declared source base.'
        }
        $normalized = $relative.Replace('\', '/')
        if (-not $stagedPaths.Add($normalized)) { continue }
        if ($normalized -ceq 'evidence-manifest.json') { throw 'Evidence input used the reserved manifest path.' }
        $destination = Join-Path $outputPath $relative
        Copy-ValidatedEvidence $file $relative $destination
    }
}

$rows = @($manifestRows.ToArray() | Sort-Object { $_.path })
$manifestPath = Join-Path $outputPath 'evidence-manifest.json'
$manifest = [ordered]@{
    schemaVersion = 1
    classification = 'accidental-runnable-free-windows-evidence'
    files = $rows
}
$manifestJson = $manifest | ConvertTo-Json -Depth 5
$manifestStream = [IO.FileStream]::new($manifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $writer = [IO.StreamWriter]::new($manifestStream, [Text.UTF8Encoding]::new($false), 4096, $true)
    try { $writer.Write($manifestJson); $writer.Flush(); $manifestStream.Flush($true) } finally { $writer.Dispose() }
} finally { $manifestStream.Dispose() }

$outputItems = @(Get-ChildItem -LiteralPath $outputPath -Recurse -Force)
if (@($outputItems | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
    throw 'The staged evidence contains a reparse point.'
}
$outputFiles = @($outputItems | Where-Object { $_ -is [IO.FileInfo] })
if ($outputFiles.Count -ne $rows.Count + 1) { throw 'The staged evidence inventory changed before upload.' }
foreach ($row in $rows) {
    $file = Get-Item -LiteralPath (Join-Path $outputPath $row.path) -Force
    if ($file.Length -ne [long]$row.bytes -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$row.sha256) {
        throw 'The staged evidence differs from its hash inventory.'
    }
}
Write-Output $rows.Count
