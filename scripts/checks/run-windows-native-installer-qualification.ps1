# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualify the no-WSL native Windows installer against OpenShell PR #2721.

.DESCRIPTION
    Verifies exact candidate and OpenShell source authority before executing the
    candidate installer. The qualification installs, damages, repairs, and
    uninstalls the candidate distribution, checks prohibited runtime processes
    before and after execution, and atomically publishes bounded receipts.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory)][string]$InstallerSha256,
    [Parameter(Mandatory)][string]$OpenShellCheckout,
    [Parameter(Mandatory)][string]$OpenShellSha,
    [Parameter(Mandatory)][string]$ArtifactDirectory,
    [string]$WxcExecPath,
    [string]$WxcExecSha256 = '6049c64723af1173c3739dc6cd6b2f33f6c021bb2832c4216233cba7f71aee9a'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CanonicalNemoClawRepository = 'https://github.com/NVIDIA/NemoClaw.git'
$script:CanonicalOpenShellRepository = 'https://github.com/NVIDIA/OpenShell.git'
$script:TrustedOpenShellPullRequest = 2721
$script:TrustedOpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'
$script:ShaPattern = '^[a-f0-9]{40}$'
$script:Sha256Pattern = '^[a-f0-9]{64}$'
$script:MaxJsonBytes = 16384
$script:MaxInstallerBytes = 524288

function Fail-Qualification {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native installer qualification failed: $Message"
}

function Get-FileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Resolve-PlainDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-Qualification "$Label is missing."
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-Qualification "$Label must not be a reparse point."
    }
    return $resolved
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git -C $Root @Arguments 2>$null
    $status = $LASTEXITCODE
    if (-not $AllowFailure -and $status -ne 0) {
        Fail-Qualification "Git could not verify $Root."
    }
    return [pscustomobject]@{
        Status = $status
        Output = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
    }
}

function Assert-Checkout {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ExpectedRevision,
        [Parameter(Mandatory)][string]$ExpectedRepository,
        [Parameter(Mandatory)][string]$Label
    )

    $checkout = Resolve-PlainDirectory -Path $Root -Label $Label
    if (-not (Test-Path -LiteralPath (Join-Path $checkout '.git'))) {
        Fail-Qualification "$Label has no Git metadata."
    }
    $revision = (Invoke-Git -Root $checkout -Arguments @('rev-parse', '--verify', 'HEAD^{commit}')).Output
    if ($revision -cne $ExpectedRevision) {
        Fail-Qualification "$Label does not match the expected revision."
    }
    $repository = (Invoke-Git -Root $checkout -Arguments @(
        'config', '--local', '--no-includes', '--get', 'remote.origin.url'
    )).Output
    $allowedRepositories = @($ExpectedRepository, $ExpectedRepository.Substring(0, $ExpectedRepository.Length - 4))
    if ($allowedRepositories -cnotcontains $repository) {
        Fail-Qualification "$Label has an unexpected origin repository."
    }
    foreach ($pattern in @('^credential\.', '^http\..*\.extraheader$')) {
        $credentialMatch = Invoke-Git -Root $checkout -Arguments @(
            'config', '--local', '--no-includes', '--get-regexp', $pattern
        ) -AllowFailure
        if ($credentialMatch.Status -eq 0) {
            Fail-Qualification "$Label must not store Git credentials."
        }
    }
    return $checkout
}

function Assert-CommittedFile {
    param(
        [Parameter(Mandatory)][string]$Checkout,
        [Parameter(Mandatory)][string]$Revision,
        [Parameter(Mandatory)][string]$RelativePath,
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
        Fail-Qualification "Candidate file is missing: $RelativePath"
    }
    $committedBlob = (Invoke-Git -Root $Checkout -Arguments @(
        'rev-parse', "${Revision}:${RelativePath}"
    )).Output
    $workingBlob = (Invoke-Git -Root $Checkout -Arguments @(
        'hash-object', '--no-filters', '--', $FilePath
    )).Output
    if ($workingBlob -cne $committedBlob) {
        Fail-Qualification "Candidate file bytes do not match the candidate commit: $RelativePath"
    }
    if ((Get-FileSha256 -Path $FilePath) -cne $ExpectedSha256) {
        Fail-Qualification "Candidate file SHA-256 does not match the trusted plan: $RelativePath"
    }
}

