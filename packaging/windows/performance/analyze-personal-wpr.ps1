# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$script:TracePin=[ordered]@{runId=34738177107L;source='bf0c01fc478b55d781fc577ee50545a7f18c10cc';artifactId=10311642072L;bytes=60500148L;sha256='08f8035e8705002b29ded7a166b065a88bf2b90e03e9b8a3c5eab063932b8461';entries=30;expandedBytes=960543435L;etl='wpr-command-prefix/capture.etl';etlBytes=960495616L;etlSha256='533fd9d540535c906d12fce20ead940bc42c947949ac0f1f5e5c347863a0db5a'}
function Save-AnalysisJson($Value,[string]$Path){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 14)+"`n",[Text.UTF8Encoding]::new($false))}
function Get-AnalysisKnownFolders {
 @([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86))|Where-Object {$_}|Select-Object -Unique
}
function Get-AnalysisToolIdentity([string]$Path){
 $file=Get-Item -LiteralPath $Path -Force
 if($file.PSIsContainer -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Analysis tool must be an ordinary installed file.'}
 $stream=[IO.File]::OpenRead($file.FullName);$reader=[IO.BinaryReader]::new($stream)
 try{
  if($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d){throw 'Analysis tool lacks MZ header.'}
  $stream.Position=60;$offset=$reader.ReadUInt32()
  if($offset -lt 64 -or $offset -gt 1MB -or $offset+6 -gt $stream.Length){throw 'Analysis tool PE is outside its read bound.'}
  $stream.Position=$offset;if($reader.ReadUInt32() -ne 0x4550){throw 'Analysis tool lacks PE header.'};$machine=$reader.ReadUInt16()
 }finally{$reader.Dispose();$stream.Dispose()}
 return [pscustomobject]@{path=$file.FullName;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$file.VersionInfo.FileVersion;machine=('0x{0:x4}' -f $machine)}
}
function Find-InstalledWptTools {
 $found=[Collections.Generic.List[object]]::new();$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($base in @(Get-AnalysisKnownFolders)){
  foreach($relative in @('Windows Kits/10/Windows Performance Toolkit','Windows Kits/10/Windows Performance Toolkit/arm64','Windows Kits/10/Windows Performance Toolkit/x64')){
   foreach($name in @('xperf.exe','WPAExporter.exe','wpa.exe')){
    $path=Join-Path $base ($relative+'/'+$name)
    if($seen.Add($path) -and (Test-Path -LiteralPath $path -PathType Leaf)){$found.Add((Get-AnalysisToolIdentity $path))}
   }
  }
 }
 return @($found.ToArray())
}
function Assert-TraceEntries($Entries,[string]$Destination){
 if(@($Entries).Count -ne $script:TracePin.entries -or ($Entries|Measure-Object -Property Length -Sum).Sum -ne $script:TracePin.expandedBytes){throw 'Trace archive layout differs from measured bytes.'}
 $seen=[Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
 foreach($entry in $Entries){
  $name=[string]$entry.FullName;$trim=$name.TrimEnd('/');$parts=$trim.Split('/')
  if(-not $trim -or $name -match '[\\:\x00-\x1f]' -or $name.StartsWith('/') -or @($parts|Where-Object {-not $_ -or $_ -cin @('.','..') -or $_ -match '[ .]$|^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$'}).Count){throw 'Unsafe trace archive path.'}
  $key=$trim.Normalize([Text.NormalizationForm]::FormC);$directory=$name.EndsWith('/')
  if($seen.ContainsKey($key)){throw 'Colliding trace archive path.'};$seen.Add($key,$directory)
  $mode=($entry.ExternalAttributes -shr 16) -band 0xf000
  if($mode -notin @(0,0x8000,0x4000) -or ($mode -eq 0x4000 -and -not $directory)){throw 'Trace archive contains a link or special file.'}
  $target=[IO.Path]::GetFullPath((Join-Path $Destination $name))
  if(-not $target.StartsWith($Destination+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Trace archive escapes its owned root.'}
 }
 foreach($key in @($seen.Keys)){
  $parts=$key.Split('/')
  for($i=1;$i -lt $parts.Length;$i++){$parent=($parts[0..($i-1)]-join '/');if($seen.ContainsKey($parent) -and -not $seen[$parent]){throw 'Trace archive file/directory overlap.'}}
 }
}
function Invoke-TraceAnalysisCommand($Tool,[string[]]$Arguments,[string]$LogPath,[string]$ReportPath='',[long]$MaximumReportBytes=64MB){
 $before=Get-AnalysisToolIdentity $Tool.path
 if($before.sha256 -cne $Tool.sha256 -or $before.bytes -ne $Tool.bytes){throw 'Selected installed analysis tool changed.'}
 $process=[Diagnostics.Process]::new();$capture=$null;$failure=$null;$clock=[Diagnostics.Stopwatch]::StartNew()
 $record=[ordered]@{tool=$Tool;arguments=$Arguments;started=$false;pid=$null;exitCode=$null;closed=$false;captureClosed=$false;timedOut=$false;reportExceeded=$false;maximumReportBytes=$MaximumReportBytes;timeoutMs=120000;error=$null;report=$null}
 try{
  $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$Tool.path;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  foreach($arg in $Arguments){$start.ArgumentList.Add($arg)}
  [void]$start.Environment.Remove('GH_TOKEN');[void]$start.Environment.Remove('GITHUB_TOKEN')
  $process.StartInfo=$start
  if(-not $process.Start()){throw 'Analysis tool did not start.'};$record.started=$true;$record.pid=$process.Id
  $capture=[NemoClaw.Performance.BoundedOutput]::new($process)
  while(-not $process.WaitForExit(100)){
   if($clock.ElapsedMilliseconds -ge 120000){$record.timedOut=$true;throw 'Owned analysis command exceeded its bound.'}
   if($ReportPath -and (Test-Path -LiteralPath $ReportPath -PathType Leaf)){
    $size=[NemoClaw.Performance.TraceFileMetadata]::Read($ReportPath)
    if($size.bytes -gt $MaximumReportBytes){$record.reportExceeded=$true;throw 'Owned analysis report exceeded its remaining byte bound.'}
   }
  }
  $record.exitCode=$process.ExitCode
  $record.captureClosed=$capture.Finish(5000)
  if(-not $record.captureClosed){throw 'Analysis output did not close.'}
  if($process.ExitCode -ne 0){throw 'Analysis action returned nonzero; exact output retained.'}
 }catch{$failure=$_;$record.error=$_.Exception.Message}
 finally{
  if($record.started){try{if(-not $process.HasExited){$process.Kill()};$record.closed=$process.WaitForExit(5000);if($record.closed){$record.exitCode=$process.ExitCode}}catch{$record['cleanupError']=$_.Exception.Message}}
  if($null -ne $capture){
   try{
    $record.captureClosed=$capture.Finish(1000);$record['output']=$capture.Save($LogPath)
    if($record.output.stdout.readFailed -or $record.output.stderr.readFailed){$record['captureError']='Analysis output read failed.'}
   }catch{$record['captureError']=$_.Exception.Message}
   finally{try{$capture.Dispose()}catch{$record['captureDisposeError']=$_.Exception.Message}}
  }
  try{$process.Dispose()}catch{$record['processDisposeError']=$_.Exception.Message}
  $record['elapsedMs']=$clock.Elapsed.TotalMilliseconds
  if($ReportPath){
   try{
    if(-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)){throw 'Expected analysis report was not written.'}
    $file=Get-Item -LiteralPath $ReportPath;if($file.Length -gt $MaximumReportBytes){$record.reportExceeded=$true}
    if($file.Length -eq 0){throw 'Expected analysis report is empty.'}
    $record.report=@{path=$file.FullName;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
   }catch{$record['reportError']=$_.Exception.Message}
  }
  foreach($secondary in @('cleanupError','captureError','captureDisposeError','processDisposeError','reportError')){
   if($record.Contains($secondary) -and -not $record.error){$record.error=$record[$secondary]}
  }
  Save-AnalysisJson $record ($LogPath+'.json')
 }
 return [pscustomobject]$record
}
function Invoke-PersonalTraceAnalysis([string]$Directory){
 if($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true'){throw 'Recorded trace analysis requires disposable Windows CI.'}
 $out=[IO.Path]::GetFullPath($Directory);if(Test-Path -LiteralPath $out){throw 'Trace analysis output must be fresh.'};[void][IO.Directory]::CreateDirectory($out)
 . (Join-Path $PSScriptRoot 'native-output-capture.ps1')
 $record=[ordered]@{schemaVersion=1;classification='recorded-Personal-WPR-analysis';controllerSource=$env:GITHUB_SHA;input=$script:TracePin;status='failed';stage='artifact-admission';applicationExecuted=$false;runtimeBuilt=$false;recordingChanged=$false;toolInstalled=$false;partialInterpretation=$true;attribution=$null;actions=@();error=$null}
 $primary=$null
 try{
  $headers=@{Accept='application/vnd.github+json';Authorization=('Bearer '+$env:GH_TOKEN)}
  $run=Invoke-RestMethod -Uri ('https://api.github.com/repos/NVIDIA/NemoClaw/actions/runs/'+$script:TracePin.runId) -Headers $headers -TimeoutSec 30
  $artifact=Invoke-RestMethod -Uri ('https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/'+$script:TracePin.artifactId) -Headers $headers -TimeoutSec 30
  if($run.id -ne $script:TracePin.runId -or $run.head_sha -cne $script:TracePin.source -or $run.path -cne '.github/workflows/windows-native-installer.yaml' -or $run.repository.full_name -cne 'NVIDIA/NemoClaw' -or $run.status -cne 'completed' -or $run.run_attempt -ne 1 -or $artifact.workflow_run.id -ne $run.id -or $artifact.workflow_run.head_sha -cne $script:TracePin.source -or $artifact.name -cne ('official-hermes-personal-trace-'+$script:TracePin.source+'-1') -or $artifact.expired -or $artifact.size_in_bytes -ne $script:TracePin.bytes -or $artifact.digest -cne ('sha256:'+$script:TracePin.sha256)){throw 'Recorded trace API identity differs.'}
  Save-AnalysisJson $run (Join-Path $out 'source-run.json');Save-AnalysisJson $artifact (Join-Path $out 'source-artifact.json')
  $archive=Join-Path $out 'recorded-trace.zip'
  Invoke-WebRequest -Uri ('https://api.github.com/repos/NVIDIA/NemoClaw/actions/artifacts/'+$script:TracePin.artifactId+'/zip') -Headers $headers -OutFile $archive -TimeoutSec 300
  if((Get-Item $archive).Length -ne $script:TracePin.bytes -or (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:TracePin.sha256){throw 'Complete trace archive hash/length differs.'}
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $inputRoot=Join-Path $out 'input';$zip=[IO.Compression.ZipFile]::OpenRead($archive)
  try{Assert-TraceEntries @($zip.Entries) $inputRoot}finally{$zip.Dispose()}
  [IO.Compression.ZipFile]::ExtractToDirectory($archive,$inputRoot)
  $etl=Join-Path $inputRoot $script:TracePin.etl
  if((Get-Item $etl).Length -ne $script:TracePin.etlBytes -or (Get-FileHash $etl -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:TracePin.etlSha256){throw 'Measured ETL identity differs.'}
  $record.stage='installed-tool-discovery';$tools=@(Find-InstalledWptTools);$record['tools']=$tools
  Save-AnalysisJson @{knownFolders=@(Get-AnalysisKnownFolders);tools=$tools;source='OS known folders; no environment-variable assumption';installedByThisRun=$false} (Join-Path $out 'analysis-tools.json')
  $xperf=@($tools|Where-Object {[IO.Path]::GetFileName($_.path) -ieq 'xperf.exe' -and $_.machine -in @('0xaa64','0x8664')}|Sort-Object @{Expression={if($_.machine -eq '0xaa64'){0}elseif($_.machine -eq '0x8664'){1}else{2}}})
  if(-not $xperf.Count){throw 'Preinstalled xperf was not found in OS-known WPT locations; no installation attempted.'}
  $tool=$xperf[0];$logs=Join-Path $out 'logs';$reports=Join-Path $out 'reports';[void][IO.Directory]::CreateDirectory($logs);[void][IO.Directory]::CreateDirectory($reports)
  $record.stage='analysis';$help=Invoke-TraceAnalysisCommand $tool @('-help','processing') (Join-Path $logs 'processing-help.log');$record.actions+=@($help)
  if($help.started -and (-not $help.closed -or -not $help.captureClosed)){throw 'Analysis help process or pipe capture has unconfirmed closure.'}
  $dumperHelp=Invoke-TraceAnalysisCommand $tool @('-help','dumper','tracestats','profile') (Join-Path $logs 'action-help.log');$record.actions+=@($dumperHelp)
  if($dumperHelp.started -and (-not $dumperHelp.closed -or -not $dumperHelp.captureClosed)){throw 'Dumper help process or pipe capture has unconfirmed closure.'}
  $actions=@(
   @{name='trace-stats';args=@('tracestats','-timespan','actual','-detail')},
   @{name='processes';args=@('process')},
   @{name='cpu-samples';args=@('profile','-detail')},
   @{name='context-switches';args=@('cswitch','-process','-thread')},
   @{name='cpu-disk';args=@('cpudisk')},
   @{name='file-names';args=@('filename')},
   @{name='disk-io';args=@('diskio','-summary')}
  )
  foreach($action in $actions){
   if(@($record.actions|Where-Object {$_.started -and (-not $_.closed -or -not $_.captureClosed)}).Count){throw 'An analysis child or its pipe capture has unconfirmed closure; no next action may start.'}
   $total=0L;foreach($file in @(Get-ChildItem -LiteralPath $reports -File)){$total+=$file.Length}
   if($total -ge 256MB){throw 'Analysis summaries reached their256MiB aggregate bound.'}
   $report=Join-Path $reports ($action.name+'.txt');$argv=@('-i',$etl,'-o',$report,'-a')+$action.args
   $value=Invoke-TraceAnalysisCommand $tool $argv (Join-Path $logs ($action.name+'.log')) $report ([Math]::Min(64MB,256MB-$total))
   $record.actions+=@($value)
   if($value.started -and (-not $value.closed -or -not $value.captureClosed)){throw 'Analysis process or pipe capture has unconfirmed closure; no next action may start.'}
   if($value.reportExceeded){throw 'Analysis report reached its observed byte bound; no next action may start.'}
  }
  if(@($record.actions|Where-Object {$_.started -and (-not $_.closed -or -not $_.captureClosed)}).Count){throw 'Final analysis process or pipe capture has unconfirmed closure.'}
  if((Get-FileHash $etl -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:TracePin.etlSha256){throw 'An analysis tool changed its recorded input.'}
  $record['inputUnchanged']=$true
  $record.status=if(@($record.actions|Where-Object {$_.error -or -not $_.closed -or -not $_.captureClosed -or $_.timedOut -or $_.reportExceeded}).Count){'partial-analysis'}else{'summaries-exported'}
 }catch{$primary=$_;$record.error=$_.Exception.Message}
 finally{Save-AnalysisJson $record (Join-Path $out 'analysis-result.json')}
 if($null -ne $primary){throw $primary}
}
if($MyInvocation.InvocationName -ne '.') {Invoke-PersonalTraceAnalysis $ArtifactDirectory}
