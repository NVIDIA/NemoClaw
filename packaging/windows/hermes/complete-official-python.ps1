# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Run the pinned official Hermes dependency stage on its complete managed venv.
.DESCRIPTION
    Build CI only. The complete official source and uv.lock remain unchanged.
    This exposes native dependency build failures before browser provisioning.
    A successful result proves Python provisioning, not installed acceptance.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [string]$LockPath = (Join-Path $PSScriptRoot 'official-components.lock.json'),
    [string]$BuildToolPath = '',
    [switch]$StageWorker
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$runtimeBuildRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$runtimeBuildEvidence = [IO.Path]::GetFullPath($ArtifactDirectory)
$runtimeBuildLock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
$runtimeBuildSource = Join-Path $runtimeBuildRoot 'hermes-agent'
$runtimeBuildInstaller = Join-Path $runtimeBuildSource 'scripts\install.ps1'
$runtimeBuildPython = Join-Path $runtimeBuildSource 'venv\Scripts\python.exe'
$runtimeBuildBase = Join-Path $runtimeBuildSource '.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe'

function Write-PythonBuildJson {
    param([object]$Value, [string]$Path)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 12) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Assert-PythonBuildSource {
    if ($env:OS -cne 'Windows_NT' -or
        $runtimeBuildRoot -notmatch '^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}$' -or
        $runtimeBuildLock.upstream.commit -cne '2237be355906fbe6065ce1815711eee52b2d646e') {
        throw 'Unexpected official Hermes Windows build identity.'
    }
    foreach ($item in @(
        @($runtimeBuildInstaller, [string]$runtimeBuildLock.upstream.installerSha256),
        @((Join-Path $runtimeBuildSource 'uv.lock'), [string]$runtimeBuildLock.upstream.dependencyLockSha256)
    )) {
        if ((Get-FileHash -LiteralPath $item[0] -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item[1]) {
            throw 'Official Hermes installer or dependency lock differs from its immutable input.'
        }
    }
    foreach ($file in @($runtimeBuildPython, $runtimeBuildBase, (Join-Path $runtimeBuildRoot 'bin\uv.exe'))) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A required managed Python component is missing.' }
    }
    if ($env:HERMES_NIX_BUILD -or $env:UV_NO_EDITABLE) { throw 'Unsupported distribution-build overrides are forbidden.' }
}

Assert-PythonBuildSource
if ($StageWorker) {
    # The official installer explicitly supports dot-sourcing. Invoke its real
    # stage and inspect the tier in that same process, without replacing helpers.
    . $runtimeBuildInstaller -NonInteractive -SkipSetup -SkipComputerUse `
        -Branch $runtimeBuildLock.upstream.tag -Commit $runtimeBuildLock.upstream.commit `
        -HermesHome $runtimeBuildRoot -InstallDir $runtimeBuildSource -Json
    $runtimeBuildBefore = (Get-FileHash -LiteralPath (Join-Path $runtimeBuildSource 'package-lock.json') -Algorithm SHA256).Hash
    $runtimeBuildStage = Get-InstallStage -Name 'dependencies'
    Invoke-Stage -StageDef $runtimeBuildStage
    $runtimeBuildTier = Get-Variable -Name InstalledTier -Scope Script -ValueOnly -ErrorAction SilentlyContinue
    if ($runtimeBuildTier -cne 'hash-verified (uv.lock)') {
        throw 'The official dependency stage fell back from its hash-verified uv.lock tier.'
    }
    Assert-PythonBuildSource
    if ((Get-FileHash -LiteralPath (Join-Path $runtimeBuildSource 'package-lock.json') -Algorithm SHA256).Hash -cne $runtimeBuildBefore) {
        throw 'The Python stage changed the official npm lock.'
    }
    $runtimeBuildCheck = @'
import importlib, importlib.metadata, json, os, sys
expected = sys.argv[1]
assert sys.version_info[:3] == (3, 11, 16), sys.version
assert os.path.normcase(os.path.realpath(sys._base_executable)) == os.path.normcase(os.path.realpath(expected)), sys._base_executable
assert sys.prefix != sys.base_prefix
modules = ['hermes_cli.main', 'tools.terminal_tool', 'tools.file_tools', 'tools.web_tools', 'fastapi', 'uvicorn', 'winpty']
for name in modules:
    importlib.import_module(name)
print(json.dumps({'executable':sys.executable,'baseExecutable':sys._base_executable,'basePrefix':sys.base_prefix,'version':sys.version,'imports':modules,'packages':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda x:x['name'].lower())}))
'@
    $runtimeBuildImportText = Invoke-NativeWithRelaxedErrorAction { & $runtimeBuildPython -I -c $runtimeBuildCheck $runtimeBuildBase }
    if ($LASTEXITCODE -ne 0) { throw 'The official full Python environment failed its exact interpreter/import checks.' }
    $runtimeBuildImport = ($runtimeBuildImportText | Select-Object -Last 1) | ConvertFrom-Json
    Write-PythonBuildJson -Value ([ordered]@{
        schemaVersion = 1; classification = 'official-hermes-python-provisioning-only'
        completeRuntime = $false; installedAcceptance = $false; relocatedRuntimeValidated = $false
        upstream = $runtimeBuildLock.upstream; installedTier = $runtimeBuildTier
        python = $runtimeBuildImport; status = 'python-provisioned'
    }) -Path (Join-Path $runtimeBuildEvidence 'official-python-worker.json')
    exit 0
}

