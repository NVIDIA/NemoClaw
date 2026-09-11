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
$runtime=Join-Path $root ('NemoClawHermesProbe-'+[guid]::NewGuid().ToString('N').Substring(0,12))
$primary=$null;$mxcAttempted=$false
$receipt=[ordered]@{schemaVersion=1;classification='canonical-personal-mxc-candidate-feasibility';sourceRevision=$env:GITHUB_SHA;
    candidateSource='47d890728482cca05e840edd27e33e3d495aeabf';artifactId=10181796438;status='failed';
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
    $source=Join-Path $downloads 'hermes-source.tar.gz'
    Invoke-WebRequest -Uri 'https://codeload.github.com/NousResearch/hermes-agent/tar.gz/2237be355906fbe6065ce1815711eee52b2d646e' -OutFile $source -TimeoutSec 120
    if ((Get-Item -LiteralPath $source).Length -ne 69242564 -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87') { throw 'The canonical source archive failed its immutable identity.' }
    Invoke-PersonalChecked $python @('-I',(Join-Path $PSScriptRoot 'verify-personal-candidate.py'),'--zip',(Join-Path $downloads 'candidate.zip'),'--output',(Join-Path $output 'verification'),'--runtime-root',$runtime,'--source-archive',$source) 'Full candidate archive verification and extraction'
    $marker=Get-Content -LiteralPath (Join-Path $runtime 'nemoclaw-windows-runtime.json') -Raw|ConvertFrom-Json
    $homeLine=@(Get-Content -LiteralPath (Join-Path $runtime 'hermes-agent\venv\pyvenv.cfg') | Where-Object { $_ -match '^home\s*=' })
    if($homeLine.Count -ne 1){throw 'The original managed Python home is ambiguous.'}
    $managedPythonHome=($homeLine[0] -replace '^home\s*=\s*','').Trim()
    $relative=[string]$marker.environmentHomes.'hermes-agent/venv'
    $suffix='\'+$relative.Replace('/','\')
    if(-not $managedPythonHome.EndsWith($suffix,[StringComparison]::OrdinalIgnoreCase)){throw 'The original generated Python home is not bound to the candidate layout.'}
    $original=$managedPythonHome.Substring(0,$managedPythonHome.Length-$suffix.Length)
    if($original -ceq $runtime -or (Test-Path -LiteralPath $original)){throw 'The original build root must be absent during moved-root execution.'}
    $receipt['originalBuildRoot']=$original
    $receipt['originalBuildRootAbsent']=$true
    Invoke-PersonalChecked $python @('-I',(Join-Path $PSScriptRoot 'prepare-native-runtime.py'),'--runtime-root',$runtime,'--source-root',$original,'--target-root',$runtime,'--environment','hermes-agent/venv','--environment','tools/browser-use','--receipt',(Join-Path $output 'relocation.json')) 'Recorded generated-metadata relocation'
    $sdk=Join-Path $downloads 'mxc-sdk.tgz'
    Invoke-WebRequest -Uri 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz' -OutFile $sdk -TimeoutSec 60
    if((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash.ToLowerInvariant() -cne '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'){throw 'The MXC SDK differs from the exact archive.'}
    Invoke-PersonalChecked (Join-Path ([Environment]::SystemDirectory) 'tar.exe') @('-xzf',$sdk,'-C',$downloads,'package/bin/arm64/wxc-exec.exe','package/bin/arm64/wxc-host-prep.exe') 'Pinned MXC extraction'
    $mxc=Join-Path $downloads 'package\bin\arm64'
    & (Join-Path $PSScriptRoot '..\host-preparation\test-system-root-mxc.ps1') -HelperPath (Join-Path $HelperDirectory 'NemoClawHostPreparation.exe') -MxcDirectory $mxc -NodePath $node -ArtifactDirectory (Join-Path $output 'system-root-proof')
    $systemProof=Get-Content -LiteralPath (Join-Path $output 'system-root-proof\system-root-mxc-proof.json') -Raw|ConvertFrom-Json
    if($systemProof.status -cne 'pass'){throw 'The same-run system-root/MXC proof failed.'}
    $mxcAttempted=$true
    Invoke-PersonalChecked $node @('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'probe-personal-candidate.mts'),'--runtime-root',$runtime,'--mxc',(Join-Path $mxc 'wxc-exec.exe'),'--output',(Join-Path $output 'personal-mxc')) 'Canonical Personal component execution'
    if(Test-Path -LiteralPath $original){throw 'The original build root became available during execution.'}
    $receipt.status='pass'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    $removeRuntime= -not $mxcAttempted
    if($mxcAttempted){
        try{
            $completed=Get-Content -LiteralPath (Join-Path $output 'personal-mxc\personal-feasibility.json') -Raw|ConvertFrom-Json
            $removeRuntime=$completed.schemaVersion -eq 1 -and $completed.classification -ceq 'canonical-personal-mxc-feasibility' -and $completed.runtime -ceq $runtime -and ($completed.executorAttempted -ceq $false -or $completed.cleanup.executorClosed -ceq $true)
        }catch{$receipt.cleanupErrors+=@('Runtime retained: executor completion receipt unavailable. '+$_.Exception.Message)}
    }
    $receipt['runtimeRetainedForUnclosedExecutor']= -not $removeRuntime
    try{if($removeRuntime -and (Test-Path -LiteralPath $runtime)){Remove-Item -LiteralPath $runtime -Recurse -Force}}
    catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $primary){$primary=$_}}
    $receipt['runtimeRootRemoved']= -not (Test-Path -LiteralPath $runtime)
    if($receipt.cleanupErrors.Count -gt 0){$receipt.status='failed'}
    try{[IO.File]::WriteAllText((Join-Path $output 'personal-phase.json'),($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The Personal receipt could not also be saved.'}}
}
if($null -ne $primary){throw $primary}
