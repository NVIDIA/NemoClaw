# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI observer/controller for the actual installed session window. It neither
# changes the application nor sends commands to unrelated processes/windows.
param([Parameter(Mandatory)][int]$RootProcessId, [Parameter(Mandatory)][string]$InstallRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') { throw 'The installed UI control requires the disposable Windows runner.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if ([string]::IsNullOrWhiteSpace($env:NEMOCLAW_OBSERVER_CONTROLLER_PID) -or
    [string]::IsNullOrWhiteSpace($env:NEMOCLAW_OBSERVER_STOP_SENTINEL) -or
    [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'The installed UI controller ownership environment is incomplete.'
}
$controllerProcessId = 0
if (-not [int]::TryParse([string]$env:NEMOCLAW_OBSERVER_CONTROLLER_PID, [ref]$controllerProcessId) -or $controllerProcessId -le 0) {
    throw 'The installed UI controller parent identity is invalid.'
}
$self = @(Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction Stop)
if ($self.Count -ne 1 -or [int]$self[0].ParentProcessId -ne $controllerProcessId) {
    throw 'The installed UI controller was not started by its declared owner.'
}
$controller = [Diagnostics.Process]::GetProcessById($controllerProcessId)
$controllerHandle = $controller.Handle
$selfStarted = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime()
if ($controller.HasExited -or $controller.StartTime.ToUniversalTime() -gt $selfStarted) {
    throw 'The installed UI controller owner already exited or its identity was replaced.'
}
$runnerTemp = [IO.Path]::GetFullPath([string]$env:RUNNER_TEMP).TrimEnd('\')
$stopSentinelPath = [IO.Path]::GetFullPath([string]$env:NEMOCLAW_OBSERVER_STOP_SENTINEL)
$runnerPrefix = $runnerTemp + '\'
if (-not [IO.Directory]::Exists($runnerTemp) -or
    -not $stopSentinelPath.StartsWith($runnerPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($stopSentinelPath) -cnotmatch '^observer-stop-[a-f0-9]{64}\.sentinel$' -or
    -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($stopSentinelPath)) -or
    [IO.File]::Exists($stopSentinelPath) -or [IO.Directory]::Exists($stopSentinelPath)) {
    throw 'The installed UI controller Stop sentinel is invalid.'
}
function Test-OwnedStopSentinel {
    if ([IO.Directory]::Exists($stopSentinelPath)) { throw 'The owned Stop sentinel became a directory.' }
    if (-not [IO.File]::Exists($stopSentinelPath)) { return $false }
    # Stop must not wait for PowerShell provider/module discovery on its first poll.
    $item = [IO.FileInfo]::new($stopSentinelPath)
    $item.Refresh()
    if (-not $item.Exists -or $item.Length -ne 0 -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The owned Stop sentinel must be an empty regular file.'
    }
    return $true
}
function Assert-OwnedFailureNoticeIdentity($HostProcess, $SessionProcess, [datetime]$HostStarted, [datetime]$SessionStarted, [string]$HostPath, [string]$SessionPath, $Window, $Button, $Open) {
    if ($HostProcess.HasExited -or $SessionProcess.HasExited -or
        $HostProcess.StartTime.ToUniversalTime() -ne $HostStarted -or
        $SessionProcess.StartTime.ToUniversalTime() -ne $SessionStarted -or
        -not [string]::Equals($HostProcess.MainModule.FileName, $HostPath, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($SessionProcess.MainModule.FileName, $SessionPath, [StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $Window -or $null -eq $Button -or $null -eq $Open -or
        $Window.Current.ProcessId -ne $SessionProcess.Id -or
        $Button.Current.ProcessId -ne $SessionProcess.Id -or $Open.Current.ProcessId -ne $SessionProcess.Id -or
        $Button.Current.AutomationId -cne 'NativeWebSessionStop' -or
        $Open.Current.AutomationId -cne 'NativeWebSessionOpen' -or
        -not $Button.Current.IsEnabled -or $Button.Current.Name -cne 'Close' -or
        $Open.Current.Name -cne 'Open diagnostics') {
        throw 'The failed notice does not belong to the held runtime and session window.'
    }
    # The shutdown-timeout notice also says Close, but never Open diagnostics.
    switch -CaseSensitive ($Window.Current.Name) {
        'NemoClaw Hermes session' { return 'hermes' }
        'NemoClaw OpenClaw session' { return 'openclaw' }
        default { throw 'The failed notice has an unexpected agent identity.' }
    }
}
function Read-OwnedFailureSnapshot([string]$File, [string]$Boundary, [int]$HostProcessId, [datetime]$HostStarted, [string]$Agent) {
    $full = [IO.Path]::GetFullPath($File)
    $boundaryPath = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not $full.StartsWith($boundaryPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($full) -cne 'session-failure.json' -or $HostProcessId -le 0) {
        throw 'The failed notice snapshot is outside its owned evidence directory.'
    }
    $parent = [IO.Path]::GetDirectoryName($full)
    while ($true) {
        $directory = [IO.DirectoryInfo]::new($parent)
        if (-not $directory.Exists -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The failed notice snapshot traverses an unavailable or linked directory.'
        }
        if ([string]::Equals($parent, $boundaryPath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
    $item = [IO.FileInfo]::new($full)
    if (-not $item.Exists -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -le 0 -or $item.Length -gt 1048576 -or $item.LastWriteTimeUtc -lt $HostStarted) {
        throw 'The failed notice snapshot is absent, stale, linked or outside its byte bound.'
    }
    $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -le 0 -or $stream.Length -gt 1048576) { throw 'The failed notice snapshot exceeds its byte bound.' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($count -eq 0) { throw 'The failed notice snapshot ended early.' }
            $offset += $count
        }
        $value = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) | ConvertFrom-Json
        $recorded = if ($value.diagnostics.recordedAt -is [datetime]) { $value.diagnostics.recordedAt.ToUniversalTime() }
            else { [datetimeoffset]::Parse([string]$value.diagnostics.recordedAt, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
        if ($value.schemaVersion -isnot [long] -and $value.schemaVersion -isnot [int]) { throw 'The failed notice snapshot schema is not numeric.' }
        if ($value.diagnostics.schemaVersion -isnot [long] -and $value.diagnostics.schemaVersion -isnot [int]) { throw 'The failure diagnostic schema is not numeric.' }
        if ($value.nodeProcessId -isnot [long] -and $value.nodeProcessId -isnot [int]) { throw 'The failed notice snapshot host identity is not numeric.' }
        foreach ($field in @('classification','agent','interface','stage')) {
            if ($value.$field -isnot [string]) { throw 'The failed notice snapshot identity is not scalar text.' }
        }
        foreach ($field in @('classification','agent','stage')) {
            if ($value.diagnostics.$field -isnot [string]) { throw 'The failure diagnostic identity is not scalar text.' }
        }
        if ($value.schemaVersion -ne 1 -or $value.classification -cne 'native-session-failure-evidence' -or
            $value.agent -cne $Agent -or $value.interface -cne 'dashboard' -or $value.nodeProcessId -ne $HostProcessId -or
            $value.backendCleanupFinished -isnot [bool] -or $value.backendCleanupFinished -ne $true -or
            @('inference','runtime','broker','gateway','sandbox','bootstrap','dashboard','agent','cleanup') -cnotcontains $value.stage -or
            $value.diagnostics.schemaVersion -ne 1 -or $value.diagnostics.classification -cne 'native-session-failure' -or
            $value.diagnostics.agent -cne $Agent -or $value.diagnostics.stage -cne $value.stage -or
            $null -eq $value.diagnostics.failure -or $value.diagnostics.failure -isnot [pscustomobject] -or
            $recorded -lt $HostStarted -or $recorded -gt [datetime]::UtcNow) {
            throw 'The failed notice snapshot does not confirm this host failure and finished backend cleanup.'
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        # No diagnostic text or saved path is copied to the observer output.
        return [ordered]@{ snapshotSha256=$digest; hostPid=$HostProcessId; agent=$Agent; stage=$value.stage; backendCleanupFinished=$true }
    } catch { throw 'The owned failed notice snapshot could not be validated.' }
    finally { $stream.Dispose() }
}
$rootPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$root = [Diagnostics.Process]::GetProcessById($RootProcessId)
$handle = $root.Handle
$started = $root.StartTime.ToUniversalTime()
if (-not [string]::Equals($root.MainModule.FileName, (Join-Path $rootPath 'bin\NemoClaw.exe'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The UI controller root is not the installed native launcher.'
}
$watch = [Diagnostics.Stopwatch]::StartNew()
$stopWatch = $null
$last = ''
$stopped = $false
$failureCloseInvoked = $false
$session = $null
$sessionStarted = $null
$heldWindowHandle = $null
$heldHost = $null
$heldHostPath = $null
$heldHostStarted = $null
$stopSnapshot = $null
$nextSnapshot = 0
$stopSnapshotTimes = @(0, 2000, 8000)
$failureSnapshotPath = Join-Path ([IO.Path]::GetDirectoryName($stopSentinelPath)) 'session/session-failure.json'
function Write-StopSnapshot([string]$Label) {
    $captureWatch = [Diagnostics.Stopwatch]::StartNew()
    $record = [ordered]@{ kind='stop-snapshot'; label=$Label; rootPid=$RootProcessId; stopElapsedMs=$stopWatch.ElapsedMilliseconds; captureElapsedMs=0; snapshot=$null; error=$null }
    try {
        if ($null -eq $stopSnapshot) { throw 'The owned Stop snapshot was not initialized.' }
        $record.snapshot = $stopSnapshot.Capture()
    } catch { $record.error = $_.Exception.GetType().FullName }
    $record.captureElapsedMs = $captureWatch.ElapsedMilliseconds
    $encoded = $record | ConvertTo-Json -Depth 8 -Compress
    if ([Text.Encoding]::UTF8.GetByteCount($encoded) -gt 32768) { $record.snapshot=$null; $record.error='Snapshot exceeds its output bound.'; $encoded=$record | ConvertTo-Json -Depth 3 -Compress }
    [Console]::Out.WriteLine($encoded); [Console]::Out.Flush()
}
try {
    while (-not $root.HasExited) {
        if ($controller.HasExited) { throw 'The installed UI controller owner exited before Stop.' }
        if ($watch.ElapsedMilliseconds -gt 600000) { throw 'The installed session observer exceeded its bound.' }
        if ($null -ne $stopWatch -and $stopWatch.ElapsedMilliseconds -gt 120000) {
            if ($failureCloseInvoked) { throw 'The owned failed notice did not finish closing.' }
            Write-StopSnapshot 'stop-deadline'
            throw 'The actual session did not finish its Stop cleanup.'
        }
        if ($failureCloseInvoked) { Start-Sleep -Milliseconds 100; continue }
        if ($stopped) {
            if ($nextSnapshot -lt $stopSnapshotTimes.Count -and $stopWatch.ElapsedMilliseconds -ge $stopSnapshotTimes[$nextSnapshot]) {
                Write-StopSnapshot ('after-' + $stopSnapshotTimes[$nextSnapshot] + 'ms')
                $nextSnapshot++
            }
            if (-not [IO.File]::Exists($failureSnapshotPath)) { Start-Sleep -Milliseconds 100; continue }
        }
        # Only the native launcher's direct SEA child may own this gateway.
        $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootProcessId" -ErrorAction Stop)
        $hosts = @($children | Where-Object {
            $_.CreationDate.ToUniversalTime() -ge $started -and
            [string]$_.ExecutablePath -match ('^' + [regex]::Escape($rootPath) + '\\runtimes\\[a-f0-9]{64}\\app\\NemoClaw\.Runtime\.exe$')
        })
        if ($hosts.Count -gt 1) { throw 'More than one installed runtime host belongs to this launch.' }
        if ($hosts.Count -eq 1) {
            $hostRow = $hosts[0]
            $hostPath = [IO.Path]::GetFullPath([string]$hostRow.ExecutablePath)
            if ($hostPath -notmatch ('^' + [regex]::Escape($rootPath) + '\\runtimes\\[a-f0-9]{64}\\app\\NemoClaw\.Runtime\.exe$')) { throw 'The installed host path is not a versioned runtime.' }
            $hostProcess = [Diagnostics.Process]::GetProcessById([int]$hostRow.ProcessId)
            try {
                $hostHandle = $hostProcess.Handle
                if ([Math]::Abs(($hostProcess.StartTime.ToUniversalTime() - $hostRow.CreationDate.ToUniversalTime()).Ticks) -gt 10) { throw 'The runtime host process identity changed.' }
                if ($null -eq $heldHost) { $heldHost=$hostProcess; $heldHostPath=$hostPath; $heldHostStarted=$hostProcess.StartTime.ToUniversalTime() }
                elseif ($heldHost.Id -ne $hostProcess.Id -or $heldHostStarted -ne $hostProcess.StartTime.ToUniversalTime()) { throw 'The held runtime host identity changed.' }
                $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $hostProcess.Id -ErrorAction SilentlyContinue |
                    Where-Object { $_.LocalAddress -ceq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object)
                if ($ports.Count -gt 16) { throw 'The installed runtime has an unexpected listener inventory.' }
                if ($null -eq $session) {
                    $windows = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $hostProcess.Id) -ErrorAction Stop | Where-Object {
                        $_.CreationDate.ToUniversalTime() -ge $hostProcess.StartTime.ToUniversalTime() -and
                        [string]::Equals($_.ExecutablePath, (Join-Path $rootPath 'native-ui\NemoClaw.Bootstrapper.exe'), [StringComparison]::OrdinalIgnoreCase)
                    })
                    if ($windows.Count -gt 1) { throw 'Multiple native session windows belong to this runtime.' }
                    if ($windows.Count -eq 1) {
                        $session = [Diagnostics.Process]::GetProcessById([int]$windows[0].ProcessId)
                        $sessionHandle = $session.Handle
                        $sessionStarted = $session.StartTime.ToUniversalTime()
                        if ([Math]::Abs(($sessionStarted - $windows[0].CreationDate.ToUniversalTime()).Ticks) -gt 10) { throw 'The session process identity changed.' }
                    }
                }
                $record = [ordered]@{ kind='observation'; rootPid=$RootProcessId; rootStartedUtc=$started.ToString('O');
                    hostPid=$hostProcess.Id; hostStartedUtc=$hostProcess.StartTime.ToUniversalTime().ToString('O');
                    hostPath=$hostPath; ports=$ports; sessionPid=$null; openEnabled=$false; windowFound=$false;
                    openFound=$false; openName=$null; openControlEnabled=$false; phase=$null; status=$null }
                if ($null -ne $session -and -not $session.HasExited) {
                    $record.sessionPid = $session.Id
                    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $session.Id)
                    $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
                    if ($null -ne $window) {
                        if ($window.Current.NativeWindowHandle -eq 0) { throw 'The session window has no native identity.' }
                        if ($null -eq $heldWindowHandle) { $heldWindowHandle = $window.Current.NativeWindowHandle }
                        elseif ($window.Current.NativeWindowHandle -ne $heldWindowHandle) { throw 'The held session window identity changed.' }
                        $record.windowFound = $true
                        foreach ($entry in @(@('phase','NativeWebSessionPhase'), @('status','NativeWebSessionStatus'))) {
                            $textCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $entry[1])
                            $text = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $textCondition)
                            if ($null -ne $text) {
                                $value = [string]$text.Current.Name
                                if ($value.Length -gt 4096) { throw 'The owned session presentation exceeded its bound.' }
                                $record[$entry[0]] = $value
                            }
                        }
                        $openCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'NativeWebSessionOpen')
                        $open = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $openCondition)
                        $record.openEnabled = $null -ne $open -and $open.Current.IsEnabled -and $open.Current.Name -ceq 'Open Web UI'
                        $record.openFound = $null -ne $open
                        if ($null -ne $open) { $record.openName = $open.Current.Name; $record.openControlEnabled = $open.Current.IsEnabled }
                        if (Test-OwnedStopSentinel) {
                            $stopCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'NativeWebSessionStop')
                            $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $stopCondition)
                            if ($null -ne $button -and $button.Current.Name -ceq 'Close') {
                                $sessionPath = Join-Path $rootPath 'native-ui\NemoClaw.Bootstrapper.exe'
                                $agent = Assert-OwnedFailureNoticeIdentity $heldHost $session $heldHostStarted $sessionStarted $heldHostPath $sessionPath $window $button $open
                                # Both installed qualifiers put their fresh session evidence beside this private sentinel.
                                $failure = Read-OwnedFailureSnapshot $failureSnapshotPath $runnerTemp $heldHost.Id $heldHostStarted $agent
                                $null = Assert-OwnedFailureNoticeIdentity $heldHost $session $heldHostStarted $sessionStarted $heldHostPath $sessionPath $window $button $open
                                if ($root.HasExited -or $controller.HasExited -or $window.Current.NativeWindowHandle -ne $heldWindowHandle) { throw 'The failed notice owner exited before closure or its window changed.' }
                                ([Windows.Automation.InvokePattern]$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
                                $failureCloseInvoked = $true
                                if ($null -eq $stopWatch) { $stopWatch = [Diagnostics.Stopwatch]::StartNew() }
                                [Console]::Out.WriteLine(([ordered]@{ kind='failure-notice-close-invoked'; rootPid=$RootProcessId; sessionPid=$session.Id; windowHandle=$heldWindowHandle; hostStartedUtc=$heldHostStarted.ToString('O'); sessionStartedUtc=$sessionStarted.ToString('O'); failure=$failure } | ConvertTo-Json -Depth 4 -Compress))
                                [Console]::Out.Flush()
                            } elseif (-not $stopped) {
                                if ($null -eq $button -or -not $button.Current.IsEnabled -or $button.Current.Name -cne 'Stop session') { throw 'The actual session Stop control is unavailable.' }
                                # Compile/hold only after the command arrives, before Stop. No startup or idle sampling work.
                                try {
                                    Add-Type -Path (Join-Path $PSScriptRoot 'InstalledStopSnapshot.cs')
                                    $stopSnapshot = [NemoClaw.InstalledStop.Snapshot]::new($RootProcessId, $handle, (Join-Path $rootPath 'bin\NemoClaw.exe'), $started.ToFileTimeUtc(), $heldHost.Id, $heldHost.Handle, $heldHostPath, $heldHostStarted.ToFileTimeUtc())
                                    $null = $stopSnapshot.Capture() # retain descendants before they can exit
                                } catch { [Console]::Error.WriteLine('Owned Stop snapshot preparation failed: ' + $_.Exception.GetType().FullName) }
                                ([Windows.Automation.InvokePattern]$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
                                $stopped = $true; $stopWatch = [Diagnostics.Stopwatch]::StartNew()
                                [Console]::Out.WriteLine('{"kind":"stop-invoked"}')
                                [Console]::Out.Flush()
                                Write-StopSnapshot 'after-0ms'
                                $nextSnapshot = 1
                            }
                        }
                    }
                }
                $encoded = $record | ConvertTo-Json -Depth 3 -Compress
                if ($encoded -cne $last) { [Console]::Out.WriteLine($encoded); [Console]::Out.Flush(); $last=$encoded }
            } finally { if (-not [object]::ReferenceEquals($hostProcess, $heldHost)) { $hostProcess.Dispose() } }
        }
        Start-Sleep -Milliseconds 500
    }
    if ($failureCloseInvoked) {
        $root.WaitForExit()
        if (-not $session.HasExited -or -not $heldHost.HasExited) { throw 'The failed notice closed without its held host/window exiting.' }
        [Console]::Out.WriteLine(([ordered]@{ kind='failure-notice-closed'; rootPid=$RootProcessId; hostPid=$heldHost.Id; sessionPid=$session.Id; exitCode=$root.ExitCode; failure=$true; elapsedMs=$stopWatch.ElapsedMilliseconds } | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        exit 1 # A closed failure notice is never successful Stop/qualification evidence.
    }
    if (-not $stopped) { throw 'The installed launcher exited before the actual Stop action.' }
    Write-StopSnapshot 'guardian-exited'
    $root.WaitForExit()
    [Console]::Out.WriteLine(([ordered]@{ kind='closed'; exitCode=$root.ExitCode; stopElapsedMs=$stopWatch.ElapsedMilliseconds } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
} finally {
    if ($null -ne $stopSnapshot) { $stopSnapshot.Dispose() }
    if ($null -ne $heldHost) { $heldHost.Dispose() }
    if ($null -ne $session) { $session.Dispose() }
    $root.Dispose()
    $controller.Dispose()
}
