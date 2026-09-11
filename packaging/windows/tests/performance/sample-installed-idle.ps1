# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$PlanPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$handles = [Collections.Generic.List[object]]::new()
$ancestryHandles = [Collections.Generic.List[object]]::new()
$phase = 'input'
function Emit($Value) { [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress)); [Console]::Out.Flush() }
function Require($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Same-Path([string]$Left, [string]$Right) { return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase) }
function Record([int]$Id) {
    $rows = @(Get-CimInstance Win32_Process -Filter "ProcessId=$Id" -OperationTimeoutSec 3)
    Require ($rows.Count -eq 1) 'The owned process is no longer present.'
    return $rows[0]
}
function File-Time($Date) { return ([datetime]$Date).ToUniversalTime().ToFileTimeUtc().ToString() }
function Hold($Row, [string]$Image, [string]$Role, [string]$Expected = '', [int]$Tolerance = 10) {
    Require ($null -ne $Row.ExecutablePath -and (Same-Path $Row.ExecutablePath $Image)) 'An owned process image is unavailable or changed.'
    if (-not $Expected) { $Expected = File-Time $Row.CreationDate }
    $counter = [NemoClaw.InstalledIdle.Counter]::new([int]$Row.ProcessId, $Image, $Expected, $Tolerance, $Role)
    try { $handles.Add($counter) } catch { $counter.Dispose(); throw }
}
function One($Rows, [string]$Label) { $values = @($Rows); Require ($values.Count -eq 1) ('The ' + $Label + ' role is missing or ambiguous.'); return $values[0] }
function Frame {
    $start = [Diagnostics.Stopwatch]::GetTimestamp()
    $rows = @($handles | ForEach-Object { $_.Snapshot() })
    return @{ processes = $rows; captureTicks = ([Diagnostics.Stopwatch]::GetTimestamp() - $start).ToString() }
}
$failed = $false
try {
    Require ($env:OS -ceq 'Windows_NT' -and $env:GITHUB_ACTIONS -ceq 'true' -and $PSVersionTable.PSEdition -ceq 'Core' -and $PSVersionTable.PSVersion -ge [version]'7.4') 'The idle observer requires the existing Windows CI PowerShell7 host.'
    $item = Get-Item -LiteralPath $PlanPath
    Require ($item -is [IO.FileInfo] -and -not $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -and $item.Length -le 16384) 'The observer plan is not a bounded regular file.'
    $plan = [IO.File]::ReadAllText($item.FullName) | ConvertFrom-Json
    Require ($plan.schemaVersion -eq 1 -and $plan.durationMs -eq 30000 -and $plan.runtimeId -cmatch '^[a-f0-9]{64}$' -and $plan.sourceRevision -cmatch '^[a-f0-9]{40}$' -and $plan.manifestSha256 -cmatch '^[a-f0-9]{64}$') 'The installed runtime measurement plan is invalid.'
    foreach ($key in @('controllerPid','guardianPid','hostPid')) { Require ($plan.$key -is [long] -or $plan.$key -is [int]) 'A process identity is not integral.'; Require ($plan.$key -gt 0 -and $plan.$key -le [int]::MaxValue) 'A process identity is out of range.' }
    $installation = [IO.Path]::GetFullPath([string]$plan.installRoot).TrimEnd('\')
    Require (Same-Path $installation (Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw')) 'The measurement target is not the fixed installed application.'
    $phase = 'prepare-counter'
    # PS7 compiles this observer in process. Compilation is outside the sample.
    Add-Type -Path (Join-Path $PSScriptRoot 'InstalledIdleCounter.cs')
    $phase = 'bind-identities'
    $self = Record $PID
    Require ([int]$self.ParentProcessId -eq [int]$plan.controllerPid) 'The observer is not a child of its controller.'
    $guardian = Record $plan.guardianPid
    Require ([int]$guardian.ParentProcessId -eq [int]$plan.controllerPid) 'The guardian is not this controller owned child.'
    Hold $guardian (Join-Path $installation 'bin\NemoClaw.exe') 'guardian' (File-Time $plan.guardianStartedUtc) 0
    $hostRow = Record $plan.hostPid
    Require ([int]$hostRow.ParentProcessId -eq [int]$plan.guardianPid) 'The runtime host is not the guardian child.'
    Hold $hostRow (Join-Path $installation "runtimes\$($plan.runtimeId)\app\NemoClaw.Runtime.exe") 'host-runtime' (File-Time $plan.hostStartedUtc) 0
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$plan.hostPid)" -OperationTimeoutSec 3)
    Require ($children.Count -le 32) 'The owned runtime child inventory exceeds its bound.'
    $gatewayImage = Join-Path $installation 'bin\openshell-gateway.exe'
    $gateway = One @($children | Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $gatewayImage) }) 'gateway'
    Hold $gateway $gatewayImage 'openshell-gateway'
    $windowImage = Join-Path $installation 'native-ui\NemoClaw.Bootstrapper.exe'
    Hold (One @($children | Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $windowImage) }) 'native-window') $windowImage 'native-window'
    $ownerImage = Join-Path $installation 'bin\NemoClaw.exe'
    $prefix = [regex]::Escape([IO.Path]::GetPathRoot($installation) + 'NemoClawNativeUiShare-')
    $sessionNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($role in @('ui-relay','inference-relay')) {
        $pattern = '^(?:"' + [regex]::Escape($ownerImage) + '"|' + [regex]::Escape($ownerImage) + ')\s+--native-ui-file-owner\s+"?(' + $prefix + '[a-f0-9]{10})\\' + $role + '"?\s*$'
        $rows = @($children | Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $ownerImage) -and [regex]::IsMatch([string]$_.CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase) })
        $row = One $rows $role
        $match = [regex]::Match([string]$row.CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        [void]$sessionNames.Add($match.Groups[1].Value)
        Hold $row $ownerImage $role
    }
    Require ($sessionNames.Count -eq 1) 'The two relays do not share one exact installed session.'
    # Live gateway ancestry is collected once before timing. No command lines or
    # arbitrary guest-reported PID are accepted as standalone authority.
    $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@{ row=$gateway; depth=0; chain=@() })
    $guestImage = Join-Path $installation 'bin\node.exe'
    $executorImage = Join-Path $installation 'mxc\wxc-exec.exe'
    $guests = @(); $records = 0
    while ($queue.Count -gt 0) {
        Require ($clock.ElapsedMilliseconds -lt 10000) 'Owned identity discovery exhausted its diagnostic budget.'
        $entry = $queue.Dequeue()
        Require ($entry.depth -lt 8) 'The owned gateway ancestry exceeds its depth bound.'
        $nested = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$([int]$entry.row.ProcessId)" -OperationTimeoutSec 3)
        foreach ($row in $nested) {
            Require ((++$records) -le 32) 'The owned gateway process inventory exceeds its bound.'
            Require ($row.ExecutablePath -and $row.CreationDate.ToUniversalTime() -ge $entry.row.CreationDate.ToUniversalTime()) 'An owned ancestry row is not live and ordered.'
            $anchor = [NemoClaw.InstalledIdle.Counter]::new([int]$row.ProcessId, [string]$row.ExecutablePath, (File-Time $row.CreationDate), 10, 'ancestry')
            try { $ancestryHandles.Add($anchor) } catch { $anchor.Dispose(); throw }
            $chain = @($entry.chain) + @($entry.row)
            if ($row.ExecutablePath -and (Same-Path $row.ExecutablePath $guestImage)) { $guests += @{ row=$row; chain=$chain } }
            else { $queue.Enqueue(@{ row=$row; depth=($entry.depth+1); chain=$chain }) }
        }
    }
    $guest = One $guests 'contained-node'
    $executor = One @($guest.chain | Where-Object { $_.ExecutablePath -and (Same-Path $_.ExecutablePath $executorImage) }) 'mxc-executor'
    Hold $executor $executorImage 'mxc-executor'
    Hold $guest.row $guestImage 'contained-node'
    Hold $self ([Environment]::ProcessPath) 'observer'
    $ids = @($handles | ForEach-Object { $_.Snapshot().processId })
    Require (@($ids | Select-Object -Unique).Count -eq $ids.Count) 'One PID was assigned multiple measurement roles.'
    Require ($clock.ElapsedMilliseconds -lt 10000) 'Observer preparation exhausted its diagnostic budget.'
    $preparationMs = $clock.Elapsed.TotalMilliseconds
    $phase = 'idle-sample'
    foreach ($anchor in $ancestryHandles) { $null = $anchor.Snapshot() }
    $before = Frame
    Emit @{ kind='ready'; schemaVersion=1; processes=$before.processes; preparationMs=$preparationMs }
    Start-Sleep -Milliseconds 30000
    $after = Frame
    foreach ($anchor in $ancestryHandles) { $null = $anchor.Snapshot() }
    $phase = 'complete'
    Emit @{ kind='complete'; schemaVersion=1; runtimeId=$plan.runtimeId; sourceRevision=$plan.sourceRevision; manifestSha256=$plan.manifestSha256;
        requestedIdleMs=30000; clock='Stopwatch.GetTimestamp'; frequency=[Diagnostics.Stopwatch]::Frequency.ToString(); logicalProcessors=[Environment]::ProcessorCount;
        preparationMs=$preparationMs; observerTotalMs=$clock.Elapsed.TotalMilliseconds; frames=@($before,$after);
        applicationInstrumentationEnabled=$false; scenario='settled-response-browser-connected-no-user-actions'; relayCounters=$null }
} catch {
    $failed = $true
    $causes = @(); $cause = $_.Exception
    while ($null -ne $cause -and $causes.Count -lt 4) {
        $nativeCode = if ($cause -is [ComponentModel.Win32Exception]) { $cause.NativeErrorCode } else { $null }
        $causes += @{ type=$cause.GetType().FullName; hresult=$cause.HResult; nativeErrorCode=$nativeCode }
        $cause = $cause.InnerException
    }
    Emit @{ kind='failure'; schemaVersion=1; phase=$phase; message='The owned idle observation could not complete.'; causes=$causes; elapsedMs=$clock.Elapsed.TotalMilliseconds }
} finally {
    foreach ($handle in $handles) { $handle.Dispose() }
    foreach ($anchor in $ancestryHandles) { $anchor.Dispose() }
}
if ($failed) { exit 1 }
