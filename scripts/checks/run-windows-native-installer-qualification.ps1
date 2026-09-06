# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualify the no-WSL native Windows installer against NVIDIA/OpenShell#2721.

.DESCRIPTION
    Verifies exact candidate and OpenShell source authority before executing the
    candidate installer. The qualification executes the ARM64 binaries, then
    installs, damages, repairs, recovers, and uninstalls the distribution. A
    calibrated Windows process-start audit proves the file-only installer starts
    no child process; prohibited runtime checks and bounded receipts preserve the
    no-WSL evidence.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory)][string]$OpenShellCheckout,
    [Parameter(Mandatory)][string]$OpenShellSha,
    [Parameter(Mandatory)][string]$ArtifactDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CanonicalNemoClawRepository = 'https://github.com/NVIDIA/NemoClaw.git'
$script:CanonicalOpenShellRepository = 'https://github.com/NVIDIA/OpenShell.git'
$script:TrustedOpenShellPullRequest = 2721
$script:TrustedOpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'
$script:ShaPattern = '^[a-f0-9]{40}$'
$script:MaxJsonBytes = 16384
$script:MaxInstallerBytes = 524288
$script:ProcessAuditSettleMilliseconds = 3000
$script:NativeProbeTimeoutMilliseconds = 30000

function Fail-Qualification {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native installer qualification failed: $Message"
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

function Assert-NoReparsePath {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-Qualification "$Label must not contain a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($candidate)
        if ($null -eq $parent) {
            break
        }
        $candidate = $parent.FullName
    }
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
        [Parameter(Mandatory)][string]$FilePath
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
}

function Invoke-ChildSideEffectProbe {
    param([Parameter(Mandatory)][string]$SentinelPath)

    $escapedPath = $SentinelPath.Replace("'", "''")
    $command = "[IO.File]::WriteAllText('$escapedPath', 'child-executed', [Text.UTF8Encoding]::new(`$false))"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $child = $null
    $startError = $null
    $exitCode = $null
    $processId = $null
    try {
        $childParameters = @{
            FilePath = (Join-Path $PSHOME 'powershell.exe')
            ArgumentList = @('-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand)
            Wait = $true
            PassThru = $true
            ErrorAction = 'Stop'
        }
        $child = Start-Process @childParameters
        if ($null -ne $child) {
            $processId = $child.Id
            $exitCode = $child.ExitCode
            $child.Dispose()
            $child = $null
        }
    } catch {
        $startError = $_.Exception.Message
    } finally {
        if ($null -ne $child) {
            $child.Dispose()
        }
    }

    return [pscustomobject]@{
        exitCode = $exitCode
        processId = $processId
        sideEffectObserved = Test-Path -LiteralPath $SentinelPath -PathType Leaf
        startRejected = $null -ne $startError
    }
}

function Start-ProcessStartAudit {
    $sourceIdentifier = 'NemoClawNativeInstaller-' + [guid]::NewGuid().ToString('N')
    Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $sourceIdentifier | Out-Null
    return [pscustomobject]@{
        sourceIdentifier = $sourceIdentifier
    }
}

function Receive-ProcessStartAudit {
    param(
        [Parameter(Mandatory)]$Audit,
        [Parameter(Mandatory)][int]$SettleMilliseconds
    )

    Start-Sleep -Milliseconds $SettleMilliseconds
    $records = @()
    foreach ($auditEvent in @(Get-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue)) {
        $processEvent = $auditEvent.SourceEventArgs.NewEvent
        $records += [pscustomobject]@{
            processId = [int]$processEvent.ProcessID
            parentProcessId = [int]$processEvent.ParentProcessID
            processName = [string]$processEvent.ProcessName
        }
        Remove-Event -EventIdentifier $auditEvent.EventIdentifier
    }
    return @($records)
}

function Get-AuditedDescendantStarts {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][Array]$Records,
        [Parameter(Mandatory)][int]$RootProcessId
    )

    $tracked = @{}
    $tracked[[string]$RootProcessId] = $true
    $descendants = @()
    foreach ($record in $Records) {
        if ($tracked.ContainsKey([string]$record.parentProcessId)) {
            $descendants += $record
            $tracked[[string]$record.processId] = $true
        }
    }
    return @($descendants)
}

