# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RequestFile)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$requestPath=[IO.Path]::GetFullPath($RequestFile)
if(-not(Test-Path -LiteralPath $requestPath -PathType Leaf)){throw 'The trace request is absent.'}
$requestInfo=Get-Item -LiteralPath $requestPath -Force
$directory=Split-Path -Parent $requestPath
$directoryInfo=Get-Item -LiteralPath $directory -Force
if($requestInfo.Name -cne 'request.json' -or $requestInfo.Length -gt 16384 -or $requestInfo.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $directoryInfo.Name -cne 'primary-wpr' -or -not $directoryInfo.PSIsContainer -or $directoryInfo.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'The owned trace request/output shape differs.'}
$ready=Join-Path $directory 'ready.json';$stop=Join-Path $directory 'stop.json';$resultPath=Join-Path $directory 'owner-result.json'
foreach($file in @($ready,$stop,$resultPath)){if(Test-Path -LiteralPath $file){throw 'Trace control output must be fresh.'}}
function Save-OwnedJson($Value,[string]$Path){$temporary=$Path+'.tmp';[IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false));[IO.File]::Move($temporary,$Path)}
function Read-ToolPeMachine([string]$Path){
 $stream=[IO.File]::OpenRead($Path);$reader=[IO.BinaryReader]::new($stream)
 try{
  if($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d){throw 'Tool lacks MZ header.'}
  $stream.Position=60;$offset=$reader.ReadUInt32()
  if($offset -lt 64 -or $offset -gt 1MB -or $offset+6 -gt $stream.Length){throw 'Tool PE header is outside its bound.'}
  $stream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550){throw 'Tool lacks PE header.'}
  return ('0x{0:x4}' -f $reader.ReadUInt16())
 }finally{$reader.Dispose();$stream.Dispose()}
}
$state=$null;$traceRecord=$null;$failure=$null;$readyWritten=$false;$request=$null;$toolPresent=$false
$record=[ordered]@{schemaVersion=1;classification='personal-primary-wpr-owner';sourceRevision=$null;nonce=$null;requestSha256=(Get-FileHash -LiteralPath $requestPath -Algorithm SHA256).Hash.ToLowerInvariant();measuredPolicySha256=$null;stage='request-identity';recordingAttempted=$false;primaryLaunchedByRecorder=$false;debuggerAttached=$false;partialPrefixOnly=$true;maximumRecordingSeconds=45;maximumObservedRecordingBytes=256MB;recordingStopped=$false;trace=$null;error=$null}
try{
 $request=Get-Content -LiteralPath $requestPath -Raw|ConvertFrom-Json
 foreach($key in @('sourceRevision','nonce')){if($request.PSObject.Properties.Name -contains $key){$record[$key]=$request.$key}}
 if($request.PSObject.Properties.Name -contains 'policySha256'){$record.measuredPolicySha256=$request.policySha256}
 if($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true'){throw 'Personal tracing requires disposable Windows CI.'}
 if($request.schemaVersion -ne 1 -or $request.classification -cne 'personal-primary-wpr-request' -or $request.sourceRevision -cne $env:GITHUB_SHA -or $request.nonce -cnotmatch '^[a-f0-9]{24}$' -or $request.policySha256 -cnotmatch '^[a-f0-9]{64}$'){throw 'The trace request identity differs.'}
 $record.stage='load-recorder-helpers'
 . (Join-Path $PSScriptRoot 'wpr-trace.ps1')
 . (Join-Path $PSScriptRoot 'measurement-tracing.ps1')
 $record.stage='analysis-discovery'
# Discovery only: do not install, execute, or infer availability of WPT analysis tools.
$analysis=[Collections.Generic.List[object]]::new()
foreach($base in @(${env:ProgramFiles(x86)},$env:ProgramFiles)|Select-Object -Unique){
 if(-not $base){continue}
 foreach($name in @('xperf.exe','WPAExporter.exe','wpa.exe')){
  $path=Join-Path $base ('Windows Kits/10/Windows Performance Toolkit/'+$name)
  if(Test-Path -LiteralPath $path -PathType Leaf){
   $file=Get-Item -LiteralPath $path
   if($file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){continue}
   try{$analysis.Add([ordered]@{path=$file.FullName;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$file.VersionInfo.FileVersion;machine=(Read-ToolPeMachine $path);executed=$false})}catch{$analysis.Add([ordered]@{path=$path;error=$_.Exception.Message;executed=$false})}
  }
 }
}
Save-OwnedJson @{classification='installed-WPT-analysis-tool-discovery';tools=@($analysis.ToArray());searchedStandardInstallPathsOnly=$true;analysisPerformed=$false} (Join-Path $directory 'analysis-tools.json')
 $record.stage='recorder-availability'
 $toolPresent=Test-Path -LiteralPath (Get-WindowsPerformanceRecorderPath) -PathType Leaf
 if(-not $toolPresent){throw 'Built-in WPR is unavailable; the primary command remains independent.'}
 $record.stage='recorder-start';$record.recordingAttempted=$true
 $state=New-MeasurementTraceState -Case ([pscustomobject]@{action='launch';wpr=$true}) -Directory $directory
 Save-OwnedJson @{sourceRevision=$request.sourceRevision;nonce=$request.nonce;started=($null -ne $state.current -and $state.current.trace.active);failures=@($state.failures.ToArray())} $ready
 $readyWritten=$true
 while($state.safeToContinue -and $null -ne $state.current -and $state.current.trace.active){
  if(Test-Path -LiteralPath $stop -PathType Leaf){
   if((Get-Item -LiteralPath $stop).Length -gt 16384){throw 'The stop request exceeds its bound.'}
   $end=Get-Content -LiteralPath $stop -Raw|ConvertFrom-Json
   if($end.nonce -cne $request.nonce -or $end.sourceRevision -cne $request.sourceRevision){throw 'Trace stop request identity differs.'}
   $record['primaryStopSignal']=$end
   break
  }
  Update-MeasurementTraceState -State $state
  Start-Sleep -Milliseconds 100
 }
}catch{$failure=$_;$record.error=$_.Exception.Message}
finally{
 if($null -ne $state){
  try{$traceRecord=Complete-MeasurementTraceState -State $state;$record.trace=$traceRecord;$record.recordingStopped=$traceRecord.safeToContinue}
  catch{if($null -eq $failure){$failure=$_;$record.error=$_.Exception.Message}else{$record['finalizationError']=$_.Exception.Message}}
 }elseif(-not $record.recordingAttempted){$record.recordingStopped=$true}
 if(-not $readyWritten){Save-OwnedJson @{sourceRevision=$record.sourceRevision;nonce=$record.nonce;started=$false;error=$record.error;stage=$record.stage;recordingAttempted=$record.recordingAttempted} $ready}
 Save-OwnedJson $record $resultPath
}
if($null -ne $failure -or -not $record.recordingStopped){exit 1}
