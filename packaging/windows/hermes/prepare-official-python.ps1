# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Prepare and record the exact canonical Hermes Python build prerequisites.
.DESCRIPTION
    CI only. Run inside the selected Visual Studio ARM64 developer environment.
    This completes the official editable dependency stage before baseline setup;
    it never creates a completed runtime or installed acceptance marker.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuntimeRoot,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [Parameter(Mandatory)][string]$ComponentEvidenceDirectory,
    [Parameter(Mandatory)][string]$RustcPath,
    [Parameter(Mandatory)][string]$CargoPath,
    [string]$LockPath = '',
    [switch]$ResolveInputPathsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Windows PowerShell5.1 does not populate script automatic variables while
# binding default script parameters through -File (PowerShell issue4688).
if ([string]::IsNullOrEmpty($LockPath)) {
    $LockPath = Join-Path ([IO.Path]::GetDirectoryName($PSCommandPath)) 'official-python.lock.json'
}
if ($ResolveInputPathsOnly) {
    [pscustomobject]@{ classification = 'python-input-path-control'; scriptPath = $PSCommandPath;
        lockPath = [IO.Path]::GetFullPath($LockPath); exists = [IO.File]::Exists($LockPath) } |
        ConvertTo-Json -Compress | Write-Output
    return
}
$ProgressPreference = 'SilentlyContinue'

function Write-PythonPhaseJson {
    param([object]$Value, [string]$Path)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 14) + "`n"), [Text.UTF8Encoding]::new($false))
}

function Get-PythonPhaseMsvcTools {
    param([Parameter(Mandatory)][string]$ToolsRoot)
    if (-not [IO.Path]::IsPathRooted($ToolsRoot)) { throw 'MSVC tools require an absolute selected installation path.' }
    $directory = [IO.Path]::GetFullPath((Join-Path $ToolsRoot 'bin/HostARM64/ARM64'))
    $result = @{}
    foreach ($entry in @(@('compiler','cl.exe'), @('linker','link.exe'))) {
        $file = Get-Item -LiteralPath (Join-Path $directory $entry[1]) -ErrorAction Stop
        if ($file.PSIsContainer -or $file.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            throw 'A selected MSVC tool must be an ordinary file.'
        }
        $result[$entry[0]] = $file.FullName
    }
    return [pscustomobject]$result
}

function Get-PythonPhaseFileIdentity {
    param([Parameter(Mandatory)][string]$Path)
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
        throw 'A Python build executable must be a regular file.'
    }
    $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($item.FullName))
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'The build input is not a Windows executable.' }
        $reader.BaseStream.Position = 0x3c
        $pe = $reader.ReadUInt32()
        if ($pe + 6 -gt $reader.BaseStream.Length) { throw 'The build executable PE header is invalid.' }
        $reader.BaseStream.Position = $pe
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'The build executable PE signature is invalid.' }
        $machine = $reader.ReadUInt16()
    } finally { $reader.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
    return [pscustomobject]@{
        path = $item.FullName
        bytes = $item.Length
        sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        peMachine = ('0x{0:x4}' -f $machine)
        fileVersion = $item.VersionInfo.FileVersion
        signatureStatus = [string]$signature.Status
        signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
        signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
    }
}