function Assert-InstallerProcessBoundary {
    param([Parameter(Mandatory)][string]$InstallerPath)

    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile(
        $InstallerPath,
        [ref]$tokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -ne 0) {
        Fail-Qualification 'Candidate installer has PowerShell parse errors.'
    }
    $prohibitedCommands = @(
        'bash', 'bash.exe', 'cmd', 'cmd.exe', 'docker', 'docker.exe',
        'invoke-expression', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
        'start-process', 'ubuntu', 'ubuntu.exe', 'wsl', 'wsl.exe'
    )
    $commands = $ast.FindAll({
        param($node)
        return $node -is [Management.Automation.Language.CommandAst]
    }, $true)
    foreach ($command in $commands) {
        $name = $command.GetCommandName()
        if ($null -eq $name) {
            Fail-Qualification 'Candidate installer contains a dynamic command invocation.'
        }
        if ($prohibitedCommands -ccontains $name.ToLowerInvariant()) {
            Fail-Qualification "Candidate installer invokes a prohibited command: $name"
        }
    }
    $source = Get-Content -LiteralPath $InstallerPath -Raw
    if ($source -match '(?i)\[\s*(?:System\.)?Diagnostics\.Process\s*\]\s*::\s*Start') {
        Fail-Qualification 'Candidate installer invokes System.Diagnostics.Process.Start.'
    }
}

function Assert-ProhibitedProcessesAbsent {
    param([Parameter(Mandatory)][string]$Phase)

    $prohibited = @('bash', 'docker', 'dockerd', 'wsl')
    $found = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $name = $_.ProcessName.ToLowerInvariant()
        $prohibited -ccontains $name -or $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    })
    if ($found.Count -ne 0) {
        Fail-Qualification "A prohibited WSL or Docker process exists during the $Phase check."
    }
    return [pscustomobject]@{
        phase = $Phase
        wslAbsent = $true
        bashAbsent = $true
        dockerAbsent = $true
        ubuntuAbsent = $true
    }
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $text = ($Value | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Assert-BoundedFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][long]$MaximumBytes
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Path).Length -gt $MaximumBytes) {
        Fail-Qualification "Qualification receipt exceeds its size limit: $(Split-Path -Leaf $Path)"
    }
}

if ($CandidateSha -cnotmatch $script:ShaPattern -or $OpenShellSha -cnotmatch $script:ShaPattern) {
    Fail-Qualification 'Candidate and OpenShell revisions must be lowercase 40-character commit SHAs.'
}
if ($InstallerSha256 -cnotmatch $script:Sha256Pattern -or $WxcExecSha256 -cnotmatch $script:Sha256Pattern) {
    Fail-Qualification 'Installer and wxc-exec digests must be lowercase SHA-256 values.'
}
if ($OpenShellSha -cne $script:TrustedOpenShellRevision) {
    Fail-Qualification 'OpenShell revision must match PR #2721 merge commit.'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'Arm64') {
    Fail-Qualification 'Windows native installer qualification requires a native ARM64 runner.'
}

