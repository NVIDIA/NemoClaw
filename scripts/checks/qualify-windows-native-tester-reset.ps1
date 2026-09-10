# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Dot-sourced by the package qualifier after all agent sessions have closed.
# This uses its existing bounded process, UI Automation and ownership helpers.
function Invoke-NativeTesterResetQualification {
    $fixture = Join-Path $artifactRoot ('tester-reset-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $helper = Join-Path $fixture 'NemoClaw.exe'
    [IO.File]::Copy($nemoclawUiLauncherPath, $helper, $false)
    $helperHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($helperHash -cne (Get-FileHash -LiteralPath $nemoclawUiLauncherPath -Algorithm SHA256).Hash.ToLowerInvariant()) {
        Fail-PackageQualification 'The retained native credential helper does not match the installed candidate.'
    }
    $stateRoot = $null
    $ownsState = $false
    $ownsKey = $false
    $binding = $null
    $process = $null
    $window = $null
    $nonce = [guid]::NewGuid().ToString('N')
    $canary = 'native-tester-reset-key-' + $nonce
    $endpoint = "https://127.0.0.1:17193/tester-$nonce/v1"
    $piConfig = Join-Path $nativeConfigurationRoot 'pi\native-windows.json'
    $preserved = @{}
    foreach ($entry in @($script:OwnedNativeConfigurations.GetEnumerator())) {
        if ($entry.Key -ine $piConfig -and $entry.Key -ine $nativeActiveAgentPath) { $preserved[$entry.Key] = $entry.Value }
    }
    try {
        # The fixture may only use a state root created by this transaction.
        # An existing persistent Pi workspace is never adopted or deleted.
        $creation = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--state-session', 'pi')
        if ($creation.exitCode -ne 0 -or $creation.stdout.Length -gt 4096) { Fail-PackageQualification 'The tester-reset state fixture could not be opened.' }
        $state = $creation.stdout | ConvertFrom-Json
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $expectedStateRoot = $env:SystemDrive.ToUpperInvariant() + '\NemoClawState-' + $sid + '-pi'
        if ($state.schemaVersion -ne 1 -or $state.kind -cne 'native-state-session' -or $state.agent -cne 'pi' -or
            $state.stateRoot -cne $expectedStateRoot -or $state.created -ne $true -or $state.leaseHeld -ne $true) {
            Fail-PackageQualification 'Tester reset requires a fresh, independently owned Pi state fixture; existing state was preserved.'
        }
        $stateRoot = $state.stateRoot
        $ownsState = $true
        $marker = Join-Path $stateRoot 'tester-reset-canary.txt'
        [IO.File]::WriteAllText($marker, ('disposable native reset fixture ' + $nonce), [Text.UTF8Encoding]::new($false))
        $markerHash = (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash.ToLowerInvariant()
        $intent = [ordered]@{ schemaVersion = 1; classification = 'nemoclaw-native-windows-agent-configuration'; profile = 'personal'; agent = 'pi'; inference = 'compatible'; endpoint = $endpoint; model = $script:NativeSetupModel; credentialStored = $true; options = @{} }
        $prepared = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath -Arguments @('--configure-native', '--prepare') -StandardInput ($intent | ConvertTo-Json -Depth 8 -Compress)
        $binding = $prepared.stdout.Trim()
        if ($prepared.exitCode -ne 0 -or $binding -cnotmatch '^[0-9a-f]{64}$') { Fail-PackageQualification 'The reset canary binding could not be prepared before Save.' }
        $absent = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--credential-read', 'compatible', '--binding', $binding)
        if ($absent.exitCode -eq 0 -or $absent.stdout.Length -ne 0) { Fail-PackageQualification 'The unique tester-reset credential target already exists.' }
        $ownsKey = $true
        $selection = Invoke-NativeSetupSelection -Agent pi -ChoiceId AgentPi -Standalone -ReplaceOwned `
            -Inference compatible -Endpoint $endpoint -CredentialCanary $canary -EvidenceName 'tester-reset-canary'
        $metadata = [IO.File]::ReadAllText($piConfig)
        $prepared = Invoke-NativeCredentialHelper -LauncherPath $nemoclawUiLauncherPath -Arguments @('--configure-native', '--prepare') -StandardInput $metadata
        if ($prepared.exitCode -ne 0 -or $prepared.stdout.Trim() -cne $binding) { Fail-PackageQualification 'The saved reset canary binding does not match its prepared identity.' }
        $read = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--credential-read', 'compatible', '--binding', $binding)
        if ($read.exitCode -ne 0 -or $read.stdout -cne $canary -or $metadata.Contains($canary)) {
            Fail-PackageQualification 'The real saved reset canary was not private and recoverable from its exact Windows binding.'
        }

        $desktop = [Windows.Automation.AutomationElement]::RootElement
        $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'NemoClaw Setup')
        if ($desktop.FindAll([Windows.Automation.TreeScope]::Children, $condition).Count -ne 0) { Fail-PackageQualification 'A setup window already exists before tester reset.' }
        $uninstallLog = Join-Path $artifactRoot 'tester-reset-uninstall.log'
        $arguments = @('/uninstall', '/norestart', '/log', $uninstallLog) | ForEach-Object { ConvertTo-NativeArgument -Value $_ }
        $process = Start-Process -FilePath $setup -ArgumentList $arguments -PassThru -ErrorAction Stop
        $null = $process.Handle
        $clock = [Diagnostics.Stopwatch]::StartNew()
        do {
            $windows = $desktop.FindAll([Windows.Automation.TreeScope]::Children, $condition)
            if ($windows.Count -eq 1) { $window = $windows[0]; break }
            if ($process.HasExited -or $windows.Count -gt 1) { break }
            Start-Sleep -Milliseconds 200
        } while ($clock.ElapsedMilliseconds -lt 60000)
        if (-not $window -or $window.Current.FrameworkId -cne 'WPF') { Fail-PackageQualification 'Tester reset did not open the actual native maintenance window.' }
        $remove = Wait-NativeSetupElement -Root $window -AutomationId 'RemoveOwnedAgentData'
        $toggle = [Windows.Automation.TogglePattern]$remove.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { Fail-PackageQualification 'Uninstall does not preserve agent data by default.' }
        $toggle.Toggle()
        foreach ($choice in $nativeAgentChoices) {
            $element = Wait-NativeSetupElement -Root $window -AutomationId ('RemoveAgent-' + $choice.agent)
            $selected = [Windows.Automation.TogglePattern]$element.GetCurrentPattern([Windows.Automation.TogglePattern]::Pattern)
            if ($selected.Current.ToggleState -ne [Windows.Automation.ToggleState]::Off) { Fail-PackageQualification 'Uninstall preselected an agent for data removal.' }
            if ($choice.agent -ceq 'pi') { $selected.Toggle() }
        }
        $beforeFrame = Save-NativeSetupFrame -Window $window -Name 'tester-reset-selected.png'
        Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'UninstallNemoClaw')
        Wait-NativeSetupElement -Root $window -AutomationId 'CloseButton' -TimeoutMilliseconds 2700000 | Out-Null
        $afterFrame = Save-NativeSetupFrame -Window $window -Name 'tester-reset-uninstalled.png'
        Invoke-NativeSetupButton -Element (Wait-NativeSetupElement -Root $window -AutomationId 'CloseButton')
        if (-not $process.WaitForExit(30000) -or $process.ExitCode -notin @(0, 3010)) { Fail-PackageQualification 'The native tester-reset uninstall did not finish successfully.' }
        if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $stateRoot) -or
            (Test-Path -LiteralPath $piConfig) -or (Test-Path -LiteralPath $nativeActiveAgentPath)) {
            Fail-PackageQualification 'Tester reset retained the selected data, configuration, remembered choice, or installed application.'
        }
        $ownsState = $false
        if (@(Get-ArpEntries -DisplayName $script:MsiDisplayName).Count -ne 0 -or
            @(Get-ArpEntries -DisplayName $script:BundleDisplayName).Count -ne 0 -or (Test-MachinePathContains -ExpectedPath $installBin)) {
            Fail-PackageQualification 'Tester reset retained installation registration or PATH.'
        }
        foreach ($entry in @($preserved.GetEnumerator())) {
            if (-not (Test-Path -LiteralPath $entry.Key -PathType Leaf) -or
                (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.Value) {
                Fail-PackageQualification 'Selecting Pi for reset changed another agent configuration.'
            }
        }
        $read = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--credential-read', 'compatible', '--binding', $binding)
        if ($read.exitCode -eq 0 -or $read.stdout.Length -ne 0) { Fail-PackageQualification 'The selected reset key remained in Windows Credential Manager.' }
        $ownsKey = $false
        $desktopReceipt = Join-Path $artifactRoot 'tester-reset-desktop-absent.json'
        & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $desktopReceipt -Expected Absent
        [void]$script:OwnedNativeConfigurations.Remove($piConfig)
        [void]$script:OwnedNativeConfigurations.Remove($nativeActiveAgentPath)

        # Reinstall through the same WPF flow, retaining the original five-choice
        # receipt while restoring deterministic configs for default-preserve removal.
        $restore = @()
        foreach ($choice in $nativeAgentChoices) {
            $existing = Test-Path -LiteralPath (Join-Path $nativeConfigurationRoot ($choice.agent + '\native-windows.json'))
            $standalone = $choice.agent -ceq 'nemocua'
            $restore += Invoke-NativeSetupSelection -Agent $choice.agent -ChoiceId $choice.automationId `
                -Maintenance:($restore.Count -gt 0 -and -not $standalone) -Standalone:$standalone -ReplaceOwned:$existing `
                -EvidenceName ('tester-reset-restore-' + $choice.agent)
        }
        Assert-InstalledTree -Root $installRoot -Phase 'Tester reset reinstall' -ExpectedFiles $expectedPayloadFiles
        if (@(Get-ArpEntries -DisplayName $script:MsiDisplayName).Count -ne 1 -or @(Get-ArpEntries -DisplayName $script:BundleDisplayName).Count -ne 1) {
            Fail-PackageQualification 'Tester reset reinstall did not restore exactly one MSI and bundle registration.'
        }
        $restoredDesktop = Join-Path $artifactRoot 'tester-reset-desktop-restored.json'
        & $desktopLinkCheck -InstallRoot $installRoot -ReceiptPath $restoredDesktop -Expected Present
        $receipt = [pscustomobject]@{
            schemaVersion = 1; classification = 'native-windows-tester-reset-qualification'; agent = 'pi'; passed = $true
            freshOwnedState = $true; stateCanarySha256 = $markerHash; installedHelperSha256 = $helperHash
            preservedDataByDefault = $true; explicitSelection = @('pi'); selectedStateRemoved = $true
            selectedCredentialRemoved = $true; selectedConfigurationRemoved = $true; activeAgentCleared = $true
            otherAgentConfigurationsPreserved = $true; desktopLinksRemoved = $true; registrationRemoved = $true
            actualNativeMaintenance = $true; reinstalledThroughNativeSetup = $true
            restoredAgents = @($restore | ForEach-Object agent); originalSelectionReceiptRetained = $true
            screenshots = @($beforeFrame, $afterFrame)
        }
        [IO.File]::WriteAllText((Join-Path $artifactRoot 'tester-reset.json'), (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
        return $receipt
    } finally {
        if ($process) {
            if (-not $process.HasExited -and $window) {
                try { ([Windows.Automation.WindowPattern]$window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)).Close() } catch { }
                if (-not $process.WaitForExit($script:OperationTimeoutMilliseconds)) { Fail-PackageQualification 'The tester-reset installer did not complete or roll back; it was not forcibly terminated.' }
            }
            $process.Dispose()
        }
        if ($ownsKey -and $binding) {
            $read = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--credential-read', 'compatible', '--binding', $binding)
            if ($read.exitCode -eq 0 -and $read.stdout -ceq $canary) {
                $cleared = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--credential-delete', 'compatible', '--binding', $binding)
                if ($cleared.exitCode -ne 0) { Fail-PackageQualification 'The owned reset canary key could not be cleared.' }
            }
        }
        if ($ownsState) {
            $removed = Invoke-NativeCredentialHelper -LauncherPath $helper -Arguments @('--state-remove', 'pi')
            if ($removed.exitCode -ne 0) { Fail-PackageQualification 'The owned tester-reset state fixture could not be cleared safely.' }
        }
        if ((Test-Path -LiteralPath $helper -PathType Leaf) -and
            (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $helperHash) { [IO.File]::Delete($helper) }
    }
}
