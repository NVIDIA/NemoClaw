# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$ProcessId,
 [Parameter(Mandatory)][string]$ExpectedExecutable,
 [Parameter(Mandatory)][string]$OutputPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if($env:OS -cne 'Windows_NT' -or (Test-Path -LiteralPath $OutputPath)){throw 'A fresh native process-start observation is required.'}
$process=Get-Process -Id $ProcessId
try {
 $null=$process.Handle
 $actual=$process.MainModule.FileName
 if(-not [string]::Equals([IO.Path]::GetFullPath($actual),[IO.Path]::GetFullPath($ExpectedExecutable),[StringComparison]::OrdinalIgnoreCase)){throw 'The observed process executable differs from the owned workload.'}
 $start=$process.StartTime.ToUniversalTime()
 $record=[ordered]@{schemaVersion=1;processId=$ProcessId;executable=$actual;osProcessCreatedUtc=$start.ToString('O');creationFileTimeUtc=$start.ToFileTimeUtc().ToString();observedUtc=[DateTime]::UtcNow.ToString('O');processAlive=(-not $process.HasExited);source='held Windows process start time, not gateway Ready or first JavaScript output'}
 [IO.File]::WriteAllText($OutputPath,($record|ConvertTo-Json -Depth 4)+"`n",[Text.UTF8Encoding]::new($false))
} finally {$process.Dispose()}
