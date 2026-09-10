# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Recorder failures are data, not a request to terminate the measured command.
function Add-MeasurementTraceFailure {
    param($State, [string]$Phase, [object]$Failure)
    $State.failures.Add([ordered]@{phase=$Phase;message=$Failure.Exception.Message;observedMs=$State.clock.Elapsed.TotalMilliseconds})
    Write-Warning ("Performance recorder failed during " + $Phase + '; the target retains its own deadline.')
}
function Stop-MeasurementTraceWindow {
    param($State)
    if($null -eq $State.current){return}
    try {Stop-WindowsPerformanceTrace -Trace $State.current.trace}
    catch {Add-MeasurementTraceFailure -State $State -Phase $State.current.phase -Failure $_}
    $State.current['stopObservedMs']=$State.clock.Elapsed.TotalMilliseconds
    if($State.current.trace.active){$State.safeToContinue=$false}
    if(-not $State.current.trace.active){$State.current=$null}
}
function Start-MeasurementTraceWindow {
    param($State,[string]$Phase,[double]$MarkerObservedMs)
    if(-not $State.safeToContinue -or -not $State.attempted.Add($Phase)){return}
    $window=[ordered]@{directory=(Join-Path $State.directory ('wpr-'+$Phase));phase=$Phase;markerObservedMs=$MarkerObservedMs;startRequestedMs=$State.clock.Elapsed.TotalMilliseconds;startCompletedMs=$null;stopObservedMs=$null;trace=$null}
    $State.windows.Add($window)
    try {
        $window.trace=Start-WindowsPerformanceTrace -Directory $window.directory
        $window.startCompletedMs=$State.clock.Elapsed.TotalMilliseconds
        $State.current=$window
    } catch {
        # Start performs an owned cancel, but no active handle was returned: do
        # not assume an unobserved failed start is safe for another recording.
        Add-MeasurementTraceFailure -State $State -Phase $Phase -Failure $_
        $State.safeToContinue=$false
    }
}
function New-MeasurementTraceState {
    param($Case,[string]$Directory)
    $log=$null
    if($Case.PSObject.Properties.Name -contains 'wprInstallerLog'){
        $log=[string]$Case.wprInstallerLog
        if($Case.action -cne 'install' -or $Case.wpr -ne $true -or @($Case.args).Count -ne 5 -or $Case.args[3] -cne '/log' -or $Case.args[4] -cne $log -or (Test-Path -LiteralPath $log)){
            throw 'Installer phase tracing requires the exact fresh log argument of the owned bundle command.'
        }
    }
    $state=[pscustomobject]@{
        directory=$Directory;clock=[Diagnostics.Stopwatch]::StartNew();log=$log;offset=0L;pending='';decoder=[Text.UTF8Encoding]::new($false,$true).GetDecoder()
        activePhase=$null;phaseObservedMs=0.0;current=$null;safeToContinue=$true;logFailed=$false
        windows=[Collections.Generic.List[object]]::new();events=[Collections.Generic.List[object]]::new();failures=[Collections.Generic.List[object]]::new()
        attempted=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    }
    if($null -eq $log){Start-MeasurementTraceWindow -State $state -Phase 'command-prefix' -MarkerObservedMs 0}
    return $state
}
function Read-MeasurementInstallerStages {
    param($State)
    if(-not(Test-Path -LiteralPath $State.log -PathType Leaf)){return}
    $info=Get-Item -LiteralPath $State.log -Force
    if($info.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'The owned Burn stage log is a reparse path.'}
    $stream=$null
    try {
        $stream=[IO.File]::Open($State.log,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        if($stream.Length -gt 2MB -or $stream.Length -lt $State.offset){throw 'The opened Burn stage log changed size outside its bound.'}
        $null=$stream.Seek($State.offset,[IO.SeekOrigin]::Begin)
        $bytes=[byte[]]::new(65536);$count=$stream.Read($bytes,0,$bytes.Length)
        $State.offset += $count
        if($State.offset -gt 2MB){throw 'The opened Burn stage log exceeded its read bound.'}
        $chars=[char[]]::new(65536);$written=$State.decoder.GetChars($bytes,0,$count,$chars,0,$false)
        $State.pending += [string]::new($chars,0,$written)
    } finally {if($null -ne $stream){$stream.Dispose()}}
    $lines=$State.pending.Split([char]10);$State.pending=$lines[$lines.Length-1]
    if($State.pending.Length -gt 16384){throw 'An installer log line exceeded its bound.'}
    foreach($line in @($lines|Select-Object -SkipLast 1)){
        if($line.Length -gt 16384){throw 'An installer log line exceeded its bound.'}
        $match=[regex]::Match($line,'^\[[A-Fa-f0-9]+:[A-Fa-f0-9]+\]\[(?<timestamp>[^\]\r\n]{1,40})\]i(?<code>301|319): (?<verb>Applying|Applied) execute package: (?<package>MxcSystemDrivePreparation|MxcNullDevicePreparation|NemoClawArm64Msi),')
        if(-not $match.Success){continue}
        $phase=switch($match.Groups['package'].Value){'MxcSystemDrivePreparation'{'system-drive-preparation'};'MxcNullDevicePreparation'{'null-device-preparation'};'NemoClawArm64Msi'{'msi'}}
        $begin=$match.Groups['code'].Value -ceq '301' -and $match.Groups['verb'].Value -ceq 'Applying'
        $end=$match.Groups['code'].Value -ceq '319' -and $match.Groups['verb'].Value -ceq 'Applied'
        if(-not($begin -or $end)){continue}
        $event=[ordered]@{phase=$phase;transition=$(if($begin){'begin'}else{'end'});bundleTimestamp=$match.Groups['timestamp'].Value;observedMs=$State.clock.Elapsed.TotalMilliseconds;logBytesRead=$State.offset}
        if($State.events.Count -ge 64){throw 'The installer stage event limit was exceeded.'}
        $State.events.Add($event)
        [IO.File]::AppendAllText((Join-Path $State.directory 'installer-stages.jsonl'),($event|ConvertTo-Json -Compress)+"`n",[Text.UTF8Encoding]::new($false))
        Write-Host ("PROFILE> Installer " + $phase + ' ' + $event.transition)
        if($begin){$State.activePhase=$phase;$State.phaseObservedMs=$event.observedMs}
        elseif($State.activePhase -ceq $phase){$State.activePhase=$null}
    }
}
function Update-MeasurementTraceState {
    param($State,[switch]$TargetExited)
    if($null -ne $State.log -and -not $State.logFailed){
        try {Read-MeasurementInstallerStages -State $State}
        catch {$State.logFailed=$true;Add-MeasurementTraceFailure -State $State -Phase 'installer-log' -Failure $_;Stop-MeasurementTraceWindow -State $State}
    }
    if($null -ne $State.current -and $State.safeToContinue){
        if($TargetExited -or ($null -ne $State.log -and $State.current.phase -cne $State.activePhase)){
            Stop-MeasurementTraceWindow -State $State
        }else{
            try {Update-WindowsPerformanceTraceBudget -Trace $State.current.trace}
            catch {Add-MeasurementTraceFailure -State $State -Phase $State.current.phase -Failure $_;Stop-MeasurementTraceWindow -State $State}
        }
    }
    if(-not $TargetExited -and -not $State.logFailed -and $State.activePhase -cin @('system-drive-preparation','msi') -and $null -eq $State.current){
        Start-MeasurementTraceWindow -State $State -Phase $State.activePhase -MarkerObservedMs $State.phaseObservedMs
    }
}
function Complete-MeasurementTraceState {
    param($State)
    if($State.safeToContinue){Update-MeasurementTraceState -State $State -TargetExited}
    else{Stop-MeasurementTraceWindow -State $State}
    $missing=@()
    if($null -ne $State.log){
        $missing=@(@('system-drive-preparation','msi')|Where-Object {-not $State.attempted.Contains($_)})
    }
    $record=[ordered]@{
        classification='partial-performance-recording-windows';completeOperationTraceClaimed=$false
        clock='observer monotonic stopwatch; Burn timestamp retained separately';installerStages=@($State.events.ToArray())
        windows=@($State.windows.ToArray()|ForEach-Object {[ordered]@{phase=$_.phase;markerObservedMs=$_.markerObservedMs;startRequestedMs=$_.startRequestedMs;startCompletedMs=$_.startCompletedMs;stopObservedMs=$_.stopObservedMs;directory=$_.directory}})
        failures=@($State.failures.ToArray());unobservedWindows=$missing;safeToContinue=$State.safeToContinue
        failed=($State.failures.Count -gt 0 -or $missing.Count -gt 0 -or -not $State.safeToContinue)
    }
    [IO.File]::WriteAllText((Join-Path $State.directory 'trace-windows.json'),($record|ConvertTo-Json -Depth 8)+"`n",[Text.UTF8Encoding]::new($false))
    return $record
}
