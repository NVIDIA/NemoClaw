# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI-only input preparation. This script is never part of the installed application.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$LockPath,
    [Parameter(Mandatory=$true)][string]$OutputDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::Arm64) {
    throw 'Application compilation requires the native GitHub Windows ARM64 runner.'
}
$lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
$artifacts = @($lock.artifacts | Where-Object { $_.file -ceq 'node-v22.23.2-win-arm64.zip' })
if ($artifacts.Count -ne 1) { throw 'The canonical runtime lock must contain exactly one selected Node artifact.' }
$artifact = $artifacts[0]
if ($artifact.url -cne 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-arm64.zip' -or
    $artifact.sha256 -cne 'fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3' -or
    $artifact.size -ne 31418167) { throw 'The selected Node distribution differs from the reviewed compilation input.' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Application Node preparation requires a fresh output directory.' }
$null = New-Item -ItemType Directory -Path $output
$archive = Join-Path $output $artifact.file
Invoke-WebRequest -Uri $artifact.url -OutFile $archive -UseBasicParsing -TimeoutSec 180
if ((Get-Item -LiteralPath $archive).Length -ne $artifact.size -or
    (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.sha256) {
    throw 'The downloaded Node distribution failed its immutable size or SHA-256 check.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    # npm is retained only as a pinned CI build tool for selected Node agents;
    # prepare-finished-host copies only node.exe and LICENSE into the product.
    foreach ($name in @('node.exe', 'LICENSE', 'npm.cmd')) {
        $members = @($zip.Entries | Where-Object { $_.FullName -ceq "node-v22.23.2-win-arm64/$name" })
        if ($members.Count -ne 1) { throw 'The verified Node archive has an unexpected executable/license layout.' }
        $stream = $members[0].Open()
        try {
            $destination = [IO.File]::Open((Join-Path $output $name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.CopyTo($destination) } finally { $destination.Dispose() }
        } finally { $stream.Dispose() }
    }
    $npmPrefix = 'node-v22.23.2-win-arm64/node_modules/npm/'
    foreach ($member in @($zip.Entries | Where-Object { $_.FullName.StartsWith($npmPrefix, [StringComparison]::Ordinal) })) {
        $relative = $member.FullName.Substring($npmPrefix.Length)
        if ([string]::IsNullOrEmpty($relative)) { continue }
        if ($relative.Contains('..') -or $relative.Contains(':') -or $relative.StartsWith('/')) {
            throw 'The verified npm member has an unsafe path.'
        }
        $destination = Join-Path $output ('node_modules\npm\' + $relative.Replace('/', '\'))
        if ($member.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($destination) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        $stream = $member.Open()
        try {
            $file = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.CopyTo($file) } finally { $file.Dispose() }
        } finally { $stream.Dispose() }
    }
} finally { $zip.Dispose() }
$node = Join-Path $output 'node.exe'
$version = & $node -p 'JSON.stringify({version:process.versions.node,platform:process.platform,architecture:process.arch})'
if ($LASTEXITCODE -ne 0) { throw 'The verified Node executable failed its native execution check.' }
$identity = $version | ConvertFrom-Json
if ($identity.version -cne '22.23.2' -or $identity.platform -cne 'win32' -or $identity.architecture -cne 'arm64') {
    throw 'The selected compiler/runtime is not the pinned native Windows ARM64 Node.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $node
$npmVersion = (& $node (Join-Path $output 'node_modules\npm\bin\npm-cli.js') --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $npmVersion -cne '10.9.8') { throw 'The pinned Node archive npm tool is invalid.' }
$receipt = [ordered]@{
    schemaVersion = 1; classification = 'compiled-windows-app-node-input'
    upstream = $artifact.url; archiveSha256 = $artifact.sha256
    nodeSha256 = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
    licenseSha256 = (Get-FileHash -LiteralPath (Join-Path $output 'LICENSE') -Algorithm SHA256).Hash.ToLowerInvariant()
    runtime = $identity; signatureStatus = $signature.Status.ToString()
    signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    npmVersion = $npmVersion
    controllerSource = $env:GITHUB_SHA
    installedAcceptance = $false
}
[IO.File]::WriteAllText((Join-Path $output 'node-input.json'), (($receipt | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Host 'Pinned native Node application/compiler input is ready; no package manager was installed.'
