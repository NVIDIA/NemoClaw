# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualification-only native Windows installer for the OpenShell MXC candidate.

.DESCRIPTION
    Installs, repairs, or removes an exact Windows OpenShell distribution built
    from NVIDIA/OpenShell#2721. The installer is deliberately file-only: it
    does not start a process, install a service, select a runtime provider, or
    activate native Windows support. A later slice can consume the receipt after
    the corresponding lifecycle and activation gates pass.

    If repair emits repair-recovery.json, run this script with -Action Recover
    and the same -ManifestPath, -PayloadRoot, and -InstallRoot values.
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Repair', 'Recover', 'Uninstall')]
    [string]$Action = 'Install',

    [string]$ManifestPath,

    [string]$PayloadRoot,

    [string]$InstallRoot = (Join-Path -Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) -ChildPath 'NVIDIA\NemoClaw\native-candidate')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TrustedOpenShellRepository = 'https://github.com/NVIDIA/OpenShell.git'
$script:TrustedOpenShellPullRequest = 2721
$script:TrustedOpenShellRevision = 'bcd517bbe08cc80860c9be57699390cd32e8445f'
$script:ReceiptFileName = 'install-receipt.json'
$script:Sha256Pattern = '^[a-f0-9]{64}$'
$script:ControlCharacterPattern = '[\u0000-\u001f\u007f-\u009f]'
$script:RequiredDestinations = @(
    'bin\openshell.exe',
    'bin\openshell-gateway.exe'
)

function Fail-NativeWindowsInstall {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native candidate installer failed: $Message"
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string[]]$Properties,
        [Parameter(Mandatory)][string]$Label
    )

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [Array]) {
        Fail-NativeWindowsInstall "$Label must be an object."
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Properties | Sort-Object)
    if ($actual.Count -ne $expected.Count) {
        Fail-NativeWindowsInstall "$Label has unknown or missing fields."
    }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ($actual[$index] -cne $expected[$index]) {
            Fail-NativeWindowsInstall "$Label has unknown or missing fields."
        }
    }
}

function Assert-NoReparsePoint {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $candidate = [IO.Path]::GetFullPath($Path)
    while ($candidate) {
        if (Test-Path -LiteralPath $candidate) {
            $item = Get-Item -LiteralPath $candidate -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-NativeWindowsInstall "$Label must not contain a reparse point."
            }
        }
        $parent = [IO.Directory]::GetParent($candidate)
        if ($null -eq $parent) {
            break
        }
        $candidate = $parent.FullName
    }
}

function Resolve-ExistingRegularFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        Fail-NativeWindowsInstall "$Label is missing."
    }
    Assert-NoReparsePoint -Path $resolved -Label $Label
    return $resolved
}

function Resolve-ExistingDirectory {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        Fail-NativeWindowsInstall "$Label is missing."
    }
    Assert-NoReparsePoint -Path $resolved -Label $Label
    return $resolved.TrimEnd('\')
}

