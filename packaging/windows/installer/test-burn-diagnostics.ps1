# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$FixtureDirectory, [Parameter(Mandatory)][string]$OutputDirectory)
Set-StrictMode -Version Latest; $ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preview-ui-controls.ps1')
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Burn diagnostic evidence must be fresh.' }
$output = [IO.Path]::GetFullPath($OutputDirectory); [void][IO.Directory]::CreateDirectory($output)
$fixture = Get-Content -LiteralPath (Join-Path $FixtureDirectory 'fixture.json') -Raw | ConvertFrom-Json
if ($fixture.classification -cne 'actual-burn-host-preparation-failure-fixture' -or $fixture.sourceRevision -cne $env:GITHUB_SHA -or $fixture.intendedForDistribution -ne $false) { throw 'The diagnostic fixture identity is invalid.' }
foreach ($item in @($fixture.helper,$fixture.setup)) {
    $file = Join-Path $FixtureDirectory $item.file
    if ([IO.Path]::GetFileName([string]$item.file) -cne $item.file -or (Get-Item -LiteralPath $file).Length -ne $item.bytes -or
        (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw 'A Burn diagnostic fixture file differs from its receipt.' }
}
$record = [ordered]@{schemaVersion=1;classification='actual-burn-prerequisite-failure-qualification';sourceRevision=$env:GITHUB_SHA;status='failed';
    packageNotInstalled=$false;primaryFailureRetained=$false;sidecarMatched=$false;stdoutReceiptAbsent=$false;ui=$null;cleanupErrors=@()}
$primary = $null
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
        $record.stdoutReceiptAbsent=$true
    } finally {
        if (-not $child.HasExited) { $child.Kill($true); if (-not $child.WaitForExit(5000)) { throw 'The owned diagnostic-only fixture did not close.' } }
        $child.Dispose()
    }
    $log = Join-Path $output 'burn.log'
    $record.ui = Invoke-PreviewUi -SetupPath (Join-Path $FixtureDirectory $fixture.setup.file) -SetupSha256 $fixture.setup.sha256 -Mode failure -LogPath $log
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
    $record.packageNotInstalled = -not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'NemoClaw Diagnostics Fixture'))
    if (-not $record.packageNotInstalled) { throw 'The downstream MSI executed despite the prerequisite failure.' }
    $record.status='pass'
} catch { $primary=$_; $record['error']=$_.Exception.Message }
finally {
    $uiReceipt=Join-Path $output 'burn.log.ui.json'
    if ($null -eq $record.ui -and (Test-Path -LiteralPath $uiReceipt)) {
        try { $record.ui=Get-Content -LiteralPath $uiReceipt -Raw | ConvertFrom-Json } catch { $record.cleanupErrors+=@('The owned UI cleanup receipt could not be read.') }
    }
    if ($null -ne $record.ui -and $record.ui.cleanupClosed) {
        try {
            $cleanupInfo=New-PreviewProcess (Join-Path $FixtureDirectory $fixture.setup.file) @('-uninstall','-quiet','-norestart','-log',(Join-Path $output 'fixture-cleanup.log'))
            $cleanup=[Diagnostics.Process]::Start($cleanupInfo)
            try {
                if (-not $cleanup.WaitForExit(60000) -or $cleanup.ExitCode -ne 0) { throw 'The failed fixture did not complete conventional cleanup.' }
                $record['fixtureUninstallExitCode']=$cleanup.ExitCode
            } finally { $cleanup.Dispose() }
        } catch { $record.cleanupErrors+=@($_.Exception.Message); $record.status='failed'; if ($null -eq $primary) { $primary=$_ } }
    }
    [IO.File]::WriteAllText((Join-Path $output 'burn-diagnostics.json'), ($record | ConvertTo-Json -Depth 7), [Text.UTF8Encoding]::new($false))
}
if ($null -ne $primary) { throw $primary }
