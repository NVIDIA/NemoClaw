# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Run the complete native Windows package qualification in a live console.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$QualificationScript,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$GitHubRepository,
    [Parameter(Mandatory)][string]$GitHubRunId,
    [Parameter(Mandatory)][string]$DownloadArtifactName,
    [Parameter(Mandatory)][string]$DesktopDownloadDirectory,
    [Parameter(Mandatory)][string]$ExpectedMsiPath,
    [Parameter(Mandatory)][string]$ExpectedSetupPath,
    [Parameter(Mandatory)][string]$ExpectedManifestPath,
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
    $windowSize = $rawUi.WindowSize
    $windowSize.Width = [Math]::Min(120, $rawUi.MaxPhysicalWindowSize.Width)
    $windowSize.Height = [Math]::Min(35, $rawUi.MaxPhysicalWindowSize.Height)
    $rawUi.WindowSize = $windowSize
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
    Start-Sleep -Seconds 2

    $gh = (Get-Command 'gh.exe' -ErrorAction Stop).Source
    Write-Host "PS> gh run download $GitHubRunId --repo $GitHubRepository --name $DownloadArtifactName --dir $DesktopDownloadDirectory"
    [IO.Directory]::CreateDirectory($DesktopDownloadDirectory) | Out-Null
    & $gh run download $GitHubRunId `
        --repo $GitHubRepository `
        --name $DownloadArtifactName `
        --dir $DesktopDownloadDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "GitHub artifact download failed with exit code $LASTEXITCODE."
    }
    Write-Host '[PASS] Installer artifact downloaded from GitHub Actions to the Windows Desktop' -ForegroundColor Green

    $downloadedMsi = Join-Path $DesktopDownloadDirectory (Split-Path -Leaf $ExpectedMsiPath)
    $downloadedSetup = Join-Path $DesktopDownloadDirectory (Split-Path -Leaf $ExpectedSetupPath)
    $downloadedManifest = Join-Path $DesktopDownloadDirectory (Split-Path -Leaf $ExpectedManifestPath)
    foreach ($downloadedFile in @($downloadedSetup, $downloadedMsi, $downloadedManifest)) {
        if (-not (Test-Path -LiteralPath $downloadedFile -PathType Leaf)) {
            throw "Downloaded artifact is missing $(Split-Path -Leaf $downloadedFile)."
        }
    }
    if ((Get-FileHash -LiteralPath $downloadedMsi -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $ExpectedMsiPath -Algorithm SHA256).Hash -or
        (Get-FileHash -LiteralPath $downloadedSetup -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $ExpectedSetupPath -Algorithm SHA256).Hash -or
        (Get-FileHash -LiteralPath $downloadedManifest -Algorithm SHA256).Hash -cne
        (Get-FileHash -LiteralPath $ExpectedManifestPath -Algorithm SHA256).Hash) {
        throw 'Downloaded artifact digests do not match the package just built on this runner.'
    }

    Write-Host "PS> Get-ChildItem $DesktopDownloadDirectory"
    foreach ($downloadedFile in @(Get-ChildItem -LiteralPath $DesktopDownloadDirectory -File | Sort-Object Name)) {
        Write-Host ("OUTPUT> {0,-58} {1,12} bytes" -f $downloadedFile.Name, $downloadedFile.Length)
    }
    Write-Host '[PASS] Downloaded EXE, MSI, and manifest match the GitHub artifact digests' -ForegroundColor Green
    Write-Host ''
    Write-Host "PS> Launch downloaded app with real WiX UI: $downloadedSetup /install /passive /norestart"

    & $QualificationScript `
        -ProductVersion $ProductVersion `
        -MsiPath $downloadedMsi `
        -SetupPath $downloadedSetup `
        -PackageManifestPath $downloadedManifest `
        -ArtifactDirectory $QualificationArtifactDirectory `
        -InteractiveProof

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
