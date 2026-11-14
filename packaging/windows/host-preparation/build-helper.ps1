# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') {
    throw 'The installer metadata helper is built only on the disposable Windows CI runner.'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($output) | Out-Null
$target = Join-Path $output 'rust-target'
$rustup = @(Get-Command rustup -CommandType Application -ErrorAction Stop)[0].Source
$previous = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    & $rustup run 1.95.0-aarch64-pc-windows-msvc cargo rustc --locked --offline --release `
        --manifest-path (Join-Path $PSScriptRoot 'Cargo.toml') --bin NemoClawHostPreparation `
        --target aarch64-pc-windows-msvc --target-dir $target -- -C target-feature=+crt-static `
        2>&1 | Tee-Object -FilePath (Join-Path $output 'build.log') | Out-Host
    $code = $LASTEXITCODE
} finally { $ErrorActionPreference = $previous }
if ($code -ne 0) { throw 'The native metadata helper build failed; its log is retained.' }
$built = Join-Path $target 'aarch64-pc-windows-msvc\release\NemoClawHostPreparation.exe'
$bytes = [IO.File]::ReadAllBytes($built)
if ($bytes.Length -lt 64 -or [BitConverter]::ToUInt16($bytes,0) -ne 0x5a4d) { throw 'The metadata helper is not a Windows executable.' }
$offset = [BitConverter]::ToInt32($bytes,0x3c)
if ($offset -lt 64 -or $offset -gt $bytes.Length-6 -or [BitConverter]::ToUInt32($bytes,$offset) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$offset+4) -ne 0xaa64) {
    throw 'The metadata helper is not native Windows ARM64.'
}
$destination = Join-Path $output 'NemoClawHostPreparation.exe'
[IO.File]::WriteAllBytes($destination,$bytes)
$sources = @(Get-ChildItem -LiteralPath $PSScriptRoot -File | Where-Object { $_.Extension -eq '.rs' -or $_.Name -in @('Cargo.toml','Cargo.lock','build-helper.ps1') } | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{ file=$_.Name; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$receipt = [ordered]@{ schemaVersion=1; classification='native-system-drive-preparation-build'; architecture='arm64'
    rustToolchain='1.95.0-aarch64-pc-windows-msvc'; file='NemoClawHostPreparation.exe'; bytes=$bytes.Length
    sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant(); sources=$sources
    systemRootProofRequired=$true; mxcLaunchProofRequired=$true; admissionAllowed=$false }
[IO.File]::WriteAllText((Join-Path $output 'build-receipt.json'), (($receipt|ConvertTo-Json -Depth 5)+"`n"), [Text.UTF8Encoding]::new($false))
