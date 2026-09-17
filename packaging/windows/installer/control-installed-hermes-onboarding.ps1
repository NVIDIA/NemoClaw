# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# CI-only use of the existing owned native onboarding window and UIA primitives.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$InstallRoot, [Parameter(Mandatory)][string]$Model,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateSet('hermes','pi')][string]$Agent = 'hermes')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preview-ui-controls.ps1')
if ($PSVersionTable.PSEdition -cne 'Core') { throw 'The native onboarding observer requires PowerShell7.' }
$secret = if ($env:NVIDIA_API_KEY) { $env:NVIDIA_API_KEY } else { $env:NVIDIA_INFERENCE_API_KEY }
if (-not $secret -or $secret -cnotmatch '^nvapi-[^\r\n\0]{1,2042}$') { throw 'An authorized NVIDIA credential is required.' }
$installation = [IO.Path]::GetFullPath($InstallRoot)
$launcher = Join-Path $installation 'bin\NemoClaw.exe'
$settings = Join-Path $env:LOCALAPPDATA 'NVIDIA\NemoClaw'
$configFile = Join-Path $settings "agents\$Agent\native-windows.json"
if ((Test-Path -LiteralPath $configFile) -or (Test-Path -LiteralPath $OutputPath)) { throw 'Native onboarding requires fresh configuration and evidence.' }
$result = [ordered]@{ schemaVersion=1; classification="installed-$Agent-native-onboarding"; passed=$false;
    nativeWpf=$false; source='installed-launcher-onboard'; successfulConfigurationSaves=0; rejectedEmptyIntegrationSave=$false;
    tavilyLiveLookup=$(if ($Agent -ceq 'hermes') { 'not-tested-user-waiver' } else { 'unsupported' }); appReceivedCiFlag=$false; keysLogged=$false; cleanupClosed=$false }
