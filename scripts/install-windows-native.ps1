# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Qualification-only native Windows installer for the OpenShell MXC candidate.

.DESCRIPTION
    Installs, repairs, or removes an exact Windows OpenShell distribution built
    from NVIDIA/OpenShell PR #2721. The installer is deliberately file-only: it
    does not start a process, install a service, select a runtime provider, or
    activate native Windows support. A later slice can consume the receipt after
    the corresponding lifecycle and activation gates pass.
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Repair', 'Uninstall')]
    [string]$Action = 'Install',

    [string]$ManifestPath,

    [string]$PayloadRoot,

    [string]$InstallRoot = (Join-Path
        ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))
        'NVIDIA\NemoClaw\native-candidate'),

    [switch]$Json
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
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    Assert-NoReparsePoint -Path $resolved -Label 'InstallRoot'
    return $resolved
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
        Fail-NativeWindowsInstall 'OpenShell authority does not match the pinned PR #2721 distribution.'
    }

    if ($manifest.files -isnot [Array] -or $manifest.files.Count -lt 2 -or $manifest.files.Count -gt 8) {
        Fail-NativeWindowsInstall 'Distribution manifest files must contain between two and eight entries.'
    }
    $destinations = @{}
    $resolvedFiles = @()
    $omittedOptionalDestinations = @()
    foreach ($entry in @($manifest.files)) {
        Assert-ExactProperties -Value $entry -Properties @(
            'destination', 'required', 'sha256', 'source'
        ) -Label 'Distribution file entry'
        $source = Resolve-SafeRelativePath -Value $entry.source -Label 'Distribution source'
        $destination = Resolve-SafeRelativePath -Value $entry.destination -Label 'Distribution destination'
        if ($entry.required -isnot [bool] -or $entry.sha256 -isnot [string] -or
            $entry.sha256 -cnotmatch $script:Sha256Pattern) {
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
            if ($entry.required) {
                Fail-NativeWindowsInstall "Required distribution source is missing: $source"
            }
            $omittedOptionalDestinations += $destination
            continue
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
        OmittedOptionalDestinations = @($omittedOptionalDestinations | Sort-Object)
    }
}

function Test-InstalledFiles {
    param(
        [Parameter(Mandatory)][string]$VersionRoot,
        [Parameter(Mandatory)][Array]$Files
    )

    foreach ($file in $Files) {
        $target = Join-Path $VersionRoot $file.Destination
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            return $false
        }
        Assert-NoReparsePoint -Path $target -Label "Installed file '$($file.Destination)'"
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
                    Write-JsonAtomic -Path $recoveryPath -Value ([pscustomobject]@{
                        receiptVersion = 1
                        action = 'restore-prior-version'
                        versionRoot = $versionRoot
                        backupRoot = $backupRoot
                        failedReplacementRoot = $null
                        publishError = $publishError
                        rollbackError = $_.Exception.Message
                    })
                    Fail-NativeWindowsInstall "Repair publication and rollback failed. Recovery authority: $recoveryPath"
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
                    Write-JsonAtomic -Path $recoveryPath -Value ([pscustomobject]@{
                        receiptVersion = 1
                        action = 'restore-prior-version-and-remove-replacement'
                        versionRoot = $versionRoot
                        backupRoot = $backupRoot
                        failedReplacementRoot = $failedReplacementRoot
                        publishError = $cleanupError
                        rollbackError = $_.Exception.Message
                    })
                    Fail-NativeWindowsInstall "Repair backup cleanup and rollback failed. Recovery authority: $recoveryPath"
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

function Invoke-InstallOrRepair {
    param([Parameter(Mandatory)][bool]$Repair)

    if ([string]::IsNullOrWhiteSpace($ManifestPath) -or [string]::IsNullOrWhiteSpace($PayloadRoot)) {
        Fail-NativeWindowsInstall 'ManifestPath and PayloadRoot are required for Install and Repair.'
    }
    $root = Resolve-InstallRoot -Path $InstallRoot
    $repairRecoveryPath = Join-Path $root 'repair-recovery.json'
    if (Test-Path -LiteralPath $repairRecoveryPath -PathType Leaf) {
        Fail-NativeWindowsInstall "Unresolved repair state must be reconciled before installation: $repairRecoveryPath"
    }
    $distribution = Read-DistributionManifest -Path $ManifestPath -Root $PayloadRoot
    $versionRoot = Publish-Distribution -Distribution $distribution -Root $root -Repair $Repair
    $receiptPath = Join-Path $root $script:ReceiptFileName
    $installedFiles = @($distribution.Files | ForEach-Object {
        [pscustomobject]@{
            path = $_.Destination
            sha256 = $_.Sha256
        }
    })
    $receipt = [pscustomobject]@{
        receiptVersion = 1
        classification = 'qualification-only'
        platform = 'windows'
        architecture = $distribution.Architecture
        openshell = [pscustomobject]@{
            repository = $script:TrustedOpenShellRepository
            pullRequest = $script:TrustedOpenShellPullRequest
            revision = $script:TrustedOpenShellRevision
        }
        manifestSha256 = $distribution.ManifestSha256
        installerSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
        installRoot = $root
        versionRoot = $versionRoot
        files = $installedFiles
        omittedOptionalDestinations = @($distribution.OmittedOptionalDestinations)
    }
    Write-JsonAtomic -Path $receiptPath -Value $receipt
    if ($Json) {
        Write-Output ($receipt | ConvertTo-Json -Depth 12 -Compress)
    } else {
        Write-Host "Native Windows candidate distribution installed at $versionRoot"
    }
}

function Invoke-Uninstall {
    $root = Resolve-InstallRoot -Path $InstallRoot
    $repairRecoveryPath = Join-Path $root 'repair-recovery.json'
    if (Test-Path -LiteralPath $repairRecoveryPath -PathType Leaf) {
        Fail-NativeWindowsInstall "Unresolved repair state must be reconciled before uninstall: $repairRecoveryPath"
    }
    $receiptPath = Resolve-ExistingRegularFile -Path (Join-Path $root $script:ReceiptFileName) -Label 'Install receipt'
    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    } catch {
        Fail-NativeWindowsInstall 'Install receipt is not valid JSON.'
    }
    Assert-ExactProperties -Value $receipt -Properties @(
        'architecture', 'classification', 'files', 'installerSha256', 'installRoot',
        'manifestSha256', 'omittedOptionalDestinations', 'openshell', 'platform',
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
    $result = [pscustomobject]@{
        receiptVersion = 1
        action = 'uninstall'
        classification = 'qualification-only'
        removedVersionRoot = $versionRoot
        finalAbsence = -not (Test-Path -LiteralPath $versionRoot)
    }
    if ($Json) {
        Write-Output ($result | ConvertTo-Json -Depth 4 -Compress)
    } else {
        Write-Host "Removed native Windows candidate distribution from $versionRoot"
    }
}

switch ($Action) {
    'Install' { Invoke-InstallOrRepair -Repair $false }
    'Repair' { Invoke-InstallOrRepair -Repair $true }
    'Uninstall' { Invoke-Uninstall }
}