function Stop-ProcessStartAudit {
    param([Parameter(Mandatory)]$Audit)

    foreach ($auditEvent in @(Get-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue)) {
        Remove-Event -EventIdentifier $auditEvent.EventIdentifier
    }
    Unregister-Event -SourceIdentifier $Audit.sourceIdentifier -ErrorAction SilentlyContinue
}

function Get-ProhibitedProcessSnapshot {
    param([Parameter(Mandatory)][string]$Phase)

    $prohibited = @('bash', 'docker', 'dockerd', 'wsl')
    $found = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $name = $_.ProcessName.ToLowerInvariant()
        $prohibited -ccontains $name -or $name.StartsWith('com.docker') -or $name.StartsWith('ubuntu')
    })
    return [pscustomobject]@{
        phase = $Phase
        processes = @($found | ForEach-Object {
            [pscustomobject]@{
                processId = $_.Id
                processName = $_.ProcessName
            }
        } | Sort-Object processId)
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

function Assert-Arm64PortableExecutable {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            Fail-Qualification "$Label is not a Windows PE executable."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
            Fail-Qualification "$Label has an invalid PE header offset."
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            Fail-Qualification "$Label has an invalid PE signature."
        }
        if ($reader.ReadUInt16() -ne 0xAA64) {
            Fail-Qualification "$Label is not an ARM64 Windows executable."
        }
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Invoke-NativeVersionProbe {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    Assert-Arm64PortableExecutable -Path $Path -Label $Label
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $Path
    $startInfo.Arguments = '--version'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            Fail-Qualification "$Label could not start its native --version probe."
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($script:NativeProbeTimeoutMilliseconds)) {
            $process.Kill()
            $process.WaitForExit()
            Fail-Qualification "$Label exceeded the native --version timeout."
        }
        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $outputText = (@($stdout.Trim(), $stderr.Trim()) | Where-Object {
            -not [string]::IsNullOrWhiteSpace($_)
        }) -join [Environment]::NewLine
    } finally {
        $process.Dispose()
    }
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($outputText) -or $outputText.Length -gt 4096) {
        Fail-Qualification "$Label did not complete a bounded native --version probe."
    }
    return [pscustomobject]@{
        file = Split-Path -Leaf $Path
        sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        exitCode = $exitCode
        output = $outputText
    }
}

function Resolve-ReceiptVersionRoot {
    param(
        [Parameter(Mandatory)]$Receipt,
        [Parameter(Mandatory)][string]$ExpectedRoot,
        [Parameter(Mandatory)][string]$Phase
    )

    if ($Receipt.versionRoot -isnot [string] -or [string]::IsNullOrWhiteSpace($Receipt.versionRoot)) {
        Fail-Qualification "$Phase receipt has no version root."
    }
    $resolved = [IO.Path]::GetFullPath([string]$Receipt.versionRoot).TrimEnd('\')
    if ($resolved -cne $ExpectedRoot) {
        Fail-Qualification "$Phase receipt version root does not match the independently derived install root."
    }
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-Qualification "$Phase receipt version root is missing."
    }
    Assert-NoReparsePath -Path $resolved -Label "$Phase receipt version root"
    return $resolved
}

