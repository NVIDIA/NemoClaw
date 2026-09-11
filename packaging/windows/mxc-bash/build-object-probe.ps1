# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Output,[Parameter(Mandatory)][string]$ToolchainReceipt)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or $PSEdition -cne 'Core'){throw 'The raw probe is a disposable Windows CI build.'}
$inputSource=[IO.Path]::GetFullPath($Source);$binary=[IO.Path]::GetFullPath($Output)
foreach($value in @($inputSource,$binary,$ToolchainReceipt)){if($value -match '[^\x20-\x7e]|["\r\n&|<>^%]'){throw 'Invalid native probe build path.'}}
if(Test-Path -LiteralPath $binary){throw 'The raw probe output must be fresh.'}
$build=Get-Content -LiteralPath $ToolchainReceipt -Raw|ConvertFrom-Json
if($build.classification -cne 'mxc-msys-compatibility-prototype-build' -or $build.status -cne 'built'){throw 'Expected the successful coordinated compiler receipt.'}
$rows=@($build.toolchains|Where-Object target -ceq 'arm64');if($rows.Count -ne 1){throw 'Expected one ARM64 toolchain.'};$arm=$rows[0]
if($arm.toolsetVersion -cne '14.51.36231' -or $arm.sdkVersion -cne '10.0.26100.0'){throw 'The reviewed compiler tuple changed.'}
foreach($pair in @(@($arm.cl,$arm.clSha256),@($arm.link,$arm.linkSha256))){if((Get-FileHash -LiteralPath $pair[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pair[1]){throw 'The coordinated compiler bytes changed.'}}
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installations=@(& $vswhere -latest -products '*' -property installationPath);if($LASTEXITCODE -ne 0 -or $installations.Count -ne 1){throw 'The Visual Studio installation is ambiguous.'}
$vsdev=Join-Path $installations[0] 'Common7/Tools/VsDevCmd.bat'
$directory=Split-Path -Parent $binary;$batch=Join-Path $directory 'compile-object-probe.cmd'
$sourceHash=(Get-FileHash -LiteralPath $inputSource -Algorithm SHA256).Hash.ToLowerInvariant()
$identity=@'
Set-StrictMode -Version Latest;$ErrorActionPreference='Stop'
if($env:VCToolsVersion.TrimEnd('\') -cne '14.51.36231' -or $env:WindowsSDKVersion.TrimEnd('\') -cne '10.0.26100.0'){throw 'Probe compiler environment differs.'}
$cl=Join-Path $env:VCToolsInstallDir 'bin/HostARM64/arm64/cl.exe'
if((Get-FileHash -LiteralPath $cl -Algorithm SHA256).Hash.ToLowerInvariant() -cne '__CL_SHA__'){throw 'Probe compiler environment selected different bytes.'}
'@
$encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($identity.Replace('__CL_SHA__',$arm.clSha256)))
$commands=@('@echo off',('call "'+$vsdev+'" -no_logo -arch=arm64 -host_arch=arm64 -vcvars_ver=14.51.36231 -winsdk=10.0.26100.0'),'if errorlevel 1 exit /b 1',('set "PATH='+([IO.Path]::GetDirectoryName($arm.cl))+';%PATH%"'),('"'+(Join-Path $PSHOME 'pwsh.exe')+'" -NoProfile -EncodedCommand '+$encoded),'if errorlevel 1 exit /b 1',('"'+$arm.cl+'" /nologo /W4 /WX /std:c++20 /EHsc /MT /DUNICODE /D_UNICODE "'+$inputSource+'" /Fo"'+$directory+'\object-probe.obj" /Fe:"'+$binary+'" /link /SUBSYSTEM:CONSOLE /INCREMENTAL:NO advapi32.lib kernel32.lib'),'if errorlevel 1 exit /b 1','exit /b 0')
[IO.File]::WriteAllText($batch,($commands -join "`r`n")+"`r`n",[Text.UTF8Encoding]::new($false))
function Invoke-ProbeCompiler([string]$Executable,[string]$Arguments,[int]$TimeoutMs=110000){
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Executable;$start.Arguments=$Arguments;$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $process=$null;$stdout=$null;$stderr=$null;$failure=$null
 try{
  $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
  # Stream both pipes into the outer owner's already bounded drains; no compiler
  # output is accumulated by this nested process or lost on a nonzero exit.
  $stdout=$process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr=$process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  if(-not $process.WaitForExit($TimeoutMs)){throw 'The raw probe compiler exceeded its bound.'}
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),5000)){throw 'The raw probe compiler output did not close.'}
  if($process.ExitCode -ne 0){throw ('The unshimmed native object probe compiler exited '+$process.ExitCode+'.')}
 }catch{$failure=$_}finally{
  if($null -ne $process){
   try{if(-not $process.HasExited){$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'Raw probe compiler did not stop.'}}}
   catch{if($null -eq $failure){$failure=$_}else{Write-Warning 'Raw probe compiler cleanup also failed.'}}
   foreach($copy in @($stdout,$stderr)){try{if($null -ne $copy -and -not $copy.Wait(1000)){throw 'Raw compiler output remained open.'}}catch{if($null -eq $failure){$failure=$_}else{Write-Warning 'Raw compiler output cleanup also failed.'}}}
   $process.Dispose()
  }
 }
 if($null -ne $failure){throw $failure}
}
Invoke-ProbeCompiler (Join-Path ([Environment]::SystemDirectory) 'cmd.exe') ('/d /s /c ""'+$batch+'""')
$bytes=[IO.File]::ReadAllBytes($binary);$offset=[BitConverter]::ToInt32($bytes,60)
if($offset -lt 64 -or $offset+6 -gt $bytes.Length -or [BitConverter]::ToUInt32($bytes,$offset) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$offset+4) -ne 0xAA64){throw 'The probe is not ARM64 PE.'}
if((Get-FileHash -LiteralPath $inputSource -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sourceHash){throw 'Probe source changed during compilation.'}
$record=@{schemaVersion=1;classification='unshimmed-native-object-probe-build';sourceSha256=$sourceHash;toolchain=$arm;bytes=$bytes.Length;sha256=(Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant();machine='arm64';executed=$false}
[IO.File]::WriteAllText(($binary+'.json'),($record|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))