function Resolve-InstallRoot {
    param([Parameter(Mandatory)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\') {
        Fail-NativeWindowsInstall 'InstallRoot must be an absolute local-drive Windows path.'
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute.TrimEnd('\') -ceq [IO.Path]::GetPathRoot($absolute).TrimEnd('\')) {
        Fail-NativeWindowsInstall 'InstallRoot must not be a drive root.'
    }
    $resolved = $absolute.TrimEnd('\')
    Assert-NoReparsePoint -Path $resolved -Label 'InstallRoot'
    return $resolved
}

function Enter-InstallerLock {
    param([Parameter(Mandatory)][string]$Root)

    $parent = Split-Path -Parent $Root
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    Assert-NoReparsePoint -Path $parent -Label 'InstallRoot parent'
    $lockPath = Join-Path $parent ('.' + (Split-Path -Leaf $Root) + '.native-installer.lock')
    try {
        return [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None,
            1,
            [IO.FileOptions]::DeleteOnClose
        )
    } catch [IO.IOException] {
        Fail-NativeWindowsInstall "Another installer operation owns $Root. Wait for it to finish, then retry."
    }
}

function Resolve-SafeRelativePath {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Label
    )

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or
        $Value -match $script:ControlCharacterPattern -or [IO.Path]::IsPathRooted($Value) -or
        $Value.Contains('/') -or $Value.Contains(':')) {
        Fail-NativeWindowsInstall "$Label is not a safe Windows relative path."
    }
    $segments = @($Value.Split('\'))
    $unsafeSegments = @($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })
    if ($segments.Count -eq 0 -or $unsafeSegments.Count -gt 0) {
        Fail-NativeWindowsInstall "$Label is not a safe Windows relative path."
    }
    return ($segments -join '\')
}

function Get-NativeArchitecture {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($architecture) {
        'Arm64' { return 'arm64' }
        'X64' { return 'x64' }
        default { Fail-NativeWindowsInstall "Unsupported native architecture: $architecture" }
    }
}

function Read-DistributionManifest {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Root
    )

    $manifestFile = Resolve-ExistingRegularFile -Path $Path -Label 'Distribution manifest'
    $payloadDirectory = Resolve-ExistingDirectory -Path $Root -Label 'Payload root'
    try {
        $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    } catch {
        Fail-NativeWindowsInstall 'Distribution manifest is not valid JSON.'
    }
    Assert-ExactProperties -Value $manifest -Properties @(
        'architecture', 'classification', 'files', 'openshell', 'platform', 'schemaVersion'
    ) -Label 'Distribution manifest'
    if ($manifest.schemaVersion -ne 1 -or $manifest.classification -cne 'qualification-only' -or
        $manifest.platform -cne 'windows') {
        Fail-NativeWindowsInstall 'Distribution manifest identity is unsupported.'
    }
    $nativeArchitecture = Get-NativeArchitecture
    if ($manifest.architecture -cne $nativeArchitecture) {
        Fail-NativeWindowsInstall "Distribution architecture '$($manifest.architecture)' does not match '$nativeArchitecture'."
    }

    Assert-ExactProperties -Value $manifest.openshell -Properties @(
        'pullRequest', 'repository', 'revision'
    ) -Label 'OpenShell authority'
    if ($manifest.openshell.repository -cne $script:TrustedOpenShellRepository -or
        $manifest.openshell.pullRequest -ne $script:TrustedOpenShellPullRequest -or
        $manifest.openshell.revision -cne $script:TrustedOpenShellRevision) {
        Fail-NativeWindowsInstall 'OpenShell authority does not match the pinned NVIDIA/OpenShell#2721 distribution.'
    }

    if ($manifest.files -isnot [Array] -or $manifest.files.Count -lt 2 -or $manifest.files.Count -gt 8) {
        Fail-NativeWindowsInstall 'Distribution manifest files must contain between two and eight entries.'
    }
    $destinations = @{}
    $resolvedFiles = @()
    foreach ($entry in @($manifest.files)) {
        Assert-ExactProperties -Value $entry -Properties @(
            'destination', 'sha256', 'source'
        ) -Label 'Distribution file entry'
        $source = Resolve-SafeRelativePath -Value $entry.source -Label 'Distribution source'
        $destination = Resolve-SafeRelativePath -Value $entry.destination -Label 'Distribution destination'
        if ($entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch $script:Sha256Pattern) {
            Fail-NativeWindowsInstall 'Distribution file entry identity is invalid.'
        }
        $destinationKey = $destination.ToLowerInvariant()
        if ($destinations.ContainsKey($destinationKey)) {
            Fail-NativeWindowsInstall "Distribution destination is duplicated: $destination"
        }
        $destinations[$destinationKey] = $true
        $sourcePath = [IO.Path]::GetFullPath((Join-Path $payloadDirectory $source))
        $payloadPrefix = $payloadDirectory + '\'
        if (-not $sourcePath.StartsWith($payloadPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Fail-NativeWindowsInstall 'Distribution source escapes the payload root.'
        }
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            Fail-NativeWindowsInstall "Distribution source is missing: $source"
        }
        $sourcePath = Resolve-ExistingRegularFile -Path $sourcePath -Label "Distribution source '$source'"
        $actualDigest = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualDigest -cne $entry.sha256) {
            Fail-NativeWindowsInstall "Distribution source digest does not match the manifest: $source"
        }
        $resolvedFiles += [pscustomobject]@{
            Source = $source
            SourcePath = $sourcePath
            Destination = $destination
            Sha256 = $entry.sha256
        }
    }
    foreach ($requiredDestination in $script:RequiredDestinations) {
        if (-not $destinations.ContainsKey($requiredDestination.ToLowerInvariant())) {
            Fail-NativeWindowsInstall "Distribution manifest is missing required destination: $requiredDestination"
        }
        $resolved = @($resolvedFiles | Where-Object { $_.Destination -ceq $requiredDestination })
        if ($resolved.Count -ne 1) {
            Fail-NativeWindowsInstall "Required distribution file is unavailable: $requiredDestination"
        }
    }

    return [pscustomobject]@{
        ManifestPath = $manifestFile
        ManifestSha256 = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
        PayloadRoot = $payloadDirectory
        Architecture = $nativeArchitecture
        Files = @($resolvedFiles)
    }
}

function Test-InstalledFiles {
    param(
        [Parameter(Mandatory)][string]$VersionRoot,
        [Parameter(Mandatory)][Array]$Files
    )

    $expectedFiles = @{}
    $expectedDirectories = @{}
    foreach ($file in $Files) {
        $expectedFiles[$file.Destination.ToLowerInvariant()] = $file.Sha256
        $segments = @($file.Destination.Split('\'))
        for ($index = 1; $index -lt $segments.Count; $index++) {
            $directory = ($segments[0..($index - 1)] -join '\').ToLowerInvariant()
            $expectedDirectories[$directory] = $true
        }
    }

    $observedFiles = @{}
    $observedDirectories = @{}
    $pendingDirectories = [Collections.Generic.Stack[string]]::new()
    $pendingDirectories.Push($VersionRoot)
    while ($pendingDirectories.Count -gt 0) {
        $directory = $pendingDirectories.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Fail-NativeWindowsInstall "Installed candidate contains a reparse point: $($item.FullName)"
            }
            $relativePath = $item.FullName.Substring($VersionRoot.Length + 1).ToLowerInvariant()
            if ($item.PSIsContainer) {
                $observedDirectories[$relativePath] = $true
                $pendingDirectories.Push($item.FullName)
            } else {
                $observedFiles[$relativePath] = $item.FullName
            }
        }
    }
    if ($observedFiles.Count -ne $expectedFiles.Count -or
        $observedDirectories.Count -ne $expectedDirectories.Count) {
        return $false
    }
    foreach ($expectedDirectory in $expectedDirectories.Keys) {
        if (-not $observedDirectories.ContainsKey($expectedDirectory)) {
            return $false
        }
    }
    foreach ($file in $Files) {
        $target = Join-Path $VersionRoot $file.Destination
        if (-not $observedFiles.ContainsKey($file.Destination.ToLowerInvariant()) -or
            -not (Test-Path -LiteralPath $target -PathType Leaf)) {
            return $false
        }
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.Sha256) {
            return $false
        }
    }
    return $true
}

function Write-JsonAtomic {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)]$Value
    )

    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + (Split-Path -Leaf $Path) + '.' + [guid]::NewGuid().ToString('N') + '.partial')
    $text = ($Value | ConvertTo-Json -Depth 12 -Compress) + [Environment]::NewLine
    [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        [IO.File]::Replace($temporary, $Path, $null, $true)
    } else {
        [IO.File]::Move($temporary, $Path)
    }
}

