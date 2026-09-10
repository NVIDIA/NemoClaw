# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory)][string]$OfficialInstallerPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if((Get-FileHash -LiteralPath $OfficialInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '53a077364aa28bbd6e8d987cdec11a4552e22ff2c5137845725a1c99770f392f'){
    throw 'The control requires the pinned official installer bytes.'
}
function Read-ControlAst([string]$Path){
    $tokens=$null;$errors=$null
    $value=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'A control source does not parse.'}
    return $value
}
$official=Read-ControlAst $OfficialInstallerPath
$resolver=$official.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Resolve-UvCmd'},$false)
$wrapper=Read-ControlAst (Join-Path $PSScriptRoot 'complete-official-python.ps1')
$stageCall=$wrapper.Find({param($item) $item -is [Management.Automation.Language.TryStatementAst] -and $item.Extent.Text.Contains('Get-InstallStage')},$true)
if($null -eq $resolver -or $null -eq $stageCall){throw 'The actual upstream resolver or stage invocation is missing.'}
$root=Join-Path ([IO.Path]::GetTempPath()) ('hermes stage control '+[guid]::NewGuid().ToString('N'))
try {
    [IO.Directory]::CreateDirectory((Join-Path $root 'bin'))|Out-Null
    $expectedUv=Join-Path $root 'bin/uv.exe'
    [IO.File]::WriteAllText($expectedUv,'Not executed: existing managed uv path fixture.')
    $HermesHome=$root
    . ([scriptblock]::Create($resolver.Extent.Text))
    Remove-Variable UvCmd -Scope Script -ErrorAction SilentlyContinue
    $rejected=$false
    try {Resolve-UvCmd}catch{$rejected=$_.FullyQualifiedErrorId -eq 'VariableIsUndefined'}
    if(-not $rejected){throw 'The official resolver did not reproduce the strict-mode failure.'}
    $fixture=@'
param([switch]$NonInteractive,[switch]$SkipSetup,[switch]$SkipComputerUse,[string]$Branch,[string]$Commit,[string]$HermesHome,[string]$InstallDir,[switch]$Json)
'@ + "`n" + $resolver.Extent.Text + @'

function Get-InstallStage([string]$Name){if($Name -cne 'dependencies'){throw 'Unexpected stage.'};return @{Name=$Name}}
function Invoke-Stage([hashtable]$StageDef){Resolve-UvCmd;if($script:ExpectedStageFailure){throw 'expected-stage-error'}}
'@
    $runtimeBuildInstaller=Join-Path $root 'fixture-installer.ps1'
    [IO.File]::WriteAllText($runtimeBuildInstaller,$fixture)
    $runtimeBuildRoot=$root;$runtimeBuildSource=$root
    $runtimeBuildLock=[pscustomobject]@{upstream=[pscustomobject]@{tag='v2026.9.7';commit='2237be355906fbe6065ce1815711eee52b2d646e'}}
    $exercise=[scriptblock]::Create('try {'+"`n"+$stageCall.Extent.Text+@'

} catch {$stageError=$_.Exception.Message}
$strictRestored=$false
try {$null=$UndeclaredStrictModeControlVariable}catch{$strictRestored=$_.FullyQualifiedErrorId -eq 'VariableIsUndefined'}
if(-not $strictRestored){throw 'The wrapper did not restore its strict validation semantics.'}
if($script:ExpectedStageFailure -and $stageError -cne 'expected-stage-error'){throw 'The original stage failure was replaced.'}
if(-not $script:ExpectedStageFailure -and $stageError){throw $stageError}
'@)
    foreach($script:ExpectedStageFailure in @($false,$true)){
        Remove-Variable UvCmd -Scope Script -ErrorAction SilentlyContinue
        $stageError=$null
        & $exercise
        if(-not [string]::Equals($script:UvCmd,$expectedUv,[StringComparison]::OrdinalIgnoreCase)){throw 'The upstream resolver did not select managed uv.'}
    }
    Write-Host 'Official installer semantics: original strict-mode failure reproduced; managed resolution and strict restoration pass on success and failure.'
} finally {
    Remove-Variable UvCmd,ExpectedStageFailure -Scope Script -ErrorAction SilentlyContinue
    if([IO.Directory]::Exists($root)){[IO.Directory]::Delete($root,$true)}
}
