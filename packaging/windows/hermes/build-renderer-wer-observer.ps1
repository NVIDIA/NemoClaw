# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
 [Parameter(Mandatory)][string]$SourceRoot,
 [Parameter(Mandatory)][string]$Directory,
 [Parameter(Mandatory)][string]$CompatibilityReceipt,
 [Parameter(Mandatory)][string]$CompatibilitySourceRevision,
 [Parameter(Mandatory)][string]$CompatibilityReceiptSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Assert-BatchPath([string]$Value) {
 if($Value -match '[^\x20-\x7e]|["\r\n&|<>^%!]'){throw 'Renderer WER observer build paths must be ordinary ASCII paths.'}
}

function Read-BuildFile([string]$File,[long]$Maximum=8388608) {
 $item=Get-Item -LiteralPath $File -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -lt 1 -or $item.Length -gt $Maximum){throw 'Renderer WER observer build input is not one bounded ordinary file.'}
 return @{path=$File;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
}

function Read-Amd64ObserverPe([string]$File) {
 $metadata=Read-BuildFile $File
 $data=[IO.File]::ReadAllBytes($File)
 if($data.Length -lt 64){throw 'WER observer PE is truncated.'}
 $pe=[BitConverter]::ToInt32($data,60)
 if($data[0] -ne 0x4d -or $data[1] -ne 0x5a -or $pe -lt 64 -or $pe -gt $data.Length-24 -or [BitConverter]::ToUInt32($data,$pe) -ne 0x4550){throw 'WER observer PE signature is invalid.'}
 $machine=[BitConverter]::ToUInt16($data,$pe+4)
 $count=[BitConverter]::ToUInt16($data,$pe+6)
 $optionalSize=[BitConverter]::ToUInt16($data,$pe+20)
 $optional=$pe+24
 if($machine -ne 0x8664 -or $count -lt 1 -or $count -gt 32 -or $optionalSize -lt 240 -or $optional+$optionalSize+40*$count -gt $data.Length){throw 'WER observer PE is not bounded AMD64.'}
 if(([BitConverter]::ToUInt16($data,$pe+22) -band 0x2000) -eq 0 -or [BitConverter]::ToUInt16($data,$optional) -ne 0x20b -or [BitConverter]::ToUInt16($data,$optional+68) -ne 2){throw 'WER observer PE is not a PE32+ Windows DLL.'}
 $sections=@()
 for($i=0;$i -lt $count;$i++){
  $at=$optional+$optionalSize+40*$i
  $row=@{rva=[BitConverter]::ToUInt32($data,$at+12);bytes=[BitConverter]::ToUInt32($data,$at+16);raw=[BitConverter]::ToUInt32($data,$at+20)}
  if([long]$row.raw+$row.bytes -gt $data.Length){throw 'WER observer section exceeds file.'}
  $sections+=@($row)
 }
 $offset={param([uint32]$Rva,[uint32]$Bytes=1)
  foreach($section in $sections){
   if($Rva -ge $section.rva -and [long]$Rva+$Bytes -le [long]$section.rva+$section.bytes){return [int]([long]$section.raw+$Rva-$section.rva)}
  }
  throw 'WER observer RVA is outside mapped bytes.'
 }
 $cstring={param([uint32]$Rva)
  $start=& $offset $Rva 1;$end=$start
  while($end -lt $data.Length -and $end-$start -lt 256 -and $data[$end] -ne 0){if($data[$end] -lt 0x20 -or $data[$end] -gt 0x7e){throw 'Invalid PE name.'};$end++}
  if($end -ge $data.Length -or $end-$start -ge 256){throw 'Unterminated PE name.'}
  return [Text.Encoding]::ASCII.GetString($data,$start,$end-$start)
 }
 $importRva=[BitConverter]::ToUInt32($data,$optional+120);$importBytes=[BitConverter]::ToUInt32($data,$optional+124)
 if($importBytes -lt 20 -or $importBytes -gt 1280){throw 'WER observer import table is unavailable or oversized.'}
 $imports=@();$ended=$false
 for($i=0;$i -lt 64 -and 20*($i+1) -le $importBytes;$i++){
  $at=& $offset ($importRva+20*$i) 20
  $name=[BitConverter]::ToUInt32($data,$at+12)
  if($name -eq 0){$ended=$true;break}
  $dll=& $cstring $name
  if($dll -ine 'KERNEL32.dll'){throw ('Unexpected observer import: '+$dll)}
  $imports+=@($dll)
 }
 if(-not $ended -or $imports.Count -ne 1){throw 'WER observer must import only KERNEL32.dll.'}
 $delayRva=[BitConverter]::ToUInt32($data,$optional+112+13*8);$delayBytes=[BitConverter]::ToUInt32($data,$optional+116+13*8)
 if($delayRva -ne 0 -or $delayBytes -ne 0){throw 'WER observer must not have delay imports.'}
 $exportRva=[BitConverter]::ToUInt32($data,$optional+112);$at=& $offset $exportRva 40
 $names=[BitConverter]::ToUInt32($data,$at+24);$namesRva=[BitConverter]::ToUInt32($data,$at+32)
 if($names -ne 3){throw 'WER observer export set differs.'}
 $exports=@();for($i=0;$i -lt $names;$i++){$entry=& $offset ($namesRva+4*$i) 4;$exports+=@(& $cstring ([BitConverter]::ToUInt32($data,$entry)))}
 $expected=@('OutOfProcessExceptionEventCallback','OutOfProcessExceptionEventDebuggerLaunchCallback','OutOfProcessExceptionEventSignatureCallback')
 if(@(Compare-Object -CaseSensitive ($exports|Sort-Object) $expected).Count){throw 'WER observer callback exports differ.'}
 $metadata.machine=$machine;$metadata.importDlls=$imports;$metadata.exports=$exports;$metadata.delayImportsAbsent=$true
 return $metadata
}

