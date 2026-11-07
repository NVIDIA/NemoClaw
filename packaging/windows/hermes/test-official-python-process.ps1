# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Exercise the actual scripts through a native -File boundary. On Windows this
# also crosses cmd.exe, matching the VS developer-command invocation route.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$work = Join-Path ([IO.Path]::GetTempPath()) ('python input boundary ' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
$powershell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$controls = 0
try {
    foreach ($name in @('prepare-official-python.ps1','complete-official-python.ps1','official-python.lock.json','official-components.lock.json')) {
        [IO.File]::Copy((Join-Path $PSScriptRoot $name), (Join-Path $work $name))
    }
    $override = Join-Path $work 'explicit override.json'
    [IO.File]::WriteAllText($override, '{}')
    foreach ($case in @(
        @{ Script = 'prepare-official-python.ps1'; Default = 'official-python.lock.json'; Extra = @('-ComponentEvidenceDirectory', $work, '-RustcPath', 'unused', '-CargoPath', 'unused') },
        @{ Script = 'complete-official-python.ps1'; Default = 'official-components.lock.json'; Extra = @() }
    )) {
        foreach ($explicit in @($false, $true)) {
            $scriptPath = Join-Path $work $case.Script
            $arguments = @('-NoProfile', '-File', $scriptPath, '-RuntimeRoot', 'unused',
                '-ArtifactDirectory', (Join-Path $work 'must-not-be-created'), '-ResolveInputPathsOnly') + $case.Extra
            $expected = Join-Path $work $case.Default
            if ($explicit) { $arguments += @('-LockPath', $override); $expected = $override }
            $line = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
            $start = [Diagnostics.ProcessStartInfo]::new()
            if ($env:OS -eq 'Windows_NT') {
                $start.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
                $start.Arguments = '/d /c call "' + $powershell + '" ' + $line
            } else {
                $start.FileName = $powershell
                $start.Arguments = $line
            }
            $start.WorkingDirectory = [IO.Path]::GetTempPath()
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $process = [Diagnostics.Process]::Start($start)
            try {
                $stdout = $process.StandardOutput.ReadToEndAsync()
                $stderr = $process.StandardError.ReadToEndAsync()
                if (-not $process.WaitForExit(15000)) {
                    if ($env:OS -eq 'Windows_NT') {
                        & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
                    } else { $process.Kill() }
                    throw 'The actual input-path process boundary exceeded its deadline.'
                }
                if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) { throw 'Input-path output did not close.' }
                if ($process.ExitCode -ne 0) { throw $stderr.GetAwaiter().GetResult() }
                $result = $stdout.GetAwaiter().GetResult() | ConvertFrom-Json
                if ($result.classification -cne 'python-input-path-control' -or $result.exists -ne $true -or
                    -not [string]::Equals($result.lockPath, $expected, [StringComparison]::OrdinalIgnoreCase) -or
                    -not [string]::Equals($result.scriptPath, $scriptPath, [StringComparison]::OrdinalIgnoreCase)) {
                    throw 'The actual script did not resolve the intended input file.'
                }
                $controls += 1
            } finally { $process.Dispose() }
        }
    }
    if (Test-Path -LiteralPath (Join-Path $work 'must-not-be-created')) { throw 'Input-path inspection attempted provisioning.' }
    Write-Host "Official Python native process boundary: $controls controls passed; no provisioning performed."
} finally { [IO.Directory]::Delete($work, $true) }
