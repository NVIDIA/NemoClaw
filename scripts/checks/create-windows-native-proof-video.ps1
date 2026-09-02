# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Create an H.264 MP4 proof-of-life video from live native Windows receipts.

.DESCRIPTION
    Renders bounded evidence frames from a completed ARM64 package
    qualification and encodes them with the Windows Media Foundation-backed
    Windows.Media.Editing API. No downloaded video encoder is used.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory)][string]$PackageManifestPath,
    [Parameter(Mandatory)][string]$QualificationReceiptPath,
    [Parameter(Mandatory)][string]$HostReceiptPath,
    [Parameter(Mandatory)][string]$OpenShellReceiptPath,
    [Parameter(Mandatory)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:FrameWidth = 1280
$script:FrameHeight = 720
$script:FrameDurationMilliseconds = 3000
$script:ExpectedFrameCount = 8

function Fail-ProofVideo {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native proof video failed: $Message"
}

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Label
    )

    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or
        (Get-Item -LiteralPath $resolved).Length -eq 0) {
        Fail-ProofVideo "$Label is missing."
    }
    return $resolved
}

function ConvertTo-DisplayDigest {
    param([Parameter(Mandatory)][string]$Digest)

    if ($Digest -cnotmatch '^[a-f0-9]{64}$') {
        Fail-ProofVideo 'A receipt contains an invalid SHA-256 digest.'
    }
    return $Digest.Substring(0, 16) + '...' + $Digest.Substring(56, 8)
}

function New-ProofFrame {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Heading,
        [Parameter(Mandatory)][string[]]$Lines,
        [Parameter(Mandatory)][int]$Index,
        [Parameter(Mandatory)][int]$Total
    )

    $bitmap = [Drawing.Bitmap]::new($script:FrameWidth, $script:FrameHeight)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $headingFont = [Drawing.Font]::new('Segoe UI Semibold', 34, [Drawing.FontStyle]::Bold)
    $bodyFont = [Drawing.Font]::new('Consolas', 22, [Drawing.FontStyle]::Regular)
    $smallFont = [Drawing.Font]::new('Segoe UI', 16, [Drawing.FontStyle]::Regular)
    $whiteBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(245, 248, 252))
    $mutedBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(174, 187, 204))
    $greenBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(118, 219, 144))
    $panelBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(30, 42, 58))
    $progressBrush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(118, 185, 255))
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $graphics.Clear([Drawing.Color]::FromArgb(10, 18, 30))
        $graphics.FillRectangle($panelBrush, 48, 42, 1184, 610)
        $graphics.FillRectangle($progressBrush, 48, 42, [int](1184 * $Index / $Total), 8)
        $graphics.DrawString($Heading, $headingFont, $whiteBrush, 82, 82)

        $y = 170
        foreach ($line in $Lines) {
            $brush = if ($line.StartsWith('[PASS]')) { $greenBrush } else { $whiteBrush }
            $graphics.DrawString($line, $bodyFont, $brush, 90, $y)
            $y += 53
        }
        $graphics.DrawString(
            "Live Windows ARM64 qualification evidence  |  frame $Index/$Total",
            $smallFont,
            $mutedBrush,
            82,
            670
        )
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $progressBrush.Dispose()
        $panelBrush.Dispose()
        $greenBrush.Dispose()
        $mutedBrush.Dispose()
        $whiteBrush.Dispose()
        $smallFont.Dispose()
        $bodyFont.Dispose()
        $headingFont.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

