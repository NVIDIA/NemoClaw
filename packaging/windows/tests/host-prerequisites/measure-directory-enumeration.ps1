# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

param([Parameter(Mandatory)][string]$ArtifactDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true') { throw 'This measurement requires the disposable Windows runner.' }
$artifact = [IO.Path]::GetFullPath($ArtifactDirectory)
$temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $artifact.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase) -or [IO.Directory]::Exists($artifact) -or [IO.File]::Exists($artifact)) {
    throw 'The measurement requires a fresh runner-owned artifact directory.'
}
[IO.Directory]::CreateDirectory($artifact) | Out-Null
$system32 = Join-Path $env:SystemRoot 'System32'
$logman = Join-Path $system32 'logman.exe'
$tracerpt = Join-Path $system32 'tracerpt.exe'
$trace = Join-Path $artifact 'file-operations.etl'
$measurement = Join-Path $artifact 'measurement'
$session = 'NemoClawAcl-' + [guid]::NewGuid().ToString('N')
$providerName = 'Microsoft-Windows-Kernel-File'
$commands = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$primary = $null; $process = $null; $captureAttempted = $false; $captureStarted = $false; $captureStopped = $false
$decoder = $null; $childStopped = $false; $providerMetadata = $null
$stderrTask = $null; $ownedProcessId = $null

function Invoke-CaptureCommand {
    param([string]$Path, [string[]]$Arguments, [string]$Name)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Path
    foreach ($value in $Arguments) { if ($value -match '["\r\n]') { throw 'An owned capture argument cannot be quoted safely.' } }
    $start.Arguments = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $row = [pscustomobject]@{ name = $Name; executable = $Path; arguments = $Arguments
        processId = $null; exitCode = $null; timedOut = $false; stopped = $false; stdout = ''; stderr = ''; error = $null }
    $commands.Add($row)
    $command = $null; $failure = $null
    try {
        $command = [Diagnostics.Process]::Start($start); $row.processId = $command.Id
        $stdout = $command.StandardOutput.ReadToEndAsync(); $stderr = $command.StandardError.ReadToEndAsync()
        if (-not $command.WaitForExit(20000)) { $row.timedOut = $true; throw 'A bounded capture command timed out.' }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { throw 'Capture command output did not close.' }
        $row.exitCode = $command.ExitCode
        $row.stdout = $stdout.GetAwaiter().GetResult(); $row.stderr = $stderr.GetAwaiter().GetResult()
        if ($row.exitCode -ne 0) { throw ('Capture command failed: ' + $Name) }
    } catch { $failure = $_; $row.error = $_.Exception.Message }
    finally {
        if ($null -ne $command) {
            try {
                if (-not $command.HasExited) { $command.Kill(); if (-not $command.WaitForExit(5000)) { throw 'The owned capture command did not stop.' } }
                $row.stopped = $true
                $row.exitCode = $command.ExitCode
                if ($stdout.Wait(1000)) { $row.stdout = $stdout.GetAwaiter().GetResult() }
                if ($stderr.Wait(1000)) { $row.stderr = $stderr.GetAwaiter().GetResult() }
            } catch { $cleanupErrors.Add($Name + ': ' + $_.Exception.Message); if ($null -eq $failure) { $failure = $_ } }
            finally { try { $command.Dispose() } catch { $cleanupErrors.Add($_.Exception.Message); if ($null -eq $failure) { $failure = $_ } } }
        }
    }
    if ($null -ne $failure) { throw $failure }
}

function Read-CaptureLine {
    $line = $process.StandardOutput.ReadLineAsync()
    if (-not $line.Wait(30000)) { throw 'The owned measurement did not reach its bounded capture boundary.' }
    $value = $line.GetAwaiter().GetResult()
    if ($null -eq $value) { throw 'The owned measurement exited before its capture boundary.' }
    return $value
}

