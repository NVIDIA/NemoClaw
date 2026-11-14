# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$NodePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-bash-compat.ps1'),[ref]$tokens,[ref]$errors)
if($errors){throw 'Runner parse failed.'}
$functions=$ast.FindAll({param($a)$a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Invoke-Owned'},$true)
$addType=$ast.FindAll({param($a)$a -is [Management.Automation.Language.CommandAst] -and $a.GetCommandName() -eq 'Add-Type'},$true)
if($functions.Count -ne 1 -or $addType.Count -ne 1){throw 'Expected actual fixed process owner and drain.'}
. ([scriptblock]::Create($addType[0].Extent.Text))
. ([scriptblock]::Create($functions[0].Extent.Text))
$work=Join-Path ([IO.Path]::GetTempPath()) ('msys-owner-control-'+[guid]::NewGuid().ToString('N'));$out=Join-Path $work 'evidence';[void][IO.Directory]::CreateDirectory($out)
$receipt=@{phase='control';stages=@()}
try{
 Invoke-Owned $NodePath @('-e','console.log("stdout retained");console.error("stderr retained")') 'normal' 5
 if(-not $receipt.stages[-1].closed -or $receipt.stages[-1].forced -or (Get-Content -Raw (Join-Path $out 'normal.stderr.log')).Trim() -cne 'stderr retained'){throw 'Normal owned output control failed.'}
 $caught=$null
 try{Invoke-Owned $NodePath @('-e','console.error("primary failure");process.exitCode=7') 'nonzero' 5}catch{$caught=$_}
 if($null -eq $caught -or $receipt.stages[-1].exitCode -ne 7 -or -not $receipt.stages[-1].closed -or (Get-Content -Raw (Join-Path $out 'nonzero.stderr.log')).Trim() -cne 'primary failure'){throw 'Nonzero primary/output retention control failed.'}
 $caught=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
 try{Invoke-Owned $NodePath @('-e','console.error("before deadline");setInterval(()=>{},1000)') 'timeout' 1}catch{$caught=$_}
 if($null -eq $caught -or $caught.Exception.Message -cne 'Owned prototype stage deadline.' -or -not $receipt.stages[-1].closed -or -not $receipt.stages[-1].forced -or $clock.ElapsedMilliseconds -gt 9000 -or (Get-Content -Raw (Join-Path $out 'timeout.stderr.log')).Trim() -cne 'before deadline'){throw 'Actual hanging child/output retention control failed.'}
 $caught=$null
 try{Invoke-Owned $NodePath @('-e','process.stdout.write("x".repeat(5*1024*1024));setInterval(()=>{},1000)') 'overflow' 5}catch{$caught=$_}
 if($null -eq $caught -or $caught.Exception.Message -cne 'Owned prototype output bound exceeded.' -or (Get-Item -LiteralPath (Join-Path $out 'overflow.stdout.log')).Length -ne 4194304 -or -not $receipt.stages[-1].closed){throw 'Output memory/retention bound control failed.'}
 $compilerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'build-object-probe.ps1'),[ref]$tokens,[ref]$errors)
 if($errors){throw 'Probe compiler parse failed.'}
 $function=$compilerAst.FindAll({param($a)$a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Invoke-ProbeCompiler'},$true)
 if($function.Count -ne 1){throw 'Expected the actual nested compiler owner.'}
 $nested=Join-Path $work 'nested.ps1';$childScript=Join-Path $work 'child.cjs'
 [IO.File]::WriteAllText($childScript,'console.log("nested compiler stdout");console.error("nested compiler stderr");process.exitCode=7;')
 $nestedText=$function[0].Extent.Text+"`nInvoke-ProbeCompiler '"+$NodePath.Replace("'","''")+"' '"+[char]34+$childScript.Replace("'","''")+[char]34+"' 5000"
 [IO.File]::WriteAllText($nested,$nestedText)
 $caught=$null
 try{Invoke-Owned (Join-Path $PSHOME $(if($IsWindows){'pwsh.exe'}else{'pwsh'})) @('-NoProfile','-File',$nested) 'nested-compiler' 10}catch{$caught=$_}
 if($null -eq $caught -or (Get-Content -Raw (Join-Path $out 'nested-compiler.stdout.log')) -notmatch 'nested compiler stdout' -or (Get-Content -Raw (Join-Path $out 'nested-compiler.stderr.log')) -notmatch 'nested compiler stderr' -or -not $receipt.stages[-1].closed){throw 'Actual nested compiler pipe retention failed.'}
 Write-Output 'PASS 5 actual owned-process/output controls (no AppContainer execution).'
}finally{Remove-Item -LiteralPath $work -Recurse -Force}
