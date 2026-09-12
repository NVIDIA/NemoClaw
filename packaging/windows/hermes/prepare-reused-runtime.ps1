# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$ControllerSource,
    [Parameter(Mandatory)][string]$InputFile)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $ControllerSource -cnotmatch '^[a-f0-9]{40}$'){
    throw 'Complete canonical runtime reuse requires explicit Windows CI.'
}
$reuseSpec=Get-Content -LiteralPath $InputFile -Raw|ConvertFrom-Json
$parent=Split-Path -Parent $ArtifactDirectory
$build=Join-Path $parent 'official-hermes-runtime-build'
$candidate=Join-Path $parent 'official-hermes-runtime-candidate'
if((Test-Path -LiteralPath $build) -or (Test-Path -LiteralPath $candidate)){throw 'Reused runtime output must be fresh.'}
$null=New-Item -ItemType Directory -Path $build
$receipt=[ordered]@{schemaVersion=1;classification='official-hermes-runtime-build-phase';controllerSource=$ControllerSource;status='failed';phase='complete-canonical-reuse';installedAcceptance=$false;runtimeExecutionQualified=$false;activationAllowed=$false;reusedCompleteBase=$true;runtimeRoot=$RuntimeRoot;wheelAttempted=$false;buildProcessesClosed=$true;stages=@()}
$primary=$null
function Assert-ReuseBytes([string]$File,[long]$Bytes,[string]$Sha){
    if((Get-Item -LiteralPath $File).Length -ne $Bytes -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha){throw 'A pinned canonical reuse input changed.'}
}
function Invoke-ReuseTool([string]$Executable,[string[]]$Arguments,[string]$Label){
    $receipt.phase=$Label
    Write-Host ('[Hermes build] '+$Label)
    $clock=[Diagnostics.Stopwatch]::StartNew();$exitCode=$null
    try{
        $previous=$ErrorActionPreference
        try{$ErrorActionPreference='Continue';$global:LASTEXITCODE=$null;& $Executable @Arguments 2>&1|Tee-Object -FilePath (Join-Path $build ($Label+'.log')) -ErrorAction Stop|Out-Host;$exitCode=$LASTEXITCODE}
        finally{$ErrorActionPreference=$previous}
        if($exitCode -ne 0){throw ($Label+' failed with exit '+$exitCode+'; output retained.')}
    }finally{$receipt.stages+=@([ordered]@{stage=$Label;elapsedMs=$clock.ElapsedMilliseconds;exitCode=$exitCode})}
}
try{
    $python=[string]$reuseSpec.bootstrapPython;$node=[string]$reuseSpec.bootstrapNode
    if((Get-FileHash -LiteralPath $python -Algorithm SHA256).Hash.ToLowerInvariant() -cne '54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b' -or
       (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne '97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878'){throw 'Pinned external build interpreters changed.'}
    Assert-ReuseBytes ([string]$reuseSpec.sourceArchive) 69242564 'c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87'
    Assert-ReuseBytes ([string]$reuseSpec.baseZip) 1099892587 'b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed'
    $baseInventory=Join-Path $build 'base-payload-inventory.json'
    $oldBuild=Join-Path $build 'official-runtime-build.json'
    $archive=[IO.Compression.ZipFile]::OpenRead([string]$reuseSpec.baseZip)
    try{
        foreach($pair in @(@('official-hermes-runtime-candidate/payload-inventory.json',$baseInventory),@('official-hermes-runtime-build/official-runtime-build.json',$oldBuild))){
            $entry=$archive.GetEntry($pair[0]);if($null -eq $entry){throw 'The complete base lacks its original metadata.'}
            $incoming=$entry.Open();$destination=[IO.File]::Open($pair[1],[IO.FileMode]::CreateNew)
            try{$incoming.CopyTo($destination)}finally{$destination.Dispose();$incoming.Dispose()}
        }
    }finally{$archive.Dispose()}
    if((Get-FileHash -LiteralPath $baseInventory -Algorithm SHA256).Hash.ToLowerInvariant() -cne '777f6a6fcbefa3790130e795b611aff086775f23682ae109c16cac2f1ff1acd0' -or
       (Get-FileHash -LiteralPath $oldBuild -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'b28c01a5eb2880cab6d824f812a414df86f91de1e0806452cf9132044d934b26'){throw 'The original inventory/build receipt bytes changed.'}
    $adaptation=Join-Path $build 'native-adaptation.json'
    Invoke-ReuseTool $python @('-I','-B',(Join-Path $PSScriptRoot 'prepare-native-runtime.py'),'--runtime-root',$RuntimeRoot,
        '--source-root',[string]$reuseSpec.originalBuildRoot,'--target-root',$RuntimeRoot,'--environment','hermes-agent/venv',
        '--environment','tools/browser-use','--ci-upgrade-startup-adapter','--receipt',$adaptation) 'upgrade-and-relocate-canonical-metadata'
    $wheelEvidence=Join-Path $build 'pywinpty'
    $receipt.wheelAttempted=$true;$receipt.buildProcessesClosed=$false
    Invoke-ReuseTool $python @('-I','-B',(Join-Path $PSScriptRoot 'rebuild-pywinpty-conpty.py'),'--runtime-root',$RuntimeRoot,
        '--base-zip',[string]$reuseSpec.baseZip,'--adaptation-receipt',$adaptation,'--artifact-directory',$wheelEvidence,
        '--rust-bin-directory',[string]$reuseSpec.rustBinDirectory) 'rebuild-only-canonical-console-wheel'
    $gitEvidence=Join-Path $build 'git'
    Invoke-ReuseTool $node @('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'prepare-canonical-git.mts'),
        '--runtime-root',$RuntimeRoot,'--base-inventory',$baseInventory,'--evidence',$gitEvidence) 'prepare-finished-canonical-git'
    $proofRoot=[string]$reuseSpec.compatibilityEvidence
    $compatSource=Join-Path $proofRoot 'compatibility-build'
    $compat=Get-Content -LiteralPath (Join-Path $compatSource 'build-receipt.json') -Raw|ConvertFrom-Json
    $compatTarget=Join-Path $RuntimeRoot 'mxc-compat'
    if(Test-Path -LiteralPath $compatTarget){throw 'Compatibility output must be fresh.'}
    $null=New-Item -ItemType Directory -Path $compatTarget
    $files=@($compat.files)+@($compat.license)
    if($files.Count -ne 4 -or @($files.file|Select-Object -Unique).Count -ne 4 -or @($files|Where-Object {$_.file -notin @('NemoClawMsysLauncher.exe','NemoClawMsysCompat-arm64.dll','NemoClawMsysCompat-x64.dll','DETOURS-LICENSE.txt')}).Count -ne 0){throw 'Unexpected compatibility members.'}
    foreach($file in $files){$sourceFile=Join-Path $compatSource $file.file;Assert-ReuseBytes $sourceFile $file.bytes $file.sha256;Copy-Item -LiteralPath $sourceFile -Destination (Join-Path $compatTarget $file.file)}
    Copy-Item -LiteralPath (Join-Path $compatSource 'build-receipt.json') -Destination (Join-Path $compatTarget 'build-receipt.json')
    $derivation=Join-Path $build 'derivation-inputs.json'
    $documents=[ordered]@{pywinptyEvidence=$wheelEvidence;gitReceipt=(Join-Path $gitEvidence 'canonical-git-derivation.json');
        compatibilityProof=(Join-Path $proofRoot 'result.json');compatibilityReceipt=(Join-Path $compatTarget 'build-receipt.json');
        mxcBuildReceipt=(Join-Path $proofRoot 'mxc-token-inspection-build/mxc-token-inspection-build.json');originalBuildRoot=[string]$reuseSpec.originalBuildRoot}
    [IO.File]::WriteAllText($derivation,($documents|ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false))
    Invoke-ReuseTool $python @('-I','-B',(Join-Path $PSScriptRoot 'export-official-runtime.py'),'--runtime-root',$RuntimeRoot,
        '--source-archive',[string]$reuseSpec.sourceArchive,'--build-receipt',$oldBuild,'--adaptation-receipt',$adaptation,
        '--output-directory',$candidate,'--controller-source',$ControllerSource,'--derivation-inputs',$derivation) 'export-complete-derived-candidate'
    $result=Get-Content -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Raw|ConvertFrom-Json
    if($result.status -cne 'candidate-bytes-exported' -or $result.completeByteInventory -cne $true -or
       $result.runtimeExecutionQualified -cne $false -or $result.installedAcceptance -cne $false -or $result.activationAllowed -cne $false){throw 'Derived candidate export did not satisfy its build-only contract.'}
    $receipt.status='candidate-bytes-exported-unqualified'
    $receipt['candidateReceiptSha256']=(Get-FileHash -LiteralPath (Join-Path $candidate 'runtime-candidate.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt['originalFullStagesReexecuted']=$false
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
    if($receipt.wheelAttempted){
        try{
            $wheel=Get-Content -LiteralPath (Join-Path $build 'pywinpty/pywinpty-rebuild.json') -Raw|ConvertFrom-Json
            $receipt.buildProcessesClosed=$wheel.schemaVersion -eq 1 -and $wheel.classification -ceq 'ci-targeted-pywinpty-conpty-rebuild' -and
                [string]::Equals([IO.Path]::GetFullPath([string]$wheel.runtimeRoot),[IO.Path]::GetFullPath($RuntimeRoot),[StringComparison]::OrdinalIgnoreCase) -and $wheel.allOwnedProcessesClosed -ceq $true
        }catch{$receipt.buildProcessesClosed=$false;$receipt['buildCleanupError']=$_.Exception.Message}
        if(-not $receipt.buildProcessesClosed){
            $receipt.status='failed'
            if($null -eq $primary){$primary=[InvalidOperationException]::new('Targeted build process closure was not confirmed; retain its runtime.')}
        }
    }
    $file=Join-Path $parent 'official-hermes-runtime-phase.json'
    try{[IO.File]::WriteAllText($file,($receipt|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))}
    catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The runtime phase receipt also could not be saved.'}}
}
if($null -ne $primary){throw $primary}
