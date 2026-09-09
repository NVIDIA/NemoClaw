# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualify the no-WSL native Windows installer against NVIDIA/OpenShell#2721.

.DESCRIPTION
    Verifies exact candidate and OpenShell source authority before executing the
    candidate installer. The qualification executes the ARM64 binaries, then
    installs, damages, repairs, recovers, and uninstalls the distribution. A
    calibrated Windows process-start audit proves the file-only installer starts
    no child process; prohibited runtime checks and bounded receipts preserve the
    no-WSL evidence.
#>

[CmdletBinding(DefaultParameterSetName = 'Full')]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory, ParameterSetName = 'Full')][string]$OpenShellCheckout,
    [Parameter(Mandatory, ParameterSetName = 'Full')][string]$OpenShellSha,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory, ParameterSetName = 'ProcessAuditControl')][switch]$ProcessAuditControlOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CanonicalNemoClawRepository = 'https://github.com/NVIDIA/NemoClaw.git'
$script:CanonicalOpenShellRepository = 'https://github.com/NVIDIA/OpenShell.git'
$script:TrustedOpenShellPullRequest = 2721
$script:TrustedOpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'
$script:ShaPattern = '^[a-f0-9]{40}$'
$script:MaxJsonBytes = 16384
$script:MaxInstallerBytes = 524288
$script:ProcessAuditSettleMilliseconds = 3000
$script:NativeProbeTimeoutMilliseconds = 30000

function Fail-Qualification {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native installer qualification failed: $Message"
}

function Resolve-PlainDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-Qualification "$Label is missing."
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-Qualification "$Label must not be a reparse point."
    }
    return $resolved
}

function Assert-NoReparsePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-Qualification "$Label must not contain a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($candidate)
        if ($null -eq $parent) {
            break
        }
        $candidate = $parent.FullName
    }
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git -C $Root @Arguments 2>$null
    $status = $LASTEXITCODE
    if (-not $AllowFailure -and $status -ne 0) {
        Fail-Qualification "Git could not verify $Root."
    }
    return [pscustomobject]@{
        Status = $status
        Output = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
}

function Assert-Checkout {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ExpectedRevision,
        [Parameter(Mandatory)][string]$ExpectedRepository,
        [Parameter(Mandatory)][string]$Label
    )

    $checkout = Resolve-PlainDirectory -Path $Root -Label $Label
    if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
        Fail-Qualification "$Label has no Git metadata."
    }
    $revision = (Invoke-Git -Root $checkout -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')).Output
    if ($revision -cne $ExpectedRevision) {
        Fail-Qualification "$Label does not match the expected revision."
    }
    $repository = (Invoke-Git -Root $checkout -Arguments @(
        'config', '--local', '--no-includes', '--get', 'remote.origin.url'
    )).Output
    $allowedRepositories = @($ExpectedRepository, $ExpectedRepository.Substring(0, $ExpectedRepository.Length - 4))
    if ($allowedRepositories -cnotcontains $repository) {
        Fail-Qualification "$Label has an unexpected origin repository."
    }
    foreach ($pattern in @('^credential\.', '^http\..*\.extraheader$')) {
        $credentialMatch = Invoke-Git -Root $checkout -Arguments @(
            'config', '--local', '--no-includes', '--get-regexp', $pattern
        ) -AllowFailure
        if ($credentialMatch.Status -eq 0) {
            Fail-Qualification "$Label must not store Git credentials."
        }
    }
    return $checkout
}

function Assert-CommittedFile {
    param(
        [Parameter(Mandatory)][string]$Checkout,
        [Parameter(Mandatory)][string]$Revision,
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$FilePath
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        Fail-Qualification "Candidate file is missing: $RelativePath"
    }
    $committedBlob = (Invoke-Git -Root $Checkout -Arguments @(
        'rev-parse', "${Revision}:${RelativePath}"
    )).Output
    $workingBlob = (Invoke-Git -Root $Checkout -Arguments @(
        'hash-object', '--no-filters', '--', $FilePath
    )).Output
    if ($workingBlob -cne $committedBlob) {
        Fail-Qualification "Candidate file bytes do not match the candidate commit: $RelativePath"
    }
}

function Invoke-ChildSideEffectProbe {
    param([Parameter(Mandatory)][string]$SentinelPath)

    $escapedPath = $SentinelPath.Replace("'", "''")
    $command = "[IO.File]::WriteAllText('$escapedPath', 'child-executed', [Text.UTF8Encoding]::new(`$false))"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $child = $null
    $startError = $null
    $exitCode = $null
    $processId = $null
    try {
        $childParameters = @{
            FilePath = (Join-Path $PSHOME 'powershell.exe')
            ArgumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand)
            Wait = $true
            PassThru = $true
            ErrorAction = 'Stop'
        }
        $child = Start-Process @childParameters
        if ($null -ne $child) {
            $processId = $child.Id
            $exitCode = $child.ExitCode
            $child.Dispose()
            $child = $null
        }
    } catch {
        $startError = $_.Exception.Message
    } finally {
        if ($null -ne $child) {
            $child.Dispose()
        }
    }

    return [pscustomobject]@{
        exitCode = $exitCode
        processId = $processId
        sideEffectObserved = Test-Path -LiteralPath $SentinelPath -PathType Leaf
        startRejected = $null -ne $startError
    }
}

function Start-ProcessStartAudit {
    $sourceIdentifier = 'NemoClawNativeInstaller-' + [guid]::NewGuid().ToString('N')
    Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $sourceIdentifier | Out-Null
    return [pscustomobject]@{
        sourceIdentifier = $sourceIdentifier
    }
}

