# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

. (Join-Path $PSScriptRoot 'native-output-capture.ps1')

function Get-WindowsPerformanceRecorderPath {
    return (Join-Path $env:SystemRoot 'System32\wpr.exe')
}

function Invoke-OwnedWprCommand {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$LogPath, [ValidateRange(1,60000)][int]$TimeoutMilliseconds=60000)
    $executable=Get-WindowsPerformanceRecorderPath
    if(-not(Test-Path -LiteralPath $executable -PathType Leaf)){throw 'The built-in Windows Performance Recorder is unavailable.'}
    $process=[Diagnostics.Process]::new();$capture=$null;$primary=$null
    $record=[ordered]@{arguments=$Arguments;timeoutMs=$TimeoutMilliseconds;timedOut=$false;started=$false;processId=$null;exitCode=$null;processStopped=$false;output=$null}
    $clock=[Diagnostics.Stopwatch]::StartNew()
    try {
        $process.StartInfo=[Diagnostics.ProcessStartInfo]::new()
        $process.StartInfo.FileName=$executable
        $process.StartInfo.Arguments=($Arguments | ForEach-Object {
            if($_ -match '["\r\n]' -or $_.EndsWith('\')){throw 'An unsupported WPR argument was supplied.'}
            if($_ -match '\s'){ '"'+$_+'"' } else {$_}
        }) -join ' '
        $process.StartInfo.UseShellExecute=$false
        $process.StartInfo.CreateNoWindow=$true
        $process.StartInfo.RedirectStandardOutput=$true
        $process.StartInfo.RedirectStandardError=$true
        if(-not $process.Start()){throw 'WPR did not start.'}
        $record.started=$true;$record.processId=$process.Id
        $capture=[NemoClaw.Performance.BoundedOutput]::new($process)
        if(-not $process.WaitForExit($TimeoutMilliseconds)){$record.timedOut=$true;throw 'WPR command exceeded its bounded wait.'}
        $record.exitCode=$process.ExitCode
        if(-not $capture.Finish(5000)){throw 'WPR output did not finish.'}
        if($process.ExitCode -ne 0){throw 'WPR command failed; its exact output is retained.'}
    } catch {$primary=$_}
    finally {
        # Only this WPR command process is stopped. The recording instance has its
        # own explicit cancel path; the measured installer/agent is never a target.
        if($record.started){
            try {if(-not $process.HasExited){$process.Kill()};$record.processStopped=$process.WaitForExit(5000);if($record.processStopped){$record.exitCode=$process.ExitCode}}
            catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'The owned WPR command also failed cleanup.'}}
        }
        if($null -ne $capture){
            try {$null=$capture.Finish(1000);$record.output=$capture.Save($LogPath)}
            catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'WPR output could not be retained.'}}
            try {$capture.Dispose()}catch{if($null -eq $primary){$primary=$_}}
        }
        $record['elapsedMs']=$clock.Elapsed.TotalMilliseconds
        try {[IO.File]::WriteAllText($LogPath+'.json',($record|ConvertTo-Json -Depth 6)+"`n",[Text.UTF8Encoding]::new($false))}
        catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'WPR command metadata could not be retained.'}}
        $process.Dispose()
    }
    if($null -ne $primary){throw $primary}
}