function Write-RepairRecoveryRecord {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Action,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$VersionRoot,
        [Parameter(Mandatory)][string]$BackupRoot,
        [AllowNull()][object]$FailedReplacementRoot,
        [Parameter(Mandatory)][string]$OperationError,
        [Parameter(Mandatory)][string]$RollbackError
    )

    $normalizedReplacementRoot = if ([string]::IsNullOrWhiteSpace([string]$FailedReplacementRoot)) {
        $null
    } else {
        [string]$FailedReplacementRoot
    }

    Write-JsonAtomic -Path $Path -Value ([pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        installRoot = $Root
        openshell = [pscustomobject]@{
            repository = $script:TrustedOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        action = $Action
        versionRoot = $VersionRoot
        backupRoot = $BackupRoot
        failedReplacementRoot = $normalizedReplacementRoot
        operationError = $OperationError
        rollbackError = $RollbackError
    })
}

function Publish-Distribution {
    param(
        [Parameter(Mandatory)]$Distribution,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][bool]$Repair
    )

    [IO.Directory]::CreateDirectory($Root) | Out-Null
    Assert-NoReparsePoint -Path $Root -Label 'InstallRoot'
    $versionsRoot = Join-Path $Root 'versions'
    [IO.Directory]::CreateDirectory($versionsRoot) | Out-Null
    $versionName = "openshell-pr$($script:TrustedOpenShellPullRequest)-$($script:TrustedOpenShellRevision.Substring(0, 12))-$($Distribution.Architecture)"
    $versionRoot = Join-Path $versionsRoot $versionName
    $stagingRoot = Join-Path $Root ('.staging-' + [guid]::NewGuid().ToString('N'))
    $backupRoot = Join-Path $Root ('.backup-' + [guid]::NewGuid().ToString('N'))
    $failedReplacementRoot = Join-Path $Root ('.replacement-' + [guid]::NewGuid().ToString('N'))
    $recoveryPath = Join-Path $Root 'repair-recovery.json'
    [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    try {
        foreach ($file in $Distribution.Files) {
            $target = Join-Path $stagingRoot $file.Destination
            [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
            [IO.File]::Copy($file.SourcePath, $target, $false)
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.Sha256) {
                Fail-NativeWindowsInstall "Staged distribution digest changed: $($file.Destination)"
            }
        }

        if (Test-Path -LiteralPath $versionRoot) {
            Assert-NoReparsePoint -Path $versionRoot -Label 'Existing version root'
            if (-not $Repair) {
                if (-not (Test-InstalledFiles -VersionRoot $versionRoot -Files $Distribution.Files)) {
                    Fail-NativeWindowsInstall 'Existing candidate installation drifted; run Repair.'
                }
                [IO.Directory]::Delete($stagingRoot, $true)
                $stagingRoot = $null
                return $versionRoot
            }
            [IO.Directory]::Move($versionRoot, $backupRoot)
            try {
                [IO.Directory]::Move($stagingRoot, $versionRoot)
                $stagingRoot = $null
            } catch {
                $publishError = $_.Exception.Message
                try {
                    if (-not (Test-Path -LiteralPath $versionRoot) -and (Test-Path -LiteralPath $backupRoot)) {
                        [IO.Directory]::Move($backupRoot, $versionRoot)
                    }
                } catch {
                    $recoveryParameters = @{
                        Path = $recoveryPath
                        Action = 'restore-prior-version'
                        Root = $Root
                        VersionRoot = $versionRoot
                        BackupRoot = $backupRoot
                        FailedReplacementRoot = $null
                        OperationError = $publishError
                        RollbackError = $_.Exception.Message
                    }
                    Write-RepairRecoveryRecord @recoveryParameters
                    Fail-NativeWindowsInstall "Repair publication and rollback failed. Run Recover with the same manifest, payload, and install root. Recovery authority: $recoveryPath"
                }
                Fail-NativeWindowsInstall "Repair publication failed and the prior version was restored: $publishError"
            }
            try {
                [IO.Directory]::Delete($backupRoot, $true)
            } catch {
                $cleanupError = $_.Exception.Message
                try {
                    [IO.Directory]::Move($versionRoot, $failedReplacementRoot)
                    [IO.Directory]::Move($backupRoot, $versionRoot)
                    [IO.Directory]::Delete($failedReplacementRoot, $true)
                } catch {
                    $rollbackError = $_.Exception.Message
                    $recoveryAction = 'restore-prior-version-and-remove-replacement'
                    $recordedReplacementRoot = $failedReplacementRoot
                    if (-not (Test-Path -LiteralPath $versionRoot) -and
                        (Test-Path -LiteralPath $failedReplacementRoot -PathType Container)) {
                        try {
                            [IO.Directory]::Move($failedReplacementRoot, $versionRoot)
                            $recoveryAction = 'remove-retained-backup'
                            $recordedReplacementRoot = $null
                        } catch {
                            $rollbackError = "$rollbackError; published-version restore failed: $($_.Exception.Message)"
                        }
                    }
                    $recoveryParameters = @{
                        Path = $recoveryPath
                        Action = $recoveryAction
                        Root = $Root
                        VersionRoot = $versionRoot
                        BackupRoot = $backupRoot
                        FailedReplacementRoot = $recordedReplacementRoot
                        OperationError = $cleanupError
                        RollbackError = $rollbackError
                    }
                    Write-RepairRecoveryRecord @recoveryParameters
                    Fail-NativeWindowsInstall "Repair backup cleanup and rollback failed. Run Recover with the same manifest, payload, and install root. Recovery authority: $recoveryPath"
                }
                Fail-NativeWindowsInstall "Repair could not retire the prior backup, so the prior version was restored. Release file locks and retry Repair. Backup cleanup error: $cleanupError"
            }
        } else {
            [IO.Directory]::Move($stagingRoot, $versionRoot)
            $stagingRoot = $null
        }
        if (-not (Test-InstalledFiles -VersionRoot $versionRoot -Files $Distribution.Files)) {
            Fail-NativeWindowsInstall 'Published candidate distribution failed verification.'
        }
        return $versionRoot
    } finally {
        if ($stagingRoot -and (Test-Path -LiteralPath $stagingRoot -PathType Container)) {
            [IO.Directory]::Delete($stagingRoot, $true)
        }
    }
}