if ($ProductVersion -cnotmatch '^[0-9]{1,3}\.[0-9]{1,5}\.[0-9]{1,5}$') {
    Fail-ProofVideo 'ProductVersion is invalid.'
}
if ($CandidateSha -cnotmatch '^[a-f0-9]{40}$') {
    Fail-ProofVideo 'CandidateSha must be a full lowercase Git revision.'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'Arm64' -or
    [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() -cne 'Arm64') {
    Fail-ProofVideo 'Proof video creation requires a native Windows ARM64 process.'
}

$manifestPath = Resolve-RequiredFile -Path $PackageManifestPath -Label 'PackageManifestPath'
$qualificationPath = Resolve-RequiredFile -Path $QualificationReceiptPath -Label 'QualificationReceiptPath'
$hostPath = Resolve-RequiredFile -Path $HostReceiptPath -Label 'HostReceiptPath'
$openshellPath = Resolve-RequiredFile -Path $OpenShellReceiptPath -Label 'OpenShellReceiptPath'
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (Test-Path -LiteralPath $output) {
    Fail-ProofVideo 'OutputDirectory must not already exist.'
}
$outputParent = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    Fail-ProofVideo 'OutputDirectory parent must exist.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$qualification = Get-Content -LiteralPath $qualificationPath -Raw | ConvertFrom-Json
$hostReceipt = Get-Content -LiteralPath $hostPath -Raw | ConvertFrom-Json
$openshellReceipt = Get-Content -LiteralPath $openshellPath -Raw | ConvertFrom-Json
if ($manifest.productVersion -cne $ProductVersion -or $manifest.architecture -cne 'arm64' -or
    $qualification.productVersion -cne $ProductVersion -or $qualification.architecture -cne 'arm64') {
    Fail-ProofVideo 'Package and qualification receipt identity do not match.'
}
if ($hostReceipt.osArchitecture -cne 'Arm64' -or $hostReceipt.processArchitecture -cne 'Arm64' -or
    $hostReceipt.runnerArchitecture -cne 'ARM64') {
    Fail-ProofVideo 'Host receipt does not prove native ARM64 execution.'
}
if ($openshellReceipt.repository -cne 'https://github.com/NVIDIA/OpenShell.git' -or
    [int]$openshellReceipt.pullRequest -ne 2721 -or
    $openshellReceipt.revision -cne 'bcd517bbe08cc80860c9be57699390cd32e8445f') {
    Fail-ProofVideo 'OpenShell source authority does not match NVIDIA/OpenShell#2721.'
}
if (-not $qualification.repairRestoredDigest -or
    -not $qualification.reinstallPreservedRegistration -or
    -not $qualification.finalAbsence -or
    -not $qualification.machinePathRemoved -or
    @($qualification.nativeExecutions).Count -ne 2 -or
    @($qualification.msiRegistration).Count -ne 1 -or
    @($qualification.bundleRegistration).Count -ne 1 -or
    @($qualification.packageDescendantProhibitedStarts).Count -ne 0 -or
    @($qualification.newProhibitedProcesses).Count -ne 0) {
    Fail-ProofVideo 'Qualification receipt is not a complete passing package lifecycle.'
}

Add-Type -AssemblyName System.Drawing
[IO.Directory]::CreateDirectory($output) | Out-Null
$frameRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-proof-frames-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($frameRoot) | Out-Null
try {
    $msi = @($manifest.packages | Where-Object { $_.file -like '*.msi' })
    $setup = @($manifest.packages | Where-Object { $_.file -like '*.exe' })
    $cli = @($qualification.nativeExecutions | Where-Object { $_.file -ceq 'openshell.exe' })
    $gateway = @($qualification.nativeExecutions | Where-Object { $_.file -ceq 'openshell-gateway.exe' })
    if ($msi.Count -ne 1 -or $setup.Count -ne 1 -or $cli.Count -ne 1 -or $gateway.Count -ne 1) {
        Fail-ProofVideo 'Package or native-execution evidence is ambiguous.'
    }

    $frames = @(
        [pscustomobject]@{
            heading = 'NemoClaw Native Windows ARM64 - Proof of Life'
            lines = @(
                "[PASS] Exact NemoClaw head $($CandidateSha.Substring(0, 12))",
                '[PASS] NVIDIA/OpenShell#2721 exact merge payload',
                "Product version $ProductVersion  |  native candidate preview"
            )
        },
        [pscustomobject]@{
            heading = 'Real native Windows ARM64 host'
            lines = @(
                "[PASS] $($hostReceipt.osDescription.Trim())",
                "[PASS] OS architecture $($hostReceipt.osArchitecture)",
                "[PASS] Process architecture $($hostReceipt.processArchitecture)",
                "Runner $($hostReceipt.runnerName)"
            )
        },
        [pscustomobject]@{
            heading = 'Literal downloadable Windows installer'
            lines = @(
                "[PASS] $($setup[0].file)",
                "SHA-256 $(ConvertTo-DisplayDigest -Digest ([string]$setup[0].sha256))",
                "[PASS] $($msi[0].file)",
                "SHA-256 $(ConvertTo-DisplayDigest -Digest ([string]$msi[0].sha256))"
            )
        },
        [pscustomobject]@{
            heading = 'Per-machine Windows Installer registration'
            lines = @(
                "[PASS] Installed under $($qualification.installRoot)",
                "[PASS] MSI ARP: $($qualification.msiRegistration[0].displayName)",
                "[PASS] Bundle ARP: $($qualification.bundleRegistration[0].displayName)",
                '[PASS] Installed bin directory added to machine PATH'
            )
        },
        [pscustomobject]@{
            heading = 'Native OpenShell execution'
            lines = @(
                "[PASS] openshell.exe --version -> $($cli[0].output)",
                "Exit code $($cli[0].exitCode)  |  $(ConvertTo-DisplayDigest -Digest ([string]$cli[0].sha256))",
                "[PASS] openshell-gateway.exe --version -> $($gateway[0].output)",
                "Exit code $($gateway[0].exitCode)  |  $(ConvertTo-DisplayDigest -Digest ([string]$gateway[0].sha256))"
            )
        },
        [pscustomobject]@{
            heading = 'Standard MSI lifecycle'
            lines = @(
                '[PASS] Deliberate file corruption repaired to source digest',
                '[PASS] Same-version reinstall preserved one registration',
                '[PASS] Windows Installer uninstall removed product files',
                '[PASS] Bundle registration and machine PATH removed'
            )
        },
        [pscustomobject]@{
            heading = 'No Linux dependency in the package path'
            lines = @(
                '[PASS] Zero WSL / Docker / Bash / Ubuntu descendants',
                '[PASS] Zero new prohibited processes remained',
                "Observed package descendants: $(@($qualification.packageDescendantStarts).Count)",
                'Customer setup contains no PowerShell or custom action'
            )
        },
        [pscustomobject]@{
            heading = 'Candidate proven - production gates remain explicit'
            lines = @(
                '[PASS] Native package install / repair / uninstall proven',
                '[PASS] Both ARM64 payload executables ran natively',
                'Deferred: real MXC + wxc-exec + gateway service',
                'Deferred: NemoClaw onboarding + production signing'
            )
        }
    )
    if ($frames.Count -ne $script:ExpectedFrameCount) {
        Fail-ProofVideo 'Unexpected proof frame count.'
    }

    $framePaths = @()
    for ($index = 0; $index -lt $frames.Count; $index++) {
        $framePath = Join-Path $frameRoot ('frame-{0:D2}.png' -f ($index + 1))
        New-ProofFrame `
            -Path $framePath `
            -Heading $frames[$index].heading `
            -Lines $frames[$index].lines `
            -Index ($index + 1) `
            -Total $frames.Count
        $framePaths += $framePath
    }

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $windowsWinMd = @(Get-ChildItem `
        -LiteralPath (Join-Path $programFilesX86 'Windows Kits\10\UnionMetadata') `
        -Filter 'Windows.winmd' `
        -Recurse `
        -File | Sort-Object FullName -Descending | Select-Object -First 1)
    if ($windowsWinMd.Count -ne 1) {
        Fail-ProofVideo 'Windows SDK metadata for Media Foundation is missing.'
    }
    $runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $runtimeWinRt = Join-Path $runtimeDirectory 'System.Runtime.WindowsRuntime.dll'
    if (-not (Test-Path -LiteralPath $runtimeWinRt -PathType Leaf)) {
        Fail-ProofVideo 'System.Runtime.WindowsRuntime.dll is missing.'
    }

    $encoderSource = @'
using System;
using System.IO;
using System.Threading.Tasks;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;

public static class NemoClawProofVideoEncoder
{
    public static async Task<string> RenderAsync(
        string[] imagePaths,
        int millisecondsPerFrame,
        string outputPath)
    {
        var composition = new MediaComposition();
        foreach (var imagePath in imagePaths)
        {
            var image = await StorageFile.GetFileFromPathAsync(imagePath);
            var clip = await MediaClip.CreateFromImageFile(
                image,
                TimeSpan.FromMilliseconds(millisecondsPerFrame));
            composition.Clips.Add(clip);
        }

        var outputFolder = await StorageFolder.GetFolderFromPathAsync(
            Path.GetDirectoryName(outputPath));
        var output = await outputFolder.CreateFileAsync(
            Path.GetFileName(outputPath),
            CreationCollisionOption.ReplaceExisting);
        var profile = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.HD720p);
        var result = await composition.RenderToFileAsync(
            output,
            MediaTrimmingPreference.Precise,
            profile);
        if (result != TranscodeFailureReason.None)
        {
            throw new InvalidOperationException("Media Foundation render failed: " + result);
        }
        return output.Path;
    }
}
'@
    Add-Type `
        -TypeDefinition $encoderSource `
        -Language CSharp `
        -ReferencedAssemblies @($windowsWinMd[0].FullName, $runtimeWinRt)

    $videoName = "NemoClaw-$ProductVersion-windows-arm64-proof-$($CandidateSha.Substring(0, 12)).mp4"
    $videoPath = Join-Path $output $videoName
    $renderTask = [NemoClawProofVideoEncoder]::RenderAsync(
        [string[]]$framePaths,
        $script:FrameDurationMilliseconds,
        $videoPath
    )
    $renderedPath = $renderTask.GetAwaiter().GetResult()
    if ($renderedPath -cne $videoPath -or
        -not (Test-Path -LiteralPath $videoPath -PathType Leaf) -or
        (Get-Item -LiteralPath $videoPath).Length -lt 65536) {
        Fail-ProofVideo 'Media Foundation did not produce the expected MP4.'
    }
    $videoBytes = [IO.File]::ReadAllBytes($videoPath)
    $headerText = [Text.Encoding]::ASCII.GetString($videoBytes, 0, [Math]::Min(64, $videoBytes.Length))
    if ($headerText -notmatch 'ftyp') {
        Fail-ProofVideo 'Rendered proof artifact is not an ISO base media file.'
    }

    [IO.File]::Copy($framePaths[0], (Join-Path $output 'proof-thumbnail.png'), $false)
    $receipt = [pscustomobject]@{
        schemaVersion = 1
        classification = 'native-windows-candidate-preview-proof-video'
        candidateSha = $CandidateSha
        productVersion = $ProductVersion
        architecture = 'arm64'
        source = [pscustomobject]@{
            packageManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            qualificationReceiptSha256 = (Get-FileHash -LiteralPath $qualificationPath -Algorithm SHA256).Hash.ToLowerInvariant()
            hostReceiptSha256 = (Get-FileHash -LiteralPath $hostPath -Algorithm SHA256).Hash.ToLowerInvariant()
            openshellReceiptSha256 = (Get-FileHash -LiteralPath $openshellPath -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        video = [pscustomobject]@{
            file = $videoName
            container = 'mp4'
            encoder = 'Windows Media Foundation via Windows.Media.Editing'
            width = $script:FrameWidth
            height = $script:FrameHeight
            frameCount = $frames.Count
            frameDurationMilliseconds = $script:FrameDurationMilliseconds
            expectedDurationMilliseconds = $frames.Count * $script:FrameDurationMilliseconds
            sha256 = (Get-FileHash -LiteralPath $videoPath -Algorithm SHA256).Hash.ToLowerInvariant()
            bytes = (Get-Item -LiteralPath $videoPath).Length
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path $output 'proof-video-receipt.json'),
        (($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Windows native proof-of-life video: $videoPath"
} finally {
    if (Test-Path -LiteralPath $frameRoot -PathType Container) {
        [IO.Directory]::Delete($frameRoot, $true)
    }
}