$candidateCheckoutParameters = @{
    Root = $CandidateCheckout
    ExpectedRevision = $CandidateSha
    ExpectedRepository = $script:CanonicalNemoClawRepository
    Label = 'Candidate checkout'
}
$candidateRoot = Assert-Checkout @candidateCheckoutParameters
$openShellCheckoutParameters = @{
    Root = $OpenShellCheckout
    ExpectedRevision = $OpenShellSha
    ExpectedRepository = $script:CanonicalOpenShellRepository
    Label = 'OpenShell checkout'
}
$openShellRoot = Assert-Checkout @openShellCheckoutParameters
$installer = Join-Path $candidateRoot 'scripts\install-windows-native.ps1'
$committedInstallerParameters = @{
    Checkout = $candidateRoot
    Revision = $CandidateSha
    RelativePath = 'scripts/install-windows-native.ps1'
    FilePath = $installer
    ExpectedSha256 = $InstallerSha256
}
Assert-CommittedFile @committedInstallerParameters
Assert-InstallerProcessBoundary -InstallerPath $installer

$artifactPath = [IO.Path]::GetFullPath($ArtifactDirectory).TrimEnd('\')
$artifactParent = Split-Path -Parent $artifactPath
$artifactName = Split-Path -Leaf $artifactPath
if (-not (Test-Path -LiteralPath $artifactParent -PathType Container) -or
    (Test-Path -LiteralPath $artifactPath) -or $artifactName -cnotmatch '^[A-Za-z0-9._-]+$') {
    Fail-Qualification 'ArtifactDirectory must be a new child of an existing directory.'
}

$qualificationRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-windows-native-' + [guid]::NewGuid().ToString('N'))
$payloadRoot = Join-Path $qualificationRoot 'payload'
$installRoot = Join-Path $qualificationRoot 'install'
$receiptStage = Join-Path $artifactParent ('.' + $artifactName + '.' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($payloadRoot) | Out-Null
[IO.Directory]::CreateDirectory($receiptStage) | Out-Null

try {
    $releaseRoot = Join-Path $openShellRoot 'target\aarch64-pc-windows-msvc\release'
    $distributionEntries = @()
    foreach ($fileName in @('openshell.exe', 'openshell-gateway.exe')) {
        $source = Join-Path $releaseRoot $fileName
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Fail-Qualification "OpenShell PR #2721 build output is missing: $fileName"
        }
        $payloadRelative = "bin\$fileName"
        $payloadPath = Join-Path $payloadRoot $payloadRelative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $payloadPath)) | Out-Null
        [IO.File]::Copy($source, $payloadPath, $false)
        $distributionEntries += [pscustomobject]@{
            source = $payloadRelative
            destination = $payloadRelative
            sha256 = Get-FileSha256 -Path $payloadPath
            required = $true
        }
    }
    $z3Source = Join-Path $releaseRoot 'libz3.dll'
    if (Test-Path -LiteralPath $z3Source -PathType Leaf) {
        $z3Relative = 'bin\libz3.dll'
        [IO.File]::Copy($z3Source, (Join-Path $payloadRoot $z3Relative), $false)
        $distributionEntries += [pscustomobject]@{
            source = $z3Relative
            destination = $z3Relative
            sha256 = Get-FileSha256 -Path (Join-Path $payloadRoot $z3Relative)
            required = $true
        }
    }

    $wxcRelative = 'mxc\wxc-exec.exe'
    if (-not [string]::IsNullOrWhiteSpace($WxcExecPath)) {
        $resolvedWxc = [IO.Path]::GetFullPath($WxcExecPath)
        if (-not (Test-Path -LiteralPath $resolvedWxc -PathType Leaf) -or
            (Get-FileSha256 -Path $resolvedWxc) -cne $WxcExecSha256) {
            Fail-Qualification 'wxc-exec candidate is missing or has the wrong digest.'
        }
        $wxcPayload = Join-Path $payloadRoot $wxcRelative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $wxcPayload)) | Out-Null
        [IO.File]::Copy($resolvedWxc, $wxcPayload, $false)
    }
    $distributionEntries += [pscustomobject]@{
        source = $wxcRelative
        destination = $wxcRelative
        sha256 = $WxcExecSha256
        required = $false
    }

    $manifest = [pscustomobject]@{
        schemaVersion = 1
        classification = 'qualification-only'
        platform = 'windows'
        architecture = 'arm64'
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        files = @($distributionEntries)
    }
    $manifestPath = Join-Path $payloadRoot 'distribution-manifest.json'
    Write-JsonFile -Path $manifestPath -Value $manifest

    $preExecution = Assert-ProhibitedProcessesAbsent -Phase 'pre-execution'
    $installParameters = @{
        Action = 'Install'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
        Json = $true
    }
    $installOutput = & $installer @installParameters
    $installReceiptPath = Join-Path $installRoot 'install-receipt.json'
    if (-not (Test-Path -LiteralPath $installReceiptPath -PathType Leaf)) {
        Fail-Qualification 'Candidate installer did not publish an install receipt.'
    }
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'install-receipt.json'), $false)

    $installReceipt = $installOutput | Select-Object -Last 1 | ConvertFrom-Json
    $driftTarget = Join-Path $installReceipt.versionRoot 'bin\openshell.exe'
    [IO.File]::AppendAllText($driftTarget, 'qualification-drift', [Text.UTF8Encoding]::new($false))
    $repairParameters = @{
        Action = 'Repair'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
        Json = $true
    }
    & $installer @repairParameters | Out-Null
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'repair-receipt.json'), $false)
    $repairedReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $expectedOpenShell = @($repairedReceipt.files | Where-Object { $_.path -ceq 'bin\openshell.exe' })
    if ($expectedOpenShell.Count -ne 1 -or
        (Get-FileSha256 -Path (Join-Path $repairedReceipt.versionRoot 'bin\openshell.exe')) -cne $expectedOpenShell[0].sha256) {
        Fail-Qualification 'Repair did not restore the OpenShell CLI digest.'
    }

    $uninstallOutput = & $installer -Action Uninstall -InstallRoot $installRoot -Json
    $uninstallReceipt = $uninstallOutput | Select-Object -Last 1 | ConvertFrom-Json
    if (-not $uninstallReceipt.finalAbsence -or (Test-Path -LiteralPath $installRoot)) {
        Fail-Qualification 'Uninstall did not prove final absence.'
    }
    $postExecution = Assert-ProhibitedProcessesAbsent -Phase 'post-execution'

    [IO.File]::Copy($installer, (Join-Path $receiptStage 'install-windows-native.ps1'), $false)
    [IO.File]::Copy($manifestPath, (Join-Path $receiptStage 'distribution-manifest.json'), $false)
    Write-JsonFile -Path (Join-Path $receiptStage 'candidate-source.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        repository = $script:CanonicalNemoClawRepository
        revision = $CandidateSha
        installerSha256 = $InstallerSha256
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'openshell-source.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        repository = $script:CanonicalOpenShellRepository
        pullRequest = $script:TrustedOpenShellPullRequest
        revision = $OpenShellSha
        architecture = 'arm64'
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'process-absence.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        installerAstProcessBoundary = $true
        preExecution = $preExecution
        postExecution = $postExecution
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'uninstall-receipt.json') -Value $uninstallReceipt

    Assert-BoundedFile -Path (Join-Path $receiptStage 'install-windows-native.ps1') -MaximumBytes $script:MaxInstallerBytes
    foreach ($jsonReceipt in @(Get-ChildItem -LiteralPath $receiptStage -Filter '*.json')) {
        Assert-BoundedFile -Path $jsonReceipt.FullName -MaximumBytes $script:MaxJsonBytes
    }
    [IO.Directory]::Move($receiptStage, $artifactPath)
    $receiptStage = $null
    Write-Host "Windows native installer qualification receipts: $artifactPath"
} finally {
    if ($receiptStage -and (Test-Path -LiteralPath $receiptStage -PathType Container)) {
        [IO.Directory]::Delete($receiptStage, $true)
    }
    if (Test-Path -LiteralPath $qualificationRoot -PathType Container) {
        [IO.Directory]::Delete($qualificationRoot, $true)
    }
}
