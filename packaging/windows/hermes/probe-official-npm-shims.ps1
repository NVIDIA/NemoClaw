# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'This is an explicit Windows CI compiler diagnostic.' }
if (Test-Path -LiteralPath $ArtifactDirectory) { throw 'The diagnostic directory must be fresh.' }
$null=New-Item -ItemType Directory -Path $ArtifactDirectory
$receipt=[ordered]@{schemaVersion=1;classification='official-npm12-Windows-shim-inputs';status='fail';runtimeQualified=$false;inputs=@()}
$primary=$null
$priorNpm=$env:NEMOCLAW_TEST_NPM_ROOT
try {
    $lockPath=Join-Path $PSScriptRoot 'official-runtime.lock.json'
    $lock=Get-Content -LiteralPath $lockPath -Raw|ConvertFrom-Json
    if ($lock.upstreamCommit -cne '2237be355906fbe6065ce1815711eee52b2d646e') { throw 'Unexpected official source identity.' }
    $nodeInputs=@($lock.artifacts|Where-Object id -CEQ 'node')
    $npmInputs=@($lock.nodeBuildTools|Where-Object id -CEQ 'npm')
    if ($nodeInputs.Count -ne 1 -or $npmInputs.Count -ne 1 -or $npmInputs[0].sha256 -cne '5dbb86c71d07a1957f2e90734092dd6a58bdcd9ebc2d8d41ca1c6e6a21d364e1') { throw 'The exact compiler inputs are missing.' }
    $tools=Join-Path $ArtifactDirectory 'tools'
    $null=New-Item -ItemType Directory -Path $tools
    foreach ($item in @($nodeInputs[0],$npmInputs[0])) {
        if ([IO.Path]::GetFileName([string]$item.file) -cne $item.file -or -not ([string]$item.url).StartsWith('https://',[StringComparison]::Ordinal)) { throw 'Invalid official artifact path.' }
        $file=Join-Path $tools $item.file
        Invoke-WebRequest -Uri $item.url -OutFile $file -TimeoutSec 120
        $sha=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ((Get-Item -LiteralPath $file).Length -ne $item.size -or $sha -cne $item.sha256) { throw 'The immutable compiler archive differs.' }
        $receipt.inputs+=@{id=$item.id;url=$item.url;bytes=$item.size;sha256=$sha}
    }
    Expand-Archive -LiteralPath (Join-Path $tools $nodeInputs[0].file) -DestinationPath (Join-Path $tools 'node')
    $node=Join-Path $tools 'node\node-v22.23.2-win-arm64\node.exe'
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878') { throw 'The executed Node does not match its ARM64 pin.' }
    $npm=Join-Path $tools 'npm'
    $null=New-Item -ItemType Directory -Path $npm
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf (Join-Path $tools $npmInputs[0].file) -C $npm --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'The verified npm archive did not extract.' }
    $env:NEMOCLAW_TEST_NPM_ROOT=$npm
    & $node --experimental-strip-types --no-warnings --test (Join-Path $PSScriptRoot 'probe-official-npm-shims.test.mts')
    if ($LASTEXITCODE -ne 0) { throw 'The pinned shim source/output controls failed.' }
    & $node --experimental-strip-types --no-warnings (Join-Path $PSScriptRoot 'probe-official-npm-shims.mts') --npm-root $npm --artifact-directory (Join-Path $ArtifactDirectory 'control')
    if ($LASTEXITCODE -ne 0) { throw 'The actual Windows negative/positive command proof failed.' }
    $result=Get-Content -LiteralPath (Join-Path $ArtifactDirectory 'control\npm-shim-control.json') -Raw|ConvertFrom-Json
    if ($result.status -cne 'pass' -or $result.hypothesisConfirmed -ne $true -or $result.workspaceRemoved -ne $true -or $result.actualHermesBuild -ne $false) { throw 'The shim proof is incomplete.' }
    $receipt.status='pass'
} catch { $primary=$_; $receipt['error']=$_.Exception.Message }
finally {
    $env:NEMOCLAW_TEST_NPM_ROOT=$priorNpm
    try { [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'inputs.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) {$primary=$_} else {Write-Warning 'The input receipt also could not be saved.'} }
}
if ($null -ne $primary) { throw $primary }