function Get-WindowsPerformanceTraceFiles {
    param([Parameter(Mandatory)][string]$Directory)
    $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($Directory)
    $files=[Collections.Generic.List[object]]::new();$bytes=[long]0;$entries=0
    while($pending.Count -gt 0){
        foreach($item in @(Get-ChildItem -LiteralPath ($pending.Pop()) -Force)){
            $entries++
            if($entries -gt 4096){throw 'The owned trace directory exceeded its inventory bound.'}
            if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Trace accounting does not follow reparse paths.'}
            if($item.PSIsContainer){$pending.Push($item.FullName)}else{
                $current=[NemoClaw.Performance.TraceFileMetadata]::Read($item.FullName)
                $bytes += $current.bytes
                $files.Add([ordered]@{relativePath=$item.FullName.Substring($Directory.Length).TrimStart('\','/');bytes=$current.bytes;attributes=$current.attributes;enumeratedBytes=$item.Length;sizeQuery=$current.method})
            }
        }
    }
    return [pscustomobject]@{logicalBytes=$bytes;files=@($files.ToArray());includesHiddenAndSystem=$true;allocatedBytes=$null}
}

function Get-WindowsPerformanceRecorderIdentity {
    $path=Get-WindowsPerformanceRecorderPath
    $file=Get-Item -LiteralPath $path
    if($file.PSIsContainer -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'The built-in WPR tool is not an ordinary file.'}
    return [pscustomobject]@{path=$file.FullName;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$file.VersionInfo.FileVersion}
}

function Read-CpuSchedulingProfile {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    $file=Get-Item -LiteralPath $Path
    if($file.PSIsContainer -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 1MB){throw 'The exported CPU profile must be a bounded ordinary file.'}
    $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null
    $reader=[Xml.XmlReader]::Create($file.FullName,$settings);$document=[Xml.XmlDocument]::new();$document.XmlResolver=$null
    try{$document.Load($reader)}finally{$reader.Dispose()}
    $profiles=@($document.SelectNodes('/WindowsPerformanceRecorder/Profiles/Profile'))
    if($profiles.Count -ne 1){throw 'Expected one effective exported CPU profile.'}
    $references=@($profiles[0].SelectNodes('Collectors/SystemCollectorId/SystemProviderId'))
    if(-not $references.Count){throw 'The exported CPU profile has no system provider.'}
    $keywords=@();$stacks=@()
    foreach($reference in $references){
        $id=$reference.GetAttribute('Value')
        $providers=@($document.SelectNodes('/WindowsPerformanceRecorder/Profiles/SystemProvider')|Where-Object {$_.GetAttribute('Id') -ceq $id})
        if($providers.Count -ne 1){throw 'The exported CPU profile provider is ambiguous.'}
        $keywords+=@($providers[0].SelectNodes('Keywords/Keyword')|ForEach-Object {$_.GetAttribute('Value')})
        $stacks+=@($providers[0].SelectNodes('Stacks/Stack')|ForEach-Object {$_.GetAttribute('Value')})
    }
    $keywords=@($keywords|Sort-Object -Unique);$stacks=@($stacks|Sort-Object -Unique)
    $required=@('ProcessThread','Loader','SampledProfile','CSwitch','ReadyThread')
    foreach($keyword in $required){if($keyword -cnotin $keywords){throw ('The exported CPU profile lacks required keyword '+$keyword+'.')}}
    return [pscustomobject]@{sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant();profileId=$profiles[0].GetAttribute('Id');detailLevel=$profiles[0].GetAttribute('DetailLevel');requiredKeywords=$required;keywords=$keywords;stacks=$stacks;requiredKeywordsVerified=$true}
}

function Start-WindowsPerformanceTrace {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Directory,[switch]$CpuSchedulingOnly)
    if($env:OS -cne 'Windows_NT' -or (Test-Path -LiteralPath $Directory)){throw 'Tracing requires Windows and a fresh output directory.'}
    [IO.Directory]::CreateDirectory($Directory)|Out-Null
    $tool=Get-WindowsPerformanceRecorderIdentity
    $instance='NemoClawPerf-'+[guid]::NewGuid().ToString('N').Substring(0,12)
    $profiles=@('GeneralProfile.Light','FileIO');$profileValidation=$null
    if($CpuSchedulingOnly){$profiles=@('GeneralProfile.Light')}
    Invoke-OwnedWprCommand -Arguments @('-profiles') -LogPath (Join-Path $Directory 'available-profiles.log')
    Invoke-OwnedWprCommand -Arguments @('-exportprofile',($profiles -join '+'),(Join-Path $Directory 'actual-profiles.wprp'),'-filemode') -LogPath (Join-Path $Directory 'export-profile.log')
    if($CpuSchedulingOnly){$profileValidation=Read-CpuSchedulingProfile -Path (Join-Path $Directory 'actual-profiles.wprp')}
    $startArguments=@('-start','GeneralProfile.Light')
    if(-not $CpuSchedulingOnly){$startArguments+=@('-start','FileIO')}
    $startArguments+=@('-filemode','-recordtempto',$Directory,'-instancename',$instance)
    try {
        Invoke-OwnedWprCommand -Arguments $startArguments -LogPath (Join-Path $Directory 'start.log')
    } catch {
        $startFailure=$_
        try {Invoke-OwnedWprCommand -Arguments @('-cancel','-instancename',$instance) -LogPath (Join-Path $Directory 'failed-start-cancel.log') -TimeoutMilliseconds 10000}
        catch {Write-Warning 'The failed owned WPR start could not confirm cancellation.'}
        throw $startFailure
    }
    return [pscustomobject]@{instance=$instance;directory=$Directory;tool=$tool;profiles=$profiles;cpuSchedulingOnly=[bool]$CpuSchedulingOnly;profileValidation=$profileValidation;started=[Diagnostics.Stopwatch]::StartNew();active=$true;capped=$false;capReason=$null;maximumBytes=256MB;maximumSeconds=45;lastBytes=0L;peakRecordingBytes=0L;recordingSeconds=$null;finalizationMs=$null;finalFiles=$null;stopSucceeded=$false;lastBudgetMs=-1000L}
}

function Stop-WindowsPerformanceTrace {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Trace)
    if(-not $Trace.active){return}
    $primary=$null;$stopClock=[Diagnostics.Stopwatch]::StartNew()
    $Trace.recordingSeconds=$Trace.started.Elapsed.TotalSeconds
    try {
        try {Invoke-OwnedWprCommand -Arguments @('-status','collectors','-details','-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'status-before-stop.log') -TimeoutMilliseconds 5000}
        catch {$primary=$_} # A status failure must not skip the owned stop.
        Invoke-OwnedWprCommand -Arguments @('-stop',(Join-Path $Trace.directory 'capture.etl'),'-skipPdbGen','-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'stop.log')
        $Trace.active=$false;$Trace.stopSucceeded=$true
    } catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'WPR stop also failed; its output is retained.'}}
    finally {
        if($Trace.active){
            try {Invoke-OwnedWprCommand -Arguments @('-cancel','-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'owned-cancel.log') -TimeoutMilliseconds 10000;$Trace.active=$false}
            catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'The owned WPR instance did not confirm cancellation.'}}
        }
        $Trace.finalizationMs=$stopClock.Elapsed.TotalMilliseconds
        try {$Trace.finalFiles=Get-WindowsPerformanceTraceFiles -Directory $Trace.directory}
        catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'Final trace accounting also failed.'}}
        $record=[ordered]@{
            instance=$Trace.instance;tool=$Trace.tool;profiles=$Trace.profiles;fileMode=$true
            cpuSchedulingOnly=$Trace.cpuSchedulingOnly;profileValidation=$Trace.profileValidation
            dedicatedLogicalFileIODetailOmitted=$Trace.cpuSchedulingOnly
            coverage='Actual exported profile/status and measured recording duration; no whole-operation coverage guarantee.'
            capped=$Trace.capped;capReason=$Trace.capReason;recordingSeconds=$Trace.recordingSeconds;finalizationMs=$Trace.finalizationMs
            maximumRecordingBytes=$Trace.maximumBytes;maximumRecordingSeconds=$Trace.maximumSeconds;pollIntervalMs=100
            peakObservedRecordingBytes=$Trace.peakRecordingBytes;finalFiles=$Trace.finalFiles
            budgetKind='observed logical-byte stop threshold; not a hard quota; finalization can add files'
            skipPdbGen=$true;managedNgenAndEmbeddedPdbGeneration=$false;stopSucceeded=$Trace.stopSucceeded;active=$Trace.active
            lostEvents='Inspect retained WPR collector status; absence is not zero';completeClaimed=$false
        }
        try { [IO.File]::WriteAllText((Join-Path $Trace.directory 'trace-receipt.json'),($record|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false)) }
        catch { if($null -eq $primary){$primary=$_}else{Write-Warning 'The trace receipt also could not be written.'} }
    }
    if($null -ne $primary){throw $primary}
}

