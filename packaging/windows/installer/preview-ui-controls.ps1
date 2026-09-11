# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# Dot-source only from the Windows-owned Burn/migration qualification controllers.
Set-StrictMode -Version Latest
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') { throw 'Preview UI qualification requires disposable Windows CI.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-PreviewChildEnvironment {
    $values = @{}
    foreach ($name in @('SystemRoot','SYSTEMROOT','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $values[$name] = $value }
    }
    $values.OS = 'Windows_NT'; $values.GITHUB_ACTIONS = 'true'
    $values.PATH = [Environment]::SystemDirectory + ';' + [Environment]::GetEnvironmentVariable('SystemRoot')
    return $values
}
function New-PreviewProcess([string]$Executable, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new(); $info.FileName = $Executable
    $info.UseShellExecute = $false; $info.WorkingDirectory = [IO.Path]::GetDirectoryName($Executable)
    $info.Environment.Clear()
    foreach ($entry in (Get-PreviewChildEnvironment).GetEnumerator()) { $info.Environment[$entry.Key] = $entry.Value }
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    return $info
}
function Find-PreviewElement($Window, [string]$Id) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    return $Window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Wait-PreviewElement($Window, [string]$Id, [int]$Milliseconds = 60000, [switch]$ExpectedFailure) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $element = Find-PreviewElement $Window $Id
        if ($null -ne $element -and -not $element.Current.IsOffscreen -and $element.Current.IsEnabled) { return $element }
        if ($null -ne $element -and $element.Current.IsEnabled) { try { $element.SetFocus() } catch [InvalidOperationException] { } }
        if (-not $ExpectedFailure) {
            foreach ($name in @('FailureDetail','ConfigurationError','MaintenanceError')) {
                $errorControl = Find-PreviewElement $Window $name
                if ($null -ne $errorControl -and -not $errorControl.Current.IsOffscreen -and -not [string]::IsNullOrWhiteSpace($errorControl.Current.Name)) {
                    throw 'The actual native setup window reported a failure.'
                }
            }
        }
        Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt $Milliseconds)
    throw "The owned setup did not expose $Id within its bound."
}
function Invoke-PreviewButton($Element) {
    ([Windows.Automation.InvokePattern]$Element.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
function Test-PreviewWindowOwner([int]$WindowProcessId, $Process) {
    $seen = [Collections.Generic.HashSet[int]]::new()
    for ($depth = 0; $depth -lt 8; $depth++) {
        if ($WindowProcessId -eq $Process.Id) { return -not $Process.HasExited }
        if (-not $seen.Add($WindowProcessId)) { return $false }
        $row = Get-CimInstance Win32_Process -Filter "ProcessId=$WindowProcessId" -ErrorAction Stop
        if ($null -eq $row -or $row.CreationDate.ToUniversalTime() -lt $Process.StartTime.ToUniversalTime()) { return $false }
        $WindowProcessId = [int]$row.ParentProcessId
    }
    return $false
}
function Wait-PreviewWindow($Process) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'NemoClaw Setup')
    do {
        $ownedWindows = @()
        foreach ($window in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)) {
            if (Test-PreviewWindowOwner $window.Current.ProcessId $Process) { $ownedWindows += $window }
        }
        if ($ownedWindows.Count -gt 1) { throw 'More than one setup window belongs to the candidate.' }
        if ($ownedWindows.Count -eq 1) {
            if ($ownedWindows[0].Current.FrameworkId -cne 'WPF') { throw 'The candidate did not launch its native WPF installer.' }
            return $ownedWindows[0]
        }
        if ($Process.HasExited) { throw "The owned setup exited before its window, status $($Process.ExitCode)." }
        Start-Sleep -Milliseconds 100
    } while ($clock.ElapsedMilliseconds -lt 60000)
    throw 'The candidate setup window did not become available.'
}
function Set-PreviewCanaryConfiguration($Window, [string]$Endpoint, [string]$Key) {
    $choice = Wait-PreviewElement $Window 'AgentOpenClaw'
    ([Windows.Automation.SelectionItemPattern]$choice.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    Invoke-PreviewButton (Wait-PreviewElement $Window 'ConfigureInference')
    $provider = Wait-PreviewElement $Window 'InferenceProvider'
    $expansion = [Windows.Automation.ExpandCollapsePattern]$provider.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expansion.Expand()
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Compatible HTTPS endpoint')
    $item = $provider.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $item) { throw 'The native compatible-provider choice is unavailable.' }
    ([Windows.Automation.SelectionItemPattern]$item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select(); $expansion.Collapse()
    foreach ($field in @(@('InferenceEndpoint',$Endpoint), @('InferenceModel','qualification/migration-canary'), @('InferenceApiKey',$Key))) {
        $element = Wait-PreviewElement $Window $field[0]
        if ($field[0] -ceq 'InferenceApiKey' -and -not $element.Current.IsPassword) { throw 'The native credential field is not concealed.' }
        ([Windows.Automation.ValuePattern]$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).SetValue($field[1])
    }
    $license = Wait-PreviewElement $Window 'LicenseCheck'
    $toggle = [Windows.Automation.TogglePattern]$license.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
}
function Invoke-PreviewUi {
    param([string]$SetupPath, [string]$SetupSha256,
        [ValidateSet('failure','install','replace','uninstall')][string]$Mode,
        [string]$LogPath, [string]$Endpoint = 'https://127.0.0.1:17193/qualification/v1',
        [string]$CanaryKey = 'disposable-setup-diagnostic-canary',
        [switch]$RemoveOpenClawData, [scriptblock]$AfterReplacement)
    if ((Get-FileHash -LiteralPath $SetupPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SetupSha256) { throw 'The setup artifact bytes changed before execution.' }
    if (Test-Path -LiteralPath $LogPath) { throw 'Setup qualification logs must be fresh.' }
    $action = if ($Mode -ceq 'uninstall') { '-uninstall' } else { '-install' }
    $info = New-PreviewProcess $SetupPath @($action,'-norestart','-log',$LogPath)
    $clock = [Diagnostics.Stopwatch]::StartNew(); $process = [Diagnostics.Process]::Start($info)
    $window = $null; $primary = $null; $result = [ordered]@{ mode=$Mode; nativeWpf=$false; installClicks=0; configureClicks=0; replacementMilliseconds=$null; applyToReadyMilliseconds=$null; exitCode=$null; cleanupClosed=$false }
    try {
        $null = $process.Handle; $window = Wait-PreviewWindow $process; $result.nativeWpf = $true
        $result['windowProcessId'] = $window.Current.ProcessId; $result['windowHandle'] = $window.Current.NativeWindowHandle
        if ($Mode -ceq 'replace') {
            $replace = Wait-PreviewElement $window 'ReplacePreviousPreview'; $replacement = [Diagnostics.Stopwatch]::StartNew()
            Invoke-PreviewButton $replace
            $null = Wait-PreviewElement $window 'ConfigureInference' -Milliseconds 180000
            $result.replacementMilliseconds = $replacement.ElapsedMilliseconds
            if ($null -ne $AfterReplacement) { & $AfterReplacement }
        }
        if ($Mode -ceq 'uninstall') {
            $remove = Wait-PreviewElement $window 'RemoveOwnedAgentData'
            $toggle = [Windows.Automation.TogglePattern]$remove.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { throw 'Uninstall did not preserve user data by default.' }
            if ($RemoveOpenClawData) {
                $toggle.Toggle()
                $agent = Wait-PreviewElement $window 'RemoveAgent-openclaw'
                $selected = [Windows.Automation.TogglePattern]$agent.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
                if ($selected.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { throw 'An agent was preselected for removal.' }
                $selected.Toggle()
            }
            $apply = [Diagnostics.Stopwatch]::StartNew(); Invoke-PreviewButton (Wait-PreviewElement $window 'UninstallNemoClaw')
            $null = Wait-PreviewElement $window 'CloseButton' -Milliseconds 180000
            $result.applyToReadyMilliseconds = $apply.ElapsedMilliseconds
        } else {
            Set-PreviewCanaryConfiguration $window $Endpoint $CanaryKey; $result.configureClicks++
            $apply = [Diagnostics.Stopwatch]::StartNew(); Invoke-PreviewButton (Wait-PreviewElement $window 'InstallNemoClaw'); $result.installClicks++
            if ($Mode -ceq 'failure') {
                $failure = Wait-PreviewElement $window 'FailureDetail' -Milliseconds 180000 -ExpectedFailure
                $text = [string]$failure.Current.Name
                if ($text.Length -gt 4096 -or $text -notmatch 'Checking system-drive access failed' -or $text -notmatch 'Windows error 32' -or $text -notmatch 'Stage: open-metadata-inspection-target') { throw 'The real WPF failure screen lost the helper stage or Windows error.' }
                $result['failureText'] = $text
            } else { $null = Wait-PreviewElement $window 'LaunchConfiguredAgent' -Milliseconds 180000 }
            $result.applyToReadyMilliseconds = $apply.ElapsedMilliseconds
        }
        ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close()
        if (-not $process.WaitForExit(30000)) { throw 'The completed setup process did not close.' }
        $result.exitCode = $process.ExitCode
        if (($Mode -ceq 'failure' -and $process.ExitCode -eq 0) -or ($Mode -cne 'failure' -and $process.ExitCode -ne 0)) { throw 'The native setup completion status was incorrect.' }
    } catch { $primary = $_ }
    finally {
        if (-not $process.HasExited -and $null -ne $window) {
            try { ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close() } catch { }
            # Request normal cancellation/rollback; never kill a live MSI operation.
            $null = $process.WaitForExit(60000)
        }
        $result.cleanupClosed = $process.HasExited; $result['elapsedMilliseconds'] = $clock.ElapsedMilliseconds
        if ($process.HasExited) { $result.exitCode = $process.ExitCode }
        $process.Dispose()
        [IO.File]::WriteAllText($LogPath + '.ui.json', ($result | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    }
    if ($null -ne $primary) { throw $primary }
    if (-not $result.cleanupClosed) { throw 'Setup cleanup did not finish.' }
    return [pscustomobject]$result
}