try {
    # Resolve the keyword from this OS's registered manifest; do not guess an
    # event mask from a different Windows build. No broad WPR profile is used.
    $provider = Get-WinEvent -ListProvider $providerName
    if ($provider.Id.ToString() -cne 'edd08927-9cc4-4e65-b970-c2560fb5c289') { throw 'Unexpected kernel file provider identity.' }
    $keywords = @($provider.Keywords | Where-Object { $_.Name -ceq 'KERNEL_FILE_KEYWORD_FILEIO' })
    if ($keywords.Count -ne 1) { throw 'The registered file-I/O keyword was not found exactly once.' }
    $keyword = '0x' + ([ulong]$keywords[0].Value).ToString('x')
    $providerMetadata = [pscustomobject]@{ name = $provider.Name; id = $provider.Id.ToString(); keyword = $keyword
        keywords = @($provider.Keywords | ForEach-Object { [pscustomobject]@{ name = $_.Name; value = $_.Value } }) }
    $dotnet = @(Get-Command dotnet -CommandType Application)[0].Source
    $dll = Join-Path $PSScriptRoot 'bin\Release\net8.0\HandleAcl.Controls.dll'
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $dotnet
    $start.Arguments = '"' + $dll + '" --measure-large-tree "' + $measurement + '"'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::Start($start)
    $ownedProcessId = $process.Id
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $ready = Read-CaptureLine | ConvertFrom-Json
    if ($ready.phase -cne 'ready' -or $ready.processId -ne $process.Id -or $ready.entryCount -ne 2080) { throw 'The capture boundary did not identify the actual owned process/tree.' }
    $captureAttempted = $true
    Invoke-CaptureCommand -Path $logman -Name 'start-exact-file-provider' -Arguments @('create','trace',$session,'-o',$trace,'-f','bincirc','-max','32','-bs','64','-nb','16','64','-p',$provider.Id.ToString(),$keyword,'5','-ets')
    $captureStarted = $true
    $process.StandardInput.WriteLine('capture-ready'); $process.StandardInput.Flush()
    if ((Read-CaptureLine) -cne 'capture-complete') { throw 'The measurement did not finish the expected API intervals.' }
    Invoke-CaptureCommand -Path $logman -Name 'stop-owned-file-provider' -Arguments @('stop',$session,'-ets')
    $captureStopped = $true
    $process.StandardInput.WriteLine('capture-stopped'); $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { throw 'The owned descriptor readback/cleanup did not finish.' }
    $childStopped = $true
    if (-not $stderrTask.Wait(1000)) { throw 'The measurement stderr pipe did not close.' }
    [IO.File]::WriteAllText((Join-Path $artifact 'measurement.stderr.log'), $stderrTask.GetAwaiter().GetResult())
    if ($process.ExitCode -ne 0) { throw 'The intended metadata operation or fixture cleanup failed.' }
    # Preserve native decoding/loss summary. Absence of an event is not admitted
    # as proof of no traversal until this trace's completeness is reviewed.
    Invoke-CaptureCommand -Path $tracerpt -Name 'decode-and-summarize' -Arguments @($trace,'-o',(Join-Path $artifact 'file-events.xml'),'-of','XML','-summary',(Join-Path $artifact 'trace-summary.txt'),'-y')
    $bounds = Get-Content -LiteralPath (Join-Path $measurement 'measurement-intervals.json') -Raw | ConvertFrom-Json
    $counts = @{}; foreach ($interval in $bounds.intervals) { $counts[$interval.name] = 0 }
    $eventCount = 0
    $matched = [Collections.Generic.List[object]]::new()
    Get-WinEvent -Path $trace -Oldest | ForEach-Object {
        $eventCount++
        if ($eventCount -gt 100000) { throw 'The bounded trace event count was exceeded.' }
        if ($_.ProviderName -ceq $providerName -and $_.Id -eq 20) {
            $record = $_; $xml = [xml]$record.ToXml(); $payload = @{}
            foreach ($item in $xml.Event.EventData.Data) { $payload[[string]$item.Name] = [string]$item.'#text' }
            $issuingThread = 0L
            foreach ($name in @('IssuingThreadId','ThreadId')) {
                if ($payload.ContainsKey($name)) {
                    $text = $payload[$name]
                    if ($text.StartsWith('0x')) { $issuingThread = [Convert]::ToInt64($text.Substring(2),16) }
                    else { $issuingThread = [Convert]::ToInt64($text,10) }
                }
            }
            if ($record.ProcessId -eq $bounds.processId -or $issuingThread -eq $bounds.threadId) {
                $time = $record.TimeCreated.ToUniversalTime()
                foreach ($interval in $bounds.intervals) {
                    if ($time -ge [DateTime]::Parse($interval.beginUtc).ToUniversalTime() -and $time -le [DateTime]::Parse($interval.endUtc).ToUniversalTime()) {
                        $counts[$interval.name]++
                        if ($matched.Count -ge 10000) { throw 'The bounded matching-event inventory was exceeded.' }
                        $matched.Add([pscustomobject]@{ interval = $interval.name; utc = $time.ToString('O'); processId = $record.ProcessId
                            threadId = $record.ThreadId; issuingThreadId = $issuingThread; eventId = $record.Id; data = $payload })
                    }
                }
            }
        }
    }
    $decoder = [pscustomobject]@{ totalEvents = $eventCount; directoryEnumerationCounts = $counts; matchedEvents = @($matched.ToArray())
        positiveControlObserved = $counts['explicit-enumeration-control'] -gt 0; noTraversalProven = $false; traceLossReviewComplete = $false }
    if (-not $decoder.positiveControlObserved) { throw 'The capture did not observe the explicit enumeration positive control.' }
} catch { $primary = $_ }
finally {
    if ($captureAttempted -and -not $captureStopped) {
        try { Invoke-CaptureCommand -Path $logman -Name 'cleanup-owned-file-provider' -Arguments @('stop',$session,'-ets'); $captureStopped = $true }
        catch { $cleanupErrors.Add($_.Exception.Message) }
    }
    if ($null -ne $process) {
        try {
            if (-not $process.HasExited) {
                try { $process.StandardInput.Close() } catch { $cleanupErrors.Add($_.Exception.Message) }
                if (-not $process.WaitForExit(5000)) { $process.Kill(); $null = $process.WaitForExit(5000) }
            }
            $childStopped = $process.HasExited
        }
        catch { $cleanupErrors.Add($_.Exception.Message) }
        finally {
            try {
                if ($null -ne $stderrTask -and $stderrTask.Wait(1000)) {
                    [IO.File]::WriteAllText((Join-Path $artifact 'measurement.stderr.log'), $stderrTask.GetAwaiter().GetResult())
                }
            } catch { $cleanupErrors.Add($_.Exception.Message) }
            try { $process.Dispose() } catch { $cleanupErrors.Add($_.Exception.Message) }
        }
    }
    try { $fixtures = Join-Path $measurement 'fixtures'; if ([IO.Directory]::Exists($fixtures)) { [IO.Directory]::Delete($fixtures, $true) } }
    catch { $cleanupErrors.Add($_.Exception.Message) }
    $receipt = [ordered]@{ schemaVersion = 1; classification = 'bounded-owned-acl-file-trace'
        status = $(if ($null -eq $primary -and $cleanupErrors.Count -eq 0) { 'captured' } else { 'failed' })
        provider = $providerMetadata; session = $session; captureAttempted = $captureAttempted; captureStarted = $captureStarted; captureStopped = $captureStopped
        ownedProcessId = $ownedProcessId; childStopped = $childStopped; traceMaximumMiB = 32; commands = @($commands.ToArray()); decoder = $decoder
        cleanupErrors = @($cleanupErrors.ToArray()); error = $(if ($null -ne $primary) { $primary.Exception.Message } else { $null })
        noDirectoryTraversalProven = $false; systemDriveTouched = $false; productionActivated = $false }
    try { [IO.File]::WriteAllText((Join-Path $artifact 'trace-receipt.json'), (($receipt | ConvertTo-Json -Depth 16) + "`n"), [Text.UTF8Encoding]::new($false)) }
    catch { if ($null -eq $primary) { $primary = $_ } }
}
if ($null -ne $primary) { $PSCmdlet.ThrowTerminatingError($primary) }
if ($cleanupErrors.Count) { throw 'The bounded ACL capture did not finish cleanup.' }
