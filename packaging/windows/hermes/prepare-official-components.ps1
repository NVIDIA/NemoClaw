# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Provision the official Hermes Windows components for an MXC feasibility run.
.DESCRIPTION
    This build-only probe retains complete official distributions. It invokes
    the stable Nous installer for its managed uv, Git, Python and venv stages.
    It does not produce a complete Hermes runtime or a customer installer.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [string]$LockPath = (Join-Path $PSScriptRoot 'official-components.lock.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-ComponentReceipt {
    param([Parameter(Mandatory)][object]$Value, [Parameter(Mandatory)][string]$Path)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Assert-ComponentHash {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Sha256)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
        throw 'An official Hermes component failed its pinned SHA-256 check.'
    }
}

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

function Invoke-OfficialStage {
    param(
        [Parameter(Mandatory)][ValidateSet('uv','git','python','venv')][string]$Name,
        [ValidateRange(1, 300000)][int]$TimeoutMilliseconds = 300000
    )
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
        '-Stage', $Name, '-NonInteractive', '-SkipSetup', '-SkipComputerUse',
        '-Branch', [string]$lock.upstream.tag, '-Commit', [string]$lock.upstream.commit,
        '-HermesHome', $runtime, '-InstallDir', $checkout, '-Json')
    Write-Host "[Hermes components] Official installer stage: $Name"
    $invocation = Invoke-ComponentProcess -FilePath $powershell -Arguments $arguments -Label $Name -TimeoutMilliseconds $TimeoutMilliseconds
    if ((Get-Item -LiteralPath $invocation.StdoutPath).Length -gt 2MB) {
        throw "Official Hermes stage '$Name' exceeded its bounded protocol output."
    }
    $lines = @(Get-Content -LiteralPath $invocation.StdoutPath | Where-Object { $_.StartsWith('{') })
    if ($invocation.ExitCode -ne 0 -or $lines.Count -ne 1) {
        throw "Official Hermes stage '$Name' failed; its stdout and stderr were retained."
    }
    $result = $lines[0] | ConvertFrom-Json
    if ($result.stage -cne $Name -or $result.ok -isnot [bool] -or $result.ok -ne $true -or
        $result.skipped -isnot [bool] -or $result.skipped -ne $false) {
        throw "Official Hermes stage '$Name' did not report a completed stage."
    }
    $stageResults.Add($result)
}

