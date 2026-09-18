# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# CI observer: input goes only to the verified installed runtime's console.
param([Parameter(Mandatory)][int]$RootProcessId,
    [Parameter(Mandatory)][int]$RuntimeProcessId,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$StateRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'preview-ui-controls.ps1')
if ($PSVersionTable.PSEdition -cne 'Core') { throw 'The installed console observer requires PowerShell7.' }
Add-Type -Path (Join-Path $PSScriptRoot 'InstalledConsoleObserver.cs')
$root = [Diagnostics.Process]::GetProcessById($RootProcessId)
$target = [Diagnostics.Process]::GetProcessById($RuntimeProcessId)
$observer = $null
# Preserve the redirected protocol handles before attaching to the owned console.
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true))
$writer = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
try {
    $null = $root.Handle; $null = $target.Handle
    $installation = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
    $relative = [IO.Path]::GetRelativePath((Join-Path $installation 'runtimes'), $runtime)
    if ($StateRoot -cnotmatch '^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-pi$') { throw 'The Pi state root is invalid.' }
    if ($relative -cnotmatch '^[a-f0-9]{64}$' -or
        -not [string]::Equals($root.MainModule.FileName, (Join-Path $installation 'bin\NemoClaw.exe'), [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals($target.MainModule.FileName, (Join-Path $runtime 'app\NemoClaw.Runtime.exe'), [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-PreviewWindowOwner $target.Id $root)) {
        throw 'The console does not belong to the selected installed guardian and runtime.'
    }
    $observer = [NemoClaw.InstalledConsole.Observer]::new($target)
    $writer.WriteLine('{"kind":"attached"}')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $pending = $reader.ReadLineAsync()
    $quitting = $false
    while ($clock.ElapsedMilliseconds -lt 600000) {
        if ($target.HasExited) {
            if (-not $quitting) { throw 'The Pi terminal exited before the requested stop.' }
            $writer.WriteLine('{"kind":"closed"}')
            break
        }
        if ($root.HasExited) { throw 'The installed guardian stopped before its terminal.' }
        if (-not $pending.IsCompleted) { Start-Sleep -Milliseconds 50; continue }
        $line = $pending.GetAwaiter().GetResult()
        if ($null -eq $line) { throw 'The console observer input closed before Stop.' }
        if ($line.Length -gt 4096) { throw 'The console command exceeds its bound.' }
        $command = $line | ConvertFrom-Json
        switch -CaseSensitive ($command.action) {
            'ready' {
                $screen = $observer.ReadScreen()
                $writer.WriteLine((@{kind='ready';rawInput=$observer.RawInput;screenNonempty=(-not [string]::IsNullOrWhiteSpace($screen))}|ConvertTo-Json -Compress))
            }
            'submit' {
                if ($quitting) { throw 'Input after Stop is forbidden.' }
                $observer.Submit([string]$command.text)
                $writer.WriteLine('{"kind":"submitted"}')
            }
            'observe' {
                $expected = [string]$command.expected
                if ($expected -cnotmatch '^PI_REPLY_[a-f0-9]{20}$') { throw 'The screen observation token is invalid.' }
                $screen = $observer.ReadScreen()
                $writer.WriteLine((@{kind='screen';containsReply=$screen.Contains($expected);rawInput=$observer.RawInput}|ConvertTo-Json -Compress))
            }
            'sessions' {
                # Send only to the private controller pipe; never save raw conversations.
                $documents = [NemoClaw.InstalledConsole.Observer]::ReadSessionFiles($StateRoot)
                $writer.WriteLine((@{kind='sessions';documents=@($documents)}|ConvertTo-Json -Compress))
            }
            'quit' {
                if ($quitting) { throw 'Stop cannot be repeated.' }
                $observer.Submit('/quit')
                $quitting = $true
                $writer.WriteLine('{"kind":"stop-requested"}')
            }
            default { throw 'The console observer command is invalid.' }
        }
        $pending = $reader.ReadLineAsync()
    }
    if (-not $target.HasExited) { throw 'The owned terminal exceeded the observer deadline.' }
} finally {
    if ($null -ne $observer) { $observer.Dispose() }
    $target.Dispose(); $root.Dispose()
    $reader.Dispose(); $writer.Dispose()
}
