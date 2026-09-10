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
$inputLine = [Console]::In.ReadLineAsync()
$watch = [Diagnostics.Stopwatch]::StartNew()
$stopWatch = $null
$last = ''
$stopped = $false
$session = $null
$sessionStarted = $null
try {
    while (-not $root.HasExited) {
        if ($watch.ElapsedMilliseconds -gt 600000) { throw 'The installed session observer exceeded its bound.' }
        if ($null -ne $stopWatch -and $stopWatch.ElapsedMilliseconds -gt 120000) { throw 'The actual session did not finish its Stop cleanup.' }
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
                    hostPath=$hostPath; ports=$ports; sessionPid=$null; openEnabled=$false }
                if ($null -ne $session -and -not $session.HasExited) {
                    $record.sessionPid = $session.Id
                    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $session.Id)
                    $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $condition)
                    if ($null -ne $window) {
                        $openCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'NativeWebSessionOpen')
                        $open = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $openCondition)
                        $record.openEnabled = $null -ne $open -and $open.Current.IsEnabled -and $open.Current.Name -ceq 'Open Web UI'
                        if (-not $stopped -and $inputLine.IsCompleted) {
                            if ($inputLine.GetAwaiter().GetResult() -cne 'stop') { throw 'The owned session command was not Stop.' }
                            $stopCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, 'NativeWebSessionStop')
                            $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $stopCondition)
                            if ($null -eq $button -or -not $button.Current.IsEnabled -or $button.Current.Name -cne 'Stop session') { throw 'The actual session Stop control is unavailable.' }
                            ([Windows.Automation.InvokePattern]$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
                            $stopped = $true; $stopWatch = [Diagnostics.Stopwatch]::StartNew()
                            [Console]::Out.WriteLine('{"kind":"stop-invoked"}')
                            [Console]::Out.Flush()
                        }
                    }
                }
                $encoded = $record | ConvertTo-Json -Depth 3 -Compress
                if ($encoded -cne $last) { [Console]::Out.WriteLine($encoded); [Console]::Out.Flush(); $last=$encoded }
            } finally { $hostProcess.Dispose() }
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $stopped) { throw 'The installed launcher exited before the actual Stop action.' }
    $root.WaitForExit()
    [Console]::Out.WriteLine(([ordered]@{ kind='closed'; exitCode=$root.ExitCode; stopElapsedMs=$stopWatch.ElapsedMilliseconds } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
} finally {
    if ($null -ne $session) { $session.Dispose() }
    $root.Dispose()
}
