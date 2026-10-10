# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PlanPath,
    [Parameter(Mandatory)][string]$HarnessNodePath,
    [Parameter(Mandatory)][string]$HarnessNodeSha256,
    [Parameter(Mandatory)][string]$ArtifactDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT' -or $env:GITHUB_ACTIONS -cne 'true' -or $env:PROCESSOR_ARCHITECTURE -cne 'ARM64'){
    throw 'This harness is restricted to a disposable GitHub Windows ARM64 job.'
}
if((Test-Path -LiteralPath $ArtifactDirectory) -or (Get-Item -LiteralPath $PlanPath).Length -gt 64KB){throw 'The plan/output boundary is invalid.'}
if($HarnessNodeSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $HarnessNodePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $HarnessNodeSha256){throw 'The measurement tool is not its exact pinned Node input.'}
$plan=Get-Content -LiteralPath $PlanPath -Raw|ConvertFrom-Json
if($plan.schemaVersion -ne 1 -or $plan.fixtureOnly -ne $true -or @($plan.cases).Count -lt 1 -or @($plan.cases).Count -gt 32){throw 'A reviewed, bounded fixture-only measurement plan is required.'}
$installedRoot=Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
if($plan.PSObject.Properties.Name -contains 'requireUninstalledStart' -and $plan.requireUninstalledStart -eq $true -and (Test-Path -LiteralPath $installedRoot)){throw 'The reviewed comparison requires an uninstalled disposable runner.'}
[IO.Directory]::CreateDirectory($ArtifactDirectory)|Out-Null
# Compile instrumentation before starting any timed target.
. (Join-Path $PSScriptRoot 'windows-observer.ps1')
. (Join-Path $PSScriptRoot 'wpr-trace.ps1')
. (Join-Path $PSScriptRoot 'measurement-tracing.ps1')
function Stop-MeasurementCollector {
    param([Parameter(Mandatory)][Diagnostics.Process]$Process)
    if($Process.HasExited){return}
    $stopper=[Diagnostics.Process]::new()
    try {
        $stopper.StartInfo=[Diagnostics.ProcessStartInfo]::new()
        $stopper.StartInfo.FileName=Join-Path $env:SystemRoot 'System32\taskkill.exe'
        $stopper.StartInfo.Arguments="/PID $($Process.Id) /T /F"
        $stopper.StartInfo.UseShellExecute=$false;$stopper.StartInfo.CreateNoWindow=$true
        $stopper.StartInfo.RedirectStandardOutput=$true;$stopper.StartInfo.RedirectStandardError=$true
        if(-not $stopper.Start()){throw 'The owned collector stop helper did not start.'}
        $out=$stopper.StandardOutput.ReadToEndAsync();$err=$stopper.StandardError.ReadToEndAsync()
        if(-not $stopper.WaitForExit(10000)){$stopper.Kill();$null=$stopper.WaitForExit(1000);throw 'Collector stop helper timed out.'}
        if(-not $out.Wait(1000) -or -not $err.Wait(1000) -or -not $Process.WaitForExit(5000)){throw 'Collector cleanup was not confirmed.'}
    } finally {$stopper.Dispose()}
}
$summary=[ordered]@{
    schemaVersion=1;classification='windows-same-runner-performance';status='failed'
    planSha256=(Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash.ToLowerInvariant()
    toolNodeSha256=$HarnessNodeSha256;runner=$env:RUNNER_NAME;runId=$env:GITHUB_RUN_ID
    osVersion=[Environment]::OSVersion.VersionString;logicalProcessors=[Environment]::ProcessorCount
    processColdIsNotOsCacheCold=$true;original142SecondTraceAvailable=$false;cases=@()
}
$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$primary=$null;$traceFailures=[Collections.Generic.List[object]]::new()
try {
    foreach($case in $plan.cases){
        if($case.id -cnotmatch '^[a-z][a-z0-9-]{1,47}$' -or -not $names.Add($case.id) -or $case.variant -cnotin @('baseline','candidate') -or $case.action -cnotin @('install','uninstall','upgrade','launch','idle','extraction','prepare','inventory')){throw 'A measurement case has invalid identity.'}
        $directory=Join-Path $ArtifactDirectory $case.id
        [IO.Directory]::CreateDirectory($directory)|Out-Null
        if($case.action -ceq 'inventory'){
            $root=[IO.Path]::GetFullPath([string]$case.root)
            $expected=Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
            if(-not [string]::Equals($root,$expected,[StringComparison]::OrdinalIgnoreCase)){throw 'Inventory is restricted to the exact installed application root.'}
            $pending=[Collections.Generic.Stack[string]]::new();$pending.Push($root)
            $files=0;$bytes=[long]0;$declarations=0;$maps=0
            while($pending.Count -gt 0){
                foreach($item in @(Get-ChildItem -LiteralPath ($pending.Pop()) -Force)){
                    if($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)){throw 'Inventory does not follow reparse paths.'}
                    if($item.PSIsContainer){$pending.Push($item.FullName)}else{
                        $files++;$bytes += $item.Length
                        if($item.Name -match '\.d\.(ts|mts|cts)$'){$declarations++}
                        if($item.Name.EndsWith('.map')){$maps++}
                        if($files -gt 250000){throw 'Installed inventory exceeded its bound.'}
                    }
                }
            }
            $summary.cases += [ordered]@{id=$case.id;variant=$case.variant;action='inventory';files=$files;logicalBytes=$bytes;declarationFiles=$declarations;sourceMapFiles=$maps;runtimeUnneededClassification=$null;runtimeBytesCopied=$null}
            continue
        }
        $cap=switch($case.action){'launch'{300000};'extraction'{180000};'idle'{120000};default{900000}}
        if($case.PSObject.Properties.Name -contains 'deadlineContract'){
            if($case.deadlineContract -cne 'f8-installed-openclaw-qualification' -or $case.source -cne 'f8a1d8c702c879d2984d76d2e0419641bb1ccd97' -or $case.action -cne 'launch' -or [IO.Path]::GetFileName([string]$case.args[2]) -cne 'profile-installed-openclaw.mts'){throw 'An extended deadline requires the exact pinned OpenClaw replay contract.'}
            $cap=1350000
        }
        if($case.timeoutMs -lt 1 -or $case.timeoutMs -gt $cap){throw 'The case exceeds its existing bounded operation deadline.'}
        $casePlan=Join-Path $directory 'command-plan.json'
        $case | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 1 -Force
        $case | Add-Member -NotePropertyName fixtureOnly -NotePropertyValue $true -Force
        [IO.File]::WriteAllText($casePlan,($case|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
        $receipt=Join-Path $directory 'command.json'
        $trace=$null;$traceRecord=$null;$collector=$null;$target=$null;$observer=$null;$observerFailure=$null
        $capture=$null;$caseFailure=$null;$measurement=$null;$outputInfo=$null
        try {
            if($case.PSObject.Properties.Name -contains 'wpr' -and $case.wpr -eq $true){$trace=New-MeasurementTraceState -Case $case -Directory $directory}
            $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$HarnessNodePath
            $argv=@('--experimental-strip-types','--no-warnings',(Join-Path $PSScriptRoot 'measure-command.mts'),$casePlan,$receipt)
            if(@($argv|Where-Object {$_ -match '["\r\n]' -or $_.EndsWith('\')}).Count){throw 'An ambiguous harness argument is unsupported.'}
            $start.Arguments=($argv|ForEach-Object {'"'+$_+'"'})-join ' '
            $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
            $start.EnvironmentVariables.Remove('NODE_OPTIONS')
            $collector=[Diagnostics.Process]::Start($start);$null=$collector.Handle
            $capture=[NemoClaw.Performance.BoundedOutput]::new($collector)
            $clock=[Diagnostics.Stopwatch]::StartNew();$lastSample=-1000
            while(-not $collector.WaitForExit(100)){
                if($clock.ElapsedMilliseconds -gt ([long]$case.timeoutMs+30000)){throw 'The measurement collector exceeded its cleanup grace; this sample is failed.'}
                if($case.PSObject.Properties.Name -contains 'observeProcess' -and $case.observeProcess -eq $true -and $null -eq $observer -and $null -eq $observerFailure -and (Test-Path -LiteralPath ($receipt+'.pid'))){
                    try {
                        $target=Get-Process -Id ([int][IO.File]::ReadAllText($receipt+'.pid'))
                        $null=$target.Handle
                        if(-not [string]::Equals($target.MainModule.FileName,[IO.Path]::GetFullPath([string]$case.executable),[StringComparison]::OrdinalIgnoreCase)){throw 'The observed process image does not match the measured executable.'}
                        $watch=if($case.PSObject.Properties.Name -contains 'watchPath'){[string]$case.watchPath}else{''}
                        $observer=New-WindowsPerformanceObserver -Process $target -WatchPath $watch
                    }catch{$observerFailure=$_.Exception.Message}
                }
                if($null -ne $observer -and $clock.ElapsedMilliseconds-$lastSample -ge 1000){
                    try {Write-WindowsPerformanceSample -Observer $observer -OutputPath (Join-Path $directory 'process-samples.jsonl')|Out-Null}
                    catch{$observerFailure=$_.Exception.Message;$observer.Dispose();$observer=$null}
                    $lastSample=$clock.ElapsedMilliseconds
                }
                if($null -ne $trace){Update-MeasurementTraceState -State $trace}
            }
            if(-not $capture.Finish(5000)){throw 'The collector output did not close.'}
            if(-not(Test-Path -LiteralPath $receipt -PathType Leaf)){throw 'No measured command receipt was produced.'}
            $measurement=Get-Content -LiteralPath $receipt -Raw|ConvertFrom-Json
            if($measurement.exitCode -eq 3010){throw 'The installer requires reboot; later same-boot samples would not be comparable.'}
            if($collector.ExitCode -ne 0){throw 'The measured command failed or was censored; the plan does not retry it.'}
            if($case.PSObject.Properties.Name -contains 'expectInstalled' -and [bool](Test-Path -LiteralPath $installedRoot) -ne [bool]$case.expectInstalled){throw 'The installed-state boundary does not match the reviewed case.'}
        } catch {$caseFailure=$_}
        finally {
            $cleanupActions=@(
                @{label='observer';action={if($null -ne $observer){$observer.Dispose()}}},
                @{label='target handle';action={if($null -ne $target){$target.Dispose()}}},
                @{label='collector stop';action={if($null -ne $collector){Stop-MeasurementCollector -Process $collector}}},
                @{label='collector output';action={if($null -ne $capture){$null=$capture.Finish(1000);$capture.Save((Join-Path $directory 'collector.log'))|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $directory 'collector-output.json') -Encoding UTF8}}},
                @{label='capture handle';action={if($null -ne $capture){$capture.Dispose()}}},
                @{label='collector handle';action={if($null -ne $collector){$collector.Dispose()}}}
            )
            foreach($cleanup in $cleanupActions){
                try {& $cleanup.action}
                catch {if($null -eq $caseFailure){$caseFailure=$_}else{Write-Warning ("Measurement cleanup also failed: "+$cleanup.label)}}
            }
        }
        if($null -ne $trace){
            try {
                $traceRecord=Complete-MeasurementTraceState -State $trace
                if($traceRecord.failed){$traceFailures.Add([ordered]@{case=$case.id;receipt=(Join-Path $directory 'trace-windows.json')})}
                if(-not $traceRecord.safeToContinue){throw 'The recorder did not confirm cleanup; no later case may start.'}
            }catch{if($null -eq $caseFailure){$caseFailure=$_}else{Write-Warning 'Recorder finalization also failed; the original command failure is retained.'}}
        }
        $sampleKind=if($case.PSObject.Properties.Name -contains 'sampleKind'){[string]$case.sampleKind}else{'unspecified'}
        $row=[ordered]@{id=$case.id;variant=$case.variant;action=$case.action;sampleKind=$sampleKind;receipt=$receipt;receiptPresent=($null -ne $measurement);wprRequested=($null -ne $trace);trace=$traceRecord;observerFailure=$observerFailure;runtimeBytesCopied=$null;error=$(if($null -ne $caseFailure){$caseFailure.Exception.Message}else{$null})}
        if($null -ne $measurement){
            foreach($field in @('elapsedMs','firstByteMs','firstConfigurationLog','exitCode','timedOut','instrumentation')){$row[$field]=$measurement.$field}
        }
        $summary.cases += $row
        try {[IO.File]::WriteAllText((Join-Path $directory 'case-result.json'),($row|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))}
        catch {if($null -eq $caseFailure){$caseFailure=$_}else{Write-Warning 'The case result also could not be retained.'}}
        if($null -ne $caseFailure){throw $caseFailure}
        if($null -ne $traceRecord -and $traceRecord.failed -and -not($plan.PSObject.Properties.Name -contains 'continueAfterTraceFailure' -and $plan.continueAfterTraceFailure -eq $true)){
            throw 'Recording failed after the measured command completed; the plan does not continue.'
        }
    }
    $summary.status=if($traceFailures.Count -gt 0){'trace-failed'}else{'collected'}
} catch {$primary=$_;$summary.status='failed';$summary['error']=$_.Exception.Message}
finally {
    $summary['traceFailures']=@($traceFailures.ToArray())
    try {[IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'measurement-summary.json'),($summary|ConvertTo-Json -Depth 12)+"`n",[Text.UTF8Encoding]::new($false))}
    catch {if($null -eq $primary){$primary=$_}else{Write-Warning 'The measurement summary could not be written.'}}
}
if($null -ne $primary){throw $primary}
