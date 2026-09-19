# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [string]$PythonPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'This is a Windows CI export control.' }
if (Test-Path -LiteralPath $ArtifactDirectory) { throw 'The export-control directory must be fresh.' }
$null=New-Item -ItemType Directory -Path $ArtifactDirectory
$receipt=[ordered]@{schemaVersion=1;classification='official-runtime-export-controls';status='fail';runtimeQualified=$false;installedAcceptance=$false;inputs=@()}
$primary=$null
$previousPython=$env:NEMOCLAW_TEST_PYTHON
$previousEvidence=$env:NEMOCLAW_EXPORT_CONTROL_EVIDENCE
try {
    $lock=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'official-runtime.lock.json') -Raw|ConvertFrom-Json
    $components=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'official-components.lock.json') -Raw|ConvertFrom-Json
    if ($lock.upstreamCommit -cne $components.upstream.commit -or $lock.upstreamCommit -cne '2237be355906fbe6065ce1815711eee52b2d646e') { throw 'The component and runtime inputs disagree.' }
    $nodes=@($lock.artifacts|Where-Object id -CEQ 'node')
    $pythons=@($components.artifacts|Where-Object id -CEQ 'python')
    if ($nodes.Count -ne 1 -or $pythons.Count -ne 1) { throw 'The exact interpreter inputs are ambiguous.' }
    $tools=Join-Path $ArtifactDirectory 'tools'
    $null=New-Item -ItemType Directory -Path $tools
    $required=@($nodes[0])
    if ([string]::IsNullOrEmpty($PythonPath)) { $required+=@($pythons[0]) }
    foreach ($item in $required) {
        if ([IO.Path]::GetFileName([string]$item.file) -cne $item.file -or -not ([string]$item.url).StartsWith('https://',[StringComparison]::Ordinal)) { throw 'Invalid interpreter artifact location.' }
        $file=Join-Path $tools $item.file
        Invoke-WebRequest -Uri $item.url -OutFile $file -TimeoutSec 120
        $hash=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ((Get-Item -LiteralPath $file).Length -ne $item.size -or $hash -cne $item.sha256) { throw 'An interpreter archive differs from its immutable input.' }
        $receipt.inputs+=@{id=$item.id;url=$item.url;bytes=$item.size;sha256=$hash}
    }
    $nodeArchive=Join-Path $tools $nodes[0].file
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $tools 'node')
    $node=Join-Path $tools 'node\node-v22.23.2-win-arm64\node.exe'
    if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878') { throw 'The executed Node differs from the exact ARM64 pin.' }
    if ([string]::IsNullOrEmpty($PythonPath)) {
        $pythonRoot=Join-Path $tools 'python'
        $null=New-Item -ItemType Directory -Path $pythonRoot
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf (Join-Path $tools $pythons[0].file) -C $pythonRoot --strip-components=1
        if ($LASTEXITCODE -ne 0) { throw 'The complete pinned Python archive did not extract.' }
        $PythonPath=Join-Path $pythonRoot 'python.exe'
    }
    $PythonPath=[IO.Path]::GetFullPath($PythonPath)
    $pythonCheck=Join-Path $ArtifactDirectory 'check-python.py'
    [IO.File]::WriteAllText($pythonCheck, "import sys, platform`nassert sys.version_info[:3] == (3, 11, 16)`nassert platform.machine().upper() == 'ARM64'`nprint('PINNED_EXPORT_PYTHON_OK')`n", [Text.UTF8Encoding]::new($false))
    & $PythonPath -I $pythonCheck
    if ($LASTEXITCODE -ne 0) { throw 'Export controls require the actual official Python3.11.16 ARM64 interpreter.' }
    $receipt['nodeArchive']=$nodeArchive
    $receipt['nodeArchiveSha256']=$nodes[0].sha256
    $receipt['pythonPath']=$PythonPath
    $receipt['pythonSha256']=(Get-FileHash -LiteralPath $PythonPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $env:NEMOCLAW_TEST_PYTHON=$PythonPath
    $results=Join-Path $ArtifactDirectory 'results'
    $null=New-Item -ItemType Directory -Path $results
    $env:NEMOCLAW_EXPORT_CONTROL_EVIDENCE=$results
    & $node --experimental-strip-types --no-warnings --test (Join-Path $PSScriptRoot 'official-runtime-export.test.mts')
    if ($LASTEXITCODE -ne 0) { throw 'The actual Windows export/link/integrity controls failed.' }
    $receipt.status='pass'
} catch { $primary=$_; $receipt['error']=$_.Exception.Message }
finally {
    $env:NEMOCLAW_TEST_PYTHON=$previousPython
    $env:NEMOCLAW_EXPORT_CONTROL_EVIDENCE=$previousEvidence
    try { [IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'export-controls.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) {$primary=$_} else {Write-Warning 'The export-control receipt also could not be saved.'} }
}
if ($null -ne $primary) { throw $primary }