if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $PSEdition -cne 'Core' -or $env:GITHUB_SHA -cnotmatch '^[0-9a-f]{40}$'){throw 'Renderer WER observer helper is a source-pinned disposable Windows CI build.'}
$sourceRootPath=[IO.Path]::GetFullPath($SourceRoot)
$directoryPath=[IO.Path]::GetFullPath($Directory)
$compatibilityPath=[IO.Path]::GetFullPath($CompatibilityReceipt)
$source=Join-Path $sourceRootPath 'packaging/windows/hermes/renderer-wer-observer.cpp'
$output=Join-Path $directoryPath 'renderer-wer-observer'
foreach($value in @($source,$output,$compatibilityPath,$PSHOME)){Assert-BatchPath $value}
if(Test-Path -LiteralPath $output){throw 'Renderer WER observer helper output must be fresh.'}
$null=New-Item -ItemType Directory -Path $output
$receipt=[ordered]@{
 schemaVersion=1;classification='renderer-wer-observer-build';sourceRevision=$env:GITHUB_SHA;status='failed'
 source=$null;compatibilityReceipt=$null;toolchain=$null;files=@();diagnostics=@();cleanupErrors=@()
 observationsExecuted=$false;executed=$false;qualified=$false;validation=@{status='not-run';callbackInvoked=$false};originalChromeWerCode409NowNonclaimed=$true
}
$primary=$null

function Invoke-WerCompiler([string]$Batch) {
 $row=[ordered]@{exitCode=$null;closed=$false;captureClosed=$false;error=$null;output='forwarded-to-outer-bounded-compiler-capture'}
 $start=[Diagnostics.ProcessStartInfo]::new()
 $start.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe'
 $start.Arguments='/d /s /c ""'+$Batch+'""'
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=$null;$stdout=$null;$stderr=$null;$failure=$null
 try {
  $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
  $stdout=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  if(-not $process.WaitForExit(110000)){throw 'Renderer WER observer compiler exceeded the existing build bound.'}
  $row.closed=$true;$row.exitCode=$process.ExitCode
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'Renderer WER observer compiler output did not close.'}
  $row.captureClosed=$true
  if($process.ExitCode -ne 0){throw ('Renderer WER observer compiler exited '+$process.ExitCode+'.')}
 } catch {$failure=$_;$row.error=$_.Exception.Message}
 finally {
  if($null -ne $process){
   try {
    if(-not $process.HasExited){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'Renderer WER observer compiler did not stop.'}}
    $row.closed=$true;$row.exitCode=$process.ExitCode
   } catch {$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
   try {
    if($null -ne $stdout -and $null -ne $stderr){$row.captureClosed=[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),1000);if(-not $row.captureClosed){throw 'Renderer WER observer compiler capture stayed open.'}}
   } catch {$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
   $process.Dispose()
  }
  $receipt.diagnostics+=@($row)
 }
 if($null -ne $failure){throw $failure}
}

