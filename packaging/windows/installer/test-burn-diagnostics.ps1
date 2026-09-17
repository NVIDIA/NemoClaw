# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$FixtureDirectory, [Parameter(Mandatory)][string]$OutputDirectory,
    [ValidateSet('openclaw','hermes','pi')][string]$Agent = 'openclaw')
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preview-ui-controls.ps1')
function Read-DiagnosticPreparationTier([string]$Text) {
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 8192) { throw 'The MXC preparation-tier probe exceeded its output bound.' }
    $options = [System.Text.Json.JsonDocumentOptions]::new(); $options.MaxDepth = 8
    $document = [System.Text.Json.JsonDocument]::Parse($Text, $options)
    try {
        $root = $document.RootElement
        if ($root.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'The exact MXC preparation-tier result is invalid.' }
        $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $root.EnumerateObject()) {
            if (-not $names.Add($property.Name)) { throw 'The MXC preparation-tier result is ambiguous.' }
        }
        $tier = $root.GetProperty('tier').GetString()
        $augment = $root.GetProperty('needsDaclAugmentation').GetBoolean()
        if (($tier -ceq 'base-container' -and -not $augment) -or ($tier -ceq 'appcontainer-dacl' -and $augment)) { return $tier }
        throw 'The exact MXC preparation-tier result is invalid.'
    } finally { $document.Dispose() }
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Burn diagnostic evidence must be fresh.' }
$output = [IO.Path]::GetFullPath($OutputDirectory); [void][IO.Directory]::CreateDirectory($output)
$fixture = Get-Content -LiteralPath (Join-Path $FixtureDirectory 'fixture.json') -Raw | ConvertFrom-Json
if ($fixture.classification -cne 'actual-burn-host-preparation-failure-fixture' -or $fixture.sourceRevision -cne $env:GITHUB_SHA -or $fixture.intendedForDistribution -ne $false) { throw 'The diagnostic fixture identity is invalid.' }
foreach ($item in @($fixture.helper,$fixture.probe,$fixture.setup)) {
    $file = Join-Path $FixtureDirectory $item.file
    if ([IO.Path]::GetFileName([string]$item.file) -cne $item.file -or (Get-Item -LiteralPath $file).Length -ne $item.bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw 'A Burn diagnostic fixture file differs from its receipt.' }
}
$record = [ordered]@{schemaVersion=1;classification='actual-burn-prerequisite-failure-qualification';sourceRevision=$env:GITHUB_SHA;agent=$Agent.ToLowerInvariant();status='failed';
    preparationTier=$null;integratedFailureApplicable=$null;directFailureRetained=$false;packageNotInstalled=$false;
    primaryFailureRetained=$false;sidecarMatched=$false;stdoutReceiptAbsent=$false;ui=$null;cleanupErrors=@()}
