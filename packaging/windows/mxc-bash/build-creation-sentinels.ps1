# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$Directory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

function Read-SentinelPe([string]$File,[int]$Machine) {
 $data=[IO.File]::ReadAllBytes($File)
 if($data.Length -lt 64 -or $data.Length -gt 8388608){throw 'Sentinel PE size is invalid.'}
 $pe=[BitConverter]::ToInt32($data,60)
 if($data[0] -ne 0x4d -or $data[1] -ne 0x5a -or $pe -lt 64 -or $pe -gt $data.Length-24 -or [BitConverter]::ToUInt32($data,$pe) -ne 0x4550){throw 'Sentinel PE signature is invalid.'}
 $actualMachine=[BitConverter]::ToUInt16($data,$pe+4)
 $count=[BitConverter]::ToUInt16($data,$pe+6);$optionalSize=[BitConverter]::ToUInt16($data,$pe+20);$optional=$pe+24
 if($actualMachine -ne $Machine -or $count -lt 1 -or $count -gt 16 -or $optionalSize -lt 240 -or $optional+$optionalSize+40*$count -gt $data.Length){throw 'Sentinel PE architecture or headers differ.'}
 if([BitConverter]::ToUInt16($data,$optional) -ne 0x20b -or [BitConverter]::ToUInt16($data,$optional+68) -ne 3 -or [BitConverter]::ToUInt32($data,$optional+108) -ne 16){throw 'Sentinel is not the expected PE32+ console image.'}
 $sections=@()
 for($i=0;$i -lt $count;$i++){
  $s=$optional+$optionalSize+40*$i
  $sections+=@{rva=[uint64][BitConverter]::ToUInt32($data,$s+12);bytes=[uint64][BitConverter]::ToUInt32($data,$s+16);offset=[uint64][BitConverter]::ToUInt32($data,$s+20)}
 }
 function Resolve-Rva([uint64]$Rva,[uint64]$Length){
  $matches=@($sections|Where-Object {$Rva -ge $_.rva -and $Rva+$Length -le $_.rva+$_.bytes -and $_.offset+($Rva-$_.rva)+$Length -le $data.Length})
  if($matches.Count -ne 1){throw 'Sentinel PE RVA is not backed by one bounded section.'}
  return [int]($matches[0].offset+$Rva-$matches[0].rva)
 }
 function Read-AsciiRva([uint64]$Rva){
  $text=''
  for($j=0;$j -lt 128;$j++){
   $value=$data[(Resolve-Rva ($Rva+$j) 1)]
   if($value -eq 0){if($text.Length -eq 0){throw 'Sentinel has an empty import name.'};return $text}
   if($value -lt 32 -or $value -gt 126){throw 'Sentinel import name is not ASCII.'}
   $text+=[char]$value
  }
  throw 'Sentinel import name exceeded its bound.'
 }
 $entry=[BitConverter]::ToUInt32($data,$optional+16);$null=Resolve-Rva $entry 1
 $importRva=[BitConverter]::ToUInt32($data,$optional+120);$importBytes=[BitConverter]::ToUInt32($data,$optional+124)
 if($importRva -eq 0 -or $importBytes -lt 40 -or $importBytes -gt 1024){throw 'Sentinel import directory is absent or oversized.'}
 if([BitConverter]::ToUInt32($data,$optional+216) -ne 0 -or [BitConverter]::ToUInt32($data,$optional+220) -ne 0){throw 'Sentinel must not have delayed imports.'}
 $imports=@();$terminated=$false
 for($i=0;$i -lt 16 -and ($i+1)*20 -le $importBytes;$i++){
  $d=Resolve-Rva ([uint64]$importRva+20*$i) 20
  $fields=@(0,4,8,12,16|ForEach-Object {[BitConverter]::ToUInt32($data,$d+$_)})
  if(@($fields|Where-Object {$_ -ne 0}).Count -eq 0){$terminated=$true;break}
  $name=Read-AsciiRva $fields[3];$thunk=$fields[0];if($thunk -eq 0){$thunk=$fields[4]}
  $functions=@();$thunksTerminated=$false
  for($j=0;$j -lt 16;$j++){
   $t=Resolve-Rva ([uint64]$thunk+8*$j) 8;$address=[BitConverter]::ToUInt64($data,$t)
   if($address -eq 0){$thunksTerminated=$true;break}
   if($address -gt [uint32]::MaxValue){throw 'Sentinel ordinal or oversized import is unexpected.'}
   $null=Resolve-Rva $address 2;$functions+=Read-AsciiRva ($address+2)
  }
  if(-not $thunksTerminated){throw 'Sentinel import thunk list exceeded its bound.'}
  $imports+=@{dll=$name;functions=@($functions)}
 }
 if(-not $terminated -or $imports.Count -ne 1 -or $imports[0].dll -ine 'KERNEL32.dll' -or $imports[0].functions.Count -ne 1 -or $imports[0].functions[0] -cne 'ExitProcess'){throw 'Sentinel imports must be only KERNEL32.dll!ExitProcess, with no USER32 or CRT.'}
 return @{machine=$actualMachine;imports=@($imports);delayImportsAbsent=$true;entryPointRva=$entry;subsystem=3}
}

