# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Fixture and configured-launch controls for the disposable preview migration job.
function New-MigrationHistoryFixture([string]$HomePath, [string]$Nonce, [string]$FixturePath) {
    if ($Nonce -cnotmatch '^[a-f0-9]{32}$' -or -not [IO.Path]::IsPathFullyQualified($HomePath)) { throw 'The migration history identity is invalid.' }
    $sessions=Join-Path $HomePath '.openclaw\agents\main\sessions'
    $archive=Join-Path ([IO.Path]::GetDirectoryName($sessions)) 'session-sqlite-import-archive'
    if ((Test-Path -LiteralPath $sessions) -or (Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $FixturePath)) { throw 'The migration history fixture must be fresh.' }
    $id='migration-'+$Nonce; $key='agent:main:'+$id
    $store=Join-Path $sessions 'sessions.json'; $transcript=Join-Path $sessions ($id+'.jsonl')
    $timestamp='2026-10-11T12:00:00.000Z'; $milliseconds=1791720000000L
    $events=@(
        @{type='session';version=3;id=$id;timestamp=$timestamp;cwd=$HomePath},
        @{type='message';id='user-1';parentId=$null;timestamp=$timestamp;message=@{role='user';content=@(@{type='text';text=('Retained migration user '+$Nonce)});timestamp=$milliseconds}},
        @{type='message';id='assistant-1';parentId='user-1';timestamp=$timestamp;message=@{role='assistant';content=@(@{type='text';text=('Retained migration assistant '+$Nonce)});api='openai-completions';provider='synthetic';model='synthetic';stopReason='stop';timestamp=$milliseconds;usage=@{input=0;output=0;cacheRead=0;cacheWrite=0;totalTokens=0;cost=@{input=0;output=0;cacheRead=0;cacheWrite=0;total=0}}}}
    )
    $entries=@{}; $entries[$key]=@{sessionId=$id;sessionFile=$transcript;updatedAt=$milliseconds}
    $fixture=[ordered]@{home=$HomePath;sessionId=$id;sessionKey=$key;store=$store;transcript=$transcript;
        storeText=($entries | ConvertTo-Json -Depth 8 -Compress);
        transcriptText=((@($events | ForEach-Object { $_ | ConvertTo-Json -Depth 8 -Compress }) -join "`n")+"`n")}
    [void][IO.Directory]::CreateDirectory($sessions)
    $encoding=[Text.UTF8Encoding]::new($false)
    foreach ($entry in @(@($transcript,$fixture.transcriptText),@($store,$fixture.storeText),@($FixturePath,($fixture | ConvertTo-Json -Depth 8 -Compress)))) {
        $stream=[IO.File]::Open($entry[0],[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=$encoding.GetBytes($entry[1]); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    }
    return $fixture
}

function Assert-MigrationHistoryPreserved($Fixture) {
    foreach ($entry in @(@($Fixture.store,$Fixture.storeText),@($Fixture.transcript,$Fixture.transcriptText))) {
        $file=Get-Item -LiteralPath $entry[0] -Force
        $expected=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($entry[1])))
        if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -cne $expected) { throw 'The retained OpenClaw history changed before migration.' }
    }
}

function New-MigrationOutputCapture([string]$Name, [IO.StreamReader]$Reader) {
    $capture=@{name=$Name;reader=$Reader;buffer=[char[]]::new(4096);text=[Text.StringBuilder]::new();done=$false;overflow=$false;failed=$false;pending=$null}
    $capture.pending=$Reader.ReadAsync($capture.buffer,0,$capture.buffer.Length)
    return $capture
}
function Update-MigrationOutputCapture($Capture) {
    # Limit work per poll so continuous output cannot hide the lifecycle deadline.
    for ($chunk=0; $chunk -lt 16 -and -not $Capture.done -and $Capture.pending.IsCompleted; $chunk++) {
        try {
            $count=$Capture.pending.GetAwaiter().GetResult()
            if ($count -eq 0) { $Capture.done=$true; break }
            if ($Capture.text.Length + $count -gt 1048576) { $Capture.overflow=$true }
            if (-not $Capture.overflow) { [void]$Capture.text.Append($Capture.buffer,0,$count) }
            $Capture.pending=$Capture.reader.ReadAsync($Capture.buffer,0,$Capture.buffer.Length)
        } catch { $Capture.failed=$true; $Capture.done=$true }
    }
}
function Wait-MigrationHistoryProcess($Process, [int]$Milliseconds, $Captures) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while (-not $Process.HasExited -and $clock.ElapsedMilliseconds -lt $Milliseconds) {
        foreach ($capture in $Captures) { Update-MigrationOutputCapture $capture }
        Start-Sleep -Milliseconds 50
    }
    return $Process.HasExited
}

