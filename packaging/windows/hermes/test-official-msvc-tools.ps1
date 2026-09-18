# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'prepare-official-python.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'The Python phase script does not parse.'}
$definition=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Get-PythonPhaseMsvcTools'},$false)
if($null -eq $definition){throw 'The native MSVC path resolver is missing.'}
. ([scriptblock]::Create($definition.Extent.Text))
$root=Join-Path ([IO.Path]::GetTempPath()) ('msvc path control '+[guid]::NewGuid().ToString('N'))
$savedPath=$env:PATH
try {
    $selected=Join-Path $root 'selected toolset'
    $native=Join-Path $selected 'bin/HostARM64/ARM64'
    [IO.Directory]::CreateDirectory($native)|Out-Null
    foreach($file in @('cl.exe','link.exe')){[IO.File]::WriteAllText((Join-Path $native $file),'selected native tool fixture')}
    $other=@()
    foreach($name in @('foreign one','foreign two')){
        $directory=Join-Path $root $name
        [IO.Directory]::CreateDirectory($directory)|Out-Null
        $file=Join-Path $directory 'link.exe'
        [IO.File]::WriteAllText($file,'foreign tool fixture')
        if($env:OS -ne 'Windows_NT'){ & /bin/chmod 755 $file; if($LASTEXITCODE -ne 0){throw 'Could not prepare the command-lookup fixture.'} }
        $other += $directory
    }
    $env:PATH=($other -join [IO.Path]::PathSeparator)
    $legacy=(Get-Command link.exe -CommandType Application -ErrorAction Stop).Source
    if(@($legacy).Count -ne 2){throw 'The command lookup did not reproduce multiple path matches.'}
    $legacyRejected=$false
    try { & {param([Parameter(Mandatory)][string]$Path) $null=$Path} -Path $legacy }
    catch {$legacyRejected=$true}
    if(-not $legacyRejected){throw 'The original array-to-Path failure did not reproduce.'}
    $actual=Get-PythonPhaseMsvcTools -ToolsRoot $selected
    foreach($pair in @(@('compiler','cl.exe'),@('linker','link.exe'))){
        $expected=[IO.Path]::GetFullPath((Join-Path $native $pair[1]))
        if($actual.($pair[0]) -isnot [string] -or $actual.($pair[0]) -cne $expected){throw 'The resolver selected a foreign or ambiguous tool.'}
    }
    $rejected=$false
    try {$null=Get-PythonPhaseMsvcTools -ToolsRoot 'relative-toolset'}catch{$rejected=$true}
    if(-not $rejected){throw 'A relative toolset was accepted.'}
    [IO.File]::Delete((Join-Path $native 'link.exe'))
    $rejected=$false
    try {$null=Get-PythonPhaseMsvcTools -ToolsRoot $selected}catch{$rejected=$true}
    if(-not $rejected){throw 'A missing native linker fell back to PATH.'}
    Write-Host 'MSVC tool selection: multiple-match regression, native selection, relative rejection and missing-tool refusal passed.'
} finally {
    $env:PATH=$savedPath
    if([IO.Directory]::Exists($root)){[IO.Directory]::Delete($root,$true)}
}
