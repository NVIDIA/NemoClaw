# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$ComponentEvidenceDirectory,
    [Parameter(Mandatory)][string]$RustcPath,
    [Parameter(Mandatory)][string]$CargoPath,
    [Parameter(Mandatory)][string]$ControllerSource,
    [string]$LockPath = '',
    [string]$ReuseInputsPath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $ControllerSource -cnotmatch '^[a-f0-9]{40}$'){
    throw 'Complete runtime provisioning is an explicit Windows CI build phase.'
}
if(-not [string]::IsNullOrEmpty($ReuseInputsPath)){
    & (Join-Path $PSScriptRoot 'prepare-reused-runtime.ps1') -RuntimeRoot $RuntimeRoot -ArtifactDirectory $ArtifactDirectory -ControllerSource $ControllerSource -InputFile $ReuseInputsPath
    return
}
if([string]::IsNullOrEmpty($LockPath)){$LockPath=Join-Path $PSScriptRoot 'official-python.lock.json'}
$build=Join-Path (Split-Path -Parent $ArtifactDirectory) 'official-hermes-runtime-build'
$candidate=Join-Path (Split-Path -Parent $ArtifactDirectory) 'official-hermes-runtime-candidate'
if((Test-Path -LiteralPath $build) -or (Test-Path -LiteralPath $candidate)){throw 'Complete runtime output must be fresh.'}
$receipt=[ordered]@{schemaVersion=1;classification='official-hermes-runtime-build-phase';controllerSource=$ControllerSource;status='failed';phase='python-prerequisites';installedAcceptance=$false;runtimeExecutionQualified=$false;activationAllowed=$false}
$primary=$null
$previousTestPython=$env:NEMOCLAW_TEST_PYTHON
try {
    $baseControlPython=Join-Path $RuntimeRoot 'hermes-agent\.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe'
    & $baseControlPython -I (Join-Path $PSScriptRoot 'test_official_runtime_build.py')
    if($LASTEXITCODE -ne 0){throw 'The official runtime controller controls failed before provisioning.'}
    & $baseControlPython -I (Join-Path $PSScriptRoot 'test_generated_finder_paths.py')
    if($LASTEXITCODE -ne 0){throw 'The generated canonical finder controls failed before provisioning.'}
    # Reject portable-export fixture failures before any expensive dependency build.
    $receipt.phase='candidate-export-controls'
    $exportControls=Join-Path (Split-Path -Parent $ArtifactDirectory) 'official-hermes-export-controls'
    & (Join-Path $PSScriptRoot 'test-official-runtime-export.ps1') -ArtifactDirectory $exportControls -PythonPath $baseControlPython
    $exportInputs=Get-Content -LiteralPath (Join-Path $exportControls 'export-controls.json') -Raw|ConvertFrom-Json
    if ($exportInputs.status -cne 'pass') { throw 'The exact Windows export controls did not pass.' }
    $receipt.phase='python-prerequisites'
    # Same selected VS environment and exact current native dependency controller.
    # Failure here precedes any large browser or desktop dependency download.
    & (Join-Path $PSScriptRoot 'prepare-official-python.ps1') -RuntimeRoot $RuntimeRoot `
        -ArtifactDirectory $ArtifactDirectory -ComponentEvidenceDirectory $ComponentEvidenceDirectory `
        -RustcPath $RustcPath -CargoPath $CargoPath -LockPath $LockPath
    $phase=Get-Content -LiteralPath (Join-Path $ArtifactDirectory 'python-phase.json') -Raw|ConvertFrom-Json
    if($phase.status -cne 'python-provisioned'){throw 'The complete build requires the successful exact Python prerequisite phase.'}
    $python=Join-Path $RuntimeRoot 'hermes-agent\.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe'
    $components=Join-Path $PSScriptRoot 'official-components.lock.json'
    $componentLock=Get-Content -LiteralPath $components -Raw|ConvertFrom-Json
    $sources=@($componentLock.artifacts|Where-Object {$_.id -ceq 'hermes-source'})
    if($sources.Count -ne 1){throw 'The official source archive identity is ambiguous.'}
    $archive=Join-Path (Join-Path $ComponentEvidenceDirectory 'downloads') $sources[0].file
    if((Get-Item -LiteralPath $archive).Length -ne $sources[0].size -or
        (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sources[0].sha256){
        throw 'The complete runtime source archive differs from its immutable identity.'
    }
    $receipt.phase='complete-official-stages'
    $arguments=@('-I',(Join-Path $PSScriptRoot 'provision-official-runtime.py'),'--phase','runtime','--runtime-root',$RuntimeRoot,
        '--artifact-directory',$build,'--component-lock',$components,'--source-archive',$archive,'--python-phase-evidence',$ArtifactDirectory,'--node-archive',$exportInputs.nodeArchive)
    foreach($directory in $phase.buildToolPaths){$arguments+=@('--build-tool-path',[string]$directory)}
    & $python @arguments
    if($LASTEXITCODE -ne 0){throw 'The complete official runtime stages failed; no candidate archive may be admitted.'}
    $receipt.phase='generated-metadata-adaptation'
    $adaptation=Join-Path $build 'native-adaptation.json'
    & $python -I (Join-Path $PSScriptRoot 'prepare-native-runtime.py') `
        --runtime-root $RuntimeRoot --source-root $RuntimeRoot --target-root $RuntimeRoot `
        --environment 'hermes-agent/venv' --environment 'tools/browser-use' `
        --browser-use-outer-inventory (Join-Path $build 'browser-use-outer-before-relocation.json') `
        --diagnostics-directory (Join-Path $build 'generated-launchers') --receipt $adaptation
    if($LASTEXITCODE -ne 0){throw 'The exact generated metadata adapter failed.'}
    $receipt.phase='complete-candidate-byte-export'
    & $python -I (Join-Path $PSScriptRoot 'export-official-runtime.py') --runtime-root $RuntimeRoot `
        --source-archive $archive --build-receipt (Join-Path $build 'official-runtime-build.json') `
        --adaptation-receipt $adaptation --output-directory $candidate --controller-source $ControllerSource
    if($LASTEXITCODE -ne 0){throw 'The candidate bytes or provenance could not be exported completely.'}
    $result=Get-Content -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Raw|ConvertFrom-Json
    if($result.status -cne 'candidate-bytes-exported' -or $result.completeByteInventory -ne $true -or
        $result.runtimeExecutionQualified -ne $false -or $result.installedAcceptance -ne $false -or $result.activationAllowed -ne $false){
        throw 'The candidate exporter did not satisfy its build-only result contract.'
    }
    $receipt.status='candidate-bytes-exported-unqualified'
    $receipt['candidateReceiptSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Algorithm SHA256).Hash.ToLowerInvariant()
} catch {$primary=$_;$receipt['error']=$_.Exception.Message}
finally {
    $env:NEMOCLAW_TEST_PYTHON=$previousTestPython
    # No baseline/MSI, MXC, qualification or product activation occurs here.
    # Retain the complete candidate even though the independent Bash/MXC gate is blocked.
    $file=Join-Path (Split-Path -Parent $ArtifactDirectory) 'official-hermes-runtime-phase.json'
    try {[IO.File]::WriteAllText($file,($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'The runtime phase receipt also could not be saved.'}}
}
if($null -ne $primary){throw $primary}
