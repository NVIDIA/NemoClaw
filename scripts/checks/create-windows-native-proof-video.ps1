# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
    Record the live console running the native Windows installer qualification.

.DESCRIPTION
    Launches the real setup/install/repair/reinstall/uninstall qualification
    in a real Windows console, captures the actual console and WiX installer
    window pixels four times per second, and encodes those live frames to H.264
    with the Windows Media Foundation-backed Windows.Media.Editing API.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CandidateCheckout,
    [Parameter(Mandatory)][string]$ProductVersion,
    [Parameter(Mandatory)][string]$CandidateSha,
    [Parameter(Mandatory)][string]$GitHubRepository,
    [Parameter(Mandatory)][string]$GitHubRunId,
    [Parameter(Mandatory)][string]$DownloadArtifactName,
    [Parameter(Mandatory)][string]$DesktopDownloadDirectory,
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
$script:MaximumRecordingMilliseconds = 1800000
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

function Initialize-NativeWindowCapture {
    Add-Type -AssemblyName System.Drawing
    $captureSource = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public static class NemoClawNativeWindowCapture
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lparam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    public static IntPtr FindWindowContaining(string titleFragment, IntPtr excluded)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
        {
            if (hwnd == excluded)
            {
                return true;
            }
            int length = GetWindowTextLength(hwnd);
            if (length <= 0)
            {
                return true;
            }
            var title = new StringBuilder(length + 1);
            GetWindowText(hwnd, title, title.Capacity);
            if (title.ToString().IndexOf(titleFragment, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static string[] ListWindowTitles()
    {
        var titles = new List<string>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr lparam)
        {
            int length = GetWindowTextLength(hwnd);
            if (length > 0)
            {
                var title = new StringBuilder(length + 1);
                GetWindowText(hwnd, title, title.Capacity);
                titles.Add(title.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return titles.ToArray();
    }

    public static Bitmap Capture(IntPtr hwnd)
    {
        Rect rect;
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out rect))
        {
            throw new InvalidOperationException("Window handle is unavailable.");
        }
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width < 64 || height < 64)
        {
            throw new InvalidOperationException("Window is too small to record.");
        }

        var bitmap = new Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format24bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            IntPtr hdc = graphics.GetHdc();
            try
            {
                if (!PrintWindow(hwnd, hdc, 2))
                {
                    throw new InvalidOperationException("PrintWindow failed.");
                }
            }
            finally
            {
                graphics.ReleaseHdc(hdc);
            }
        }
        return bitmap;
    }
}
'@
    Add-Type `
        -TypeDefinition $captureSource `
        -Language CSharp `
        -ReferencedAssemblies @([Drawing.Bitmap].Assembly.Location)
}

function Save-ActualWindowFrame {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][IntPtr]$ConsoleWindow,
        [Parameter(Mandatory)][IntPtr]$InstallerWindow
    )

    $consoleBitmap = [NemoClawNativeWindowCapture]::Capture($ConsoleWindow)
    $installerBitmap = $null
    $installerCaptured = $false
    if ($InstallerWindow -ne [IntPtr]::Zero) {
        try {
            $installerBitmap = [NemoClawNativeWindowCapture]::Capture($InstallerWindow)
            $installerCaptured = $true
        } catch {
            # Burn can close its progress window between enumeration and capture.
        }
    }
    $frame = [Drawing.Bitmap]::new(1280, 720, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($frame)
    try {
        $graphics.Clear([Drawing.Color]::Black)
        $consoleScale = [Math]::Min(1280 / $consoleBitmap.Width, 720 / $consoleBitmap.Height)
        $consoleWidth = [int]($consoleBitmap.Width * $consoleScale)
        $consoleHeight = [int]($consoleBitmap.Height * $consoleScale)
        $consoleX = [int]((1280 - $consoleWidth) / 2)
        $consoleY = [int]((720 - $consoleHeight) / 2)
        $graphics.DrawImage($consoleBitmap, $consoleX, $consoleY, $consoleWidth, $consoleHeight)

        if ($null -ne $installerBitmap) {
            $installerScale = [Math]::Min(620 / $installerBitmap.Width, 620 / $installerBitmap.Height)
            $installerWidth = [int]($installerBitmap.Width * $installerScale)
            $installerHeight = [int]($installerBitmap.Height * $installerScale)
            $installerX = [int]((1280 - $installerWidth) / 2)
            $installerY = [int]((720 - $installerHeight) / 2)
            $graphics.FillRectangle([Drawing.Brushes]::Black, $installerX - 8, $installerY - 8, $installerWidth + 16, $installerHeight + 16)
            $graphics.DrawImage($installerBitmap, $installerX, $installerY, $installerWidth, $installerHeight)
        }
        $frame.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $frame.Dispose()
        if ($null -ne $installerBitmap) {
            $installerBitmap.Dispose()
        }
        $consoleBitmap.Dispose()
    }
    return $installerCaptured
}

if ($ProductVersion -cnotmatch '^[0-9]{1,3}\.[0-9]{1,5}\.[0-9]{1,5}$') {
    Fail-ProofVideo 'ProductVersion is invalid.'
}
if ($CandidateSha -cnotmatch '^[a-f0-9]{40}$') {
    Fail-ProofVideo 'CandidateSha must be a full lowercase Git revision.'
}
if ($GitHubRepository -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
    $GitHubRunId -cnotmatch '^[0-9]+$' -or
    $DownloadArtifactName -cnotmatch '^[A-Za-z0-9._-]+$') {
    Fail-ProofVideo 'GitHub artifact download authority is invalid.'
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
$desktopDownload = [IO.Path]::GetFullPath($DesktopDownloadDirectory).TrimEnd('\')
if (Test-Path -LiteralPath $desktopDownload) {
    Fail-ProofVideo 'DesktopDownloadDirectory must not already exist.'
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
    $qualification.nativeTurn.verdict -cne 'pass' -or
    $qualification.nativeTurn.exactReply -cne 'CHAT_OK' -or
    $qualification.nativeTurn.openClawExecutionMode -cne 'embedded-worker' -or
    $qualification.nativeTurn.sandboxDeleted -ne $true -or
    @($qualification.nativeExecutions).Count -ne 3 -or
    @($qualification.applicationExecutions).Count -ne 2 -or
    @($qualification.packageDescendantProhibitedStarts).Count -ne 0 -or
    @($qualification.newPackageDescendantProhibitedProcesses).Count -ne 0) {
    Fail-ProofVideo 'Initial package qualification receipt is not a complete passing lifecycle.'
}

Add-Type -AssemblyName System.Drawing
Initialize-NativeWindowCapture
[IO.Directory]::CreateDirectory($output) | Out-Null
$consoleTranscript = Join-Path $output 'live-console-transcript.txt'
$frameRoot = Join-Path $env:RUNNER_TEMP ('nemoclaw-console-frames-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($frameRoot) | Out-Null
$proofProcess = $null
try {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $proofArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $consoleDriver,
        '-QualificationScript', $qualificationScript,
        '-ProductVersion', $ProductVersion,
        '-GitHubRepository', $GitHubRepository,
        '-GitHubRunId', $GitHubRunId,
        '-DownloadArtifactName', $DownloadArtifactName,
        '-DesktopDownloadDirectory', $desktopDownload,
        '-ExpectedMsiPath', $msi,
        '-ExpectedSetupPath', $setup,
        '-ExpectedManifestPath', $manifestPath,
        '-QualificationArtifactDirectory', $consoleQualification,
        '-TranscriptPath', $consoleTranscript
    )
    $proofProcess = Start-Process `
        -FilePath $powershell `
        -ArgumentList $proofArguments `
        -WindowStyle Normal `
        -PassThru `
        -ErrorAction Stop

    $consoleWindowTitle = 'NemoClaw Native Windows ARM64 Installer - Live Qualification'
    $consoleWindow = [IntPtr]::Zero
    $windowDeadline = [DateTime]::UtcNow.AddSeconds(12)
    while ($consoleWindow -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $windowDeadline) {
        $consoleWindow = [NemoClawNativeWindowCapture]::FindWindowContaining(
            $consoleWindowTitle,
            [IntPtr]::Zero
        )
        if ($consoleWindow -eq [IntPtr]::Zero) {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($consoleWindow -eq [IntPtr]::Zero) {
        $titles = [NemoClawNativeWindowCapture]::ListWindowTitles() -join ' | '
        Fail-ProofVideo "The real PowerShell console window was not created. Windows: $titles"
    }

    $recordingClock = [Diagnostics.Stopwatch]::StartNew()
    $framePaths = @()
    $installerWindowFrameCount = 0
    while (-not $proofProcess.HasExited) {
        if ($recordingClock.ElapsedMilliseconds -gt $script:MaximumRecordingMilliseconds) {
            $proofProcess.Kill()
            $proofProcess.WaitForExit()
            Fail-ProofVideo 'Real console qualification exceeded its recording timeout.'
        }
        $installerWindow = [NemoClawNativeWindowCapture]::FindWindowContaining(
            'NemoClaw Native Windows Candidate Setup',
            $consoleWindow
        )
        $framePath = Join-Path $frameRoot ('frame-{0:D5}.png' -f ($framePaths.Count + 1))
        try {
            $installerCaptured = Save-ActualWindowFrame `
                -Path $framePath `
                -ConsoleWindow $consoleWindow `
                -InstallerWindow $installerWindow
        } catch {
            $proofProcess.Refresh()
            if ($proofProcess.HasExited) {
                break
            }
            $consoleWindow = [NemoClawNativeWindowCapture]::FindWindowContaining(
                $consoleWindowTitle,
                [IntPtr]::Zero
            )
            if ($consoleWindow -eq [IntPtr]::Zero) {
                Fail-ProofVideo "The real console window disappeared during qualification: $($_.Exception.Message)"
            }
            continue
        }
        if ($installerCaptured) {
            $installerWindowFrameCount++
        }
        $framePaths += $framePath
        Start-Sleep -Milliseconds $script:FrameDurationMilliseconds
        $proofProcess.Refresh()
    }
    $proofProcess.WaitForExit()
    $recordingClock.Stop()
    $proofExitCode = $proofProcess.ExitCode
    if ($proofExitCode -ne 0) {
        $failureText = if (Test-Path -LiteralPath $consoleTranscript -PathType Leaf) {
            [IO.File]::ReadAllText($consoleTranscript).Trim()
        } else {
            ''
        }
        Fail-ProofVideo "Real console qualification failed with exit code $proofExitCode. $failureText"
    }
    if ($framePaths.Count -lt $script:MinimumCaptureFrames) {
        Fail-ProofVideo "The live console recording captured too few frames: $($framePaths.Count)."
    }
    if (-not (Test-Path -LiteralPath $consoleTranscript -PathType Leaf) -or
        (Get-Item -LiteralPath $consoleTranscript).Length -eq 0) {
        Fail-ProofVideo 'The live console transcript is missing.'
    }
    $consoleTranscriptText = [IO.File]::ReadAllText($consoleTranscript)
    if (-not $consoleTranscriptText.Contains('AGENT> CHAT_OK') -or
        -not $consoleTranscriptText.Contains(
            '[PASS] Installed nemoclaw command created an MXC sandbox and completed an exact CHAT_OK turn'
        )) {
        Fail-ProofVideo 'The recorded console did not show the installed NemoClaw agent turn.'
    }

    if ($installerWindowFrameCount -lt 4) {
        Fail-ProofVideo 'The real WiX installer window was not captured for at least one second.'
    }
    $frameHashes = @($framePaths | ForEach-Object {
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
    })
    $uniqueFrameCount = @($frameHashes | Sort-Object -Unique).Count
    if ($uniqueFrameCount -lt $script:MinimumUniqueFrames) {
        Fail-ProofVideo "The real window recording changed too little: only $uniqueFrameCount unique frames."
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
    $recordedQualification = Get-Content -LiteralPath $consoleQualificationReceipt -Raw | ConvertFrom-Json
    if ($recordedQualification.nativeTurn.verdict -cne 'pass' -or
        $recordedQualification.nativeTurn.exactReply -cne 'CHAT_OK' -or
        $recordedQualification.nativeTurn.openClawExecutionMode -cne 'embedded-worker' -or
        $recordedQualification.nativeTurn.sandboxDeleted -ne $true) {
        Fail-ProofVideo 'The recorded qualification receipt does not prove the installed NemoClaw turn.'
    }
    $receipt = [pscustomobject]@{
        schemaVersion = 2
        classification = 'native-windows-candidate-preview-actual-window-recording'
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
            kind = 'actual PrintWindow capture of real PowerShell console and WiX installer windows'
            sourceWidth = 1280
            sourceHeight = 720
            requestedFramesPerSecond = $script:CaptureFramesPerSecond
            frameDurationMilliseconds = $script:FrameDurationMilliseconds
            frameCount = $framePaths.Count
            uniqueFrameCount = $uniqueFrameCount
            installerWindowFrameCount = $installerWindowFrameCount
            recordingWallTimeMilliseconds = $recordingClock.ElapsedMilliseconds
            qualificationExitCode = $proofExitCode
            installedNemoClawTurn = 'CHAT_OK'
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
    Write-Host "Windows native live console recording: $videoPath"
} finally {
    if ($null -ne $proofProcess) {
        if (-not $proofProcess.HasExited) {
            try {
                $proofProcess.Kill()
                $proofProcess.WaitForExit()
            } catch {
                Write-Warning "Could not stop live proof console: $($_.Exception.Message)"
            }
        }
        $proofProcess.Dispose()
    }
    if (Test-Path -LiteralPath $frameRoot -PathType Container) {
        [IO.Directory]::Delete($frameRoot, $true)
    }
}