if ($env:OS -cne 'Windows_NT') { throw 'This component probe requires Windows.' }
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$evidence = [IO.Path]::GetFullPath($ArtifactDirectory)
foreach ($root in @($runtime, $evidence)) {
    if ($root.Contains('"') -or $root.Contains("`n") -or $root.Contains("`r") -or (Test-Path -LiteralPath $root)) {
        throw 'Component runtime and evidence roots must be fresh, unambiguous directories.'
    }
}
if ($runtime -notmatch '^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$') {
    throw 'The component runtime must use a fresh drive-root probe directory.'
}
$lock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
if ($lock.schemaVersion -ne 1 -or $lock.classification -cne 'official-hermes-windows-component-feasibility-inputs' -or
    $lock.upstream.commit -cne '2237be355906fbe6065ce1815711eee52b2d646e') {
    throw 'Unexpected official Hermes component lock.'
}
[IO.Directory]::CreateDirectory($runtime) | Out-Null
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$downloads = Join-Path $evidence 'downloads'
[IO.Directory]::CreateDirectory($downloads) | Out-Null
$checkout = Join-Path $runtime 'hermes-agent'
$system32 = Join-Path $env:SystemRoot 'System32'
$powershell = Join-Path $system32 'WindowsPowerShell\v1.0\powershell.exe'
$taskkill = Join-Path $system32 'taskkill.exe'
$tar = Join-Path $system32 'tar.exe'
$stageResults = [Collections.Generic.List[object]]::new()
$downloadResults = [Collections.Generic.List[object]]::new()
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$originalUserBash = [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User')
$originalProcessPath = $env:Path
$originalOffline = $env:UV_OFFLINE
$primaryFailure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$receipt = [ordered]@{
    schemaVersion = 1
    classification = 'official-hermes-component-feasibility-only'
    completeRuntime = $false
    installedAcceptance = $false
    upstream = $lock.upstream
    artifacts = $downloadResults
    stages = $stageResults
    status = 'in-progress'
}
try {
    foreach ($artifact in $lock.artifacts) {
        if ($artifact.file -notmatch '^[A-Za-z0-9.+_-]+$' -or $artifact.sha256 -notmatch '^[a-f0-9]{64}$') {
            throw 'Invalid component artifact identity.'
        }
        $target = Join-Path $downloads $artifact.file
        Write-Host "[Hermes components] Downloading and verifying $($artifact.id)"
        Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $target -TimeoutSec 180
        Assert-ComponentHash -Path $target -Sha256 $artifact.sha256
        if ((Get-Item -LiteralPath $target).Length -ne $artifact.size) { throw 'Component artifact size differs from its lock.' }
        $downloadResults.Add($artifact)
        switch ($artifact.id) {
            'hermes-source' {
                & $tar -xzf $target -C $runtime
                if ($LASTEXITCODE -ne 0) { throw 'Official Hermes source extraction failed.' }
                Move-Item -LiteralPath (Join-Path $runtime ('hermes-agent-' + $lock.upstream.commit)) -Destination $checkout
            }
            'uv' {
                $bin = Join-Path $runtime 'bin'
                Expand-Archive -LiteralPath $target -DestinationPath $bin
            }
            'portable-git' {
                $git = Join-Path $runtime 'git'
                $extraction = Invoke-ComponentProcess -FilePath $target -Arguments @(('-o' + $git), '-y') -Label 'portable-git-extract' -TimeoutMilliseconds 180000
                if ($extraction.ExitCode -ne 0) { throw 'Official PortableGit extraction failed.' }
            }
            'python' {
                $managed = Join-Path $checkout '.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none'
                [IO.Directory]::CreateDirectory($managed) | Out-Null
                & $tar -xzf $target -C $managed --strip-components 1
                if ($LASTEXITCODE -ne 0) { throw 'Official managed Python extraction failed.' }
            }
            { $_ -in @('uv-license-apache', 'uv-license-mit') } {
                $licenseRoot = Join-Path $runtime 'licenses\uv'
                [IO.Directory]::CreateDirectory($licenseRoot) | Out-Null
                Copy-Item -LiteralPath $target -Destination (Join-Path $licenseRoot $artifact.file)
            }
            default { throw 'Unexpected official component.' }
        }
    }
    $installer = Join-Path $checkout $lock.upstream.installerPath
    Assert-ComponentHash -Path $installer -Sha256 $lock.upstream.installerSha256
    Assert-ComponentHash -Path (Join-Path $checkout $lock.upstream.dependencyLockPath) -Sha256 $lock.upstream.dependencyLockSha256
    $ownedPath = @((Join-Path $runtime 'bin'), (Join-Path $runtime 'git\cmd'), (Join-Path $runtime 'git\bin'),
        (Join-Path $runtime 'git\usr\bin'), $system32, $env:SystemRoot, (Split-Path -Parent $powershell)) -join ';'
    # The official stage protocol refreshes PATH from HKCU. Use its expected
    # registry contract on this disposable build runner and restore it below.
    [Environment]::SetEnvironmentVariable('Path', $ownedPath, 'User')
    $env:Path = $ownedPath
    $env:UV_OFFLINE = '1'
    foreach ($relative in @('bin\uv.exe', 'git\cmd\git.exe', 'git\bin\bash.exe', 'git\usr\bin\bash.exe',
        'git\usr\bin\true.exe', 'git\usr\bin\cat.exe', 'git\usr\bin\printf.exe', 'git\usr\bin\msys-2.0.dll',
        'hermes-agent\.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe')) {
        $component = Join-Path $runtime $relative
        if (-not (Test-Path -LiteralPath $component -PathType Leaf) -or
            (Get-Item -LiteralPath $component).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            throw 'An exact preseeded component is unavailable; host-tool fallback is forbidden.'
        }
    }
    $bashCheck = Invoke-ComponentProcess -FilePath (Join-Path $runtime 'git\bin\bash.exe') `
        -Arguments @('--noprofile', '--norc', '-c', '/usr/bin/true && /usr/bin/cat --version >/dev/null && /usr/bin/printf HERMES_COMPONENT_BASH_OK') `
        -Label 'owned-bash-preflight' -TimeoutMilliseconds 15000
    if ($bashCheck.ExitCode -ne 0 -or (Get-Content -LiteralPath $bashCheck.StdoutPath -Raw).Trim() -cne 'HERMES_COMPONENT_BASH_OK') {
        throw 'The owned official Git Bash/coreutils cannot run; its repair-download fallback is not permitted.'
    }
    foreach ($stage in @('uv', 'git', 'python', 'venv')) { Invoke-OfficialStage -Name $stage }
    $bash = [Environment]::GetEnvironmentVariable('HERMES_GIT_BASH_PATH', 'User')
    if (-not [string]::Equals($bash, (Join-Path $runtime 'git\bin\bash.exe'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The official installer selected a Bash outside its owned PortableGit tree.'
    }
    $receipt.status = 'components-provisioned'
    $receipt['gitBashRelativePath'] = 'git/bin/bash.exe'
    $receipt['pythonRelativePath'] = 'hermes-agent/venv/Scripts/python.exe'
    Write-Host '[Hermes components] Official component stages passed; MXC execution remains to be tested.'
} catch {
    $primaryFailure = $_
    $receipt.status = 'failed'
    $receipt['failedStage'] = if ($stageResults.Count -gt 0) { 'after-' + $stageResults[$stageResults.Count - 1].stage } else { 'provisioning' }
} finally {
    $cleanupActions = @(
        @{ Label = 'user-path'; Action = { [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User') } },
        @{ Label = 'user-bash'; Action = { [Environment]::SetEnvironmentVariable('HERMES_GIT_BASH_PATH', $originalUserBash, 'User') } },
        @{ Label = 'process-path'; Action = { $env:Path = $originalProcessPath } },
        @{ Label = 'process-offline'; Action = { $env:UV_OFFLINE = $originalOffline } }
    )
    foreach ($cleanup in $cleanupActions) {
        try { & $cleanup.Action }
        catch { $cleanupFailures.Add($cleanup.Label); Write-Warning "Component cleanup failed: $($cleanup.Label)" }
    }
    if ($cleanupFailures.Count -gt 0) {
        $receipt.status = 'failed'
        $receipt['cleanupFailures'] = @($cleanupFailures)
    }
    try { Write-ComponentReceipt -Value $receipt -Path (Join-Path $evidence 'components.json') }
    catch { $cleanupFailures.Add('receipt'); Write-Warning 'The component receipt could not be written.' }
}
if ($null -ne $primaryFailure) { $PSCmdlet.ThrowTerminatingError($primaryFailure) }
if ($cleanupFailures.Count -gt 0) { throw 'Official component cleanup did not finish successfully.' }