function Assert-PythonPhaseResult {
    param([Parameter(Mandatory)][object]$Result)
    if ($Result.schemaVersion -ne 1 -or $Result.status -cne 'python-provisioned' -or
        $Result.installedTier -cne 'hash-verified (uv.lock)' -or
        $Result.upstream.commit -cne '2237be355906fbe6065ce1815711eee52b2d646e' -or
        $Result.completeRuntime -isnot [bool] -or $Result.completeRuntime -ne $false -or
        $Result.installedAcceptance -isnot [bool] -or $Result.installedAcceptance -ne $false) {
        throw 'The official Python phase did not satisfy its exact locked result contract.'
    }
    if ($Result.python.cryptographyVersion -cne '50.0.0' -or $Result.python.opensslVersion -cnotmatch '^OpenSSL 3\.5\.8(?: |$)') {
        throw 'The locked cryptography module did not load its pinned built OpenSSL.'
    }
    $imports = @($Result.python.imports)
    foreach ($name in @('hermes_cli.main','tools.terminal_tool','tools.file_tools','tools.web_tools','fastapi','uvicorn','winpty')) {
        if ($imports -cnotcontains $name) { throw "The official Python phase did not import $name." }
    }
    $winpty = @($Result.python.packages | Where-Object { $_.name -eq 'pywinpty' })
    $hermes = @($Result.python.packages | Where-Object { $_.name -eq 'hermes-agent' })
    if ($winpty.Count -ne 1 -or $winpty[0].version -cne '2.0.15' -or
        $hermes.Count -ne 1 -or $hermes[0].version -cne '0.21.1') {
        throw 'The official Hermes or pywinpty version was substituted.'
    }
}

if ($env:OS -cne 'Windows_NT') { throw 'The canonical Python phase requires Windows.' }
$phaseRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$phaseEvidence = [IO.Path]::GetFullPath($ArtifactDirectory)
if ($phaseRoot -cnotmatch '^[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}\z' -or
    (Test-Path -LiteralPath $phaseEvidence)) { throw 'The Python phase requires owned runtime and fresh evidence roots.' }