function Receive-ProcessStartAudit {
    param(
        [Parameter(Mandatory)]$Audit,
        [Parameter(Mandatory)][int]$SettleMilliseconds,
        [long]$StartedAt = [Diagnostics.Stopwatch]::GetTimestamp(),
        [switch]$DrainOnly
    )

    $frequency = [Diagnostics.Stopwatch]::Frequency
    $deadline = $StartedAt + [long]($SettleMilliseconds * $frequency / 1000.0)
    $records = [Collections.Generic.List[object]]::new()
    do {
        $queued = @(Get-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue)
        $observedAt = [Diagnostics.Stopwatch]::GetTimestamp()
        foreach ($auditEvent in $queued) {
            $processEvent = $auditEvent.SourceEventArgs.NewEvent
            $records.Add([pscustomobject]@{
                eventIdentifier = [int]$auditEvent.EventIdentifier
                eventTime = [long]$processEvent.TIME_CREATED
                timeGenerated = $auditEvent.TimeGenerated.ToUniversalTime().ToString('O')
                observedAfterMilliseconds = 1000.0 * ($observedAt - $StartedAt) / $frequency
                observedWithinWindow = $observedAt -le $deadline
                processId = [int]$processEvent.ProcessID
                parentProcessId = [int]$processEvent.ParentProcessID
                processName = [string]$processEvent.ProcessName
            })
            Remove-Event -EventIdentifier $auditEvent.EventIdentifier
        }
        $remainingMilliseconds = 1000.0 * ($deadline - [Diagnostics.Stopwatch]::GetTimestamp()) / $frequency
        if ($DrainOnly -or $remainingMilliseconds -le 0) { break }
        Start-Sleep -Milliseconds ([int][Math]::Max(1, [Math]::Min(50, [Math]::Floor($remainingMilliseconds))))
    } while ($true)
    return $records.ToArray()
}

function Get-AuditedDescendantStarts {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][Array]$Records,
        [Parameter(Mandatory)][int]$RootProcessId
    )

    $tracked = @{}
    $tracked[[string]$RootProcessId] = $true
    # WMI arrival order does not establish parent-before-child order.
    do {
        $expanded = $false
        foreach ($record in $Records) {
            if ($tracked.ContainsKey([string]$record.parentProcessId) -and
                -not $tracked.ContainsKey([string]$record.processId)) {
                $tracked[[string]$record.processId] = $true
                $expanded = $true
            }
        }
    } while ($expanded)
    $descendants = @()
    foreach ($record in $Records) {
        if ($tracked.ContainsKey([string]$record.parentProcessId)) {
            $descendants += $record
        }
    }
    return @($descendants)
}

function Assert-ProcessAuditAncestryControl {
    $records = @(
        [pscustomobject]@{ processId = 103; parentProcessId = 102; processName = 'synthetic-leaf' }
        [pscustomobject]@{ processId = 203; parentProcessId = 202; processName = 'unrelated-leaf' }
        [pscustomobject]@{ processId = 102; parentProcessId = 101; processName = 'synthetic-helper' }
        [pscustomobject]@{ processId = 202; parentProcessId = 201; processName = 'unrelated-helper' }
    )
    $descendants = @(Get-AuditedDescendantStarts -Records $records -RootProcessId 101)
    $observedIds = @($descendants | ForEach-Object { $_.processId } | Sort-Object)
    if (($observedIds -join ',') -cne '102,103') {
        Fail-Qualification 'The synthetic ancestry control did not retain the reversed chain and exclude the unrelated chain.'
    }
    return [pscustomobject]@{
        classification = 'synthetic-ancestry-regression'
        recordOrder = 'leaf-before-helper'
        unrelatedChainExcluded = $true
        verdict = 'pass'
    }
}

function Stop-ProcessStartAudit {
    param([Parameter(Mandatory)]$Audit)

    foreach ($auditEvent in @(Get-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue)) {
        Remove-Event -EventIdentifier $auditEvent.EventIdentifier
    }
    Unregister-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue
}