function Update-WindowsPerformanceTraceBudget {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Trace)
    if(-not $Trace.active){return}
    $inventory=Get-WindowsPerformanceTraceFiles -Directory $Trace.directory
    $Trace.lastBytes=$inventory.logicalBytes
    $Trace.peakRecordingBytes=[Math]::Max($Trace.peakRecordingBytes,$Trace.lastBytes)
    # Persist one sample/second and every threshold crossing. Each full sample is
    # bounded by the directory entry limit; no file contents or security journals.
    if($Trace.started.ElapsedMilliseconds-$Trace.lastBudgetMs -ge 1000 -or $Trace.lastBytes -ge $Trace.maximumBytes){
        $sample=[ordered]@{elapsedMs=$Trace.started.Elapsed.TotalMilliseconds;logicalBytes=$Trace.lastBytes;files=$inventory.files;includesHiddenAndSystem=$true}
        [IO.File]::AppendAllText((Join-Path $Trace.directory 'recording-bytes.jsonl'),($sample|ConvertTo-Json -Compress -Depth 5)+"`n",[Text.UTF8Encoding]::new($false))
        $Trace.lastBudgetMs=$Trace.started.ElapsedMilliseconds
    }
    if($Trace.lastBytes -ge $Trace.maximumBytes -or $Trace.started.Elapsed.TotalSeconds -ge $Trace.maximumSeconds){
        $Trace.capped=$true
        $Trace.capReason=if($Trace.lastBytes -ge $Trace.maximumBytes){'trace-byte-budget'}else{'trace-time-budget'}
        Stop-WindowsPerformanceTrace -Trace $Trace
    }
}