[IO.Directory]::CreateDirectory($phaseEvidence) | Out-Null
$phaseLock = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
$phaseSource = Join-Path $phaseRoot 'hermes-agent'
$phaseComponentReceipt = Join-Path $ComponentEvidenceDirectory 'components.json'
$phaseReceipt = [ordered]@{
    schemaVersion = 1; classification = 'official-hermes-python-phase'
    completeRuntime = $false; installedAcceptance = $false; conptyExecutionTested = $false
    status = 'failed'; upstreamCommit = $phaseLock.upstreamCommit
    inputLockSha256 = (Get-FileHash -LiteralPath $LockPath -Algorithm SHA256).Hash.ToLowerInvariant()
    componentReceiptSha256 = (Get-FileHash -LiteralPath $phaseComponentReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
    artifacts = [Collections.Generic.List[object]]::new()
    executables = [Collections.Generic.List[object]]::new()
}
$phaseOriginalFindLinks = $env:UV_FIND_LINKS
$phaseOriginalCargoHome = $env:CARGO_HOME
$phaseOriginalOpenSslRoot = $env:OPENSSL_DIR
$phaseOriginalOpenSslStatic = $env:OPENSSL_STATIC
$phaseFailure = $null
$phaseReceiptFailure = $null
try {
    if ($phaseLock.schemaVersion -ne 1 -or $phaseLock.classification -cne 'official-hermes-python-phase-inputs' -or
        $phaseLock.upstreamCommit -cne '2237be355906fbe6065ce1815711eee52b2d646e') { throw 'Unexpected Python phase input identity.' }
    $components = Get-Content -LiteralPath $phaseComponentReceipt -Raw | ConvertFrom-Json
    if ($components.status -cne 'components-provisioned' -or $components.upstream.commit -cne $phaseLock.upstreamCommit) {
        throw 'The official managed prerequisites did not finish provisioning.'
    }
    foreach ($property in $phaseLock.upstreamFiles.PSObject.Properties) {
        $file = Join-Path $phaseSource $property.Name
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $property.Value) {
            throw "The official source input changed: $($property.Name)"
        }
    }
    $requirements = Join-Path $PSScriptRoot $phaseLock.requirementsFile
    if ((Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant() -cne $phaseLock.requirementsSha256) {
        throw 'The pinned Python build dependency graph changed.'
    }
    $phaseReceipt['msvc'] = [ordered]@{
        developerEnvironmentVersion = $env:VSCMD_VER; toolsetVersion = $env:VCToolsVersion
        windowsSdkVersion = $env:WindowsSDKVersion; installationRoot = $env:VSINSTALLDIR
        host = $env:VSCMD_ARG_HOST_ARCH; target = $env:VSCMD_ARG_TGT_ARCH
        versionSelectionPinned = $true; executableHashScope = 'Successfully inspected tools in executables; incomplete on failure.'
    }
    if ($env:VSCMD_ARG_TGT_ARCH -cne $phaseLock.msvcTarget -or $env:VSCMD_ARG_HOST_ARCH -cne $phaseLock.msvcHost) {
        throw 'The selected Visual Studio environment is not native ARM64.'
    }
    if ($env:VCToolsVersion.TrimEnd('\') -cne $phaseLock.msvcToolset -or
        $env:WindowsSDKVersion.TrimEnd('\') -cne $phaseLock.windowsSdk) {
        throw 'The selected MSVC toolset or Windows SDK differs from the recorded version pin.'
    }
    $rustc = [IO.Path]::GetFullPath($RustcPath)
    $cargo = [IO.Path]::GetFullPath($CargoPath)
    $rustBin = Split-Path -Parent $rustc
    if ((Split-Path -Parent $cargo) -cne $rustBin) { throw 'Rust compiler and Cargo must come from the same pinned toolchain.' }
    # Get-Command can return multiple ApplicationInfo objects for one name.
    # Resolve both tools inside the chosen native toolset, independent of PATH.
    $msvcTools = Get-PythonPhaseMsvcTools -ToolsRoot $env:VCToolsInstallDir
    $cl = $msvcTools.compiler
    $link = $msvcTools.linker
    foreach ($file in @($rustc, $cargo, $cl, $link, (Join-Path $phaseRoot 'bin\uv.exe'),
        (Join-Path $phaseSource '.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe'))) {
        $identity = Get-PythonPhaseFileIdentity -Path $file
        if ($identity.peMachine -cne '0xaa64') { throw 'An early Python build executable is not native ARM64.' }
        $phaseReceipt.executables.Add($identity)
    }
    $rustVersion = (& $rustc -vV) -join "`n"
    if ($LASTEXITCODE -ne 0 -or $rustVersion -notmatch '(?m)^release: 1\.95\.0\r?$' -or
        $rustVersion -notmatch '(?m)^host: aarch64-pc-windows-msvc\r?$') { throw 'The selected Rust version or host differs from the pin.' }
    $phaseReceipt['rustVersionOutput'] = $rustVersion
    $allowedBuildRoots = @($rustBin, $env:VSINSTALLDIR, $env:WindowsSdkDir) | Where-Object { $_ }
    $buildPaths = @($rustBin, (Split-Path -Parent $cl))
    foreach ($entry in ($env:PATH -split ';')) {
        if (-not $entry -or -not [IO.Path]::IsPathRooted($entry)) { continue }
        $absolute = [IO.Path]::GetFullPath($entry).TrimEnd('\')
        foreach ($root in $allowedBuildRoots) {
            $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\')
            if ([string]::Equals($absolute, $prefix, [StringComparison]::OrdinalIgnoreCase) -or
                $absolute.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) {
                if ($buildPaths -notcontains $absolute) { $buildPaths += $absolute }
                break
            }
        }
    }
    $phaseReceipt['buildToolPaths'] = $buildPaths
    $opensslLock = Join-Path $PSScriptRoot $phaseLock.opensslBuildLock
    if ((Get-FileHash -LiteralPath $opensslLock -Algorithm SHA256).Hash.ToLowerInvariant() -cne $phaseLock.opensslBuildLockSha256) {
        throw 'The official OpenSSL build prerequisite lock changed.'
    }
    $opensslEvidence = Join-Path $phaseEvidence 'openssl'
    $basePython = Join-Path $phaseSource '.hermes-runtime\python\cpython-3.11.16-windows-aarch64-none\python.exe'
    $opensslArguments = @('-I', (Join-Path $PSScriptRoot 'prepare-official-openssl.py'), '--artifact-directory', $opensslEvidence,
        '--compiler-directory', (Split-Path -Parent $cl), '--lock', $opensslLock)
    foreach ($directory in $buildPaths) { $opensslArguments += @('--build-tool-path', $directory) }
    & $basePython @opensslArguments
    if ($LASTEXITCODE -ne 0) { throw 'The pinned native OpenSSL prerequisite failed before the official Python dependency stage.' }
    $opensslReceipt = Join-Path $opensslEvidence 'openssl-build.json'
    $openssl = Get-Content -LiteralPath $opensslReceipt -Raw | ConvertFrom-Json
    if ($openssl.status -cne 'sdk-built' -or $openssl.opensslVersion -cne '3.5.8' -or
        $openssl.static -isnot [bool] -or $openssl.static -ne $true -or
        $openssl.inputLockSha256 -cne $phaseLock.opensslBuildLockSha256 -or
        -not [string]::Equals([IO.Path]::GetFullPath($openssl.sdkRoot), (Join-Path $opensslEvidence 'sdk'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The OpenSSL prerequisite did not produce its exact owned static SDK.'
    }
    $phaseReceipt['opensslReceiptSha256'] = (Get-FileHash -LiteralPath $opensslReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
    $env:OPENSSL_DIR = $openssl.sdkRoot
    $env:OPENSSL_STATIC = '1'
    $downloads = Join-Path $phaseEvidence 'downloads'
    [IO.Directory]::CreateDirectory($downloads) | Out-Null
    foreach ($artifact in $phaseLock.artifacts) {
        if ($artifact.file -cnotmatch '^[A-Za-z0-9_.+-]+\.whl\z' -or $artifact.sha256 -cnotmatch '^[a-f0-9]{64}\z' -or
            -not $artifact.url.StartsWith('https://files.pythonhosted.org/', [StringComparison]::Ordinal)) { throw 'Invalid pinned build artifact.' }
        $file = Join-Path $downloads $artifact.file
        Write-Host "[Hermes Python] Downloading $($artifact.id): $($artifact.size) bytes."
        Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $file -TimeoutSec 180
        if ((Get-Item -LiteralPath $file).Length -ne $artifact.size -or
            (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.sha256) { throw 'A pinned build wheel failed its size/hash check.' }
        $phaseReceipt.artifacts.Add($artifact)
    }
    $env:UV_FIND_LINKS = $downloads
    $env:CARGO_HOME = Join-Path $phaseEvidence 'cargo-home'
    & (Join-Path $PSScriptRoot 'complete-official-python.ps1') -RuntimeRoot $phaseRoot `
        -ArtifactDirectory (Join-Path $phaseEvidence 'dependency-stage') `
        -LockPath (Join-Path $PSScriptRoot 'official-components.lock.json') -BuildToolPath ($buildPaths -join ';')
    $resultPath = Join-Path $phaseEvidence 'dependency-stage\official-python.json'
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    Assert-PythonPhaseResult -Result $result
    $phaseReceipt['dependencyReceiptSha256'] = (Get-FileHash -LiteralPath $resultPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $phaseReceipt.status = 'python-provisioned'
} catch {
    $phaseFailure = $_
    $phaseReceipt['error'] = $_.Exception.Message
    $phaseReceipt['errorContext'] = @{ type = $_.Exception.GetType().FullName; scriptStackTrace = $_.ScriptStackTrace }
}
finally {
    $env:UV_FIND_LINKS = $phaseOriginalFindLinks
    $env:CARGO_HOME = $phaseOriginalCargoHome
    $env:OPENSSL_DIR = $phaseOriginalOpenSslRoot
    $env:OPENSSL_STATIC = $phaseOriginalOpenSslStatic
    try { Write-PythonPhaseJson -Value $phaseReceipt -Path (Join-Path $phaseEvidence 'python-phase.json') }
    catch { $phaseReceiptFailure = $_ }
}
if ($null -ne $phaseFailure) {
    if ($null -ne $phaseReceiptFailure) { Write-Warning 'The Python phase also failed to write its receipt.' }
    $PSCmdlet.ThrowTerminatingError($phaseFailure)
}
if ($null -ne $phaseReceiptFailure) { $PSCmdlet.ThrowTerminatingError($phaseReceiptFailure) }