$primary = $null; $window = $null; $phase = 'launch'; $watch = [Diagnostics.Stopwatch]::StartNew()
$info = New-PreviewProcess $launcher @('--onboard','--agent',$Agent,'--wait')
$null = $info.Environment.Remove('GITHUB_ACTIONS')
$process = [Diagnostics.Process]::Start($info)
function Wait-InstalledElement($Window, [string]$Id, [int]$Milliseconds = 60000, [switch]$ExpectedFailure) {
    $remaining = 120000 - $watch.ElapsedMilliseconds
    if ($remaining -le 0) { throw 'The native onboarding interaction exceeded its bounded UI phase.' }
    return Wait-PreviewElement $Window $Id -Milliseconds ([int][Math]::Min($Milliseconds, $remaining)) -ExpectedFailure:$ExpectedFailure
}
function Select-OnboardingProvider($Element, [string]$Name) {
    $expansion = [Windows.Automation.ExpandCollapsePattern]$Element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expansion.Expand()
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
    $item = $Element.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $item) { throw 'The expected native provider choice is unavailable.' }
    ([Windows.Automation.SelectionItemPattern]$item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    $expansion.Collapse()
}
function Toggle-Onboarding($Window, [string]$Id, [bool]$Enabled) {
    $element = Wait-InstalledElement $Window $Id
    $toggle = [Windows.Automation.TogglePattern]$element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
    $state = if ($Enabled) { [Windows.Automation.ToggleState]::On } else { [Windows.Automation.ToggleState]::Off }
    if ($toggle.Current.ToggleState -ne $state) { $toggle.Toggle() }
    if ($toggle.Current.ToggleState -ne $state) { throw 'The native option did not reach its requested state.' }
}
try {
    $null = $process.Handle
    $window = Wait-PreviewWindow $process; $result.nativeWpf = $true
    $result['windowProcessId'] = $window.Current.ProcessId
    $phase = "$Agent-provider"
    $choiceId = if ($Agent -ceq 'hermes') { 'AgentHermes' } else { 'AgentPi' }
    $choice = Wait-InstalledElement $window $choiceId
    ([Windows.Automation.SelectionItemPattern]$choice.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    Invoke-PreviewButton (Wait-InstalledElement $window 'ConfigureInference')
    Select-OnboardingProvider (Wait-InstalledElement $window 'InferenceProvider') 'NVIDIA hosted inference'
    $endpoint = [Windows.Automation.ValuePattern](Wait-InstalledElement $window 'InferenceEndpoint').GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if (-not $endpoint.Current.IsReadOnly -or $endpoint.Current.Value -cne 'https://integrate.api.nvidia.com/v1') { throw 'The fixed NVIDIA endpoint contract changed.' }
    foreach ($field in @(@('InferenceModel',$Model), @('InferenceApiKey',$secret))) {
        $element = Wait-InstalledElement $window $field[0]
        if ($field[0] -ceq 'InferenceApiKey' -and -not $element.Current.IsPassword) { throw 'The native inference key field is not concealed.' }
        ([Windows.Automation.ValuePattern]$element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)).SetValue($field[1])
    }
    Toggle-Onboarding $window 'LicenseCheck' $true
    $save = Wait-InstalledElement $window 'InstallNemoClaw'
    if ($save.Current.Name -cne 'Save configuration') { throw 'The installed onboarding action is not configuration-only.' }
    $phase = 'optional-integrations'
    if ($Agent -ceq 'hermes') {
        $options = Wait-InstalledElement $window 'DownstreamOptions'
        ([Windows.Automation.ExpandCollapsePattern]$options.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()
        $messaging = @()
        foreach ($channel in @('Telegram','Discord','Slack')) {
            $check = Wait-InstalledElement $window ('Enable' + $channel)
            $toggle = [Windows.Automation.TogglePattern]$check.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { throw 'Messaging must be unconfigured by default.' }
            Toggle-Onboarding $window ('Enable' + $channel) $true
            $tokenIds = if ($channel -ceq 'Slack') { @('SlackBotToken','SlackAppToken') } else { @($channel + 'BotToken') }
            foreach ($id in $tokenIds) { if (-not (Wait-InstalledElement $window $id).Current.IsPassword) { throw 'An optional messaging token field is not concealed.' } }
            $allowed = [Windows.Automation.ValuePattern](Wait-InstalledElement $window ($channel + 'AllowedUsers')).GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
            if ($allowed.Current.Value -cne '') { throw 'Messaging allowed-user IDs were unexpectedly prefilled.' }
            Toggle-Onboarding $window ('Enable' + $channel) $false
            $messaging += @{ channel=$channel; defaultOff=$true; tokenFieldsConcealed=$true; allowedUsersInitiallyEmpty=$true; credentialsEntered=$false }
        }
        $result['messagingChoices'] = $messaging
        Toggle-Onboarding $window 'EnableSearch' $true
        Select-OnboardingProvider (Wait-InstalledElement $window 'SearchProvider') 'Tavily'
        $searchKey = Wait-InstalledElement $window 'SearchApiKey'
        if (-not $searchKey.Current.IsPassword) { throw 'The optional search key field is not concealed.' }
        $helpCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Get a search API key')
        if ($null -eq $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $helpCondition)) { throw 'The optional search help link is missing.' }
        Invoke-PreviewButton $save
        $failure = Wait-InstalledElement $window 'ConfigurationError' -ExpectedFailure
        if ($failure.Current.Name -cne 'Enter the required keys for each enabled integration.' -or (Test-Path -LiteralPath $configFile)) { throw 'Empty Tavily credentials did not refuse before configuration was saved.' }
        $result.rejectedEmptyIntegrationSave = $true
        Toggle-Onboarding $window 'EnableSearch' $false
    } else {
        # Pi must not inherit Hermes-only service options or claim their tests passed.
        $options = Find-PreviewElement $window 'DownstreamOptions'
        if ($null -ne $options -and -not $options.Current.IsOffscreen) { throw 'Pi exposed unsupported downstream integration options.' }
        $result['integrationChoicesUnavailable'] = $true
        $result['messagingChoices'] = @()
    }
    $phase = 'save-once'
    Invoke-PreviewButton $save
    $null = Wait-InstalledElement $window 'LaunchConfiguredAgent' -Milliseconds 60000
    $saved = [IO.File]::ReadAllText($configFile) | ConvertFrom-Json
    if ($saved.agent -cne $Agent -or $saved.profile -cne 'personal' -or $saved.inference -cne 'nvidia' -or $saved.endpoint -cne 'https://integrate.api.nvidia.com/v1' -or $saved.model -cne $Model -or $saved.credentialStored -cne $true) { throw 'The native saved configuration differs from the actual choices.' }
    if ([IO.File]::ReadAllText((Join-Path $settings 'active-agent.txt')).Trim() -cne $Agent) { throw 'Native onboarding did not remember the selected agent.' }
    $result.successfulConfigurationSaves = 1
    $result['rememberedAgent'] = $Agent; $result['provider'] = 'nvidia'; $result['searchRequested'] = $false
    ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close()
    if (-not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'Completed native onboarding did not close successfully.' }
    $result.passed = $true
} catch { $primary = $_ }
finally {
    if (-not $process.HasExited -and $null -ne $window) {
        try { ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close() } catch { }
        $null = $process.WaitForExit(30000)
    }
    $result.cleanupClosed = $process.HasExited; $result['elapsedMilliseconds'] = $watch.ElapsedMilliseconds; $result['phase'] = $phase
    if ($process.HasExited) { $result['exitCode'] = $process.ExitCode }
    if ($null -ne $primary) { $result['error'] = ([string]$primary.Exception.Message).Replace($secret, '[redacted]') }
    $process.Dispose()
    [IO.File]::WriteAllText($OutputPath, (($result | ConvertTo-Json -Depth 6) + "`n"), [Text.UTF8Encoding]::new($false))
}
if ($null -ne $primary) { throw $primary }
if (-not $result.cleanupClosed) { throw 'Native onboarding remained open.' }