function Assert-InstalledDistribution {
    param(
        [Parameter(Mandatory)][string]$VersionRoot,
        [Parameter(Mandatory)][Array]$Entries,
        [Parameter(Mandatory)][string]$Phase
    )

    $VersionRoot = [IO.Path]::GetFullPath($VersionRoot).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $VersionRoot -PathType Container)) {
        Fail-Qualification "$Phase distribution root is missing."
    }
    Assert-NoReparsePath -Path $VersionRoot -Label "$Phase distribution root"
    $expectedFiles = @($Entries | ForEach-Object { $_.destination.ToLowerInvariant() } | Sort-Object)
    $expectedDirectories = @()
    foreach ($entry in $Entries) {
        $segments = @($entry.destination.Split('\'))
        for ($index = 1; $index -lt $segments.Count; $index++) {
            $expectedDirectories += ($segments[0..($index - 1)] -join '\').ToLowerInvariant()
        }
        $target = Join-Path $VersionRoot $entry.destination
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or
            (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
            Fail-Qualification "$Phase distribution file is missing or has the wrong digest: $($entry.destination)"
        }
    }
    $observed = @(Get-ChildItem -LiteralPath $VersionRoot -Recurse -Force)
    foreach ($item in $observed) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Fail-Qualification "$Phase distribution contains a reparse point."
        }
    }
    $observedFiles = @($observed | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($VersionRoot.Length + 1).ToLowerInvariant()
    } | Sort-Object)
    $observedDirectories = @($observed | Where-Object { $_.PSIsContainer } | ForEach-Object {
        $_.FullName.Substring($VersionRoot.Length + 1).ToLowerInvariant()
    } | Sort-Object -Unique)
    $expectedDirectories = @($expectedDirectories | Sort-Object -Unique)
    if (@(Compare-Object $expectedFiles $observedFiles).Count -ne 0 -or
        @(Compare-Object $expectedDirectories $observedDirectories).Count -ne 0) {
        Fail-Qualification "$Phase distribution contains an unexpected file or directory."
    }
}

