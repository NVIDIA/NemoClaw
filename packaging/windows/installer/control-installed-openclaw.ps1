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
$rootPath = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$root = [Diagnostics.Process]::GetProcessById($RootProcessId)
$handle = $root.Handle
$started = $root.StartTime.ToUniversalTime()
if (-not [string]::Equals($root.MainModule.FileName, (Join-Path $rootPath 'bin\NemoClaw.exe'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The UI controller root is not the installed native launcher.'
}
# Console.In is synchronized and its ReadLineAsync blocks this observer thread.
$inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false, 1024, $false)
$inputLine = $inputReader.ReadLineAsync()
$watch = [Diagnostics.Stopwatch]::StartNew()
$stopWatch = $null
$last = ''
$stopped = $false
$session = $null
$sessionStarted = $null
$heldHost = $null
$heldHostPath = $null
$heldHostStarted = $null
$stopSnapshot = $null
$nextSnapshot = 0
$stopSnapshotTimes = @(0, 2000, 8000)
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
        if ($watch.ElapsedMilliseconds -gt 600000) { throw 'The installed session observer exceeded its bound.' }
        if ($null -ne $stopWatch -and $stopWatch.ElapsedMilliseconds -gt 120000) {
            Write-StopSnapshot 'stop-deadline'
            throw 'The actual session did not finish its Stop cleanup.'
        }
        if ($stopped) {
            if ($nextSnapshot -lt $stopSnapshotTimes.Count -and $stopWatch.ElapsedMilliseconds -ge $stopSnapshotTimes[$nextSnapshot]) {
                Write-StopSnapshot ('after-' + $stopSnapshotTimes[$nextSnapshot] + 'ms')
                $nextSnapshot++
            }
            Start-Sleep -Milliseconds 100
            continue
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
                        if (-not $stopped -and $inputLine.IsCompleted) {
                            if ($inputLine.GetAwaiter().GetResult() -cne 'stop') { throw 'The owned session command was not Stop.' }
                            $stopCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'NativeWebSessionStop')
                            $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $stopCondition)
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
                $encoded = $record | ConvertTo-Json -Depth 3 -Compress
                if ($encoded -cne $last) { [Console]::Out.WriteLine($encoded); [Console]::Out.Flush(); $last=$encoded }
            } finally { if (-not [object]::ReferenceEquals($hostProcess, $heldHost)) { $hostProcess.Dispose() } }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $stopped) { throw 'The installed launcher exited before the actual Stop action.' }
    Write-StopSnapshot 'guardian-exited'
    $root.WaitForExit()
    [Console]::Out.WriteLine(([ordered]@{ kind='closed'; exitCode=$root.ExitCode; stopElapsedMs=$stopWatch.ElapsedMilliseconds } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
} finally {
    if ($null -ne $stopSnapshot) { $stopSnapshot.Dispose() }
    if ($null -ne $heldHost) { $heldHost.Dispose() }
    $inputReader.Dispose()
    if ($null -ne $session) { $session.Dispose() }
    $root.Dispose()
}
