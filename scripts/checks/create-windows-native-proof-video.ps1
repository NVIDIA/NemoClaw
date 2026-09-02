# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Screen-record the complete native Windows installer qualification.

.DESCRIPTION
    Launches the real setup/install/repair/reinstall/uninstall qualification
    in a visible maximized PowerShell console, captures the actual Windows
    desktop four times per second, and encodes those captured frames to H.264
    with the Windows Media Foundation-backed Windows.Media.Editing API.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory)][string]$MsiPath,
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$PackageManifestPath,
    [Parameter(Mandatory)][string]$QualificationReceiptPath,
    [Parameter(Mandatory)][string]$HostReceiptPath,
    [Parameter(Mandatory)][string]$OpenShellReceiptPath,
    [Parameter(Mandatory)][string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:CaptureFramesPerSecond = 4
$script:FrameDurationMilliseconds = 250
$script:MaximumRecordingMilliseconds = 180000
$script:MinimumCaptureFrames = 40
$script:MinimumUniqueFrames = 8

function Fail-ProofVideo {
    param([Parameter(Mandatory)][string]$Message)
    throw "Windows native console proof video failed: $Message"
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

function Save-DesktopFrame {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][Drawing.Rectangle]$Bounds
    )

    $bitmap = [Drawing.Bitmap]::new(
        $Bounds.Width,
        $Bounds.Height,
        [Drawing.Imaging.PixelFormat]::Format24bppRgb
    )
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($Bounds.Location, [Drawing.Point]::Empty, $Bounds.Size)
        $bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
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
    Fail-ProofVideo 'Screen recording requires a native Windows ARM64 process.'
}

$candidate = [IO.Path]::GetFullPath($CandidateCheckout).TrimEnd('\')
if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
    Fail-ProofVideo 'CandidateCheckout is missing.'
}
$msi = Resolve-RequiredFile -Path $MsiPath -Label 'MsiPath'
$setup = Resolve-RequiredFile -Path $SetupPath -Label 'SetupPath'
$manifestPath = Resolve-RequiredFile -Path $PackageManifestPath -Label 'PackageManifestPath'
$qualificationPath = Resolve-RequiredFile -Path $QualificationReceiptPath -Label 'QualificationReceiptPath'
$hostPath = Resolve-RequiredFile -Path $HostReceiptPath -Label 'HostReceiptPath'
$openshellPath = Resolve-RequiredFile -Path $OpenShellReceiptPath -Label 'OpenShellReceiptPath'
$qualificationScript = Resolve-RequiredFile `
    -Path (Join-Path $candidate 'scripts\checks\run-windows-native-package-qualification.ps1') `
    -Label 'Package qualification script'
$consoleDriver = Resolve-RequiredFile `
    -Path (Join-Path $candidate 'scripts\checks\run-windows-native-package-console-proof.ps1') `
    -Label 'Visible console proof driver'

