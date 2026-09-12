# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$BootstrapDirectory,
    [Parameter(Mandatory)][string]$HelperDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'This candidate test requires disposable Windows CI.' }
$output=[IO.Path]::GetFullPath($ArtifactDirectory)
if (Test-Path -LiteralPath $output) { throw 'The Personal evidence directory must be fresh.' }
$null=New-Item -ItemType Directory -Path $output
$downloads=Join-Path $output 'downloads'
$null=New-Item -ItemType Directory -Path $downloads
$root=[IO.Path]::GetPathRoot([Environment]::SystemDirectory)
$runtime=Join-Path $root 'NemoClawHermesProbe-274d797050ea'
$primary=$null;$mxcAttempted=$false;$runtimeOwned=$false
$receipt=[ordered]@{schemaVersion=1;classification='canonical-personal-mxc-candidate-feasibility';sourceRevision=$env:GITHUB_SHA;
    candidateSource='8d78fe458e9268a7afdc8ed06b85c23306452036';artifactId=10293082661;status='failed';runtimeRebuilt=$false;runtimeExported=$false;
    installedAcceptance=$false;fullAgentQualified=$false;runtimeRoot=$runtime;cleanupErrors=@()}
function Invoke-PersonalChecked([string]$Executable,[string[]]$Arguments,[string]$Label) {
    $receipt['activeStage']=$Label
    Write-Host ('[Hermes Personal] '+$Label)
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $output (($Label -replace '[^a-zA-Z0-9-]','-')+'.log'))
    if ($LASTEXITCODE -ne 0) { throw ($Label+' failed with exit '+$LASTEXITCODE) }
}
try {
    $bootstrap=Get-Content -LiteralPath (Join-Path $BootstrapDirectory 'export-controls.json') -Raw|ConvertFrom-Json
    if ($bootstrap.status -cne 'pass') { throw 'Pinned interpreter/bootstrap controls did not pass.' }
    $python=[string]$bootstrap.pythonPath
    $node=Join-Path $BootstrapDirectory 'tools\node\node-v22.23.2-win-arm64\node.exe'
    foreach($pin in @(@($python,'54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b'),@($node,'97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'))) {
        if ((Get-FileHash -LiteralPath $pin[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin[1]) { throw 'A bootstrap interpreter changed after archive verification.' }
    }
    $receipt['bootstrapPythonSha256']=$bootstrap.pythonSha256
    $receipt['bootstrapNodeSha256']='97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'
    $candidate=Join-Path $output 'verification'
    Invoke-PersonalChecked $python @('-I',(Join-Path $PSScriptRoot 'replay-personal-runtime.py'),
        '--zip',(Join-Path $downloads 'candidate.zip'),'--output',$candidate,'--runtime-root',$runtime) 'Verify and place complete immutable runtime'
    $ownership=Get-Content -LiteralPath (Join-Path $candidate 'runtime-ownership.json') -Raw|ConvertFrom-Json
    if($ownership.runtimeRoot -cne $runtime -or $ownership.createdByReplay -cne $true){throw 'Completed replay extraction ownership is not confirmed.'}
    $runtimeOwned=$true
    $derivation=Get-Content -LiteralPath (Join-Path $candidate 'candidate-derivation.json') -Raw|ConvertFrom-Json
    $original=[string]$derivation.originalBuildRoot
    if($original -ceq $runtime -or (Test-Path -LiteralPath $original)){throw 'The original pre-adaptation root must remain absent.'}
    $receipt['originalBuildRoot']=$original
    $receipt['originalBuildRootAbsent']=$true
    $receipt['replayInputSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'replay-input.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $compatZip=Join-Path $downloads 'passed-bash-compatibility.zip'
    $headers=@{Authorization=('Bearer '+$env:GH_TOKEN);Accept='application/vnd.github+json'}
    Invoke-WebRequest -Uri 'https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/10294450574/zip' -Headers $headers -OutFile $compatZip -TimeoutSec 120
    if((Get-Item -LiteralPath $compatZip).Length -ne 11208445 -or (Get-FileHash -LiteralPath $compatZip -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'f9701fb60b7553891cf9665a4abfe31c26937141cd945a190fbbc3f8acd7b612'){throw 'The passed Bash artifact changed.'}
    $compatExtract=Join-Path $downloads 'passed-bash'
    $zip=[IO.Compression.ZipFile]::OpenRead($compatZip)
    try{
        if($zip.Entries.Count -ne 85 -or ($zip.Entries|Measure-Object -Property Length -Sum).Sum -ne 33598871){throw 'The passed Bash archive layout changed.'}
        foreach($entry in $zip.Entries){
            $target=[IO.Path]::GetFullPath((Join-Path $compatExtract $entry.FullName))
            if(-not $target.StartsWith($compatExtract+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'The passed Bash archive path escapes its owned output.'}
        }
    }finally{$zip.Dispose()}
    Expand-Archive -LiteralPath $compatZip -DestinationPath $compatExtract
    $compatEvidence=Join-Path $compatExtract 'bash-compat-evidence'
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    $receipt['derivedCandidateReceiptSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt['compatibilityProofSource']='336a9ac95d9cacb005785e04fe0a9ddaa43df952'
    $receipt['completeBaseReused']=$true
    $sdk=Join-Path $downloads 'mxc-sdk.tgz'
    Invoke-WebRequest -Uri 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz' -OutFile $sdk -TimeoutSec 60
    if((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash.ToLowerInvariant() -cne '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'){throw 'The MXC SDK differs from the exact archive.'}
    Invoke-PersonalChecked (Join-Path ([Environment]::SystemDirectory) 'tar.exe') @('-xzf',$sdk,'-C',$downloads,'package/bin/arm64/wxc-exec.exe','package/bin/arm64/wxc-host-prep.exe') 'Pinned MXC extraction'
    $mxc=Join-Path $downloads 'package\bin\arm64'
    & (Join-Path $PSScriptRoot '..\host-preparation\test-system-root-mxc.ps1') -HelperPath (Join-Path $HelperDirectory 'NemoClawHostPreparation.exe') -MxcDirectory $mxc -NodePath $node -ArtifactDirectory (Join-Path $output 'system-root-proof')
    $systemProof=Get-Content -LiteralPath (Join-Path $output 'system-root-proof\system-root-mxc-proof.json') -Raw|ConvertFrom-Json
    if($systemProof.status -cne 'pass'){throw 'The same-run system-root/MXC proof failed.'}
    $mxcAttempted=$true
    $patchedMxc=Join-Path $compatEvidence 'mxc-token-inspection-build'
    Invoke-PersonalChecked $node @('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'probe-personal-candidate.mts'),
        '--runtime-root',$runtime,'--mxc',(Join-Path $patchedMxc 'wxc-exec.exe'),'--stock-mxc',(Join-Path $mxc 'wxc-exec.exe'),'--host-controller-python',$python,'--output',(Join-Path $output 'personal-mxc'),
        '--compatibility-root',(Join-Path $compatEvidence 'compatibility-build'),'--compatibility-receipt',(Join-Path $compatEvidence 'compatibility-build/build-receipt.json'),
        '--compatibility-proof',(Join-Path $compatEvidence 'result.json'),'--mxc-build-receipt',(Join-Path $patchedMxc 'mxc-token-inspection-build.json'),
        '--derived-runtime-receipt',(Join-Path $candidate 'runtime-candidate.json'),'--replay-receipt',(Join-Path $candidate 'replay-input.json')) 'Canonical Personal component execution'
    if(Test-Path -LiteralPath $original){throw 'The original build root became available during execution.'}
    $receipt.status='pass'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    $removeRuntime=$runtimeOwned -and -not $mxcAttempted
    if($mxcAttempted){
        try{
            $completed=Get-Content -LiteralPath (Join-Path $output 'personal-mxc\personal-feasibility.json') -Raw|ConvertFrom-Json
            $removeRuntime=$runtimeOwned -and $completed.schemaVersion -eq 1 -and $completed.classification -ceq 'canonical-personal-mxc-feasibility' -and $completed.runtime -ceq $runtime -and ($completed.executorAttempted -ceq $false -or ($completed.cleanup.executorClosed -ceq $true -and $completed.cleanup.hostDiagnosticChildrenClosed -ceq $true -and $completed.rootsRetainedForUnclosedExecutor -ceq $false))
        }catch{$receipt.cleanupErrors+=@('Runtime retained: executor completion receipt unavailable. '+$_.Exception.Message)}
    }
    $receipt['runtimeRetainedForUnclosedExecutor']=$runtimeOwned -and -not $removeRuntime
    try{if($removeRuntime -and (Test-Path -LiteralPath $runtime)){Remove-Item -LiteralPath $runtime -Recurse -Force}}
    catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $primary){$primary=$_}}
    $receipt['runtimeRootRemoved']= -not (Test-Path -LiteralPath $runtime)
    if($receipt.cleanupErrors.Count -gt 0){$receipt.status='failed'}
    try{[IO.File]::WriteAllText((Join-Path $output 'personal-phase.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The Personal receipt could not also be saved.'}}
}
if($null -ne $primary){throw $primary}