if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $PSEdition -cne 'Core'){throw 'Creation sentinels are a disposable Windows CI build.'}
$sourceRootPath=[IO.Path]::GetFullPath($SourceRoot);$directoryPath=[IO.Path]::GetFullPath($Directory)
$source=Join-Path $sourceRootPath 'packaging/windows/mxc-bash/creation-sentinel.cpp'
$output=Join-Path $directoryPath 'creation-sentinels'
$toolchainReceipt=Join-Path $directoryPath 'compatibility-build/build-receipt.json'
foreach($value in @($source,$output,$toolchainReceipt,$PSScriptRoot)){if($value -match '[^\x20-\x7e]|["\r\n&|<>^%!]'){throw 'Sentinel build paths must be ordinary ASCII paths.'}}
if(Test-Path -LiteralPath $output){throw 'Sentinel build output must be fresh.'}
$null=New-Item -ItemType Directory -Path $output
$receipt=[ordered]@{schemaVersion=1;classification='unshimmed-creation-sentinels-build';sourceRevision=$env:GITHUB_SHA;status='failed';source=$null;toolchainReceipt=$null;toolchains=@();files=@();diagnostics=@();executed=$false;canonicalChromeSupportQualified=$false;cleanupErrors=@()}
$primary=$null
function Invoke-SentinelCompiler([string]$Batch,[string]$Target,[int]$TimeoutMs){
 $row=[ordered]@{target=$Target;batch=$Batch;exitCode=$null;closed=$false;captureClosed=$false;error=$null;output='forwarded-to-outer-bounded-compiler-capture'}
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe';$start.Arguments='/d /s /c ""'+$Batch+'""'
 $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=$null;$stdout=$null;$stderr=$null;$failure=$null
 try{
  $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
  $stdout=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput());$stderr=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  if(-not $process.WaitForExit($TimeoutMs)){throw 'Sentinel compiler exceeded its existing build bound.'}
  $row.closed=$true;$row.exitCode=$process.ExitCode
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'Sentinel compiler output did not close.'}
  $row.captureClosed=$true
  if($process.ExitCode -ne 0){throw ('Sentinel '+$Target+' compiler exited '+$process.ExitCode+'.')}
 }catch{$failure=$_;$row.error=$_.Exception.Message}
 finally{
  if($null -ne $process){
   try{if(-not $process.HasExited){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'Sentinel compiler did not stop.'}};$row.closed=$true;$row.exitCode=$process.ExitCode}
   catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
   try{if($null -ne $stdout -and $null -ne $stderr){$row.captureClosed=[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),1000);if(-not $row.captureClosed){throw 'Sentinel compiler capture stayed open.'}}}
   catch{$receipt.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
   $process.Dispose()
  }
  $receipt.diagnostics+=@($row)
 }
 if($null -ne $failure){throw $failure}
}
try{
 $receipt.source=@{path='packaging/windows/mxc-bash/creation-sentinel.cpp';bytes=(Get-Item -LiteralPath $source).Length;sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()}
 $build=Get-Content -LiteralPath $toolchainReceipt -Raw|ConvertFrom-Json
 if($build.schemaVersion -ne 1 -or $build.classification -cne 'mxc-msys-compatibility-prototype-build' -or $build.status -cne 'built' -or $build.sourceRevision -cne $env:GITHUB_SHA){throw 'Expected the same-source successful coordinated compiler receipt.'}
 $receipt.toolchainReceipt=@{path='compatibility-build/build-receipt.json';bytes=(Get-Item -LiteralPath $toolchainReceipt).Length;sha256=(Get-FileHash -LiteralPath $toolchainReceipt -Algorithm SHA256).Hash.ToLowerInvariant()}
 $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
 $installations=@(& $vswhere -latest -products '*' -property installationPath);if($LASTEXITCODE -ne 0 -or $installations.Count -ne 1){throw 'The coordinated Visual Studio installation is ambiguous.'}
 $vsdev=Join-Path $installations[0] 'Common7/Tools/VsDevCmd.bat';$clock=[Diagnostics.Stopwatch]::StartNew()
 foreach($item in @(@('arm64','arm64',0xAA64,'ARM64'),@('amd64','x64',0x8664,'X64'))){
  $target=$item[0];$vcTarget=$item[1];$rows=@($build.toolchains|Where-Object target -ceq $vcTarget)
  if($rows.Count -ne 1){throw 'Expected one coordinated compiler per sentinel architecture.'};$tool=$rows[0]
  if($tool.toolsetVersion -cne '14.51.36231' -or $tool.sdkVersion -cne '10.0.26100.0'){throw 'Sentinel compiler tuple differs.'}
  foreach($pair in @(@($tool.cl,$tool.clSha256),@($tool.link,$tool.linkSha256))){if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'Coordinated compiler bytes changed.'}}
  $receipt.toolchains+=@($tool)
  $targetDirectory=Join-Path $output $target;$null=New-Item -ItemType Directory -Path $targetDirectory
  $binary=Join-Path $targetDirectory 'creation-sentinel.exe';$object=Join-Path $targetDirectory 'creation-sentinel.obj'
  $identity=@'
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if($env:VCToolsVersion.TrimEnd('\') -cne '14.51.36231' -or $env:WindowsSDKVersion.TrimEnd('\') -cne '10.0.26100.0'){throw 'Sentinel compiler environment differs.'}
foreach($name in @('cl','link')){
 $actual=Join-Path $env:VCToolsInstallDir ('bin/HostARM64/__TARGET__/'+$name+'.exe')
 $expected=if($name -ceq 'cl'){'__CL__'}else{'__LINK__'}
 if((Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected){throw 'Sentinel compiler environment selected different bytes.'}
}
'@
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($identity.Replace('__TARGET__',$vcTarget).Replace('__CL__',$tool.clSha256).Replace('__LINK__',$tool.linkSha256)))
  foreach($value in @($vsdev,$tool.cl,$tool.link,$PSHOME)){if($value -match '[^\x20-\x7e]|["\r\n&|<>^%!]'){throw 'Compiler paths are not safe batch arguments.'}}
  $commands=@('@echo off',('call "'+$vsdev+'" -no_logo -arch='+$vcTarget+' -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0'),'if errorlevel 1 exit /b 1',('"'+(Join-Path $PSHOME 'pwsh.exe')+'" -NoProfile -EncodedCommand '+$encoded),'if errorlevel 1 exit /b 1',('"'+$tool.cl+'" /nologo /W4 /WX /std:c++17 /c /GS- /GR- /Zl /O1 "'+$source+'" /Fo"'+$object+'"'),'if errorlevel 1 exit /b 1',('"'+$tool.link+'" /nologo /NODEFAULTLIB /ENTRY:SentinelEntry /SUBSYSTEM:CONSOLE /INCREMENTAL:NO /MACHINE:'+$item[3]+' /OUT:"'+$binary+'" "'+$object+'" kernel32.lib'),'if errorlevel 1 exit /b 1','exit /b 0')
  $batch=Join-Path $targetDirectory 'compile.cmd';[IO.File]::WriteAllText($batch,($commands -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
  $remaining=110000-[int]$clock.ElapsedMilliseconds;if($remaining -le 0){throw 'Sentinel build deadline exhausted.'}
  Invoke-SentinelCompiler $batch $target $remaining
  $pe=Read-SentinelPe $binary $item[2]
  $receipt.files+=@{target=$target;relativePath=$target+'/creation-sentinel.exe';machine=$pe.machine;bytes=(Get-Item -LiteralPath $binary).Length;sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();imports=@($pe.imports);delayImportsAbsent=$pe.delayImportsAbsent;entryPointRva=$pe.entryPointRva;subsystem=$pe.subsystem;executed=$false}
 }
 if($receipt.files.Count -ne 2 -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.source.sha256 -or (Get-FileHash -LiteralPath $toolchainReceipt -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.toolchainReceipt.sha256){throw 'Sentinel source, toolchain receipt or completed artifact set changed.'}
 $receipt.status='built'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
 try{[IO.File]::WriteAllText((Join-Path $output 'build-receipt.json'),($receipt|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))}
 catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'Sentinel failure receipt also failed to write.'}}
}
if($null -ne $primary){throw $primary}
