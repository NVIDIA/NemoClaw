# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Read debugger bytes/signatures/resources only. Never execute a debugger here.
param([Parameter(Mandatory)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Output){throw 'Tool inspection output must be fresh.'}
function Read-DebuggerFile([string]$File,[int]$Machine) {
 $item=Get-Item -LiteralPath $File -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -lt 64 -or $item.Length -gt 33554432){throw 'Debugger file is not bounded and ordinary.'}
 $before=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
 $bytes=[IO.File]::ReadAllBytes($File);$pe=[BitConverter]::ToInt32($bytes,60)
 if($bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a -or $pe -lt 64 -or $pe -gt $bytes.Length-24 -or [BitConverter]::ToUInt32($bytes,$pe) -ne 0x4550 -or [BitConverter]::ToUInt16($bytes,$pe+4) -ne $Machine){throw 'Debugger PE architecture differs.'}
 $signature=Get-AuthenticodeSignature -LiteralPath $File
 if($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)'){throw 'Debugger file lacks a valid Microsoft signature.'}
 $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($File).FileVersion
 if(-not $version -or $version.Length -gt 128){throw 'Debugger version is unavailable.'}
 $after=Get-Item -LiteralPath $File -Force
 if($after.Length -ne $bytes.Length -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before){throw 'Debugger bytes changed during inspection.'}
 return @{path=$File;bytes=$bytes.Length;sha256=$before;machine=$Machine;version=$version;signatureStatus=[string]$signature.Status;signerSubject=$signature.SignerCertificate.Subject;signerThumbprint=$signature.SignerCertificate.Thumbprint;executed=$false}
}
$record=[ordered]@{schemaVersion=1;classification='renderer-postmortem-tool-inspection';source='OS known folders';executedDebugger=$false;candidates=@();selected=$null;status='unavailable'}
$roots=@([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86),[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))|Select-Object -Unique
foreach($architecture in @('x64','arm64')){
 foreach($root in $roots){
  if(-not $root){continue}
  $directory=Join-Path $root ('Windows Kits\10\Debuggers\'+$architecture)
  $candidate=[ordered]@{directory=$directory;architecture=$architecture;status='unavailable';files=@();error=$null}
  try {
   $folder=Get-Item -LiteralPath $directory -Force
   if(-not $folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Debugger directory redirects.'}
   $machine=if($architecture -ceq 'x64'){0x8664}else{0xaa64}
   foreach($name in @('cdb.exe','dbgeng.dll','dbghelp.dll','dbgcore.dll','dbgmodel.dll')){
    $candidate.files+=@(Read-DebuggerFile (Join-Path $directory $name) $machine)
   }
   $candidate.status='available'
   if($null -eq $record.selected){$record.selected=@{cdb=$candidate.files[0];debuggerDlls=@($candidate.files|Select-Object -Skip 1);architecture=$architecture}}
  }catch{$candidate.error=$_.Exception.Message}
  $record.candidates+=@($candidate)
 }
}
if($null -ne $record.selected){$record.status='available'}
[IO.File]::WriteAllText($Output,($record|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
@{output=$Output;status=$record.status;executedDebugger=$false}|ConvertTo-Json -Compress