if (Test-Path -LiteralPath $runtimeBuildEvidence) { throw 'Python build evidence must use a fresh directory.' }
[IO.Directory]::CreateDirectory($runtimeBuildEvidence) | Out-Null
$runtimeBuildSystem32 = Join-Path $env:SystemRoot 'System32'
$runtimeBuildPowerShell = Join-Path $runtimeBuildSystem32 'WindowsPowerShell\v1.0\powershell.exe'
$runtimeBuildTaskkill = Join-Path $runtimeBuildSystem32 'taskkill.exe'
$runtimeBuildSavedUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$runtimeBuildOwnedPath = @((Join-Path $runtimeBuildRoot 'bin'), (Join-Path $runtimeBuildRoot 'git\cmd'),
    (Join-Path $runtimeBuildRoot 'git\bin'), $BuildToolPath, (Join-Path $runtimeBuildRoot 'git\usr\bin'),
    (Split-Path $runtimeBuildPython -Parent), $runtimeBuildSystem32, $env:SystemRoot,
    (Split-Path $runtimeBuildPowerShell -Parent)) -join ';'
$runtimeBuildProcess = $null
$runtimeBuildOutputFile = $null
$runtimeBuildErrorFile = $null
$runtimeBuildCleanupErrors = [Collections.Generic.List[string]]::new()
$runtimeBuildPrimaryFailure = $null
$runtimeBuildReceipt = [ordered]@{
    schemaVersion = 1; classification = 'official-hermes-python-build-attempt'
    completeRuntime = $false; installedAcceptance = $false; status = 'failed'
    timeoutSeconds = 1200; cleanupStopped = $false; upstream = $runtimeBuildLock.upstream
    buildRequirementsSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'official-python-build.requirements.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
}
try {
    [Environment]::SetEnvironmentVariable('Path', $runtimeBuildOwnedPath, 'User')
    $runtimeBuildStart = [Diagnostics.ProcessStartInfo]::new()
    $runtimeBuildStart.FileName = $runtimeBuildPowerShell
    $runtimeBuildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
        '-RuntimeRoot', $runtimeBuildRoot, '-ArtifactDirectory', $runtimeBuildEvidence,
        '-LockPath', ([IO.Path]::GetFullPath($LockPath)), '-StageWorker')
    foreach ($value in $runtimeBuildArgs) {
        if ($value -match '["\r\n]') { throw 'An official build argument contains an unsupported character.' }
    }
    $runtimeBuildStart.Arguments = ($runtimeBuildArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $runtimeBuildStart.UseShellExecute = $false
    $runtimeBuildStart.CreateNoWindow = $true
    $runtimeBuildStart.RedirectStandardOutput = $true
    $runtimeBuildStart.RedirectStandardError = $true
    $runtimeBuildStart.EnvironmentVariables.Clear()
    foreach ($name in @('SystemRoot','SystemDrive','WINDIR','COMSPEC','OS','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','NUMBER_OF_PROCESSORS','INCLUDE','LIB','LIBPATH','VCINSTALLDIR','VCToolsInstallDir','WindowsSdkDir','WindowsSDKVersion','WindowsSdkVerBinPath','UniversalCRTSdkDir','UCRTVersion','VSCMD_ARG_TGT_ARCH','VSCMD_ARG_HOST_ARCH','CARGO_HOME','RUSTUP_HOME')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $runtimeBuildStart.EnvironmentVariables[$name] = $value }
    }
    $runtimeBuildStart.EnvironmentVariables['PATH'] = $runtimeBuildOwnedPath
    $runtimeBuildStart.EnvironmentVariables['UV_LINK_MODE'] = 'copy'
    $runtimeBuildStart.EnvironmentVariables['UV_CACHE_DIR'] = (Join-Path $runtimeBuildEvidence 'uv-cache')
    $runtimeBuildStart.EnvironmentVariables['UV_PYTHON_DOWNLOADS'] = 'never'
    $runtimeBuildStart.EnvironmentVariables['UV_KEYRING_PROVIDER'] = 'disabled'
    $runtimeBuildStart.EnvironmentVariables['UV_BUILD_CONSTRAINT'] = (Join-Path $PSScriptRoot 'official-python-build.requirements.txt')
    if ($env:UV_FIND_LINKS) { $runtimeBuildStart.EnvironmentVariables['UV_FIND_LINKS'] = $env:UV_FIND_LINKS }
    $runtimeBuildOutputFile = [IO.File]::Open((Join-Path $runtimeBuildEvidence 'dependencies.stdout.log'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $runtimeBuildErrorFile = [IO.File]::Open((Join-Path $runtimeBuildEvidence 'dependencies.stderr.log'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $runtimeBuildProcess = [Diagnostics.Process]::Start($runtimeBuildStart)
    $runtimeBuildStdout = $runtimeBuildProcess.StandardOutput.BaseStream.CopyToAsync($runtimeBuildOutputFile)
    $runtimeBuildStderr = $runtimeBuildProcess.StandardError.BaseStream.CopyToAsync($runtimeBuildErrorFile)
    $runtimeBuildDeadline = [DateTime]::UtcNow.AddSeconds(1200)
    while (-not $runtimeBuildProcess.WaitForExit(15000)) {
        if ($runtimeBuildStdout.IsFaulted) { $runtimeBuildStdout.GetAwaiter().GetResult() }
        if ($runtimeBuildStderr.IsFaulted) { $runtimeBuildStderr.GetAwaiter().GetResult() }
        Write-Host '[Hermes runtime] Official locked Python dependencies are still provisioning.'
        if ([DateTime]::UtcNow -ge $runtimeBuildDeadline) { throw 'The official Python dependency stage exceeded twenty minutes.' }
    }
    $runtimeBuildReceipt.cleanupStopped = $true
    if (-not $runtimeBuildStdout.Wait(10000) -or -not $runtimeBuildStderr.Wait(10000)) {
        throw 'The official dependency process did not close its owned output pipes.'
    }
    $runtimeBuildOutputFile.Flush()
    $runtimeBuildErrorFile.Flush()
    if ((Get-Item -LiteralPath (Join-Path $runtimeBuildEvidence 'dependencies.stdout.log')).Length -gt 2MB) {
        throw 'The official dependency stage exceeded its protocol output bound.'
    }
    $runtimeBuildOutput = Get-Content -LiteralPath (Join-Path $runtimeBuildEvidence 'dependencies.stdout.log') -Raw
    if ($runtimeBuildProcess.ExitCode -ne 0 -or
        $runtimeBuildOutput -match 'falling back to PyPI|Trying tier: (all|core)|Reinstalling entry points|targeted install of \[web\]') {
        throw 'The official locked Python dependency stage failed or used a recovery path; full logs were retained.'
    }
    $runtimeBuildReceipt.status = 'python-provisioned'
} catch {
    $runtimeBuildReceipt['error'] = $_.Exception.Message
    $runtimeBuildPrimaryFailure = $_
} finally {
    if ($null -ne $runtimeBuildProcess) {
        try {
            if (-not $runtimeBuildProcess.HasExited) {
                $runtimeBuildCleanup = Start-Process -FilePath $runtimeBuildTaskkill -ArgumentList @('/PID', $runtimeBuildProcess.Id, '/T', '/F') -PassThru -NoNewWindow
                try {
                    if (-not $runtimeBuildCleanup.WaitForExit(10000)) {
                        $runtimeBuildCleanup.Kill()
                        $null = $runtimeBuildCleanup.WaitForExit(1000)
                        throw 'The exact-owned process-tree cleanup helper timed out.'
                    }
                } finally { $runtimeBuildCleanup.Dispose() }
                $runtimeBuildReceipt.cleanupStopped = $runtimeBuildProcess.WaitForExit(10000)
            }
        } catch { $runtimeBuildCleanupErrors.Add($_.Exception.Message) }
    }
    foreach ($resource in @($runtimeBuildProcess, $runtimeBuildOutputFile, $runtimeBuildErrorFile)) {
        if ($null -ne $resource) {
            try { $resource.Dispose() } catch { $runtimeBuildCleanupErrors.Add($_.Exception.Message) }
        }
    }
    try { [Environment]::SetEnvironmentVariable('Path', $runtimeBuildSavedUserPath, 'User') }
    catch { $runtimeBuildCleanupErrors.Add($_.Exception.Message) }
    $runtimeBuildReceipt['cleanupErrors'] = @($runtimeBuildCleanupErrors.ToArray())
    if ($runtimeBuildCleanupErrors.Count -gt 0 -or -not $runtimeBuildReceipt.cleanupStopped) {
        $runtimeBuildReceipt.status = 'failed'
    }
    try { Write-PythonBuildJson -Value $runtimeBuildReceipt -Path (Join-Path $runtimeBuildEvidence 'python-build-attempt.json') }
    catch {
        $runtimeBuildCleanupErrors.Add($_.Exception.Message)
        $runtimeBuildReceipt.status = 'failed'
    }
}
if ($null -ne $runtimeBuildPrimaryFailure) {
    if ($runtimeBuildCleanupErrors.Count -gt 0) { Write-Warning 'The official dependency failure also encountered cleanup or receipt-write errors.' }
    $PSCmdlet.ThrowTerminatingError($runtimeBuildPrimaryFailure)
}
if ($runtimeBuildReceipt.status -cne 'python-provisioned') { throw 'The official Python build did not finish its owned cleanup.' }
$runtimeBuildCompleted = Get-Content -LiteralPath (Join-Path $runtimeBuildEvidence 'official-python-worker.json') -Raw | ConvertFrom-Json
Write-PythonBuildJson -Value $runtimeBuildCompleted -Path (Join-Path $runtimeBuildEvidence 'official-python.json')