$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (Test-Path -LiteralPath $output) {
    Fail-ProofVideo 'OutputDirectory must not already exist.'
}
$outputParent = Split-Path -Parent $output
if (-not (Test-Path -LiteralPath $outputParent -PathType Container)) {
    Fail-ProofVideo 'OutputDirectory parent must exist.'
}
$consoleQualification = Join-Path $outputParent 'console-video-qualification'
if (Test-Path -LiteralPath $consoleQualification) {
    Fail-ProofVideo 'Console qualification output already exists.'
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
    @($qualification.packageDescendantProhibitedStarts).Count -ne 0 -or
    @($qualification.newPackageDescendantProhibitedProcesses).Count -ne 0) {
    Fail-ProofVideo 'Initial package qualification receipt is not a complete passing lifecycle.'
}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
[IO.Directory]::CreateDirectory($output) | Out-Null
$consoleTranscript = Join-Path $output 'live-console-transcript.txt'
$frameRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-console-frames-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($frameRoot) | Out-Null
$proofProcess = $null
try {
    $primaryScreen = [Windows.Forms.Screen]::PrimaryScreen
    if ($null -eq $primaryScreen) {
        Fail-ProofVideo 'The Windows runner has no primary desktop screen.'
    }
    $screenBounds = $primaryScreen.Bounds
    if ($screenBounds.Width -lt 800 -or $screenBounds.Height -lt 600) {
        Fail-ProofVideo "The Windows desktop is too small to record: $($screenBounds.Width)x$($screenBounds.Height)."
    }

    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $proofArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $consoleDriver,
        '-QualificationScript', $qualificationScript,
        '-ProductVersion', $ProductVersion,
        '-MsiPath', $msi,
        '-SetupPath', $setup,
        '-PackageManifestPath', $manifestPath,
        '-QualificationArtifactDirectory', $consoleQualification,
        '-TranscriptPath', $consoleTranscript
    )
    $proofProcess = Start-Process `
        -FilePath $powershell `
        -ArgumentList $proofArguments `
        -WindowStyle Maximized `
        -PassThru `
        -ErrorAction Stop

    Start-Sleep -Seconds 1
    $recordingClock = [Diagnostics.Stopwatch]::StartNew()
    $framePaths = @()
    while (-not $proofProcess.HasExited) {
        if ($recordingClock.ElapsedMilliseconds -gt $script:MaximumRecordingMilliseconds) {
            $proofProcess.Kill()
            $proofProcess.WaitForExit()
            Fail-ProofVideo 'Visible console qualification exceeded its recording timeout.'
        }
        $framePath = Join-Path $frameRoot ('frame-{0:D5}.png' -f ($framePaths.Count + 1))
        Save-DesktopFrame -Path $framePath -Bounds $screenBounds
        $framePaths += $framePath
        Start-Sleep -Milliseconds $script:FrameDurationMilliseconds
        $proofProcess.Refresh()
    }
    $proofProcess.WaitForExit()
    $recordingClock.Stop()
    $proofExitCode = $proofProcess.ExitCode
    if ($proofExitCode -ne 0) {
        Fail-ProofVideo "Visible console qualification failed with exit code $proofExitCode."
    }
    if ($framePaths.Count -lt $script:MinimumCaptureFrames) {
        Fail-ProofVideo "The screen recording captured too few frames: $($framePaths.Count)."
    }
    if (-not (Test-Path -LiteralPath $consoleTranscript -PathType Leaf) -or
        (Get-Item -LiteralPath $consoleTranscript).Length -eq 0) {
        Fail-ProofVideo 'The visible console transcript is missing.'
    }

    $frameHashes = @($framePaths | ForEach-Object {
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
    })
    $uniqueFrameCount = @($frameHashes | Sort-Object -Unique).Count
    if ($uniqueFrameCount -lt $script:MinimumUniqueFrames) {
        Fail-ProofVideo "The desktop capture is static or blank: only $uniqueFrameCount unique frames."
    }

    $middleIndex = [int][Math]::Floor(($framePaths.Count - 1) / 2)
    [IO.File]::Copy($framePaths[0], (Join-Path $output 'console-start.png'), $false)
    [IO.File]::Copy($framePaths[$middleIndex], (Join-Path $output 'console-middle.png'), $false)
    [IO.File]::Copy($framePaths[$framePaths.Count - 1], (Join-Path $output 'console-finish.png'), $false)

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $unionMetadataRoot = Join-Path $programFilesX86 'Windows Kits\10\UnionMetadata'
    $windowsWinMd = @(Get-ChildItem -LiteralPath $unionMetadataRoot -Directory | Where-Object {
        $_.Name -cmatch '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
    } | Sort-Object { [version]$_.Name } -Descending | ForEach-Object {
        Get-Item -LiteralPath (Join-Path $_.FullName 'Windows.winmd') -ErrorAction SilentlyContinue
    } | Select-Object -First 1)
    if ($windowsWinMd.Count -ne 1) {
        Fail-ProofVideo 'Windows SDK metadata for Media Foundation is missing.'
    }
    $runtimeDirectory = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $runtimeWinRt = Join-Path $runtimeDirectory 'System.Runtime.WindowsRuntime.dll'
    $compiler = Join-Path $runtimeDirectory 'csc.exe'
    if (-not (Test-Path -LiteralPath $runtimeWinRt -PathType Leaf) -or
        -not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
        Fail-ProofVideo 'The .NET Framework WinRT compiler support is missing.'
    }
    $frameworkReferenceRoot = Join-Path $programFilesX86 'Reference Assemblies\Microsoft\Framework\.NETFramework'
    $systemRuntimeFacade = @(Get-ChildItem -LiteralPath $frameworkReferenceRoot -Directory | Where-Object {
        $_.Name -cmatch '^v[0-9]+\.[0-9]+(\.[0-9]+)?$'
    } | Sort-Object { [version]$_.Name.TrimStart('v') } -Descending | ForEach-Object {
        Get-Item -LiteralPath (Join-Path $_.FullName 'Facades\System.Runtime.dll') -ErrorAction SilentlyContinue
    } | Select-Object -First 1)
    if ($systemRuntimeFacade.Count -ne 1) {
        Fail-ProofVideo 'The .NET Framework System.Runtime facade is missing.'
    }

    $encoderSource = @'
using System;
using System.IO;
using System.Threading.Tasks;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;

public static class NemoClawConsoleVideoEncoder
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
            var clip = await MediaClip.CreateFromImageFileAsync(
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
    $encoderSourcePath = Join-Path $frameRoot 'NemoClawConsoleVideoEncoder.cs'
    $encoderAssemblyPath = Join-Path $frameRoot 'NemoClawConsoleVideoEncoder.dll'
    [IO.File]::WriteAllText($encoderSourcePath, $encoderSource, [Text.UTF8Encoding]::new($false))
    $compilerArguments = @(
        '/nologo',
        '/target:library',
        "/out:$encoderAssemblyPath",
        "/reference:$($windowsWinMd[0].FullName)",
        "/reference:$runtimeWinRt",
        "/reference:$($systemRuntimeFacade[0].FullName)",
        $encoderSourcePath
    )
    & $compiler @compilerArguments
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $encoderAssemblyPath -PathType Leaf)) {
        Fail-ProofVideo 'The Windows Media Foundation console encoder did not compile.'
    }
    [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($encoderAssemblyPath)) | Out-Null

    $videoName = "NemoClaw-$ProductVersion-windows-arm64-console-proof-$($CandidateSha.Substring(0, 12)).mp4"
    $videoPath = Join-Path $output $videoName
    $renderTask = [NemoClawConsoleVideoEncoder]::RenderAsync(
        [string[]]$framePaths,
        $script:FrameDurationMilliseconds,
        $videoPath
    )
    $renderedPath = $renderTask.GetAwaiter().GetResult()
    if ($renderedPath -cne $videoPath -or
        -not (Test-Path -LiteralPath $videoPath -PathType Leaf) -or
        (Get-Item -LiteralPath $videoPath).Length -lt 65536) {
        Fail-ProofVideo 'Media Foundation did not produce the expected console MP4.'
    }
    $videoBytes = [IO.File]::ReadAllBytes($videoPath)
    $headerText = [Text.Encoding]::ASCII.GetString($videoBytes, 0, [Math]::Min(64, $videoBytes.Length))
    if ($headerText -notmatch 'ftyp') {
        Fail-ProofVideo 'Rendered console proof is not an ISO base media file.'
    }

    $consoleQualificationReceipt = Resolve-RequiredFile `
        -Path (Join-Path $consoleQualification 'package-qualification.json') `
        -Label 'Recorded console qualification receipt'
    $receipt = [pscustomobject]@{
        schemaVersion = 2
        classification = 'native-windows-candidate-preview-console-screen-recording'
        candidateSha = $CandidateSha
        productVersion = $ProductVersion
        architecture = 'arm64'
        source = [pscustomobject]@{
            packageManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            initialQualificationReceiptSha256 = (Get-FileHash -LiteralPath $qualificationPath -Algorithm SHA256).Hash.ToLowerInvariant()
            recordedQualificationReceiptSha256 = (Get-FileHash -LiteralPath $consoleQualificationReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
            hostReceiptSha256 = (Get-FileHash -LiteralPath $hostPath -Algorithm SHA256).Hash.ToLowerInvariant()
            openshellReceiptSha256 = (Get-FileHash -LiteralPath $openshellPath -Algorithm SHA256).Hash.ToLowerInvariant()
            consoleTranscriptSha256 = (Get-FileHash -LiteralPath $consoleTranscript -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        capture = [pscustomobject]@{
            kind = 'actual Windows desktop screen capture of visible PowerShell console'
            sourceWidth = $screenBounds.Width
            sourceHeight = $screenBounds.Height
            requestedFramesPerSecond = $script:CaptureFramesPerSecond
            frameDurationMilliseconds = $script:FrameDurationMilliseconds
            frameCount = $framePaths.Count
            uniqueFrameCount = $uniqueFrameCount
            recordingWallTimeMilliseconds = $recordingClock.ElapsedMilliseconds
            qualificationExitCode = $proofExitCode
        }
        video = [pscustomobject]@{
            file = $videoName
            container = 'mp4'
            encoder = 'Windows Media Foundation via Windows.Media.Editing'
            outputWidth = 1280
            outputHeight = 720
            expectedDurationMilliseconds = $framePaths.Count * $script:FrameDurationMilliseconds
            sha256 = (Get-FileHash -LiteralPath $videoPath -Algorithm SHA256).Hash.ToLowerInvariant()
            bytes = (Get-Item -LiteralPath $videoPath).Length
        }
    }
    [IO.File]::WriteAllText(
        (Join-Path $output 'proof-video-receipt.json'),
        (($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Windows native console screen recording: $videoPath"
} finally {
    if ($null -ne $proofProcess) {
        if (-not $proofProcess.HasExited) {
            try {
                $proofProcess.Kill()
                $proofProcess.WaitForExit()
            } catch {
                Write-Warning "Could not stop visible proof console: $($_.Exception.Message)"
            }
        }
        $proofProcess.Dispose()
    }
    if (Test-Path -LiteralPath $frameRoot -PathType Container) {
        [IO.Directory]::Delete($frameRoot, $true)
    }
}
