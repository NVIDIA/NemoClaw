# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

function Invoke-OwnedWprCommand {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$LogPath)
    $executable=Join-Path $env:SystemRoot 'System32\wpr.exe'
    if(-not(Test-Path -LiteralPath $executable -PathType Leaf)){throw 'The built-in Windows Performance Recorder is unavailable.'}
    $process=[Diagnostics.Process]::new()
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
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(60000)){$process.Kill();$null=$process.WaitForExit(5000);throw 'WPR command exceeded its bounded wait.'}
        if(-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)){throw 'WPR output did not finish.'}
        [IO.File]::WriteAllText($LogPath,($stdout.Result+"`n"+$stderr.Result),[Text.UTF8Encoding]::new($false))
        if($process.ExitCode -ne 0){throw 'WPR command failed; its exact output is retained.'}
    } finally {$process.Dispose()}
}

function Get-WindowsPerformanceRecorderIdentity {
    $path=Join-Path $env:SystemRoot 'System32\wpr.exe'
    $file=Get-Item -LiteralPath $path
    if($file.PSIsContainer -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'The built-in WPR tool is not an ordinary file.'}
    return [pscustomobject]@{path=$file.FullName;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant();fileVersion=$file.VersionInfo.FileVersion}
}

function Start-WindowsPerformanceTrace {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Directory)
    if($env:OS -cne 'Windows_NT' -or (Test-Path -LiteralPath $Directory)){throw 'Tracing requires Windows and a fresh output directory.'}
    [IO.Directory]::CreateDirectory($Directory)|Out-Null
    $tool=Get-WindowsPerformanceRecorderIdentity
    $instance='NemoClawPerf-'+[guid]::NewGuid().ToString('N').Substring(0,12)
    Invoke-OwnedWprCommand -Arguments @('-profiles') -LogPath (Join-Path $Directory 'available-profiles.log')
    Invoke-OwnedWprCommand -Arguments @('-exportprofile','GeneralProfile.Light+FileIO',(Join-Path $Directory 'actual-profiles.wprp'),'-filemode') -LogPath (Join-Path $Directory 'export-profile.log')
    try {
        Invoke-OwnedWprCommand -Arguments @('-start','GeneralProfile.Light','-start','FileIO','-filemode','-recordtempto',$Directory,'-instancename',$instance) -LogPath (Join-Path $Directory 'start.log')
    } catch {
        $startFailure=$_
        try {Invoke-OwnedWprCommand -Arguments @('-cancel','-instancename',$instance) -LogPath (Join-Path $Directory 'failed-start-cancel.log')}
        catch {Write-Warning 'The failed owned WPR start could not confirm cancellation.'}
        $PSCmdlet.ThrowTerminatingError($startFailure)
    }
    return [pscustomobject]@{instance=$instance;directory=$Directory;tool=$tool;started=[Diagnostics.Stopwatch]::StartNew();active=$true;capped=$false;capReason=$null;maximumBytes=1GB;maximumSeconds=300}
}

function Stop-WindowsPerformanceTrace {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Trace)
    if(-not $Trace.active){return}
    $primary=$null
    try {
        Invoke-OwnedWprCommand -Arguments @('-status','collectors','-details','-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'status-before-stop.log')
        Invoke-OwnedWprCommand -Arguments @('-stop',(Join-Path $Trace.directory 'capture.etl'),'-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'stop.log')
        $Trace.active=$false
    } catch {$primary=$_}
    finally {
        if($Trace.active){
            try {Invoke-OwnedWprCommand -Arguments @('-cancel','-instancename',$Trace.instance) -LogPath (Join-Path $Trace.directory 'owned-cancel.log');$Trace.active=$false}
            catch {Write-Warning 'The owned WPR instance did not confirm cancellation.'}
        }
        $record=[ordered]@{instance=$Trace.instance;tool=$Trace.tool;profiles=@('GeneralProfile.Light','FileIO');fileMode=$true;capped=$Trace.capped;capReason=$Trace.capReason;seconds=$Trace.started.Elapsed.TotalSeconds;active=$Trace.active;lostEvents='Inspect retained WPR collector status; absence is not zero';completeClaimed=$false}
        try { [IO.File]::WriteAllText((Join-Path $Trace.directory 'trace-receipt.json'),($record|ConvertTo-Json -Depth 5)+"`n",[Text.UTF8Encoding]::new($false)) }
        catch { if($null -eq $primary){$primary=$_}else{Write-Warning 'The trace receipt also could not be written.'} }
    }
    if($null -ne $primary){$PSCmdlet.ThrowTerminatingError($primary)}
}

function Update-WindowsPerformanceTraceBudget {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Trace)
    if(-not $Trace.active){return}
    $bytes=(@(Get-ChildItem -LiteralPath $Trace.directory -File -Recurse | Measure-Object Length -Sum)[0]).Sum
    if($bytes -ge $Trace.maximumBytes -or $Trace.started.Elapsed.TotalSeconds -ge $Trace.maximumSeconds){
        $Trace.capped=$true
        $Trace.capReason=if($bytes -ge $Trace.maximumBytes){'trace-byte-budget'}else{'trace-time-budget'}
        Stop-WindowsPerformanceTrace -Trace $Trace
    }
}
