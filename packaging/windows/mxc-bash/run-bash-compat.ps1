# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Explicit disposable Windows CI only: no Hermes/Python/model or installer build.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceRoot,[Parameter(Mandatory)][string]$ArtifactDirectory,[Parameter(Mandatory)][string]$HelperDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -cne 'true' -or $env:OS -cne 'Windows_NT' -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne [Runtime.InteropServices.Architecture]::Arm64){throw 'The prototype requires disposable Windows ARM64 CI.'}
$out=[IO.Path]::GetFullPath($ArtifactDirectory);if(Test-Path -LiteralPath $out){throw 'Prototype evidence must be fresh.'};[void][IO.Directory]::CreateDirectory($out)
$work=Join-Path ([IO.Path]::GetPathRoot([Environment]::SystemDirectory)) ('NemoClawMsysProof-'+[guid]::NewGuid().ToString('N').Substring(0,12));[void][IO.Directory]::CreateDirectory($work)
$downloads=Join-Path $out 'downloads';[void][IO.Directory]::CreateDirectory($downloads)
$tools=Join-Path $work 'control';[void][IO.Directory]::CreateDirectory($tools)
$receipt=[ordered]@{schemaVersion=1;classification='small-mxc-msys-prototype';sourceRevision=$env:GITHUB_SHA;status='failed';phase='inputs';workRoot=$work;hermesPayloadDownloaded=$false;modelKeysUsed=$false;stages=@();cleanup=@{}}
$primary=$null
function Assert-Bytes([string]$File,[long]$Size,[string]$Hash){if((Get-Item -LiteralPath $File).Length -ne $Size -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash){throw 'Pinned prototype input changed.'}}
# Concurrent drains retain a fixed prefix while continuing to consume both pipes.
# An overflow ends the owned process; memory does not scale with compiler output.
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Threading.Tasks;
public sealed class MsysBoundedOutput {
 readonly MemoryStream captured=new MemoryStream();readonly object gate=new object();
 public long Total {get;private set;} public bool Overflow {get;private set;}
 public Task Completion {get;private set;}
 public MsysBoundedOutput(Stream source){Completion=Drain(source);}
 async Task Drain(Stream source){var buffer=new byte[8192];int count;while((count=await source.ReadAsync(buffer,0,buffer.Length))!=0){lock(gate){Total+=count;int retain=(int)Math.Min(count,4194304-captured.Length);if(retain>0)captured.Write(buffer,0,retain);if(Total>4194304)Overflow=true;}}}
 public bool Exceeded(){lock(gate){return Overflow;}}
 public byte[] Snapshot(){lock(gate){return captured.ToArray();}}
}
'@
function Invoke-Owned([string]$File,[string[]]$Arguments,[string]$Label,[int]$Seconds=120,[string]$RawArguments=''){
 $receipt.phase=$Label
 $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$File;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$work
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $start.Environment.Clear()
 foreach($key in @('SystemRoot','WINDIR','SystemDrive','ComSpec','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','ProgramFiles','ProgramFiles(x86)','ProgramW6432','PATH','PATHEXT','PSModulePath','VCToolsInstallDir','VCINSTALLDIR','VSINSTALLDIR','WindowsSdkDir','WindowsSDKVersion','VSCMD_ARG_HOST_ARCH','VSCMD_ARG_TGT_ARCH','INCLUDE','LIB','LIBPATH')){ $value=[Environment]::GetEnvironmentVariable($key);if($null -ne $value){$start.Environment[$key]=$value}}
 foreach($key in @('HOME','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')){$start.Environment[$key]=$work}
 $start.Environment['GITHUB_ACTIONS']='true';$start.Environment['GITHUB_SHA']=$env:GITHUB_SHA;$start.Environment['GITHUB_REPOSITORY']='NVIDIA/NemoClaw'
 if($RawArguments){$start.Arguments=$RawArguments}else{foreach($arg in $Arguments){$start.ArgumentList.Add($arg)}}
 $process=$null;$stdout=$null;$stderr=$null;$clock=[Diagnostics.Stopwatch]::StartNew();$row=[ordered]@{label=$Label;executable=$File;exitCode=$null;elapsedMs=$null;closed=$false;forced=$false;cleanupErrors=@()};$failure=$null
 try{
  $process=[Diagnostics.Process]::Start($start);$process.StandardInput.Close()
  $stdout=[MsysBoundedOutput]::new($process.StandardOutput.BaseStream);$stderr=[MsysBoundedOutput]::new($process.StandardError.BaseStream)
  while(-not $process.WaitForExit(100)){
   if($stdout.Exceeded() -or $stderr.Exceeded()){throw 'Owned prototype output bound exceeded.'}
   if($clock.ElapsedMilliseconds -ge $Seconds*1000){throw 'Owned prototype stage deadline.'}
  }
  $row.exitCode=$process.ExitCode;$row.closed=$true
  if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout.Completion,$stderr.Completion),5000)){throw 'Owned prototype output did not close.'}
  if($stdout.Exceeded() -or $stderr.Exceeded()){throw 'Owned prototype output bound exceeded.'}
  if($process.ExitCode -ne 0){throw ($Label+' failed; exact output retained.')}
 }catch{$failure=$_}finally{
  if($null -ne $process){
   try{if(-not $process.HasExited){$row.forced=$true;$process.Kill($true);if(-not $process.WaitForExit(5000)){throw 'Owned prototype child did not stop.'}};$row.closed=$process.HasExited;if($row.closed){$row.exitCode=$process.ExitCode}}
   catch{$row.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
  }
  foreach($entry in @(@('stdout',$stdout),@('stderr',$stderr))){
   if($null -ne $entry[1]){
    try{[void]$entry[1].Completion.Wait(1000)}catch{$row.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
    try{[IO.File]::WriteAllBytes((Join-Path $out ($Label+'.'+$entry[0]+'.log')),$entry[1].Snapshot())}catch{$row.cleanupErrors+=@($_.Exception.Message);if($null -eq $failure){$failure=$_}}
   }
  }
  if($null -ne $process){$process.Dispose()};$row.elapsedMs=$clock.ElapsedMilliseconds;$receipt.stages+=@($row)
 }
 if($null -ne $failure){throw $failure}
}
try{
 $nodeOutput=Join-Path $out 'node'
 Invoke-Owned (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $SourceRoot 'packaging/windows/app/prepare-app-node.ps1'),'-LockPath',(Join-Path $SourceRoot 'packaging/windows/hermes/official-runtime.lock.json'),'-OutputDirectory',$nodeOutput) 'pinned-node' 180
 Copy-Item -LiteralPath (Join-Path $nodeOutput 'node.exe') -Destination (Join-Path $tools 'node.exe')
 $gitArchive=Join-Path $downloads 'PortableGit-2.54.0-arm64.7z.exe';Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/download/v2.54.0.windows.1/PortableGit-2.54.0-arm64.7z.exe' -OutFile $gitArchive -TimeoutSec 180
 Assert-Bytes $gitArchive 59757336 'f8e92cd3359fcbb96998cfd606a536ccc6dbfb23c04e12b29042f9ba45b6b0c7'
 # Treat SFX as an archive: never execute its optional post-extraction program,
 # which could warm host MSYS before the contained comparison.
 $seven=Join-Path $env:ProgramFiles '7-Zip/7z.exe';if(-not(Test-Path -LiteralPath $seven)){throw 'The CI-only7-Zip archive tool is missing.'}
 $receipt['archiveExtractor']=[ordered]@{path=$seven;sha256=(Get-FileHash -LiteralPath $seven -Algorithm SHA256).Hash.ToLowerInvariant()}
 Invoke-Owned $seven @('x',$gitArchive,('-o'+(Join-Path $work 'git-original')),'-y') 'portable-git-extract' 180
 $derivation=Join-Path $out 'derived-aslr'
 Invoke-Owned (Join-Path $tools 'node.exe') @('--experimental-strip-types','--no-warnings',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/prepare-msys-aslr.mts'),'--source',(Join-Path $work 'git-original'),'--destination',(Join-Path $work 'git'),'--evidence',$derivation) 'derive-msys-dynamic-base' 180
 # The portable checksum implementation is independently checked by Windows.
 Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class MsysImageChecksum {
 [DllImport("imagehlp.dll",CharSet=CharSet.Unicode,ExactSpelling=true)]
 public static extern uint MapFileAndCheckSumW(string file,out uint header,out uint computed);
}
'@
 $derived=Get-Content -LiteralPath (Join-Path $derivation 'derivation.json') -Raw|ConvertFrom-Json
 $nativeChecks=@();$checksumsValid=$true
 foreach($name in @('original-msys-2.0.dll','derived-msys-2.0.dll','original-bash.exe','derived-bash.exe')) {
  [uint32]$header=0;[uint32]$computed=0
  $code=[MsysImageChecksum]::MapFileAndCheckSumW((Join-Path $derivation $name),[ref]$header,[ref]$computed)
  if($code -ne 0 -or $header -ne $computed){$checksumsValid=$false}
  $nativeChecks+=@(@{file=$name;header=$header;computed=$computed;status=$code})
 }
 $nativeSignatures=@()
 foreach($name in @('original-bash.exe','derived-bash.exe','original-arm64-wrapper.exe')) {
  $file=Join-Path $derivation $name;$signature=Get-AuthenticodeSignature -LiteralPath $file
  $nativeSignatures+=@(@{file=$name;sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();status=$signature.Status.ToString();statusMessage=$signature.StatusMessage;signatureType=$signature.SignatureType.ToString();signerSubject=$(if($null -ne $signature.SignerCertificate){$signature.SignerCertificate.Subject}else{$null});signerThumbprint=$(if($null -ne $signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null})})
 }
 $unsigned=@($nativeSignatures|Where-Object file -ceq 'derived-bash.exe')[0].status -ceq 'NotSigned'
 $bash=@($derived.files|Where-Object path -ceq 'usr/bin/bash.exe')[0]
 $bash.originalCertificate.authenticodeStatus=@($nativeSignatures|Where-Object file -ceq 'original-bash.exe')[0].status
 $derived|Add-Member -NotePropertyName nativeChecksumVerified -NotePropertyValue $checksumsValid
 $derived|Add-Member -NotePropertyName nativeChecksums -NotePropertyValue $nativeChecks
 $derived|Add-Member -NotePropertyName derivedBashUnsignedVerified -NotePropertyValue $unsigned
 $derived|Add-Member -NotePropertyName nativeSignatures -NotePropertyValue $nativeSignatures
 [IO.File]::WriteAllText((Join-Path $derivation 'derivation.json'),($derived|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))
 if(-not $checksumsValid){throw 'Windows rejected an original or derived image checksum.'}
 if(-not $unsigned){throw 'Windows must report the derived Bash copy as NotSigned.'}
 Copy-Item -LiteralPath (Join-Path $derivation 'derivation.json') -Destination (Join-Path $tools 'git-aslr-derivation.json')
 $sdk=Join-Path $downloads 'mxc-sdk-0.8.0.tgz';Invoke-WebRequest -Uri 'https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz' -OutFile $sdk -TimeoutSec 120
 if((Get-FileHash -LiteralPath $sdk -Algorithm SHA256).Hash.ToLowerInvariant() -cne '06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e'){throw 'Pinned stock MXC archive changed.'}
 Invoke-Owned (Join-Path ([Environment]::SystemDirectory) 'tar.exe') @('-xzf',$sdk,'-C',$downloads,'package/bin/arm64/wxc-exec.exe','package/bin/arm64/wxc-host-prep.exe') 'stock-mxc-extract' 30
 $mxc=Join-Path $downloads 'package/bin/arm64';$helper=Join-Path $HelperDirectory 'NemoClawHostPreparation.exe'
 Invoke-Owned $helper @('prepare-system-drive') 'existing-system-drive-helper' 30
 Invoke-Owned (Join-Path $mxc 'wxc-host-prep.exe') @('prepare-null-device','--json') 'existing-null-device-prep' 30
 $compatBuild=Join-Path $out 'compatibility-build'
 Invoke-Owned (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/build-msys-compat.ps1'),'-OutputDirectory',$compatBuild) 'compile-compatibility' 360
 $built=Get-Content -Raw (Join-Path $compatBuild 'build-receipt.json')|ConvertFrom-Json
 if($built.schemaVersion -ne 1 -or $built.classification -cne 'mxc-msys-compatibility-prototype-build' -or $built.status -cne 'built' -or $built.detours.commit -cne 'adb07604aa56508448b95bf037c2a6d0d3b6831a'){throw 'Compatibility build receipt differs from the reviewed contract.'}
 $compat=Join-Path $work 'compatibility';[void][IO.Directory]::CreateDirectory($compat)
 foreach($file in $built.files){if($file.file -notin @('NemoClawMsysLauncher.exe','NemoClawMsysCompat-arm64.dll','NemoClawMsysCompat-x64.dll')){throw 'Unexpected compatibility build output.'};Assert-Bytes (Join-Path $compatBuild $file.file) $file.bytes $file.sha256;Copy-Item -LiteralPath (Join-Path $compatBuild $file.file) -Destination (Join-Path $compat $file.file)}
 if(@($built.files).Count -ne 3 -or @($built.files.file|Select-Object -Unique).Count -ne 3){throw 'Compatibility build did not produce the three fixed outputs.'}
 Copy-Item -LiteralPath (Join-Path $compatBuild 'DETOURS-LICENSE.txt') -Destination (Join-Path $compat 'DETOURS-LICENSE.txt')
 Copy-Item -LiteralPath (Join-Path $compatBuild 'build-receipt.json') -Destination (Join-Path $compat 'build-receipt.json')
 $arm=@($built.toolchains|Where-Object target -ceq 'arm64');if($arm.Count -ne 1){throw 'Native ARM64 compiler identity missing.'}
 $rustCargo=@(& rustup which --toolchain 1.93.0 cargo)
 if($LASTEXITCODE -ne 0 -or $rustCargo.Count -ne 1){throw 'The upstream-pinned Rust toolchain is unavailable.'}
 $inspectionBuild=Join-Path $out 'mxc-token-inspection-build'
 Invoke-Owned (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/build-mxc-token-inspection.ps1'),'-SourceRoot',$SourceRoot,'-OutputDirectory',$inspectionBuild,'-ToolchainReceipt',(Join-Path $compatBuild 'build-receipt.json'),'-RustBinDirectory',([IO.Path]::GetDirectoryName($rustCargo[0]))) 'compile-mxc-token-inspection' 900
 $inspection=Get-Content -LiteralPath (Join-Path $inspectionBuild 'mxc-token-inspection-build.json') -Raw|ConvertFrom-Json
 $inspectionPatch=Join-Path $SourceRoot 'packaging/windows/mxc-bash/mxc-token-inspection.patch'
 if($inspection.schemaVersion -ne 1 -or $inspection.classification -cne 'mxc-owned-token-inspection-build' -or $inspection.status -cne 'built' -or $inspection.sourceCommit -cne '7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a' -or $inspection.sourceSha256 -cne '814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258' -or $inspection.patchSha256 -cne (Get-FileHash -LiteralPath $inspectionPatch -Algorithm SHA256).Hash.ToLowerInvariant() -or $inspection.tokenQueryRepairSupported -cne $true -or $inspection.tokenAccessMode -cne 'owned-child-query-only'){throw 'The scoped MXC token-query producer differs from its contract.'}
 $executors=@($inspection.files);if($executors.Count -ne 1 -or $executors[0].file -cne 'wxc-exec.exe' -or $executors[0].machine -ne 0xAA64){throw 'Unexpected inspection executor output.'}
 $inspectionExe=Join-Path $inspectionBuild 'wxc-exec.exe';Assert-Bytes $inspectionExe $executors[0].bytes $executors[0].sha256
 Copy-Item -LiteralPath $inspectionExe -Destination (Join-Path $tools 'wxc-exec.exe')
 Copy-Item -LiteralPath (Join-Path $inspectionBuild 'mxc-token-inspection-build.json') -Destination (Join-Path $tools 'mxc-token-inspection-build.json')
 Copy-Item -LiteralPath $inspectionPatch -Destination (Join-Path $tools 'mxc-token-inspection.patch')
 # Use the producer's initialized environment through its narrow probe builder.
 try{Invoke-Owned (Join-Path $PSHOME 'pwsh.exe') @('-NoProfile','-File',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/build-object-probe.ps1'),'-Source',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/object-probe.cpp'),'-Output',(Join-Path $tools 'NemoClawMsysObjectProbe.exe'),'-ToolchainReceipt',(Join-Path $compatBuild 'build-receipt.json')) 'compile-object-probe' 120}catch{$receipt['objectProbeCompileError']=$_.Exception.Message}
 Invoke-Owned (Join-Path $tools 'node.exe') @('--experimental-strip-types','--no-warnings',(Join-Path $SourceRoot 'packaging/windows/mxc-bash/bash-compat.mts'),'--work-root',$work,'--output',$out,'--mxc',(Join-Path $tools 'wxc-exec.exe')) 'contained-qualification' 420
 $proof=Get-Content -LiteralPath (Join-Path $out 'result.json') -Raw|ConvertFrom-Json
 if($proof.passed -cne $true -or $proof.normalCleanup -cne $true){throw 'The prototype did not finish all required checks.'}
 $receipt.status='pass'
}catch{$primary=$_;$receipt['error']=$_.Exception.Message}
finally{
 # The workflow excludes build/download trees; retain bounded compiler logs in a distinct directory.
 try{
 $kept=Join-Path $out 'compiler-logs';[void][IO.Directory]::CreateDirectory($kept)
 $buildPath=Join-Path $out 'compatibility-build/build'
 if(Test-Path -LiteralPath $buildPath){foreach($file in Get-ChildItem -LiteralPath $buildPath -File -Recurse){if($file.Extension -eq '.log' -and $file.Length -le 4194304){Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $kept (($file.FullName.Substring($buildPath.Length).TrimStart('\') -replace '[\\/:]','_')))}}}
 foreach($name in @('build-receipt.json','DETOURS-LICENSE.txt')){$file=Join-Path (Join-Path $out 'compatibility-build') $name;if(Test-Path -LiteralPath $file){Copy-Item -LiteralPath $file -Destination (Join-Path $kept $name)}}
 $probeReceipt=Join-Path $tools 'NemoClawMsysObjectProbe.exe.json';if(Test-Path -LiteralPath $probeReceipt){Copy-Item -LiteralPath $probeReceipt -Destination (Join-Path $out 'object-probe-build.json')}
 }catch{$receipt['compilerLogRetentionError']=$_.Exception.Message;if($null -eq $primary){$primary=$_}}
 $safe=$true;$result=Join-Path $out 'result.json'
 if(Test-Path -LiteralPath $result){try{$value=Get-Content -Raw $result|ConvertFrom-Json;$rows=@($value.cleanup.PSObject.Properties.Value);$safe=$value.hostProcessesClosed -ceq $true -and $value.hostProcessesNormal -ceq $true -and @($value.hostBaseline).Count -eq $value.startedHostProcesses -and $value.startedExecutors -gt 0 -and $rows.Count -eq $value.startedExecutors -and @($rows|Where-Object {$_.executor.closed -cne $true}).Count -eq 0}catch{$safe=$false}}
 elseif($receipt.phase -ceq 'contained-qualification'){$safe=$false}
 $safe=$safe -and @($receipt.stages|Where-Object {$_.closed -cne $true}).Count -eq 0
 $receipt.cleanup['workRetainedForUnconfirmedExecutor']= -not $safe
 if($safe){try{Remove-Item -LiteralPath $work -Recurse -Force}catch{if($null -eq $primary){$primary=$_};$receipt['cleanupError']=$_.Exception.Message}}
 $receipt.cleanup['workRootRemoved']= -not(Test-Path -LiteralPath $work)
 if($null -ne $primary){$receipt.status='failed'}
 try{[IO.File]::WriteAllText((Join-Path $out 'runner-result.json'),($receipt|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))}catch{if($null -eq $primary){$primary=$_}else{Write-Warning 'The runner receipt also failed to write.'}}
}
if($null -ne $primary){throw $primary}