function Invoke-MigrationHistorySession([string]$InstallRoot, [string]$RuntimeId, [string]$EvidenceRoot) {
    if ($RuntimeId -cnotmatch '^[a-f0-9]{64}$' -or (Test-Path -LiteralPath $EvidenceRoot)) { throw 'The migration launch identity or evidence path is invalid.' }
    [void][IO.Directory]::CreateDirectory($EvidenceRoot)
    $sentinel=Join-Path $EvidenceRoot ('observer-stop-'+[guid]::NewGuid().ToString('N')+[guid]::NewGuid().ToString('N')+'.sentinel')
    $sessionRoot=Join-Path $EvidenceRoot 'session'
    $launcher=Join-Path $InstallRoot 'bin\NemoClaw.exe'
    $info=New-PreviewProcess $launcher @('--configured','--agent','openclaw','--wait','--artifact-directory',$sessionRoot)
    $info.CreateNoWindow=$true; $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
    $guardian=[Diagnostics.Process]::Start($info); $script:MigrationSessionOpen=$true
    $captures=[Collections.Generic.List[object]]::new()
    $observer=$null; $records=[Collections.Generic.List[object]]::new()
    $ready=$false; $requested=$false; $invoked=$false; $closed=$false; $cleanupConfirmed=$false; $recordBytes=0
    $watch=[Diagnostics.Stopwatch]::StartNew(); $stopWatch=$null; $primary=$null; $cleanupErrors=@()
    try {
        $guardian.StandardInput.Close()
        $captures.Add((New-MigrationOutputCapture 'guardian.stdout.log' $guardian.StandardOutput))
        $captures.Add((New-MigrationOutputCapture 'guardian.stderr.log' $guardian.StandardError))
        $ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $observerInfo=New-PreviewProcess $ps @('-NoProfile','-File',(Join-Path $PSScriptRoot 'control-installed-openclaw.ps1'),'-RootProcessId',[string]$guardian.Id,'-InstallRoot',$InstallRoot)
        $observerInfo.CreateNoWindow=$true; $observerInfo.RedirectStandardOutput=$true; $observerInfo.RedirectStandardError=$true
        $observerInfo.Environment['RUNNER_TEMP']=$env:RUNNER_TEMP
        $observerInfo.Environment['NEMOCLAW_OBSERVER_CONTROLLER_PID']=[string]$PID
        $observerInfo.Environment['NEMOCLAW_OBSERVER_STOP_SENTINEL']=$sentinel
        $observer=[Diagnostics.Process]::Start($observerInfo)
        $captures.Add((New-MigrationOutputCapture 'observer.stderr.log' $observer.StandardError))
        $line=$observer.StandardOutput.ReadLineAsync()
        while ($true) {
            foreach ($capture in $captures) {
                Update-MigrationOutputCapture $capture
                if ($capture.overflow -or $capture.failed) { throw 'Migration process output failed or exceeded its bound.' }
            }
            if (-not $requested -and $watch.ElapsedMilliseconds -gt 180000) { throw 'The configured migration session did not become available.' }
            if ($requested -and $stopWatch.ElapsedMilliseconds -gt 130000) { throw 'The configured migration session did not finish Stop.' }
            if (-not $line.IsCompleted) { Start-Sleep -Milliseconds 100; continue }
            $text=$line.GetAwaiter().GetResult()
            if ($null -eq $text) { break }
            $recordBytes += [Text.Encoding]::UTF8.GetByteCount($text)
            if ($recordBytes -gt 262144) { throw 'The migration observer exceeded its output bound.' }
            $record=$text | ConvertFrom-Json
            $records.Add($record)
            switch -CaseSensitive ($record.kind) {
                'observation' {
                    $expectedHost=Join-Path $InstallRoot ('runtimes\'+$RuntimeId+'\app\NemoClaw.Runtime.exe')
                    if ($record.rootPid -ne $guardian.Id -or -not [string]::Equals($record.hostPath,$expectedHost,[StringComparison]::OrdinalIgnoreCase)) { throw 'The migration observer followed another installed runtime.' }
                    if ($record.openEnabled -eq $true -and $record.windowFound -eq $true -and -not $requested) {
                        $ready=$true
                        $handle=[IO.File]::Open($sentinel,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
                        $handle.Dispose(); $requested=$true; $stopWatch=[Diagnostics.Stopwatch]::StartNew()
                    }
                }
                'stop-invoked' { if (-not $requested) { throw 'Stop preceded its owned request.' }; $invoked=$true }
                'stop-snapshot' { if ($record.rootPid -ne $guardian.Id) { throw 'The Stop snapshot belongs to another session.' } }
                'closed' { if (-not $invoked -or $record.exitCode -ne 0) { throw 'The configured migration session failed to close normally.' }; $closed=$true }
                default { throw 'The migration observer returned an unknown record.' }
            }
            $line=$observer.StandardOutput.ReadLineAsync()
        }
        if (-not $observer.WaitForExit(5000) -or $observer.ExitCode -ne 0 -or
            -not $guardian.WaitForExit(5000) -or $guardian.ExitCode -ne 0 -or -not $ready -or -not $closed) { throw 'The configured migration launch or Stop failed.' }
        $receipts=@(Get-ChildItem -LiteralPath $sessionRoot -File | Where-Object Name -cmatch '^native-windows-web-ui-[a-f0-9]+\.json$')
        if ($receipts.Count -ne 1 -or $receipts[0].Length -gt 1048576) { throw 'The configured migration cleanup receipt is missing or ambiguous.' }
        $receipt=Get-Content -LiteralPath $receipts[0].FullName -Raw | ConvertFrom-Json
        if ($receipt.verdict -cne 'pass' -or $receipt.runtimeIdentity.runtimeId -cne $RuntimeId -or
            $receipt.runtimeIdentity.sourceRevision -cne $env:GITHUB_SHA -or $receipt.backend -cne 'process_container' -or
            $receipt.sandboxDeleted -ne $true -or $receipt.sandboxRegistryAbsent -ne $true -or
            $receipt.gatewayStopped -ne $true -or $receipt.qualificationRootsRemoved -ne $true) { throw 'The configured migration session did not confirm owned cleanup.' }
        $cleanupConfirmed=$true
    } catch { $primary=$_ }
    finally {
        # Request normal Stop on failure before terminating only this owned process tree.
        if (-not $guardian.HasExited -and $null -ne $observer -and -not $observer.HasExited) {
            try {
                if (-not $requested) {
                    $handle=[IO.File]::Open($sentinel,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
                    $handle.Dispose()
                }
                if (-not (Wait-MigrationHistoryProcess $guardian 130000 $captures)) { throw 'Normal failure cleanup did not finish.' }
            } catch { $cleanupErrors+=@($_.Exception.Message) }
        }
        if (-not $guardian.HasExited) {
            try { $guardian.Kill($true); if (-not $guardian.WaitForExit(5000)) { throw 'The owned migration guardian did not exit.' } }
            catch { $cleanupErrors+=@($_.Exception.Message) }
        }
        if ($guardian.HasExited -and $cleanupConfirmed) { $script:MigrationSessionOpen=$false }
        if ($null -ne $observer -and -not $observer.HasExited) {
            try { $observer.Kill($true); if (-not $observer.WaitForExit(5000)) { throw 'The owned migration observer did not exit.' } }
            catch { $cleanupErrors+=@($_.Exception.Message) }
        }
        $drain=[Diagnostics.Stopwatch]::StartNew()
        do {
            foreach ($capture in $captures) { Update-MigrationOutputCapture $capture }
            if (@($captures | Where-Object { -not $_.done }).Count -eq 0) { break }
            Start-Sleep -Milliseconds 50
        } while ($drain.ElapsedMilliseconds -lt 5000)
        foreach ($capture in $captures) {
            if (-not $capture.done -or $capture.overflow -or $capture.failed) { $cleanupErrors+=@('Migration process output is incomplete or exceeds its bound.') }
            [IO.File]::WriteAllText((Join-Path $EvidenceRoot $capture.name),$capture.text.ToString(),[Text.UTF8Encoding]::new($false))
        }
        $evidence=[ordered]@{ready=$ready;stopRequested=$requested;stopInvoked=$invoked;closed=$closed;records=@($records.ToArray());cleanupErrors=$cleanupErrors;passed=($null -eq $primary -and $cleanupErrors.Count -eq 0)}
        [IO.File]::WriteAllText((Join-Path $EvidenceRoot 'history-session.json'),($evidence | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
        if ($null -ne $observer) { $observer.Dispose() }
        $guardian.Dispose()
    }
    if ($null -ne $primary) { throw $primary }
    if ($cleanupErrors.Count) { throw 'The migration session cleanup failed.' }
}
