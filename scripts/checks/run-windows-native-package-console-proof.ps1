# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Run the complete native Windows package qualification in a visible console.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$QualificationScript,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$MsiPath,
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$PackageManifestPath,
    [Parameter(Mandatory)][string]$QualificationArtifactDirectory,
    [Parameter(Mandatory)][string]$TranscriptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$exitCode = 1
$transcriptStarted = $false
try {
    $rawUi = $Host.UI.RawUI
    $rawUi.WindowTitle = 'NemoClaw Native Windows ARM64 Installer - Live Qualification'
    $bufferSize = $rawUi.BufferSize
    $bufferSize.Width = 140
    $bufferSize.Height = 3000
    $rawUi.BufferSize = $bufferSize
} catch {
    # Window sizing is presentation-only; qualification remains authoritative.
}

try {
    Start-Transcript -LiteralPath $TranscriptPath -Force | Out-Null
    $transcriptStarted = $true
    Clear-Host
    Write-Host 'NemoClaw Native Windows ARM64 Installer - LIVE CONSOLE PROOF' -ForegroundColor Cyan
    Write-Host 'This window is executing the complete setup/install/repair/uninstall flow.'
    Write-Host ''
    Start-Sleep -Seconds 3

    & $QualificationScript `
        -ProductVersion $ProductVersion `
        -MsiPath $MsiPath `
        -SetupPath $SetupPath `
        -PackageManifestPath $PackageManifestPath `
        -ArtifactDirectory $QualificationArtifactDirectory

    Write-Host ''
    Write-Host '[PASS] LIVE CONSOLE PROOF COMPLETE' -ForegroundColor Green
    $exitCode = 0
} catch {
    Write-Host ''
    Write-Host "[FAIL] $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
} finally {
    Start-Sleep -Seconds 4
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}

exit $exitCode