function Write-InstallReceipt {
    param(
        [Parameter(Mandatory)]$Distribution,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$VersionRoot
    )

    $receiptPath = Join-Path $Root $script:ReceiptFileName
    $installedFiles = @($Distribution.Files | ForEach-Object {
        [pscustomobject]@{
            path = $_.Destination
            sha256 = $_.Sha256
        }
    })
    $receipt = [pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        platform = 'windows'
        architecture = $Distribution.Architecture
        openshell = [pscustomobject]@{
            repository = $script:TrustedOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        manifestSha256 = $Distribution.ManifestSha256
        installerSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
        installRoot = $Root
        versionRoot = $VersionRoot
        files = $installedFiles
    }
    Write-JsonAtomic -Path $receiptPath -Value $receipt
}

function Invoke-InstallOrRepair {
    param([Parameter(Mandatory)][bool]$Repair)

    if ([string]::IsNullOrWhiteSpace($ManifestPath) -or [string]::IsNullOrWhiteSpace($PayloadRoot)) {
        Fail-NativeWindowsInstall 'ManifestPath and PayloadRoot are required for Install and Repair.'
    }
    $root = Resolve-InstallRoot -Path $InstallRoot
    $repairRecoveryPath = Join-Path $root 'repair-recovery.json'
    if (Test-Path -LiteralPath $repairRecoveryPath -PathType Leaf) {
        Fail-NativeWindowsInstall "Unresolved repair state blocks installation. Run Recover with the same manifest, payload, and install root: $repairRecoveryPath"
    }
    $distribution = Read-DistributionManifest -Path $ManifestPath -Root $PayloadRoot
    $versionRoot = Publish-Distribution -Distribution $distribution -Root $root -Repair $Repair
    Write-InstallReceipt -Distribution $distribution -Root $root -VersionRoot $versionRoot
    Write-Host "Native Windows candidate distribution installed at $versionRoot"
}

function Resolve-RecoveryAuxiliaryPath {
    param(
        [AllowNull()]$Value,
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Prefix,
        [Parameter(Mandatory)][string]$Label
    )

    if ($null -eq $Value -or ($Value -is [string] -and [string]::IsNullOrWhiteSpace($Value))) {
        return $null
    }
    if ($Value -isnot [string]) {
        Fail-NativeWindowsInstall "$Label is invalid."
    }
    $resolved = [IO.Path]::GetFullPath($Value).TrimEnd('\')
    if ((Split-Path -Parent $resolved) -cne $Root -or
        (Split-Path -Leaf $resolved) -cnotmatch "^$([regex]::Escape($Prefix))[a-f0-9]{32}$") {
        Fail-NativeWindowsInstall "$Label is outside its owned recovery namespace."
    }
    return $resolved
}

function Invoke-Recover {
    if ([string]::IsNullOrWhiteSpace($ManifestPath) -or [string]::IsNullOrWhiteSpace($PayloadRoot)) {
        Fail-NativeWindowsInstall 'ManifestPath and PayloadRoot are required for Recover.'
    }
    $root = Resolve-InstallRoot -Path $InstallRoot
    $distribution = Read-DistributionManifest -Path $ManifestPath -Root $PayloadRoot
    $recoveryPath = Resolve-ExistingRegularFile -Path (Join-Path $root 'repair-recovery.json') -Label 'Repair recovery authority'
    try {
        $recovery = Get-Content -LiteralPath $recoveryPath -Raw | ConvertFrom-Json
    } catch {
        Fail-NativeWindowsInstall 'Repair recovery authority is not valid JSON.'
    }
    Assert-ExactProperties -Value $recovery -Properties @(
        'action', 'backupRoot', 'classification', 'failedReplacementRoot', 'installRoot',
        'openshell', 'operationError', 'receiptVersion', 'rollbackError', 'versionRoot'
    ) -Label 'Repair recovery authority'
    Assert-ExactProperties -Value $recovery.openshell -Properties @(
        'pullRequest', 'repository', 'revision'
    ) -Label 'Recovery OpenShell authority'
    if ($recovery.receiptVersion -ne 1 -or $recovery.classification -cne 'qualification-only' -or
        $recovery.installRoot -cne $root -or
        $recovery.action -cnotin @(
            'remove-retained-backup',
            'restore-prior-version',
            'restore-prior-version-and-remove-replacement'
        ) -or
        $recovery.openshell.repository -cne $script:TrustedOpenShellRepository -or
        $recovery.openshell.pullRequest -ne $script:TrustedOpenShellPullRequest -or
        $recovery.openshell.revision -cne $script:TrustedOpenShellRevision) {
        Fail-NativeWindowsInstall 'Repair recovery authority identity is invalid.'
    }

    $versionName = "openshell-pr$($script:TrustedOpenShellPullRequest)-$($script:TrustedOpenShellRevision.Substring(0, 12))-$($distribution.Architecture)"
    $expectedVersionRoot = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'versions') $versionName)).TrimEnd('\')
    $recordedVersionRoot = [IO.Path]::GetFullPath([string]$recovery.versionRoot).TrimEnd('\')
    if ($recordedVersionRoot -cne $expectedVersionRoot) {
        Fail-NativeWindowsInstall 'Repair recovery version root does not match the pinned distribution.'
    }
    $backupParameters = @{
        Value = $recovery.backupRoot
        Root = $root
        Prefix = '.backup-'
        Label = 'Recovery backup root'
    }
    $backupRoot = Resolve-RecoveryAuxiliaryPath @backupParameters
    $replacementParameters = @{
        Value = $recovery.failedReplacementRoot
        Root = $root
        Prefix = '.replacement-'
        Label = 'Recovery replacement root'
    }
    $replacementRoot = Resolve-RecoveryAuxiliaryPath @replacementParameters

    if ($recovery.action -ceq 'remove-retained-backup') {
        if (-not (Test-Path -LiteralPath $recordedVersionRoot -PathType Container) -or
            -not (Test-InstalledFiles -VersionRoot $recordedVersionRoot -Files $distribution.Files)) {
            Fail-NativeWindowsInstall "Recover cannot verify the published version. Recovery authority remains at $recoveryPath"
        }
        if ($backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
            Assert-NoReparsePoint -Path $backupRoot -Label 'Retained recovery backup root'
            [IO.Directory]::Delete($backupRoot, $true)
        }
        if ($replacementRoot -and (Test-Path -LiteralPath $replacementRoot -PathType Container)) {
            Assert-NoReparsePoint -Path $replacementRoot -Label 'Retained recovery replacement root'
            [IO.Directory]::Delete($replacementRoot, $true)
        }
        Write-InstallReceipt -Distribution $distribution -Root $root -VersionRoot $recordedVersionRoot
        [IO.File]::Delete($recoveryPath)
        Write-Host "Recovered the native Windows candidate distribution at $recordedVersionRoot"
        return
    }

    if ($backupRoot -and (Test-Path -LiteralPath $backupRoot -PathType Container)) {
        Assert-NoReparsePoint -Path $backupRoot -Label 'Recovery backup root'
        if (Test-Path -LiteralPath $recordedVersionRoot -PathType Container) {
            if (-not $replacementRoot) {
                $replacementRoot = Join-Path $root ('.replacement-' + [guid]::NewGuid().ToString('N'))
                $recordParameters = @{
                    Path = $recoveryPath
                    Action = 'restore-prior-version-and-remove-replacement'
                    Root = $root
                    VersionRoot = $recordedVersionRoot
                    BackupRoot = $backupRoot
                    FailedReplacementRoot = $replacementRoot
                    OperationError = [string]$recovery.operationError
                    RollbackError = [string]$recovery.rollbackError
                }
                Write-RepairRecoveryRecord @recordParameters
            }
            if (Test-Path -LiteralPath $replacementRoot) {
                Fail-NativeWindowsInstall "Recover retained both a current version and replacement. Recovery authority remains at $recoveryPath"
            }
            [IO.Directory]::Move($recordedVersionRoot, $replacementRoot)
        }
        [IO.Directory]::Move($backupRoot, $recordedVersionRoot)
    }
    if (-not (Test-Path -LiteralPath $recordedVersionRoot -PathType Container)) {
        Fail-NativeWindowsInstall "Recover has no prior version to restore. Recovery authority remains at $recoveryPath"
    }
    Assert-NoReparsePoint -Path $recordedVersionRoot -Label 'Recovered prior version root'

    $publishedVersionRoot = Publish-Distribution -Distribution $distribution -Root $root -Repair $true
    Write-InstallReceipt -Distribution $distribution -Root $root -VersionRoot $publishedVersionRoot
    if ($replacementRoot -and (Test-Path -LiteralPath $replacementRoot -PathType Container)) {
        Assert-NoReparsePoint -Path $replacementRoot -Label 'Recovery replacement root'
        [IO.Directory]::Delete($replacementRoot, $true)
    }
    [IO.File]::Delete($recoveryPath)
    Write-Host "Recovered and republished the native Windows candidate distribution at $publishedVersionRoot"
}

function Invoke-Uninstall {
    $root = Resolve-InstallRoot -Path $InstallRoot
    $repairRecoveryPath = Join-Path $root 'repair-recovery.json'
    if (Test-Path -LiteralPath $repairRecoveryPath -PathType Leaf) {
        Fail-NativeWindowsInstall "Unresolved repair state blocks uninstall. Run Recover with the same manifest, payload, and install root: $repairRecoveryPath"
    }
    $receiptPath = Resolve-ExistingRegularFile -Path (Join-Path $root $script:ReceiptFileName) -Label 'Install receipt'
    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    } catch {
        Fail-NativeWindowsInstall 'Install receipt is not valid JSON.'
    }
    Assert-ExactProperties -Value $receipt -Properties @(
        'architecture', 'classification', 'files', 'installerSha256', 'installRoot',
        'manifestSha256', 'openshell', 'platform',
        'receiptVersion', 'versionRoot'
    ) -Label 'Install receipt'
    Assert-ExactProperties -Value $receipt.openshell -Properties @(
        'pullRequest', 'repository', 'revision'
    ) -Label 'Receipt OpenShell authority'
    if ($receipt.receiptVersion -ne 1 -or $receipt.classification -cne 'qualification-only' -or
        $receipt.platform -cne 'windows' -or $receipt.installRoot -cne $root -or
        $receipt.openshell.repository -cne $script:TrustedOpenShellRepository -or
        $receipt.openshell.pullRequest -ne $script:TrustedOpenShellPullRequest -or
        $receipt.openshell.revision -cne $script:TrustedOpenShellRevision) {
        Fail-NativeWindowsInstall 'Install receipt authority is invalid.'
    }
    $versionRoot = [IO.Path]::GetFullPath([string]$receipt.versionRoot).TrimEnd('\')
    $versionsRoot = [IO.Path]::GetFullPath((Join-Path $root 'versions')).TrimEnd('\')
    if (-not $versionRoot.StartsWith($versionsRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $versionRoot -PathType Container)) {
        Fail-NativeWindowsInstall 'Receipt version root is outside the owned versions directory.'
    }
    Assert-NoReparsePoint -Path $versionRoot -Label 'Receipt version root'
    foreach ($entry in @($receipt.files)) {
        Assert-ExactProperties -Value $entry -Properties @('path', 'sha256') -Label 'Receipt file entry'
        $relativePath = Resolve-SafeRelativePath -Value $entry.path -Label 'Receipt file path'
        if ($entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch $script:Sha256Pattern) {
            Fail-NativeWindowsInstall 'Receipt file digest is invalid.'
        }
        $target = Resolve-ExistingRegularFile -Path (Join-Path $versionRoot $relativePath) -Label "Owned file '$relativePath'"
        if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) {
            Fail-NativeWindowsInstall "Owned file drifted; repair before uninstall: $relativePath"
        }
    }
    [IO.Directory]::Delete($versionRoot, $true)
    [IO.File]::Delete($receiptPath)
    if ((Test-Path -LiteralPath $versionsRoot -PathType Container) -and
        @(Get-ChildItem -LiteralPath $versionsRoot -Force).Count -eq 0) {
        [IO.Directory]::Delete($versionsRoot)
    }
    if ((Test-Path -LiteralPath $root -PathType Container) -and
        @(Get-ChildItem -LiteralPath $root -Force).Count -eq 0) {
        [IO.Directory]::Delete($root)
    }
    Write-Host "Removed native Windows candidate distribution from $versionRoot"
}

$operationRoot = Resolve-InstallRoot -Path $InstallRoot
$installerLock = Enter-InstallerLock -Root $operationRoot
try {
    switch ($Action) {
        'Install' { Invoke-InstallOrRepair -Repair $false }
        'Repair' { Invoke-InstallOrRepair -Repair $true }
        'Recover' { Invoke-Recover }
        'Uninstall' { Invoke-Uninstall }
    }
} finally {
    $installerLock.Dispose()
}