$primary = $null; $fixtureSetupStopped = $false
if (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw')) { throw 'The Burn failure regression requires no installed product.' }
try {
    $helper = Join-Path $FixtureDirectory $fixture.helper.file
    $attempt = [guid]::NewGuid().ToString('N'); $sidecar = Join-Path $output "direct.log.host-preparation-$attempt.json"
    $info = New-PreviewProcess $helper @('prepare-system-drive','--diagnostic-log',$sidecar,'--diagnostic-id',$attempt)
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
    $child = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(30000)) { throw 'The owned diagnostic-only helper did not exit.' }
        if ($child.ExitCode -ne 32 -or $stdout.GetAwaiter().GetResult().Length -ne 0) { throw 'The fixture did not fail before a stdout receipt.' }
        $retained = $stderr.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($retained) -gt 8192) { throw 'Fixture stderr exceeded its bound.' }
        [IO.File]::WriteAllText((Join-Path $output 'direct.stderr.json'), $retained)
        $detail = $retained | ConvertFrom-Json
        if ($detail.attemptId -cne $attempt -or $detail.stage -cne $fixture.expectedStage -or $detail.win32Error -ne 32) { throw 'Direct helper stderr lost its exact failure.' }
        $record.stdoutReceiptAbsent=$true; $record.directFailureRetained=$true
    } finally {
        if (-not $child.HasExited) { $child.Kill($true); if (-not $child.WaitForExit(5000)) { throw 'The owned diagnostic-only fixture did not close.' } }
        $child.Dispose()
    }
    $probeInfo = New-PreviewProcess (Join-Path $FixtureDirectory $fixture.probe.file) @('--probe')
    $probeInfo.RedirectStandardInput=$true; $probeInfo.RedirectStandardOutput=$true; $probeInfo.RedirectStandardError=$true; $probeInfo.CreateNoWindow=$true
    $probeProcess = [Diagnostics.Process]::Start($probeInfo)
    try {
        $probeProcess.StandardInput.Close(); $probeOut=$probeProcess.StandardOutput.ReadToEndAsync(); $probeErr=$probeProcess.StandardError.ReadToEndAsync()
        if (-not $probeProcess.WaitForExit(15000) -or $probeProcess.ExitCode -ne 0) { throw 'The exact MXC preparation-tier probe failed.' }
        $probeText=$probeOut.GetAwaiter().GetResult(); $probeError=$probeErr.GetAwaiter().GetResult()
        if ([Text.Encoding]::UTF8.GetByteCount($probeText) -gt 8192 -or [Text.Encoding]::UTF8.GetByteCount($probeError) -gt 8192) { throw 'The MXC preparation-tier probe exceeded its output bound.' }
        $record.preparationTier=Read-DiagnosticPreparationTier $probeText
    } finally {
        if (-not $probeProcess.HasExited) { $probeProcess.Kill($true); if (-not $probeProcess.WaitForExit(5000)) { throw 'The MXC preparation-tier probe did not close.' } }
        $probeProcess.Dispose()
    }
    $log = Join-Path $output 'burn.log'
    if ($record.preparationTier -ceq 'appcontainer-dacl') {
        $record.integratedFailureApplicable=$true
        $record.ui = Invoke-PreviewUi -SetupPath (Join-Path $FixtureDirectory $fixture.setup.file) -SetupSha256 $fixture.setup.sha256 -Mode failure -LogPath $log -Agent $Agent
        $files = @(Get-ChildItem -LiteralPath $output -Filter 'burn.log.host-preparation-*.json' -File)
        if ($files.Count -ne 1 -or $files[0].Length -gt 8192) { throw 'The actual Burn invocation did not retain exactly one bounded helper sidecar.' }
        $detail = Get-Content -LiteralPath $files[0].FullName -Raw | ConvertFrom-Json
        if ($detail.status -cne 'failed' -or $detail.stage -cne $fixture.expectedStage -or $detail.win32Error -ne 32 -or
            $detail.attemptId -cnotmatch '^[a-f0-9]{32}$' -or $files[0].Name -cne "burn.log.host-preparation-$($detail.attemptId).json") { throw 'The Burn helper sidecar does not match its failed invocation.' }
        $record.sidecarMatched=$true
        $logText = Get-Content -LiteralPath $log -Raw
        if ($logText -notmatch 'NemoClaw host preparation failed at open-metadata-inspection-target; Win32=32; helper stderr:' -or
            $logText -match 'Applying execute package: NemoClawArm64Msi') { throw 'Burn lost the primary failure or proceeded into MSI.' }
        $record.primaryFailureRetained=$true
        if (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'NemoClaw Diagnostics Fixture')) { throw 'The downstream MSI executed despite the prerequisite failure.' }
    } else {
        $record.integratedFailureApplicable=$false
        # This MSI contains only a marker, not the native runtime required for
        # onboarding. Exercise actual Burn planning without claiming a UI pass.
        $setupInfo=New-PreviewProcess (Join-Path $FixtureDirectory $fixture.setup.file) @('-install','-quiet','-norestart','-log',$log)
        $setupProcess=[Diagnostics.Process]::Start($setupInfo)
        $record['headlessInstall']=[ordered]@{pid=$setupProcess.Id;startedUtc=$setupProcess.StartTime.ToUniversalTime().ToString('o');stopped=$false;exitCode=$null}
        try {
            if (-not $setupProcess.WaitForExit(180000)) { throw 'The owned fixture install remains live; reconcile before cleanup.' }
            $record.headlessInstall.exitCode=$setupProcess.ExitCode
            if ($setupProcess.ExitCode -ne 0) { throw 'The BaseContainer fixture install failed.' }
        } finally { $fixtureSetupStopped=$setupProcess.HasExited; $record.headlessInstall.stopped=$fixtureSetupStopped; $setupProcess.Dispose() }
        if (@(Get-ChildItem -LiteralPath $output -Filter 'burn.log.host-preparation-*.json' -File).Count -ne 0) { throw 'BaseContainer unexpectedly invoked the AppContainer preparation helper.' }
        $logText = Get-Content -LiteralPath $log -Raw
        if ($logText -match 'Applying execute package: MxcSystemDrivePreparation' -or $logText -notmatch 'Applying execute package: NemoClawArm64Msi') { throw 'Burn did not preserve BaseContainer prerequisite selection.' }
        if (-not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'NemoClaw Diagnostics Fixture'))) { throw 'The BaseContainer downstream MSI did not execute.' }
    }
    $record.status='pass'
} catch { $primary=$_; $record['error']=$_.Exception.Message }
finally {
    $uiReceipt=Join-Path $output 'burn.log.ui.json'
    if ($null -eq $record.ui -and (Test-Path -LiteralPath $uiReceipt)) {
        try { $record.ui=Get-Content -LiteralPath $uiReceipt -Raw | ConvertFrom-Json } catch { $record.cleanupErrors+=@('The owned UI cleanup receipt could not be read.') }
    }
    if ($fixtureSetupStopped -or ($null -ne $record.ui -and $record.ui.cleanupClosed)) {
        try {
            $cleanupInfo=New-PreviewProcess (Join-Path $FixtureDirectory $fixture.setup.file) @('-uninstall','-quiet','-norestart','-log',(Join-Path $output 'fixture-cleanup.log'))
            $cleanup=[Diagnostics.Process]::Start($cleanupInfo)
            try {
                if (-not $cleanup.WaitForExit(60000) -or $cleanup.ExitCode -ne 0) { throw 'The failed fixture did not complete conventional cleanup.' }
                $record['fixtureUninstallExitCode']=$cleanup.ExitCode
            } finally { $cleanup.Dispose() }
        } catch { $record.cleanupErrors+=@($_.Exception.Message); $record.status='failed'; if ($null -eq $primary) { $primary=$_ } }
    }
    $record.packageNotInstalled = -not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'NemoClaw Diagnostics Fixture'))
    if (-not $record.packageNotInstalled) { $record.cleanupErrors+=@('The diagnostic fixture remained installed.'); $record.status='failed' }
    [IO.File]::WriteAllText((Join-Path $output 'burn-diagnostics.json'), ($record | ConvertTo-Json -Depth 7), [Text.UTF8Encoding]::new($false))
}
if ($null -ne $primary) { throw $primary }
if ($record.status -cne 'pass') { throw 'The Burn prerequisite-selection fixture did not complete cleanly.' }