function Invoke-DelayedDescendantProbe {
    param(
        [Parameter(Mandatory)][string]$SentinelPath,
        [Parameter(Mandatory)][string]$DiagnosticPath
    )

    $delayMilliseconds = 2500
    $timeoutMilliseconds = 10000
    $eventPrefix = 'Local\NemoClawDelayedChild-' + [guid]::NewGuid().ToString('N')
    $ready = $null
    $go = $null
    $helper = $null
    $audit = $null
    $result = $null
    $records = @()
    $probe = $null
    $releasedAt = 0L
    $registrationStartedAt = 0L
    $registrationCompletedAt = 0L
    $helperStartedAt = 0L
    $helperReadyAt = 0L
    $helperProcessId = $null
    $collectionCompletedMilliseconds = $null
    $launchStartedMilliseconds = $null
    $launchCompletedMilliseconds = $null
    $failureMessage = $null
    $cleanupComplete = $false
    $ancestryControl = $null
    # The handshake excludes PowerShell startup from the calibrated drain window.
    $command = @'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ready = [Threading.EventWaitHandle]::OpenExisting('__READY_EVENT__')
$go = [Threading.EventWaitHandle]::OpenExisting('__GO_EVENT__')
$child = $null
try {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $startInfo.Arguments = '/d /c echo delayed-child-executed'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $ready.Set() | Out-Null
    if (-not $go.WaitOne(10000)) { throw 'Delayed child was not released.' }
    $delayClock = [Diagnostics.Stopwatch]::StartNew()
    [Threading.Thread]::Sleep(__DELAY_MILLISECONDS__)
    while ($delayClock.ElapsedMilliseconds -lt __DELAY_MILLISECONDS__) {
        [Threading.Thread]::Sleep(1)
    }
    $delayClock.Stop()
    $launchStarted = [Diagnostics.Stopwatch]::GetTimestamp()
    $child = [Diagnostics.Process]::Start($startInfo)
    $launchCompleted = [Diagnostics.Stopwatch]::GetTimestamp()
    if (-not $child.WaitForExit(5000)) { throw 'Delayed child did not exit.' }
    $output = $child.StandardOutput.ReadToEnd()
    if ($output.Length -gt 64) { throw 'Delayed child output exceeded its bound.' }
    $receipt = [pscustomobject]@{
        parentProcessId = $PID
        processId = $child.Id
        exitCode = $child.ExitCode
        launchStarted = $launchStarted
        launchCompleted = $launchCompleted
        output = $output.Trim()
    }
    [IO.File]::WriteAllText('__SENTINEL_PATH__', ($receipt | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
} finally {
    if ($child) {
        try {
            if (-not $child.HasExited) {
                $child.Kill()
                if (-not $child.WaitForExit(5000)) { throw 'Delayed child cleanup did not complete.' }
            }
        } finally { $child.Dispose() }
    }
    $go.Dispose()
    $ready.Dispose()
}
'@
    $command = $command.Replace('__READY_EVENT__', "$eventPrefix-ready")
    $command = $command.Replace('__GO_EVENT__', "$eventPrefix-go")
    $command = $command.Replace('__SENTINEL_PATH__', $SentinelPath.Replace("'", "''"))
    $command = $command.Replace('__DELAY_MILLISECONDS__', [string]$delayMilliseconds)
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    try {
        $ancestryControl = Assert-ProcessAuditAncestryControl
        $ready = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, "$eventPrefix-ready")
        $go = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, "$eventPrefix-go")
        $registrationStartedAt = [Diagnostics.Stopwatch]::GetTimestamp()
        $audit = Start-ProcessStartAudit
        $registrationCompletedAt = [Diagnostics.Stopwatch]::GetTimestamp()
        $helperStartedAt = [Diagnostics.Stopwatch]::GetTimestamp()
        $helper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
            -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand) `
            -PassThru -ErrorAction Stop
        $helperProcessId = $helper.Id
        $null = $helper.Handle
        if (-not $ready.WaitOne($timeoutMilliseconds)) {
            Fail-Qualification 'The delayed descendant helper did not become ready.'
        }
        $helperReadyAt = [Diagnostics.Stopwatch]::GetTimestamp()
        $releasedAt = [Diagnostics.Stopwatch]::GetTimestamp()
        $go.Set() | Out-Null
        $records = @(Receive-ProcessStartAudit -Audit $audit `
            -SettleMilliseconds $script:ProcessAuditSettleMilliseconds -StartedAt $releasedAt)
        $collectionCompletedMilliseconds = 1000.0 * ([Diagnostics.Stopwatch]::GetTimestamp() - $releasedAt) / [Diagnostics.Stopwatch]::Frequency
        if (-not $helper.WaitForExit($timeoutMilliseconds) -or $helper.ExitCode -ne 0) {
            Fail-Qualification 'The delayed descendant helper did not complete successfully.'
        }
        Assert-BoundedFile -Path $SentinelPath -MaximumBytes 1024
        $probe = Get-Content -LiteralPath $SentinelPath -Raw | ConvertFrom-Json
        $launchStartedMilliseconds = 1000.0 * ([long]$probe.launchStarted - $releasedAt) / [Diagnostics.Stopwatch]::Frequency
        $launchCompletedMilliseconds = 1000.0 * ([long]$probe.launchCompleted - $releasedAt) / [Diagnostics.Stopwatch]::Frequency
        if ($launchStartedMilliseconds -lt $delayMilliseconds -or
            $launchCompletedMilliseconds -lt $launchStartedMilliseconds -or
            $launchCompletedMilliseconds -ge $script:ProcessAuditSettleMilliseconds) {
            Fail-Qualification 'The delayed descendant did not start inside the calibrated 2500-3000 ms window.'
        }
        if ($probe.parentProcessId -ne $helper.Id -or $probe.exitCode -ne 0 -or
            $probe.output -cne 'delayed-child-executed') {
            Fail-Qualification 'The delayed descendant did not produce its bounded control side effect.'
        }
        $inWindowRecords = @($records | Where-Object { $_.observedWithinWindow })
        $descendants = @(Get-AuditedDescendantStarts -Records $inWindowRecords -RootProcessId $PID)
        $helperStarts = @($descendants | Where-Object {
            $_.processId -eq $helper.Id -and $_.parentProcessId -eq $PID
        })
        $childStarts = @($descendants | Where-Object {
            $_.processId -eq $probe.processId -and $_.parentProcessId -eq $helper.Id -and
                $_.processName -ieq 'cmd.exe'
        })
        if ($helperStarts.Count -ne 1 -or $childStarts.Count -ne 1) {
            Fail-Qualification "The calibrated Windows process-start audit missed its delayed descendant (helper=$($helperStarts.Count), child=$($childStarts.Count))."
        }
        $result = [pscustomobject]@{
            delayMilliseconds = $delayMilliseconds
            settleMilliseconds = $script:ProcessAuditSettleMilliseconds
            launchStartedMilliseconds = $launchStartedMilliseconds
            launchCompletedMilliseconds = $launchCompletedMilliseconds
            helperProcessId = $helper.Id
            processId = [int]$probe.processId
            exitCode = [int]$probe.exitCode
            sideEffectObserved = $true
            auditedDescendantStarts = $descendants
        }
    } catch {
        $failureMessage = $_.Exception.Message
        throw
    } finally {
        try {
            try {
                if ($helper) {
                    try {
                        if (-not $helper.HasExited) {
                            $helper.Kill()
                            if (-not $helper.WaitForExit(5000)) {
                                Fail-Qualification 'The delayed descendant helper cleanup did not complete.'
                            }
                        }
                    } finally { $helper.Dispose() }
                }
            } finally {
                if ($go) { $go.Dispose() }
                if ($ready) { $ready.Dispose() }
                if ($audit) {
                    try {
                        if ($releasedAt -gt 0) {
                            # This immediate diagnostic drain cannot satisfy the earlier assertion.
                            $records += @(Receive-ProcessStartAudit -Audit $audit -DrainOnly `
                                -SettleMilliseconds $script:ProcessAuditSettleMilliseconds -StartedAt $releasedAt)
                        }
                    } finally {
                        Stop-ProcessStartAudit -Audit $audit
                        if (@(Get-EventSubscriber -SourceIdentifier $audit.sourceIdentifier -ErrorAction SilentlyContinue).Count -ne 0 -or
                            @(Get-Event -SourceIdentifier $audit.sourceIdentifier -ErrorAction SilentlyContinue).Count -ne 0) {
                            Fail-Qualification 'The delayed descendant process-start audit cleanup did not complete.'
                        }
                    }
                }
                if (Test-Path -LiteralPath $SentinelPath -PathType Leaf) {
                    [IO.File]::Delete($SentinelPath)
                }
            }
            $cleanupComplete = $true
        } finally {
            $childProcessId = if ($probe) { [int]$probe.processId } else { $null }
            $helperEvents = @($records | Where-Object {
                $_.processId -eq $helperProcessId -and $_.parentProcessId -eq $PID
            })
            $childEvents = @($records | Where-Object {
                $_.processId -eq $childProcessId -and $_.parentProcessId -eq $helperProcessId
            })
            $diagnostic = [pscustomobject]@{
                receiptVersion = 1
                classification = 'qualification-only-process-audit-control'
                candidateSha = $CandidateSha
                syntheticAncestryControl = $ancestryControl
                verdict = if ($result -and $cleanupComplete) { 'pass' } else { 'fail' }
                failure = $failureMessage
                rootProcessId = $PID
                helperProcessId = $helperProcessId
                childProcessId = $childProcessId
                delayMilliseconds = $delayMilliseconds
                settleMilliseconds = $script:ProcessAuditSettleMilliseconds
                stopwatchFrequency = [Diagnostics.Stopwatch]::Frequency
                registrationStartedAtTicks = $registrationStartedAt
                registrationCompletedAtTicks = $registrationCompletedAt
                helperLaunchStartedAtTicks = $helperStartedAt
                helperReadyAtTicks = $helperReadyAt
                observationStartedAtTicks = $releasedAt
                collectionCompletedMilliseconds = $collectionCompletedMilliseconds
                launchStartedMilliseconds = $launchStartedMilliseconds
                launchCompletedMilliseconds = $launchCompletedMilliseconds
                sideEffect = $probe
                helperEventCount = $helperEvents.Count
                childEventCount = $childEvents.Count
                inWindowHelperEventCount = @($helperEvents | Where-Object { $_.observedWithinWindow }).Count
                inWindowChildEventCount = @($childEvents | Where-Object { $_.observedWithinWindow }).Count
                helperEvents = @($helperEvents | Select-Object -First 8)
                childEvents = @($childEvents | Select-Object -First 8)
                rawEventCount = $records.Count
                rawEventsTruncated = $records.Count -gt 64
                rawEvents = @($records | Select-Object -First 64)
                cleanupComplete = $cleanupComplete
            }
            Write-JsonFile -Path $DiagnosticPath -Value $diagnostic
            Assert-BoundedFile -Path $DiagnosticPath -MaximumBytes 65536
            if ($diagnostic.verdict -ne 'pass') {
                Write-Host ('Windows process-audit diagnostic: ' + ($diagnostic | ConvertTo-Json -Depth 12 -Compress))
            }
        }
    }
    $result | Add-Member -NotePropertyName cleanupComplete -NotePropertyValue $true
    return $result
}

function Get-ProhibitedProcessSnapshot {
    param([Parameter(Mandatory)][string]$Phase)

    $prohibited = @('bash', 'docker', 'dockerd', 'wsl')
    $found = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $name = $_.ProcessName.ToLowerInvariant()
        $prohibited -ccontains $name -or $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    })
    return [pscustomobject]@{
        phase = $Phase
        processes = @($found | ForEach-Object {
            [pscustomobject]@{
                processId = $_.Id
                processName = $_.ProcessName
            }
        } | Sort-Object processId)
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $text = ($Value | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Assert-BoundedFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][long]$MaximumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -gt $MaximumBytes) {
        Fail-Qualification "Qualification receipt exceeds its size limit: $(Split-Path -Leaf $Path)"
    }
}

function Assert-Arm64PortableExecutable {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            Fail-Qualification "$Label is not a Windows PE executable."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            Fail-Qualification "$Label has an invalid PE header offset."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            Fail-Qualification "$Label has an invalid PE signature."
        }
        if ($reader.ReadUInt16() -ne 0xAA64) {
            Fail-Qualification "$Label is not an ARM64 Windows executable."
        }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Invoke-NativeVersionProbe {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $Path -Label $Label
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Path
    $startInfo.Arguments = '--version'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            Fail-Qualification "$Label could not start its native --version probe."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($script:NativeProbeTimeoutMilliseconds)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-Qualification "$Label exceeded the native --version timeout."
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $outputText = (@($stdout.Trim(), $stderr.Trim()) | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        }) -join [Environment]::NewLine
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($outputText) -or $outputText.Length -gt 4096) {
        Fail-Qualification "$Label did not complete a bounded native --version probe."
    }
    return [pscustomobject]@{
        file = Split-Path -Leaf $Path
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        exitCode = $exitCode
        output = $outputText
    }
}

function Resolve-ReceiptVersionRoot {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][string]$ExpectedRoot,
        [Parameter(Mandatory)][string]$Phase
    )

    if ($Receipt.versionRoot -isnot [string] -or [string]::IsNullOrWhiteSpace($Receipt.versionRoot)) {
        Fail-Qualification "$Phase receipt has no version root."
    }
    $resolved = [IO.Path]::GetFullPath([string]$Receipt.versionRoot).TrimEnd('\')
    if ($resolved -cne $ExpectedRoot) {
        Fail-Qualification "$Phase receipt version root does not match the independently derived install root."
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-Qualification "$Phase receipt version root is missing."
    }
    Assert-NoReparsePath -Path $resolved -Label "$Phase receipt version root"
    return $resolved
}

function Assert-InstalledDistribution {
    param(
        [Parameter(Mandatory)][string]$VersionRoot,
        [Parameter(Mandatory)][Array]$Entries,
        [Parameter(Mandatory)][string]$Phase
    )

    $VersionRoot = [IO.Path]::GetFullPath($VersionRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $VersionRoot -PathType Container)) {
        Fail-Qualification "$Phase distribution root is missing."
    }
    Assert-NoReparsePath -Path $VersionRoot -Label "$Phase distribution root"
    $expectedFiles = @($Entries | ForEach-Object { $_.destination.ToLowerInvariant() } | Sort-Object)
    $expectedDirectories = @()
    foreach ($entry in $Entries) {
        $segments = @($entry.destination.Split('\'))
        for ($index = 1; $index -lt $segments.Count; $index++) {
            $expectedDirectories += ($segments[0..($index - 1)] -join '\').ToLowerInvariant()
        }
        $target = Join-Path $VersionRoot $entry.destination
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
            Fail-Qualification "$Phase distribution file is missing or has the wrong digest: $($entry.destination)"
        }
    }
    $observed = @(Get-ChildItem -LiteralPath $VersionRoot -Recurse -Force)
    foreach ($item in $observed) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Qualification "$Phase distribution contains a reparse point."
        }
    }
    $observedFiles = @($observed | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($VersionRoot.Length + 1).ToLowerInvariant()
    } | Sort-Object)
    $observedDirectories = @($observed | Where-Object { $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($VersionRoot.Length + 1).ToLowerInvariant()
    } | Sort-Object -Unique)
    $expectedDirectories = @($expectedDirectories | Sort-Object -Unique)
    if (@(Compare-Object $expectedFiles $observedFiles).Count -ne 0 -or
        @(Compare-Object $expectedDirectories $observedDirectories).Count -ne 0) {
        Fail-Qualification "$Phase distribution contains an unexpected file or directory."
    }
}

if ($CandidateSha -cnotmatch $script:ShaPattern) {
    Fail-Qualification 'Candidate revision must be a lowercase 40-character commit SHA.'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'Arm64') {
    Fail-Qualification 'Windows native installer qualification requires a native ARM64 runner.'
}

$candidateCheckoutParameters = @{
    Root = $CandidateCheckout
    ExpectedRevision = $CandidateSha
    ExpectedRepository = $script:CanonicalNemoClawRepository
    Label = 'Candidate checkout'
}
$candidateRoot = Assert-Checkout @candidateCheckoutParameters
$committedHarnessParameters = @{
    Checkout = $candidateRoot
    Revision = $CandidateSha
    RelativePath = 'scripts/checks/run-windows-native-installer-qualification.ps1'
    FilePath = $PSCommandPath
}
Assert-CommittedFile @committedHarnessParameters

$artifactPath = [IO.Path]::GetFullPath($ArtifactDirectory).TrimEnd('\')
$artifactParent = Split-Path -Parent $artifactPath
$artifactName = Split-Path -Leaf $artifactPath
if (-not (Test-Path -LiteralPath $artifactParent -PathType Container) -or
    (Test-Path -LiteralPath $artifactPath) -or $artifactName -cnotmatch '^[A-Za-z0-9._-]+$') {
    Fail-Qualification 'ArtifactDirectory must be a new child of an existing directory.'
}

if ($ProcessAuditControlOnly) {
    $controlRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-process-audit-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($controlRoot) | Out-Null
    [IO.Directory]::CreateDirectory($artifactPath) | Out-Null
    try {
        $control = Invoke-DelayedDescendantProbe `
            -SentinelPath (Join-Path $controlRoot 'delayed-child.json') `
            -DiagnosticPath (Join-Path $artifactPath 'process-audit-control.json')
        Write-Host "Windows process-audit control passed: child launch completed after $($control.launchCompletedMilliseconds) ms."
    } finally {
        if (Test-Path -LiteralPath $controlRoot -PathType Container) {
            [IO.Directory]::Delete($controlRoot, $true)
        }
    }
    return
}

if ($OpenShellSha -cnotmatch $script:ShaPattern -or $OpenShellSha -cne $script:TrustedOpenShellRevision) {
    Fail-Qualification 'OpenShell revision must match NVIDIA/OpenShell#2721 merge commit.'
}
$openShellCheckoutParameters = @{
    Root = $OpenShellCheckout
    ExpectedRevision = $OpenShellSha
    ExpectedRepository = $script:CanonicalOpenShellRepository
    Label = 'OpenShell checkout'
}
$openShellRoot = Assert-Checkout @openShellCheckoutParameters
$installerSource = Join-Path $candidateRoot 'scripts\install-windows-native.ps1'
$committedInstallerParameters = @{
    Checkout = $candidateRoot
    Revision = $CandidateSha
    RelativePath = 'scripts/install-windows-native.ps1'
    FilePath = $installerSource
}
Assert-CommittedFile @committedInstallerParameters

$qualificationRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-windows-native-' + [guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $qualificationRoot 'payload'
$installRoot = Join-Path $qualificationRoot 'install'
$receiptStage = Join-Path $artifactParent ('.' + $artifactName + '.' + [guid]::NewGuid().ToString('N'))
$processAudit = $null
$installerDescendantStarts = @()
$childProbeControl = $null
$delayedChildProbeControl = $null
$controlDescendantStarts = @()
$nativeBinaryEvidence = $null
$hostPlatformEvidence = [pscustomobject]@{
    receiptVersion = 1
    osDescription = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    osVersion = [Environment]::OSVersion.Version.ToString()
    osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    runnerName = $env:RUNNER_NAME
    runnerArchitecture = $env:RUNNER_ARCH
}
[IO.Directory]::CreateDirectory($payloadRoot) | Out-Null
[IO.Directory]::CreateDirectory($receiptStage) | Out-Null
$installer = Join-Path $qualificationRoot 'install-windows-native.ps1'
[IO.File]::Copy($installerSource, $installer, $false)
$installerItem = Get-Item -LiteralPath $installer -Force
$installerItem.IsReadOnly = $true
$validatedInstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()

try {
    $releaseRoot = Join-Path $openShellRoot 'target\aarch64-pc-windows-msvc\release'
    $distributionEntries = @()
    foreach ($fileName in @('openshell.exe', 'openshell-gateway.exe')) {
        $source = Join-Path $releaseRoot $fileName
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Fail-Qualification "NVIDIA/OpenShell#2721 build output is missing: $fileName"
        }
        $payloadRelative = "bin\$fileName"
        $payloadPath = Join-Path $payloadRoot $payloadRelative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $payloadPath)) | Out-Null
        [IO.File]::Copy($source, $payloadPath, $false)
        $distributionEntries += [pscustomobject]@{
            source = $payloadRelative
            destination = $payloadRelative
            sha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $z3Source = Join-Path $releaseRoot 'libz3.dll'
    if (Test-Path -LiteralPath $z3Source -PathType Leaf) {
        $z3Relative = 'bin\libz3.dll'
        [IO.File]::Copy($z3Source, (Join-Path $payloadRoot $z3Relative), $false)
        $distributionEntries += [pscustomobject]@{
            source = $z3Relative
            destination = $z3Relative
            sha256 = (Get-FileHash -LiteralPath (Join-Path $payloadRoot $z3Relative) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    $manifest = [pscustomobject]@{
        schemaVersion = 1
        classification = 'qualification-only'
        platform = 'windows'
        architecture = 'arm64'
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        files = @($distributionEntries)
    }
    $manifestPath = Join-Path $payloadRoot 'distribution-manifest.json'
    Write-JsonFile -Path $manifestPath -Value $manifest
    $expectedOpenShellEntry = @($distributionEntries | Where-Object {
        $_.destination -ceq 'bin\openshell.exe'
    })
    if ($expectedOpenShellEntry.Count -ne 1) {
        Fail-Qualification 'Qualification payload has no unique OpenShell CLI digest.'
    }
    $expectedOpenShellSha256 = $expectedOpenShellEntry[0].sha256
    $expectedVersionName = "openshell-pr$($script:TrustedOpenShellPullRequest)-$($script:TrustedOpenShellRevision.Substring(0, 12))-arm64"
    $expectedVersionRoot = [IO.Path]::GetFullPath(
        (Join-Path (Join-Path $installRoot 'versions') $expectedVersionName)
    ).TrimEnd('\')

    $nativeBinaryEvidence = @(
        Invoke-NativeVersionProbe -Path (Join-Path $payloadRoot 'bin\openshell.exe') -Label 'OpenShell CLI'
        Invoke-NativeVersionProbe -Path (Join-Path $payloadRoot 'bin\openshell-gateway.exe') -Label 'OpenShell gateway'
    )
    $delayedChildProbeControl = Invoke-DelayedDescendantProbe `
        -SentinelPath (Join-Path $qualificationRoot 'child-delayed-control.json') `
        -DiagnosticPath ($artifactPath + '.process-audit-control.json')
    $processAudit = Start-ProcessStartAudit
    $controlSentinel = Join-Path $qualificationRoot 'child-control.txt'
    $childProbeControl = Invoke-ChildSideEffectProbe -SentinelPath $controlSentinel
    if ($childProbeControl.startRejected -or $childProbeControl.exitCode -ne 0 -or
        -not $childProbeControl.sideEffectObserved) {
        Fail-Qualification 'The child side-effect control probe did not execute before installer qualification.'
    }
    $controlAuditRecords = @(
        Receive-ProcessStartAudit -Audit $processAudit -SettleMilliseconds $script:ProcessAuditSettleMilliseconds
    )
    $controlDescendantStarts = @(Get-AuditedDescendantStarts `
        -Records @($controlAuditRecords | Where-Object { $_.observedWithinWindow }) -RootProcessId $PID)
    if (@($controlDescendantStarts | Where-Object {
        $_.processId -eq $childProbeControl.processId
    }).Count -ne 1) {
        Fail-Qualification 'The calibrated Windows process-start audit did not observe its control child.'
    }
    [IO.File]::Delete($controlSentinel)

    $preExecution = Get-ProhibitedProcessSnapshot -Phase 'pre-execution'
    $volumeRootRejected = $false
    try {
        & $installer -Action Uninstall -InstallRoot ([IO.Path]::GetPathRoot($installRoot)) | Out-Null
    } catch {
        $volumeRootRejected = $_.Exception.Message -like '*InstallRoot must not be a drive root.*'
    }
    if (-not $volumeRootRejected) {
        Fail-Qualification 'Installer accepted a drive root as InstallRoot.'
    }
    $installParameters = @{
        Action = 'Install'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }
    & $installer @installParameters
    $installReceiptPath = Join-Path $installRoot 'install-receipt.json'
    if (-not (Test-Path -LiteralPath $installReceiptPath -PathType Leaf)) {
        Fail-Qualification 'Candidate installer did not publish an install receipt.'
    }
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'install-receipt.json'), $false)

    $installReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $initialVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $installReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Initial install'
    $initialDistributionParameters = @{
        VersionRoot = $initialVersionRoot
        Entries = $distributionEntries
        Phase = 'Initial install'
    }
    Assert-InstalledDistribution @initialDistributionParameters
    foreach ($installedExecutable in @('openshell.exe', 'openshell-gateway.exe')) {
        Assert-Arm64PortableExecutable `
            -Path (Join-Path $initialVersionRoot "bin\$installedExecutable") `
            -Label "Installed $installedExecutable"
    }
    $untrackedPath = Join-Path $initialVersionRoot 'bin\untracked-qualification.txt'
    [IO.File]::WriteAllText($untrackedPath, 'untracked', [Text.UTF8Encoding]::new($false))
    $untrackedInstallRejected = $false
    try {
        & $installer @installParameters | Out-Null
    } catch {
        $untrackedInstallRejected = $_.Exception.Message -like '*Existing candidate installation drifted; run Repair.*'
    }
    if (-not $untrackedInstallRejected) {
        Fail-Qualification 'Install accepted an untracked file inside the owned version root.'
    }
    $driftTarget = Join-Path $initialVersionRoot 'bin\openshell.exe'
    [IO.File]::AppendAllText($driftTarget, 'qualification-drift', [Text.UTF8Encoding]::new($false))
    $repairParameters = @{
        Action = 'Repair'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }

    $lockPath = Join-Path (Split-Path -Parent $installRoot) ('.' + (Split-Path -Leaf $installRoot) + '.native-installer.lock')
    $heldLock = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    $overlappingRepairRejected = $false
    try {
        try {
            & $installer @repairParameters | Out-Null
        } catch {
            $overlappingRepairRejected = $_.Exception.Message -like '*Another installer operation owns*'
        }
    } finally {
        $heldLock.Dispose()
        [IO.File]::Delete($lockPath)
    }
    if (-not $overlappingRepairRejected) {
        Fail-Qualification 'Installer lock allowed an overlapping repair operation.'
    }
    & $installer @repairParameters | Out-Null
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'repair-receipt.json'), $false)
    $repairedReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $repairedVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $repairedReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Repair'
    if ((Test-Path -LiteralPath $untrackedPath) -or
        (Get-FileHash -LiteralPath (Join-Path $repairedVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Repair did not restore the OpenShell CLI digest.'
    }
    Assert-InstalledDistribution -VersionRoot $repairedVersionRoot -Entries $distributionEntries -Phase 'Repair'

    $recoveryBackupRoot = Join-Path $installRoot ('.backup-' + [guid]::NewGuid().ToString('N'))
    $recoveryReplacementRoot = Join-Path $installRoot ('.replacement-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($repairedVersionRoot, $recoveryBackupRoot)
    [IO.Directory]::CreateDirectory($recoveryReplacementRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $recoveryReplacementRoot 'incomplete.txt'),
        'incomplete replacement',
        [Text.UTF8Encoding]::new($false)
    )
    $recoveryAuthorityPath = Join-Path $installRoot 'repair-recovery.json'
    Write-JsonFile -Path $recoveryAuthorityPath -Value ([pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        installRoot = $installRoot
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        action = 'restore-prior-version-and-remove-replacement'
        versionRoot = $repairedVersionRoot
        backupRoot = $recoveryBackupRoot
        failedReplacementRoot = $recoveryReplacementRoot
        operationError = 'qualification fixture'
        rollbackError = 'qualification fixture'
    })
    $recoverParameters = @{
        Action = 'Recover'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }
    & $installer @recoverParameters | Out-Null
    $recoveredReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $recoveredVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $recoveredReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Recover with replacement root'
    if ((Test-Path -LiteralPath $recoveryAuthorityPath) -or
        (Test-Path -LiteralPath $recoveryBackupRoot) -or
        (Test-Path -LiteralPath $recoveryReplacementRoot) -or
        (Get-FileHash -LiteralPath (Join-Path $recoveredVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Recover did not publish one clean pinned distribution.'
    }
    Assert-InstalledDistribution `
        -VersionRoot $recoveredVersionRoot `
        -Entries $distributionEntries `
        -Phase 'Recover with replacement root'

    $nullReplacementReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $nullReplacementVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $nullReplacementReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Pre-null recovery'
    $nullReplacementBackupRoot = Join-Path $installRoot ('.backup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($nullReplacementVersionRoot, $nullReplacementBackupRoot)
    Write-JsonFile -Path $recoveryAuthorityPath -Value ([pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        installRoot = $installRoot
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        action = 'restore-prior-version'
        versionRoot = $nullReplacementVersionRoot
        backupRoot = $nullReplacementBackupRoot
        failedReplacementRoot = $null
        operationError = 'qualification null-replacement fixture'
        rollbackError = 'qualification null-replacement fixture'
    })
    & $installer @recoverParameters | Out-Null
    $nullRecoveredReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $nullRecoveredVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $nullRecoveredReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Recover with null replacement root'
    if ((Test-Path -LiteralPath $recoveryAuthorityPath) -or
        (Test-Path -LiteralPath $nullReplacementBackupRoot) -or
        (Get-FileHash -LiteralPath (Join-Path $nullRecoveredVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Recover did not handle a null replacement root.'
    }
    Assert-InstalledDistribution `
        -VersionRoot $nullRecoveredVersionRoot `
        -Entries $distributionEntries `
        -Phase 'Recover with null replacement root'
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'recovery-receipt.json'), $false)

    & $installer -Action Uninstall -InstallRoot $installRoot
    if (Test-Path -LiteralPath $installRoot) {
        Fail-Qualification 'Uninstall did not prove final absence.'
    }
    $uninstallReceipt = [pscustomobject]@{
        receiptVersion = 1
        action = 'uninstall'
        classification = 'qualification-only'
        installRoot = $installRoot
        finalAbsence = $true
    }
    $postExecution = Get-ProhibitedProcessSnapshot -Phase 'post-execution'
    $baselineProcessIds = @($preExecution.processes | ForEach-Object { $_.processId })
    $newProhibitedProcesses = @($postExecution.processes | Where-Object {
        $baselineProcessIds -notcontains $_.processId
    })
    if ($newProhibitedProcesses.Count -ne 0) {
        $newNames = @($newProhibitedProcesses | ForEach-Object { $_.processName } | Sort-Object -Unique) -join ', '
        Fail-Qualification "A new prohibited WSL or Docker process appeared during installer qualification: $newNames"
    }
    $installerAuditRecords = @(
        Receive-ProcessStartAudit -Audit $processAudit -SettleMilliseconds $script:ProcessAuditSettleMilliseconds
    )
    $installerDescendantStarts = @(Get-AuditedDescendantStarts -Records $installerAuditRecords -RootProcessId $PID)
    if ($installerDescendantStarts.Count -ne 0) {
        $startedNames = @($installerDescendantStarts | ForEach-Object { $_.processName } | Sort-Object -Unique) -join ', '
        Fail-Qualification "The file-only installer started a descendant process: $startedNames"
    }

    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $validatedInstallerSha256) {
        Fail-Qualification 'The staged installer bytes changed during qualification.'
    }
    [IO.File]::Copy($installer, (Join-Path $receiptStage 'install-windows-native.ps1'), $false)
    [IO.File]::Copy($manifestPath, (Join-Path $receiptStage 'distribution-manifest.json'), $false)
    Write-JsonFile -Path (Join-Path $receiptStage 'candidate-source.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        repository = $script:CanonicalNemoClawRepository
        revision = $CandidateSha
        installerSha256 = $validatedInstallerSha256
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'openshell-source.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        repository = $script:CanonicalOpenShellRepository
        pullRequest = $script:TrustedOpenShellPullRequest
        revision = $OpenShellSha
        architecture = 'arm64'
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'process-absence.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        calibratedChildProbe = $childProbeControl
        calibratedDescendantStarts = $controlDescendantStarts
        delayedChildProbe = $delayedChildProbeControl
        installerDescendantStarts = $installerDescendantStarts
        newProhibitedProcesses = $newProhibitedProcesses
        preExecution = $preExecution
        postExecution = $postExecution
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'host-platform.json') -Value $hostPlatformEvidence
    Write-JsonFile -Path (Join-Path $receiptStage 'native-binary-smoke.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        executions = $nativeBinaryEvidence
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'uninstall-receipt.json') -Value $uninstallReceipt

    Assert-BoundedFile -Path (Join-Path $receiptStage 'install-windows-native.ps1') -MaximumBytes $script:MaxInstallerBytes
    foreach ($jsonReceipt in @(Get-ChildItem -LiteralPath $receiptStage -Filter '*.json')) {
        Assert-BoundedFile -Path $jsonReceipt.FullName -MaximumBytes $script:MaxJsonBytes
    }
    [IO.Directory]::Move($receiptStage, $artifactPath)
    $receiptStage = $null
    Write-Host "Windows native installer qualification receipts: $artifactPath"
} finally {
    if ($processAudit) {
        Stop-ProcessStartAudit -Audit $processAudit
    }
    if ($receiptStage -and (Test-Path -LiteralPath $receiptStage -PathType Container)) {
        [IO.Directory]::Delete($receiptStage, $true)
    }
    if (Test-Path -LiteralPath $installer -PathType Leaf) {
        (Get-Item -LiteralPath $installer -Force).IsReadOnly = $false
    }
    if (Test-Path -LiteralPath $qualificationRoot -PathType Container) {
        [IO.Directory]::Delete($qualificationRoot, $true)
    }
}
