# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ArtifactDirectory,[Parameter(Mandatory)][string]$NodePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $ArtifactDirectory){throw 'The control output must be fresh.'}
[IO.Directory]::CreateDirectory($ArtifactDirectory)|Out-Null
. (Join-Path $PSScriptRoot 'wpr-trace.ps1')
. (Join-Path $PSScriptRoot 'measurement-tracing.ps1')
$results=[Collections.Generic.List[object]]::new()
function Assert-Control {param([bool]$Value,[string]$Label);if(-not $Value){throw $Label};$results.Add(@{label=$Label;pass=$true})}
function New-ControlChild {param([string]$Code)
    $script=Join-Path $ArtifactDirectory ([guid]::NewGuid().ToString('N')+'.cjs')
    [IO.File]::WriteAllText($script,$Code)
    $start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$NodePath;$start.Arguments='"'+$script+'"';$start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    return [Diagnostics.Process]::Start($start)
}
# The actual bounded pipe implementation preserves both native channels before EOF.
$child=New-ControlChild "process.stdout.write('native-out');process.stderr.write('native-err');setTimeout(()=>process.exit(37),600);"
$capture=[NemoClaw.Performance.BoundedOutput]::new($child)
try {
    Start-Sleep -Milliseconds 250
    $snapshot=$capture.Save((Join-Path $ArtifactDirectory 'partial.log'))
    Assert-Control (-not $snapshot.outputClosed) 'partial output saved while actual child remains live'
    Assert-Control ([IO.File]::ReadAllText((Join-Path $ArtifactDirectory 'partial.log')).Contains('native-err')) 'stderr retained before EOF'
    Assert-Control ($child.WaitForExit(3000) -and $capture.Finish(1000) -and $child.ExitCode -eq 37) 'real nonzero exit retained'
}finally{if(-not $child.HasExited){$child.Kill();$null=$child.WaitForExit(3000)};$capture.Dispose();$child.Dispose()}
$files=Join-Path $ArtifactDirectory 'files';[IO.Directory]::CreateDirectory($files)|Out-Null
[IO.File]::WriteAllBytes((Join-Path $files '.hidden.etl'),[byte[]]::new(123))
[IO.File]::WriteAllBytes((Join-Path $files 'normal.etl'),[byte[]]::new(321))
if($env:OS -ceq 'Windows_NT'){[IO.File]::SetAttributes((Join-Path $files '.hidden.etl'),([IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System))}
$inventory=Get-WindowsPerformanceTraceFiles -Directory $files
Assert-Control ($inventory.logicalBytes -eq 444 -and $inventory.files.Count -eq 2) 'hidden/system-capable accounting includes all actual file bytes'
$growingPath=Join-Path $files 'growing.etl'
$writer=[IO.File]::Open($growingPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
try {
    $writer.Write([byte[]]::new(777),0,777);$writer.Flush()
    $growing=Get-WindowsPerformanceTraceFiles -Directory $files
    Assert-Control ($growing.logicalBytes -eq 1221) 'opened-handle accounting sees a real growing file before writer close'
}finally{$writer.Dispose()}
# Exercise the actual tool-command timeout/capture function with the owned Node
# executable as a controlled native process; this is not a fake WPR success.
$toolRoot=Join-Path $ArtifactDirectory 'tool';$system32=Join-Path $toolRoot 'System32'
[IO.Directory]::CreateDirectory($system32)|Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $system32 'wpr.exe')
$program=Join-Path $toolRoot 'tool.cjs';[IO.File]::WriteAllText($program,"process.stdout.write('tool-stdout');process.stderr.write('tool-stderr');setTimeout(()=>process.exit(0),60000);")
$originalSystemRoot=$env:SystemRoot;$caught=$null
try {
    $env:SystemRoot=$toolRoot
    # Establish that the freshly copied test executable can run before the
    # deliberately short timeout control; this setup is outside all samples.
    Invoke-OwnedWprCommand -Arguments @('--version') -LogPath (Join-Path $toolRoot 'version.log') -TimeoutMilliseconds 30000
    try {Invoke-OwnedWprCommand -Arguments @($program) -LogPath (Join-Path $toolRoot 'timeout.log') -TimeoutMilliseconds 3000}
    catch {$caught=$_}
} finally {$env:SystemRoot=$originalSystemRoot}
$toolRecord=Get-Content -LiteralPath (Join-Path $toolRoot 'timeout.log.json') -Raw|ConvertFrom-Json
Assert-Control ($null -ne $caught -and $caught.Exception.Message -ceq 'WPR command exceeded its bounded wait.') 'native command timeout remains the primary failure'
Assert-Control ($toolRecord.timedOut -and $toolRecord.processStopped -and $toolRecord.output.outputClosed) 'timed-out exact owned tool exits and both pipes close'
Assert-Control ([IO.File]::ReadAllText((Join-Path $toolRoot 'timeout.log')).Contains('tool-stdout') -and [IO.File]::ReadAllText((Join-Path $toolRoot 'timeout.log')).Contains('tool-stderr')) 'timeout retains partial stdout and stderr'
Remove-Item -LiteralPath (Join-Path $system32 'wpr.exe')
# No WPR execution is claimed here. These seams control recorder outcomes while
# the target is a separate real process; use actual WPR only in the Windows job.
function Start-WindowsPerformanceTrace {param([string]$Directory)
    [IO.Directory]::CreateDirectory($Directory)|Out-Null
    return [pscustomobject]@{directory=$Directory;active=$true}
}
function Stop-WindowsPerformanceTrace {param($Trace);$Trace.active=$false}
function Update-WindowsPerformanceTraceBudget {param($Trace);throw 'controlled-recorder-failure'}
$case=[pscustomobject]@{action='launch';wpr=$true}
$state=New-MeasurementTraceState -Case $case -Directory $ArtifactDirectory
$child=New-ControlChild "setTimeout(()=>{process.stdout.write('target-finished');process.exit(0)},400);"
$capture=[NemoClaw.Performance.BoundedOutput]::new($child)
try {
    while(-not $child.WaitForExit(25)){Update-MeasurementTraceState -State $state}
    $null=$capture.Finish(1000);$null=$capture.Save((Join-Path $ArtifactDirectory 'target.log'))
    $record=Complete-MeasurementTraceState -State $state
    Assert-Control ($child.ExitCode -eq 0 -and [IO.File]::ReadAllText((Join-Path $ArtifactDirectory 'target.log')).Contains('target-finished')) 'recorder failure never stops the real measured target'
    Assert-Control ($record.failed -and $record.safeToContinue -and $record.failures.Count -eq 1) 'recorder remains failed with confirmed cancellation'
}finally{if(-not $child.HasExited){$child.Kill();$null=$child.WaitForExit(3000)};$capture.Dispose();$child.Dispose()}
# Complete-line phase recognition does not invent a completed MSI trace from a
# short phase already over before observation, and never starts from a substring.
$phaseDir=Join-Path $ArtifactDirectory 'phases';[IO.Directory]::CreateDirectory($phaseDir)|Out-Null
$log=Join-Path $phaseDir 'burn.log';$case=[pscustomobject]@{action='install';wpr=$true;wprInstallerLog=$log;args=@('/install','/quiet','/norestart','/log',$log)}
$state=New-MeasurementTraceState -Case $case -Directory $phaseDir
$begin='[AB:CD][2026-09-10T10:00:00]i301: Applying execute package: MxcSystemDrivePreparation, action: Install'
[IO.File]::WriteAllText($log,$begin)
Update-MeasurementTraceState -State $state
Assert-Control ($state.windows.Count -eq 0) 'partial Burn line cannot start a capture'
[IO.File]::AppendAllText($log,"`n")
Update-MeasurementTraceState -State $state
Assert-Control ($state.windows.Count -eq 1 -and $state.current.phase -ceq 'system-drive-preparation') 'exact first host-prep begins its own window'
[IO.File]::AppendAllText($log,"[AB:CD][2026-09-10T10:05:00]i319: Applied execute package: MxcSystemDrivePreparation, result: 0x0`n[AB:CD][2026-09-10T10:05:01]i301: Applying execute package: NemoClawArm64Msi, action: Install`n")
Update-MeasurementTraceState -State $state
Assert-Control ($state.windows.Count -eq 2 -and $state.current.phase -ceq 'msi') 'MSI receives a separate fresh recording window'
[IO.File]::AppendAllText($log,"[AB:CD][2026-09-10T10:06:00]i319: Applied execute package: NemoClawArm64Msi, result: 0x0`n")
Update-MeasurementTraceState -State $state
$record=Complete-MeasurementTraceState -State $state
Assert-Control (-not $record.failed -and $record.installerStages.Count -eq 4 -and -not $record.completeOperationTraceClaimed) 'phase timestamps retained without a whole-operation trace claim'
# A recorder that still owns an active session remains held for final cleanup
# and cannot admit a new MSI recording or later measurement case.
function Stop-WindowsPerformanceTrace {param($Trace);throw 'controlled-cancel-failure'}
$unsafeDir=Join-Path $ArtifactDirectory 'unsafe';[IO.Directory]::CreateDirectory($unsafeDir)|Out-Null
$unsafe=New-MeasurementTraceState -Case ([pscustomobject]@{action='launch';wpr=$true}) -Directory $unsafeDir
Update-MeasurementTraceState -State $unsafe
Assert-Control (-not $unsafe.safeToContinue -and $unsafe.current.trace.active) 'unconfirmed recording cancellation retains ownership and refuses continuation'
$unsafe.activePhase='msi';Update-MeasurementTraceState -State $unsafe
Assert-Control ($unsafe.windows.Count -eq 1) 'an unsafe recording cannot admit the next MSI window'
$unsafeRecord=Complete-MeasurementTraceState -State $unsafe
Assert-Control ($unsafeRecord.failed -and -not $unsafeRecord.safeToContinue) 'final unconfirmed recorder cleanup remains red'
[IO.File]::WriteAllText((Join-Path $ArtifactDirectory 'controls.json'),(@{classification='portable actual-process/actual-file controls; WPR outcomes controlled';results=@($results.ToArray())}|ConvertTo-Json -Depth 6)+"`n")
Write-Host ($results.Count.ToString()+' recording controls passed')