if ($CandidateSha -cnotmatch $script:ShaPattern -or $OpenShellSha -cnotmatch $script:ShaPattern) {
    Fail-Qualification 'Candidate and OpenShell revisions must be lowercase 40-character commit SHAs.'
}
if ($OpenShellSha -cne $script:TrustedOpenShellRevision) {
    Fail-Qualification 'OpenShell revision must match NVIDIA/OpenShell#2721 merge commit.'
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
$installerSource = Join-Path $candidateRoot 'scripts\install-windows-native.ps1'
$committedInstallerParameters = @{
    Checkout = $candidateRoot
    Revision = $CandidateSha
    RelativePath = 'scripts/install-windows-native.ps1'
    FilePath = $installerSource
}
Assert-CommittedFile @committedInstallerParameters

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
$processAudit = $null
$installerDescendantStarts = @()
$childProbeControl = $null
$controlDescendantStarts = @()
$nativeBinaryEvidence = $null
$hostPlatformEvidence = [pscustomobject]@{
    receiptVersion = 1
    osDescription = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    osVersion = [Environment]::OSVersion.Version.ToString()
    osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    powershellVersion = $PSVersionTable.PSVersion.ToString()
    runnerName = $env:RUNNER_NAME
    runnerArchitecture = $env:RUNNER_ARCH
}
[IO.Directory]::CreateDirectory($payloadRoot) | Out-Null
[IO.Directory]::CreateDirectory($receiptStage) | Out-Null
$installer = Join-Path $qualificationRoot 'install-windows-native.ps1'
[IO.File]::Copy($installerSource, $installer, $false)
$installerItem = Get-Item -LiteralPath $installer -Force
$installerItem.IsReadOnly = $true
$validatedInstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()

try {
    $releaseRoot = Join-Path $openShellRoot 'target\aarch64-pc-windows-msvc\release'
    $distributionEntries = @()
    foreach ($fileName in @('openshell.exe', 'openshell-gateway.exe')) {
        $source = Join-Path $releaseRoot $fileName
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            Fail-Qualification "NVIDIA/OpenShell#2721 build output is missing: $fileName"
        }
        $payloadRelative = "bin\$fileName"
        $payloadPath = Join-Path $payloadRoot $payloadRelative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $payloadPath)) | Out-Null
        [IO.File]::Copy($source, $payloadPath, $false)
        $distributionEntries += [pscustomobject]@{
            source = $payloadRelative
            destination = $payloadRelative
            sha256 = (Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $z3Source = Join-Path $releaseRoot 'libz3.dll'
    if (Test-Path -LiteralPath $z3Source -PathType Leaf) {
        $z3Relative = 'bin\libz3.dll'
        [IO.File]::Copy($z3Source, (Join-Path $payloadRoot $z3Relative), $false)
        $distributionEntries += [pscustomobject]@{
            source = $z3Relative
            destination = $z3Relative
            sha256 = (Get-FileHash -LiteralPath (Join-Path $payloadRoot $z3Relative) -Algorithm SHA256).Hash.ToLowerInvariant()
        }
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
    $expectedOpenShellEntry = @($distributionEntries | Where-Object {
        $_.destination -ceq 'bin\openshell.exe'
    })
    if ($expectedOpenShellEntry.Count -ne 1) {
        Fail-Qualification 'Qualification payload has no unique OpenShell CLI digest.'
    }
    $expectedOpenShellSha256 = $expectedOpenShellEntry[0].sha256
    $expectedVersionName = "openshell-pr$($script:TrustedOpenShellPullRequest)-$($script:TrustedOpenShellRevision.Substring(0, 12))-arm64"
    $expectedVersionRoot = [IO.Path]::GetFullPath(
        (Join-Path (Join-Path $installRoot 'versions') $expectedVersionName)
    ).TrimEnd('\')

    $nativeBinaryEvidence = @(
        Invoke-NativeVersionProbe -Path (Join-Path $payloadRoot 'bin\openshell.exe') -Label 'OpenShell CLI'
        Invoke-NativeVersionProbe -Path (Join-Path $payloadRoot 'bin\openshell-gateway.exe') -Label 'OpenShell gateway'
    )
    $processAudit = Start-ProcessStartAudit
    $controlSentinel = Join-Path $qualificationRoot 'child-control.txt'
    $childProbeControl = Invoke-ChildSideEffectProbe -SentinelPath $controlSentinel
    if ($childProbeControl.startRejected -or $childProbeControl.exitCode -ne 0 -or
        -not $childProbeControl.sideEffectObserved) {
        Fail-Qualification 'The child side-effect control probe did not execute before installer qualification.'
    }
    $controlAuditRecords = @(
        Receive-ProcessStartAudit -Audit $processAudit -SettleMilliseconds $script:ProcessAuditSettleMilliseconds
    )
    $controlDescendantStarts = @(Get-AuditedDescendantStarts -Records $controlAuditRecords -RootProcessId $PID)
    if (@($controlDescendantStarts | Where-Object {
        $_.processId -eq $childProbeControl.processId
    }).Count -ne 1) {
        Fail-Qualification 'The calibrated Windows process-start audit did not observe its control child.'
    }
    [IO.File]::Delete($controlSentinel)

    $preExecution = Get-ProhibitedProcessSnapshot -Phase 'pre-execution'
    $volumeRootRejected = $false
    try {
        & $installer -Action Uninstall -InstallRoot ([IO.Path]::GetPathRoot($installRoot)) | Out-Null
    } catch {
        $volumeRootRejected = $_.Exception.Message -like '*InstallRoot must not be a drive root.*'
    }
    if (-not $volumeRootRejected) {
        Fail-Qualification 'Installer accepted a drive root as InstallRoot.'
    }
    $installParameters = @{
        Action = 'Install'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }
    & $installer @installParameters
    $installReceiptPath = Join-Path $installRoot 'install-receipt.json'
    if (-not (Test-Path -LiteralPath $installReceiptPath -PathType Leaf)) {
        Fail-Qualification 'Candidate installer did not publish an install receipt.'
    }
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'install-receipt.json'), $false)

    $installReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $initialVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $installReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Initial install'
    $initialDistributionParameters = @{
        VersionRoot = $initialVersionRoot
        Entries = $distributionEntries
        Phase = 'Initial install'
    }
    Assert-InstalledDistribution @initialDistributionParameters
    foreach ($installedExecutable in @('openshell.exe', 'openshell-gateway.exe')) {
        Assert-Arm64PortableExecutable `
            -Path (Join-Path $initialVersionRoot "bin\$installedExecutable") `
            -Label "Installed $installedExecutable"
    }
    $untrackedPath = Join-Path $initialVersionRoot 'bin\untracked-qualification.txt'
    [IO.File]::WriteAllText($untrackedPath, 'untracked', [Text.UTF8Encoding]::new($false))
    $untrackedInstallRejected = $false
    try {
        & $installer @installParameters | Out-Null
    } catch {
        $untrackedInstallRejected = $_.Exception.Message -like '*Existing candidate installation drifted; run Repair.*'
    }
    if (-not $untrackedInstallRejected) {
        Fail-Qualification 'Install accepted an untracked file inside the owned version root.'
    }
    $driftTarget = Join-Path $initialVersionRoot 'bin\openshell.exe'
    [IO.File]::AppendAllText($driftTarget, 'qualification-drift', [Text.UTF8Encoding]::new($false))
    $repairParameters = @{
        Action = 'Repair'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }

    $lockPath = Join-Path (Split-Path -Parent $installRoot) ('.' + (Split-Path -Leaf $installRoot) + '.native-installer.lock')
    $heldLock = [IO.File]::Open(
        $lockPath,
        [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite,
        [IO.FileShare]::None
    )
    $overlappingRepairRejected = $false
    try {
        try {
            & $installer @repairParameters | Out-Null
        } catch {
            $overlappingRepairRejected = $_.Exception.Message -like '*Another installer operation owns*'
        }
    } finally {
        $heldLock.Dispose()
        [IO.File]::Delete($lockPath)
    }
    if (-not $overlappingRepairRejected) {
        Fail-Qualification 'Installer lock allowed an overlapping repair operation.'
    }
    & $installer @repairParameters | Out-Null
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'repair-receipt.json'), $false)
    $repairedReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $repairedVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $repairedReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Repair'
    if ((Test-Path -LiteralPath $untrackedPath) -or
        (Get-FileHash -LiteralPath (Join-Path $repairedVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Repair did not restore the OpenShell CLI digest.'
    }
    Assert-InstalledDistribution -VersionRoot $repairedVersionRoot -Entries $distributionEntries -Phase 'Repair'

    $recoveryBackupRoot = Join-Path $installRoot ('.backup-' + [guid]::NewGuid().ToString('N'))
    $recoveryReplacementRoot = Join-Path $installRoot ('.replacement-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($repairedVersionRoot, $recoveryBackupRoot)
    [IO.Directory]::CreateDirectory($recoveryReplacementRoot) | Out-Null
    [IO.File]::WriteAllText(
        (Join-Path $recoveryReplacementRoot 'incomplete.txt'),
        'incomplete replacement',
        [Text.UTF8Encoding]::new($false)
    )
    $recoveryAuthorityPath = Join-Path $installRoot 'repair-recovery.json'
    Write-JsonFile -Path $recoveryAuthorityPath -Value ([pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        installRoot = $installRoot
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        action = 'restore-prior-version-and-remove-replacement'
        versionRoot = $repairedVersionRoot
        backupRoot = $recoveryBackupRoot
        failedReplacementRoot = $recoveryReplacementRoot
        operationError = 'qualification fixture'
        rollbackError = 'qualification fixture'
    })
    $recoverParameters = @{
        Action = 'Recover'
        ManifestPath = $manifestPath
        PayloadRoot = $payloadRoot
        InstallRoot = $installRoot
    }
    & $installer @recoverParameters | Out-Null
    $recoveredReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $recoveredVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $recoveredReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Recover with replacement root'
    if ((Test-Path -LiteralPath $recoveryAuthorityPath) -or
        (Test-Path -LiteralPath $recoveryBackupRoot) -or
        (Test-Path -LiteralPath $recoveryReplacementRoot) -or
        (Get-FileHash -LiteralPath (Join-Path $recoveredVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Recover did not publish one clean pinned distribution.'
    }
    Assert-InstalledDistribution `
        -VersionRoot $recoveredVersionRoot `
        -Entries $distributionEntries `
        -Phase 'Recover with replacement root'

    $nullReplacementReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $nullReplacementVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $nullReplacementReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Pre-null recovery'
    $nullReplacementBackupRoot = Join-Path $installRoot ('.backup-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($nullReplacementVersionRoot, $nullReplacementBackupRoot)
    Write-JsonFile -Path $recoveryAuthorityPath -Value ([pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        installRoot = $installRoot
        openshell = [pscustomobject]@{
            repository = $script:CanonicalOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        action = 'restore-prior-version'
        versionRoot = $nullReplacementVersionRoot
        backupRoot = $nullReplacementBackupRoot
        failedReplacementRoot = $null
        operationError = 'qualification null-replacement fixture'
        rollbackError = 'qualification null-replacement fixture'
    })
    & $installer @recoverParameters | Out-Null
    $nullRecoveredReceipt = Get-Content -LiteralPath $installReceiptPath -Raw | ConvertFrom-Json
    $nullRecoveredVersionRoot = Resolve-ReceiptVersionRoot `
        -Receipt $nullRecoveredReceipt `
        -ExpectedRoot $expectedVersionRoot `
        -Phase 'Recover with null replacement root'
    if ((Test-Path -LiteralPath $recoveryAuthorityPath) -or
        (Test-Path -LiteralPath $nullReplacementBackupRoot) -or
        (Get-FileHash -LiteralPath (Join-Path $nullRecoveredVersionRoot 'bin\openshell.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedOpenShellSha256) {
        Fail-Qualification 'Recover did not handle a null replacement root.'
    }
    Assert-InstalledDistribution `
        -VersionRoot $nullRecoveredVersionRoot `
        -Entries $distributionEntries `
        -Phase 'Recover with null replacement root'
    [IO.File]::Copy($installReceiptPath, (Join-Path $receiptStage 'recovery-receipt.json'), $false)

    & $installer -Action Uninstall -InstallRoot $installRoot
    if (Test-Path -LiteralPath $installRoot) {
        Fail-Qualification 'Uninstall did not prove final absence.'
    }
    $uninstallReceipt = [pscustomobject]@{
        receiptVersion = 1
        action = 'uninstall'
        classification = 'qualification-only'
        installRoot = $installRoot
        finalAbsence = $true
    }
    $postExecution = Get-ProhibitedProcessSnapshot -Phase 'post-execution'
    $baselineProcessIds = @($preExecution.processes | ForEach-Object { $_.processId })
    $newProhibitedProcesses = @($postExecution.processes | Where-Object {
        $baselineProcessIds -notcontains $_.processId
    })
    if ($newProhibitedProcesses.Count -ne 0) {
        $newNames = @($newProhibitedProcesses | ForEach-Object { $_.processName } | Sort-Object -Unique) -join ', '
        Fail-Qualification "A new prohibited WSL or Docker process appeared during installer qualification: $newNames"
    }
    $installerAuditRecords = @(
        Receive-ProcessStartAudit -Audit $processAudit -SettleMilliseconds $script:ProcessAuditSettleMilliseconds
    )
    $installerDescendantStarts = @(Get-AuditedDescendantStarts -Records $installerAuditRecords -RootProcessId $PID)
    if ($installerDescendantStarts.Count -ne 0) {
        $startedNames = @($installerDescendantStarts | ForEach-Object { $_.processName } | Sort-Object -Unique) -join ', '
        Fail-Qualification "The file-only installer started a descendant process: $startedNames"
    }

    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $validatedInstallerSha256) {
        Fail-Qualification 'The staged installer bytes changed during qualification.'
    }
    [IO.File]::Copy($installer, (Join-Path $receiptStage 'install-windows-native.ps1'), $false)
    [IO.File]::Copy($manifestPath, (Join-Path $receiptStage 'distribution-manifest.json'), $false)
    Write-JsonFile -Path (Join-Path $receiptStage 'candidate-source.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        repository = $script:CanonicalNemoClawRepository
        revision = $CandidateSha
        installerSha256 = $validatedInstallerSha256
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
        calibratedChildProbe = $childProbeControl
        calibratedDescendantStarts = $controlDescendantStarts
        installerDescendantStarts = $installerDescendantStarts
        newProhibitedProcesses = $newProhibitedProcesses
        preExecution = $preExecution
        postExecution = $postExecution
    })
    Write-JsonFile -Path (Join-Path $receiptStage 'host-platform.json') -Value $hostPlatformEvidence
    Write-JsonFile -Path (Join-Path $receiptStage 'native-binary-smoke.json') -Value ([pscustomobject]@{
        receiptVersion = 1
        executions = $nativeBinaryEvidence
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
    if ($processAudit) {
        Stop-ProcessStartAudit -Audit $processAudit
    }
    if ($receiptStage -and (Test-Path -LiteralPath $receiptStage -PathType Container)) {
        [IO.Directory]::Delete($receiptStage, $true)
    }
    if (Test-Path -LiteralPath $installer -PathType Leaf) {
        (Get-Item -LiteralPath $installer -Force).IsReadOnly = $false
    }
    if (Test-Path -LiteralPath $qualificationRoot -PathType Container) {
        [IO.Directory]::Delete($qualificationRoot, $true)
    }
}