try {
 $receipt.source=Read-BuildFile $source 65536
 $receipt.source.path='packaging/windows/hermes/renderer-wer-observer.cpp'
 if($CompatibilitySourceRevision -cnotmatch '^[0-9a-f]{40}$' -or $CompatibilityReceiptSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'Expected immutable lowercase compatibility source and receipt identities.'}
 $receipt.compatibilityReceipt=Read-BuildFile $compatibilityPath 1048576
 if($receipt.compatibilityReceipt.sha256 -cne $CompatibilityReceiptSha256){throw 'Compatibility receipt bytes differ from the approved identity.'}
 $build=Get-Content -LiteralPath $compatibilityPath -Raw|ConvertFrom-Json
 if($build.schemaVersion -ne 1 -or $build.classification -cne 'mxc-msys-compatibility-prototype-build' -or $build.status -cne 'built' -or $build.sourceRevision -cne $CompatibilitySourceRevision){throw 'Expected the approved source-pinned successful coordinated compiler receipt.'}
 $receipt.compatibilityReceipt.sourceRevision=$build.sourceRevision
 $rows=@($build.toolchains|Where-Object target -ceq 'x64')
 if($rows.Count -ne 1){throw 'Expected one coordinated AMD64 compiler.'}
 $tool=$rows[0]
 if($tool.toolsetVersion -cne '14.51.36231' -or $tool.sdkVersion -cne '10.0.26100.0'){throw 'Renderer WER observer compiler tuple differs.'}
 foreach($pair in @(@($tool.cl,$tool.clSha256),@($tool.link,$tool.linkSha256))){
  Assert-BatchPath $pair[0]
  if($pair[1] -cnotmatch '^[0-9a-f]{64}$' -or (Read-BuildFile $pair[0]).sha256 -cne $pair[1]){throw 'Coordinated compiler bytes changed.'}
 }
 $receipt.toolchain=$tool
 $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
 $installations=@(& $vswhere -latest -products '*' -property installationPath)
 if($LASTEXITCODE -ne 0 -or $installations.Count -ne 1){throw 'The coordinated Visual Studio installation is ambiguous.'}
 $vsdev=Join-Path $installations[0] 'Common7/Tools/VsDevCmd.bat'
 Assert-BatchPath $vsdev
 $identity=@'
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if($env:VCToolsVersion.TrimEnd('\') -cne '14.51.36231' -or $env:WindowsSDKVersion.TrimEnd('\') -cne '10.0.26100.0'){throw 'Renderer WER observer compiler environment differs.'}
foreach($name in @('cl','link')){
 $actual=Join-Path $env:VCToolsInstallDir ('bin/HostARM64/x64/'+$name+'.exe')
 $expectedPath=if($name -ceq 'cl'){'__CL_PATH__'}else{'__LINK_PATH__'}
 $expectedHash=if($name -ceq 'cl'){'__CL_SHA__'}else{'__LINK_SHA__'}
 if([IO.Path]::GetFullPath($actual) -ine [IO.Path]::GetFullPath($expectedPath) -or (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash){throw 'Renderer WER observer compiler environment selected different compiler bytes or paths.'}
}
'@
 $identity=$identity.Replace('__CL_PATH__',$tool.cl.Replace("'","''")).Replace('__LINK_PATH__',$tool.link.Replace("'","''")).Replace('__CL_SHA__',$tool.clSha256).Replace('__LINK_SHA__',$tool.linkSha256)
 $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($identity))
 $binary=Join-Path $output 'chrome_wer.dll'
 $object=Join-Path $output 'renderer-wer-observer.obj'
 $commands=@(
  '@echo off',
  ('call "'+$vsdev+'" -no_logo -arch=x64 -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0'),
  'if errorlevel 1 exit /b 1',
  ('"'+(Join-Path $PSHOME 'pwsh.exe')+'" -NoProfile -EncodedCommand '+$encoded),
  'if errorlevel 1 exit /b 1',
  ('"'+$tool.cl+'" /nologo /W4 /WX /std:c++20 /EHa /MT /O1 /c /DUNICODE /D_UNICODE "'+$source+'" /Fo"'+$object+'"'),
  'if errorlevel 1 exit /b 1',
  ('"'+$tool.link+'" /nologo /DLL /SUBSYSTEM:WINDOWS /INCREMENTAL:NO /MACHINE:X64 /OUT:"'+$binary+'" "'+$object+'" kernel32.lib'),
  'if errorlevel 1 exit /b 1',
  'if errorlevel 1 exit /b 1','exit /b 0'
 )
 $batch=Join-Path $output 'compile.cmd'
 [IO.File]::WriteAllText($batch,($commands -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
 Invoke-WerCompiler $batch
 $pe=Read-Amd64ObserverPe $binary
 $receipt.files=@(@{role='wer-observer';relativePath='chrome_wer.dll';bytes=$pe.bytes;sha256=$pe.sha256;machine=$pe.machine;importDlls=$pe.importDlls;exports=$pe.exports;delayImportsAbsent=$pe.delayImportsAbsent;executed=$false})
 foreach($pair in @(@($source,$receipt.source.sha256),@($compatibilityPath,$receipt.compatibilityReceipt.sha256),@($tool.cl,$tool.clSha256),@($tool.link,$tool.linkSha256))){
  if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Renderer WER observer source or compiler inputs changed during compilation.'}
 }
 $receipt.status='built'
} catch {$primary=$_;$receipt['error']=$_.Exception.Message}
finally {
 try {[IO.File]::WriteAllText((Join-Path $output 'build-receipt.json'),($receipt|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))}
 catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'Renderer WER observer failure receipt also failed to write.'}}
}
if($null -ne $primary){throw $primary}
