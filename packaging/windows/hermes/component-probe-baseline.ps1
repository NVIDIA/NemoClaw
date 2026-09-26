# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Stop-OwnedComponentProcess {
    param([Parameter(Mandatory)][Diagnostics.Process]$Process)
    if ($Process.HasExited) { return }
    $killer = [Diagnostics.Process]::new()
    try {
        $killer.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $killer.StartInfo.FileName = $taskkill
        $killer.StartInfo.Arguments = "/PID $($Process.Id) /T /F"
        $killer.StartInfo.UseShellExecute = $false
        $killer.StartInfo.CreateNoWindow = $true
        $killer.StartInfo.RedirectStandardOutput = $true
        $killer.StartInfo.RedirectStandardError = $true
        if (-not $killer.Start()) { throw 'The owned process-tree stop helper did not start.' }
        $stdout = $killer.StandardOutput.ReadToEndAsync()
        $stderr = $killer.StandardError.ReadToEndAsync()
        if (-not $killer.WaitForExit(10000)) {
            $killer.Kill()
            $null = $killer.WaitForExit(10000)
            throw 'The owned process-tree stop helper exceeded its deadline.'
        }
        if (-not $stdout.Wait(1000) -or -not $stderr.Wait(1000)) {
            throw 'The owned process-tree stop helper did not finish its output.'
        }
        if (-not $Process.WaitForExit(10000)) {
            throw 'The owned component process remained alive after its stop request.'
        }
    } finally { $killer.Dispose() }
}

function Invoke-ComponentProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Label,
        [ValidateRange(1, 900000)][int]$TimeoutMilliseconds
    )
    $stdout = Join-Path $evidence "$Label-stdout.log"
    $stderr = Join-Path $evidence "$Label-stderr.log"
    $quoted = @($Arguments | ForEach-Object {
        if ($_.Contains('"') -or $_.EndsWith('\') -or $_.Contains("`n") -or $_.Contains("`r")) {
            throw 'A component argument cannot be represented by this bounded invocation.'
        }
        '"' + $_ + '"'
    })
    $process = [Diagnostics.Process]::new()
    $outputFile = $null
    $errorFile = $null
    $started = $false
    $primaryFailure = $null
    $cleanupFailure = $null
    $exitCode = $null
    try {
        $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $process.StartInfo.FileName = $FilePath
        $process.StartInfo.Arguments = $quoted -join ' '
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $outputFile = [IO.File]::Open($stdout, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $errorFile = [IO.File]::Open($stderr, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        $started = $process.Start()
        if (-not $started) { throw "The component process '$Label' did not start." }
        $null = $process.Handle
        $outputCopy = $process.StandardOutput.BaseStream.CopyToAsync($outputFile)
        $errorCopy = $process.StandardError.BaseStream.CopyToAsync($errorFile)
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            throw "The component process '$Label' exceeded its deadline."
        }
        if (-not $outputCopy.Wait(10000) -or -not $errorCopy.Wait(10000)) {
            throw "The component process '$Label' did not finish its captured output."
        }
        $outputFile.Flush()
        $errorFile.Flush()
        $exitCode = $process.ExitCode
    } catch { $primaryFailure = $_ }
    finally {
        if ($started) {
            try { Stop-OwnedComponentProcess -Process $process }
            catch { $cleanupFailure = $_ }
        }
        foreach ($resource in @($process, $outputFile, $errorFile)) {
            if ($null -ne $resource) {
                try { $resource.Dispose() }
                catch { if ($null -eq $cleanupFailure) { $cleanupFailure = $_ } }
            }
        }
    }
    if ($null -ne $primaryFailure) {
        if ($null -ne $cleanupFailure) { Write-Warning "The component process '$Label' also failed its owned cleanup." }
        $PSCmdlet.ThrowTerminatingError($primaryFailure)
    }
    if ($null -ne $cleanupFailure) { $PSCmdlet.ThrowTerminatingError($cleanupFailure) }
    return [pscustomobject]@{ ExitCode = $exitCode; StdoutPath = $stdout; StderrPath = $stderr }
}

$root = [IO.Path]::GetFullPath($ArtifactDirectory)
$setup = Join-Path $root 'baseline-setup.exe'
$expected = '0377de7a402f266f190b62084ada986612538de3cd6bd7358d267d4432bf3f04'
$source = 'f8a1d8c702c879d2984d76d2e0419641bb1ccd97'
$url = 'https://media.githubusercontent.com/media/NVIDIA/NemoClaw/73733de5d960ac2daa06f6a43f184df382d12add/NemoClawSetup-0.1.0-windows-arm64.exe'
$installRoot = Join-Path $env:ProgramFiles 'NVIDIA\NemoClaw'
$evidence = $root
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
if (-not $Uninstall) {
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $installRoot)) {
        throw 'The component probe requires a fresh runner without an existing NemoClaw installation.'
    }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $setup -TimeoutSec 300
} elseif (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    return
}
if ((Get-Item -LiteralPath $setup).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
    (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) {
    throw 'The MXC baseline package failed its immutable SHA-256 check.'
}
$action = if ($Uninstall) { 'uninstall' } else { 'install' }
$log = Join-Path $root ("baseline-$action.log")
$arguments = @(('/' + $action), '/quiet', '/norestart', '/log', $log)
$process = Invoke-ComponentProcess -FilePath $setup -Arguments $arguments -Label ('baseline-' + $action) -TimeoutMilliseconds 900000
$receipt = [ordered]@{
    schemaVersion = 1
    classification = 'mxc-component-probe-baseline'
    action = $action
    sourceCandidate = $source
    setupUrl = $url
    setupSha256 = $expected
    exitCode = $process.ExitCode
    completeHermesAcceptance = $false
}
[IO.File]::WriteAllText((Join-Path $root "baseline-$action.json"),
    (($receipt | ConvertTo-Json -Depth 4) + "`n"), [Text.UTF8Encoding]::new($false))
if ($process.ExitCode -notin @(0, 3010)) { throw "The component probe baseline $action failed." }
if ($Uninstall) {
    if (Test-Path -LiteralPath $installRoot) { throw 'The probe baseline installation remains after uninstall.' }
} else {
    foreach ($relative in @('bin\node.exe', 'bin\openshell.exe', 'bin\openshell-gateway.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative) -PathType Leaf)) {
            throw 'The baseline did not install its required MXC runtime components.'
        }
    }
}
