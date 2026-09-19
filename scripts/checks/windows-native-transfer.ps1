# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Creates or verifies the content-addressed manifest around a same-run Actions
# cache. A cache key is only a lookup key; this manifest is the byte-identity
# boundary checked again by every consumer before any executable is launched.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Create', 'Verify')][string]$Mode,
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][ValidateSet('compiled-application', 'finished-installer', 'bash-compatibility')][string]$Kind,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceRevision,
    [Parameter(Mandatory)][ValidateSet('openclaw', 'hermes', 'pi')][string]$Agent,
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]*$')][string]$RunId,
    [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]*$')][string]$RunAttempt,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestSha256 = '',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:exe|msi)$')][string[]]$ExpectedPackageRunnables = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root)
$manifestPath = Join-Path $rootPath 'transfer-manifest.json'

function Get-TransferFiles {
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
        throw 'The transfer root is missing.'
    }
    $rootItem = Get-Item -LiteralPath $rootPath -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The transfer root must not be a reparse point.'
    }
    $items = @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force)
    foreach ($item in $items) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "The transfer tree contains a reparse point: $($item.FullName)"
        }
    }
    return @($items | Where-Object { $_ -is [IO.FileInfo] -and $_.FullName -cne $manifestPath } | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($rootPath, $_.FullName).Replace('\', '/')
        if ($relative -match '(^|/)\.\.(/|$)' -or $relative.StartsWith('/') -or [IO.Path]::IsPathRooted($relative)) {
            throw 'A transfer entry escaped its root.'
        }
        [ordered]@{
            path = $relative
            bytes = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    } | Sort-Object { $_.path })
}

function Assert-ExpectedPackageRunnables {
    if ($ExpectedPackageRunnables.Count -eq 0) { return }
    if ($Mode -cne 'Verify' -or $Kind -cne 'finished-installer') {
        throw 'A package runnable allowlist is valid only while verifying a finished installer.'
    }
    $expectedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $ExpectedPackageRunnables) {
        if (-not $expectedNames.Add($name)) { throw 'The package runnable allowlist contains a duplicate.' }
    }
    $packagePath = Join-Path $rootPath 'package'
    if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) {
        throw 'The finished installer package directory is missing.'
    }
    $actualRunnables = @(Get-ChildItem -LiteralPath $packagePath -File -Force | Where-Object {
        $_.Extension -ieq '.exe' -or $_.Extension -ieq '.msi'
    })
    if ($actualRunnables.Count -ne $expectedNames.Count -or
        @($actualRunnables | Where-Object { -not $expectedNames.Contains($_.Name) }).Count -ne 0) {
        throw 'The package runnable inventory differs from the qualified publication allowlist.'
    }
    $receiptPath = Join-Path $packagePath 'immutable-package-build.json'
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $receiptFiles = @($receipt.files)
    if ($receipt.sourceRevision -cne $SourceRevision -or
        $receipt.status -cne 'candidate-built-for-installed-qualification' -or
        $receiptFiles.Count -ne $expectedNames.Count) {
        throw 'The immutable package receipt does not identify the exact publication inventory.'
    }
    foreach ($name in $ExpectedPackageRunnables) {
        $rows = @($receiptFiles | Where-Object { [string]$_.file -ceq $name })
        $file = Get-Item -LiteralPath (Join-Path $packagePath $name) -Force
        if ($rows.Count -ne 1 -or [long]$rows[0].bytes -ne $file.Length -or
            [string]$rows[0].sha256 -cne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) {
            throw 'A qualified publication runnable differs from its immutable package receipt.'
        }
    }
}

if ($Mode -ceq 'Create') {
    if (Test-Path -LiteralPath $manifestPath) { throw 'The transfer manifest must be created exactly once.' }
    $files = @(Get-TransferFiles)
    if ($files.Count -eq 0) { throw 'A transfer cache cannot be empty.' }
    $manifest = [ordered]@{
        schemaVersion = 1
        classification = 'same-run-private-executable-transfer'
        kind = $Kind
        sourceRevision = $SourceRevision
        agent = $Agent
        workflowRunId = $RunId
        workflowRunAttempt = $RunAttempt
        files = $files
    }
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    return
}

if (-not $ExpectedManifestSha256) { throw 'Verification requires the producer manifest SHA-256.' }
$actualManifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualManifestHash -cne $ExpectedManifestSha256) { throw 'The transfer manifest differs from the producer output.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.classification -cne 'same-run-private-executable-transfer' -or
    $manifest.kind -cne $Kind -or $manifest.sourceRevision -cne $SourceRevision -or $manifest.agent -cne $Agent -or
    [string]$manifest.workflowRunId -cne $RunId -or [string]$manifest.workflowRunAttempt -cne $RunAttempt) {
    throw 'The transfer manifest identity does not match this exact workflow run.'
}
$expectedFiles = @($manifest.files)
if ($expectedFiles.Count -eq 0 -or @($expectedFiles.path | Sort-Object -Unique).Count -ne $expectedFiles.Count) {
    throw 'The transfer manifest has an empty or duplicate inventory.'
}
$actualFiles = @(Get-TransferFiles)
if ($actualFiles.Count -ne $expectedFiles.Count) { throw 'The transfer cache file count changed.' }
for ($index = 0; $index -lt $expectedFiles.Count; $index += 1) {
    $expected = $expectedFiles[$index]
    $actual = $actualFiles[$index]
    if ([string]$expected.path -cnotmatch '^[^/\\]+(?:/[^/\\]+)*$' -or [string]$expected.path -match '(^|/)\.\.(/|$)' -or
        $actual.path -cne [string]$expected.path -or $actual.bytes -ne [long]$expected.bytes -or
        $actual.sha256 -cne [string]$expected.sha256) {
        throw 'A transfer cache entry differs from its manifest.'
    }
}
Assert-ExpectedPackageRunnables
Write-Output $actualManifestHash
