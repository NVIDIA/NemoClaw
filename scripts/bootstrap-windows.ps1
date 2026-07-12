# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
    Minimal Windows bootstrap for the standard NemoClaw installer.

.DESCRIPTION
    Prepares a Windows host for NemoClaw by enabling WSL 2, installing an
    Ubuntu 24.04 WSL distro when needed, installing Docker Desktop, verifying Docker
    from WSL, and then opening Ubuntu so the user can run the standard
    curl|bash installer in a native Linux terminal:

        curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

    This script intentionally does not duplicate the full Windows installer.
    It leaves Node.js, NemoClaw CLI installation, Ollama/provider setup, and
    onboarding to scripts/install.sh and nemoclaw onboard.

.PARAMETER DistroName
    WSL distro to install/use. Defaults to Ubuntu-24.04.

.PARAMETER InstallerUrl
    NemoClaw installer URL to print in the final WSL handoff command.

.PARAMETER InstallerArgs
    Optional raw arguments appended after `bash -s --` in the final standard
    installer. Example:
      -InstallerArgs "--non-interactive --yes-i-accept-third-party-software"

.PARAMETER InstallDockerDesktop
    Install and start Docker Desktop before handing off to the standard WSL installer.
    Defaults to true. Pass -InstallDockerDesktop:$false to skip it.

.PARAMETER AutoReboot
    Automatically reboot when WSL feature enablement requests one. By default
    the script prompts first.

.PARAMETER Resume
    Internal switch used by the one-time RunOnce reboot continuation.
#>

[CmdletBinding()]
param(
    [string]$DistroName = 'Ubuntu-24.04',
    [string]$InstallerUrl = 'https://www.nvidia.com/nemoclaw.sh',
    [string]$InstallerArgs = '',
    [bool]$InstallDockerDesktop = $true,
    [switch]$AutoReboot,
    [switch]$Resume
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:SystemRoot) {
    throw 'scripts/bootstrap-windows.ps1 must be run from Windows PowerShell on the Windows host.'
}

$script:RunOnceKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
$script:RunOnceValueName = 'NVIDIA.NemoClaw.WindowsBootstrap'
$script:DockerDesktopExe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$script:DockerCli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$script:WingetDockerId = 'Docker.DockerDesktop'
$script:InstallerWindowTitle = "NVIDIA NemoClaw Installer ($PID)"
$script:InstallDistroAtHandoff = $false
$script:WslOfflineInstallDocsUrl = 'https://learn.microsoft.com/en-us/windows/wsl/install#offline-install'
$script:WslLatestReleaseUrl = 'https://github.com/microsoft/WSL/releases/latest'

function Write-Status {
    param(
        [Parameter(Mandatory)] [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')] [string]$Level = 'INFO'
    )
    switch ($Level) {
        'WARN' { Write-Host $Message -ForegroundColor Yellow }
        'ERROR' { Write-Host $Message -ForegroundColor Red }
        default { Write-Host $Message }
    }
}

function ConvertTo-ProcessArgument {
    param([Parameter(Mandatory)] [string]$Value)
    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function ConvertTo-PowerShellLiteral {
    param([Parameter(Mandatory)] [string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-ScriptInvocationArguments {
    param([switch]$ResumeRun)

    $args = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $PSCommandPath,
        '-DistroName',
        $DistroName,
        '-InstallerUrl',
        $InstallerUrl
    )
    if ($InstallerArgs) {
        $args += @('-InstallerArgs', $InstallerArgs)
    }
    $args += ('-InstallDockerDesktop:{0}' -f ([bool]$InstallDockerDesktop).ToString().ToLowerInvariant())
    if ($AutoReboot) {
        $args += '-AutoReboot'
    }
    if ($ResumeRun) {
        $args += '-Resume'
    }
    return $args
}

function Test-IsAdministrator {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-SelfElevation {
    if (Test-IsAdministrator) {
        return
    }

    if ($Resume) {
        $args = Get-ScriptInvocationArguments -ResumeRun
    } else {
        $args = Get-ScriptInvocationArguments
    }

    Write-Host 'Requesting Administrator privileges to enable WSL...' -ForegroundColor Yellow
    $argumentLine = ($args | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentLine -Verb RunAs -Wait -PassThru
    exit $proc.ExitCode
}

function Initialize-InstallerWindowTitle {
    try {
        $Host.UI.RawUI.WindowTitle = $script:InstallerWindowTitle
    } catch {
        # Some hosts do not expose a mutable window title.
    }
}

function Initialize-WindowInterop {
    try {
        if ('NemoClaw.WindowFocus' -as [type]) {
            return $true
        }
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace NemoClaw {
    public static class WindowFocus {
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
    }
}
"@
        return $true
    } catch {
        return $false
    }
}

function Set-InstallerWindowForeground {
    try {
        if (-not (Initialize-WindowInterop)) {
            throw 'Window interop unavailable.'
        }
        $windowHandle = [NemoClaw.WindowFocus]::GetConsoleWindow()
        if ($windowHandle -ne [IntPtr]::Zero) {
            [NemoClaw.WindowFocus]::ShowWindow($windowHandle, 9) | Out-Null
            [NemoClaw.WindowFocus]::SetForegroundWindow($windowHandle) | Out-Null
            return
        }
    } catch {
        # Fall through to title/PID activation below.
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.AppActivate($script:InstallerWindowTitle)) {
            return
        }
        $shell.AppActivate($PID) | Out-Null
    } catch {
        # Returning focus is best-effort only.
    }
}

function Minimize-DockerDesktopWindow {
    param([int]$TimeoutSeconds = 10)
    if (-not (Initialize-WindowInterop)) {
        return
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $processes = Get-Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.MainWindowHandle -ne [IntPtr]::Zero -and (
                        $_.ProcessName -eq 'Docker Desktop' -or
                        $_.MainWindowTitle -like '*Docker Desktop*'
                    )
                }
            $minimizedAny = $false
            foreach ($process in $processes) {
                [NemoClaw.WindowFocus]::ShowWindow($process.MainWindowHandle, 6) | Out-Null
                $minimizedAny = $true
            }
            if ($minimizedAny) {
                return
            }
        } catch {
            return
        }
        Start-Sleep -Milliseconds 500
    }
}

function Test-DockerDesktopRunning {
    try {
        return $null -ne (
            Get-Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.ProcessName -eq 'Docker Desktop' -or
                    $_.MainWindowTitle -like '*Docker Desktop*'
                } |
                Select-Object -First 1
        )
    } catch {
        return $false
    }
}

function Resolve-WslExe {
    $candidates = @(
        (Join-Path -Path $env:SystemRoot -ChildPath 'System32\wsl.exe'),
        (Join-Path -Path $env:SystemRoot -ChildPath 'Sysnative\wsl.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    $command = Get-Command 'wsl.exe' -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    throw 'wsl.exe was not found. WSL installation requires Windows 10 version 2004/build 19041 or later, or Windows 11.'
}

function Resolve-WingetExe {
    $cmd = Get-Command 'winget.exe' -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $alias = Join-Path -Path $env:LOCALAPPDATA -ChildPath 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $alias) {
        return $alias
    }
    return $null
}

function Set-JsonProperty {
    param(
        [Parameter(Mandatory)] $Object,
        [Parameter(Mandatory)] [string]$PropertyName,
        [AllowNull()] $Value
    )

    $property = $Object.PSObject.Properties[$PropertyName]
    if ($null -ne $property) {
        $property.Value = $Value
    } else {
        Add-Member -InputObject $Object -MemberType NoteProperty -Name $PropertyName -Value $Value
    }
}

function Get-DockerDesktopSettingsPath {
    $settingsDir = Join-Path -Path $env:APPDATA -ChildPath 'Docker'
    $settingsStorePath = Join-Path -Path $settingsDir -ChildPath 'settings-store.json'
    $legacySettingsPath = Join-Path -Path $settingsDir -ChildPath 'settings.json'

    if (Test-Path -LiteralPath $settingsStorePath) {
        return $settingsStorePath
    }
    if (Test-Path -LiteralPath $legacySettingsPath) {
        return $legacySettingsPath
    }
    return $settingsStorePath
}

function Enable-DockerDesktopWslIntegration {
    param([Parameter(Mandatory)] [string]$Name)

    if (-not $InstallDockerDesktop) {
        return
    }
    if (-not $env:APPDATA) {
        Write-Status -Level WARN 'APPDATA is not set; cannot update Docker Desktop WSL integration settings.'
        return
    }

    $settingsPath = Get-DockerDesktopSettingsPath
    $settingsDir = Split-Path -Parent $settingsPath
    New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null

    if (Test-Path -LiteralPath $settingsPath) {
        $backupPath = "$settingsPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
        Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
        try {
            $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        } catch {
            Write-Status -Level WARN "Could not parse Docker Desktop settings at $settingsPath; leaving settings unchanged."
            return
        }
    } else {
        $settings = [pscustomobject]@{}
    }

    Set-JsonProperty -Object $settings -PropertyName 'wslEngineEnabled' -Value $true
    Set-JsonProperty -Object $settings -PropertyName 'enableIntegrationWithDefaultWslDistro' -Value $false

    $integratedDistros = @()
    $integratedDistrosProperty = $settings.PSObject.Properties['integratedWslDistros']
    if ($null -ne $integratedDistrosProperty -and $null -ne $integratedDistrosProperty.Value) {
        $integratedDistros = @($integratedDistrosProperty.Value)
    }
    if ($integratedDistros -notcontains $Name) {
        $integratedDistros += $Name
    }
    Set-JsonProperty -Object $settings -PropertyName 'integratedWslDistros' -Value ([string[]]($integratedDistros | Where-Object { $_ } | Select-Object -Unique))

    $json = $settings | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($settingsPath, $json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-Status "Enabled Docker Desktop WSL integration settings for '$Name'."
}

function Get-WindowsFeatureState {
    param([Parameter(Mandatory)] [string]$Name)
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $Name -ErrorAction SilentlyContinue
    if (-not $feature) {
        throw "Windows optional feature not found: $Name"
    }
    return [string]$feature.State
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [switch]$SuppressOutput
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($SuppressOutput) {
            & $FilePath @ArgumentList *> $null
        } else {
            & $FilePath @ArgumentList | ForEach-Object { Write-NativeOutput -Value $_ }
        }
        $exitCode = $LASTEXITCODE
        return [int]$exitCode
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Write-NativeOutput {
    param([AllowNull()] $Value)
    if ($null -eq $Value) {
        return
    }

    $text = [string]$Value
    $normalized = $text -replace "`r`n", "`n" -replace "`r", "`n"
    foreach ($line in ($normalized -split "`n")) {
        Write-Host $line
    }
}

function Write-CompactNativeOutput {
    param([AllowNull()] $Value)
    if ($null -eq $Value) {
        return
    }

    $text = [string]$Value
    $normalized = $text -replace "`r`n", "`n" -replace "`r", "`n"
    foreach ($line in ($normalized -split "`n")) {
        $display = ([string]$line).Replace([string][char]0, '').TrimEnd()
        if ($display.Trim().Length -gt 0) {
            Write-Host $display
        }
    }
}

function Invoke-NativeCommandOutput {
    param(
        [Parameter(Mandatory)] [string]$FilePath,
        [string[]]$ArgumentList = @(),
        [switch]$MergeError
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($MergeError) {
            $output = & $FilePath @ArgumentList 2>&1 | ForEach-Object { "$_" } | Out-String
        } else {
            $output = & $FilePath @ArgumentList 2>$null | ForEach-Object { "$_" } | Out-String
        }
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{
            ExitCode = $exitCode
            Output = $output
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Install-DockerDesktop {
    if (-not $InstallDockerDesktop) {
        Write-Status 'InstallDockerDesktop=$false; skipping Docker Desktop install.'
        return
    }
    if (Test-Path -LiteralPath $script:DockerDesktopExe) {
        Write-Status 'Docker Desktop already installed.'
        return
    }

    $winget = Resolve-WingetExe
    if (-not $winget) {
        $scriptHint = if ($PSCommandPath) { $PSCommandPath } else { 'this bootstrap script' }
        Write-Status -Level ERROR 'Cannot install Docker Desktop automatically: winget.exe is not available on this machine.'
        Write-Status -Level ERROR 'This usually means the Windows App Installer package is missing (common on Windows Server or stripped images).'
        Write-Status -Level INFO  "To finish setup, do one of the following, then re-run ${scriptHint}:"
        Write-Status -Level INFO  '  1) Install "App Installer" from the Microsoft Store (provides winget), or'
        Write-Status -Level INFO  '  2) Download Docker Desktop manually from https://www.docker.com/products/docker-desktop/ and install it.'
        Write-Status -Level INFO  'After Docker Desktop is installed, the bootstrap script will skip the install step on the next run.'
        exit 1
    }

    Write-Status 'Installing Docker Desktop with winget...'
    & $winget install `
        --id $script:WingetDockerId `
        --source winget `
        --silent `
        --accept-package-agreements `
        --accept-source-agreements

    $acceptedExitCodes = @(0, 3010, -1978335189)
    if ($acceptedExitCodes -notcontains $LASTEXITCODE) {
        throw "Docker Desktop winget install failed with exit code $LASTEXITCODE"
    }

    if (-not (Test-Path -LiteralPath $script:DockerDesktopExe)) {
        Write-Status -Level WARN "Docker Desktop binary not found at $script:DockerDesktopExe after winget install."
    }
}

function Wait-DockerDesktopEngine {
    param([int]$TimeoutSeconds = 120)
    if (-not (Test-Path -LiteralPath $script:DockerCli)) {
        Write-Status -Level WARN "Docker CLI not found at $script:DockerCli; skipping Docker readiness wait."
        return $false
    }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            & $script:DockerCli info *> $null
            if ($LASTEXITCODE -eq 0) {
                Write-Status 'Docker engine is responsive.'
                return $true
            }
        } catch {
            # Docker Desktop is still starting.
        }
        Start-Sleep -Seconds 5
    }

    Write-Status -Level WARN "Docker engine did not become responsive within $TimeoutSeconds seconds."
    return $false
}

function Start-DockerDesktop {
    if (-not $InstallDockerDesktop) {
        return
    }
    if (-not (Test-Path -LiteralPath $script:DockerDesktopExe)) {
        Write-Status -Level WARN 'Docker Desktop is not installed; cannot start it.'
        return
    }

    $wasRunning = Test-DockerDesktopRunning
    if ($wasRunning) {
        Write-Status 'Docker Desktop is already running.'
    } else {
        Write-Status 'Launching Docker Desktop...'
    }
    Start-Process -FilePath $script:DockerDesktopExe | Out-Null

    if (-not (Test-Path -LiteralPath $script:DockerCli)) {
        Write-Status -Level WARN "Docker CLI not found at $script:DockerCli; skipping Docker readiness wait."
        return
    }

    Wait-DockerDesktopEngine -TimeoutSeconds 120 | Out-Null
    if ($wasRunning) {
        Write-Status 'Restarting Docker Desktop so WSL integration picks up the configured distro...'
        Restart-DockerDesktop
    } else {
        Minimize-DockerDesktopWindow
        Set-InstallerWindowForeground
    }
}

function Restart-DockerDesktop {
    if (-not (Test-Path -LiteralPath $script:DockerCli)) {
        Write-Status -Level WARN "Docker CLI not found at $script:DockerCli; cannot restart Docker Desktop."
        return
    }

    Write-Status 'Restarting Docker Desktop...'
    try {
        & $script:DockerCli desktop restart *> $null
        if ($LASTEXITCODE -ne 0) {
            Write-Status -Level WARN "docker desktop restart exited with code $LASTEXITCODE."
        }
    } catch {
        Write-Status -Level WARN "docker desktop restart failed: $($_.Exception.Message)"
    }
    Wait-DockerDesktopEngine -TimeoutSeconds 120 | Out-Null
    Minimize-DockerDesktopWindow
    Set-InstallerWindowForeground
}

function Verify-DockerFromWsl {
    if (-not $InstallDockerDesktop) {
        return $true
    }
    $wsl = Resolve-WslExe
    try {
        $dockerInfoExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('-d', $DistroName, '--', 'docker', 'info') -SuppressOutput
        if ($dockerInfoExitCode -eq 0) {
            Write-Status "Docker is reachable from WSL distro '$DistroName'."
            return $true
        } else {
            Write-Status -Level WARN "docker info from WSL exited $dockerInfoExitCode. Docker Desktop may still be starting, or WSL integration may need to be enabled in Docker Desktop settings."
        }
    } catch {
        Write-Status -Level WARN "Docker-in-WSL verification skipped: $($_.Exception.Message)"
    }
    return $false
}

function Ensure-DockerWslIntegration {
    if (-not $InstallDockerDesktop) {
        return
    }
    if (Verify-DockerFromWsl) {
        return
    }

    Minimize-DockerDesktopWindow
    Set-InstallerWindowForeground
    Write-Host ''
    Write-Host "Waiting for Docker Desktop WSL integration for '$DistroName'..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
        if (Verify-DockerFromWsl) {
            return
        }
    }

    Write-Host ''
    Write-Host "Docker Desktop is installed, but Docker is not reachable from WSL distro '$DistroName'." -ForegroundColor Yellow
    Write-Host 'Open Docker Desktop > Settings > Resources > WSL integration.' -ForegroundColor Yellow
    Write-Host "Enable integration for '$DistroName' and apply the change, then rerun this script." -ForegroundColor Yellow
    Write-Host ''
    throw "Docker is not reachable from WSL distro '$DistroName'."
}

function Register-ResumeRunOnce {
    if (-not (Test-Path -LiteralPath $script:RunOnceKey)) {
        New-Item -Path $script:RunOnceKey -Force | Out-Null
    }
    $cmd = Get-ManualResumeCommand
    New-ItemProperty -Path $script:RunOnceKey -Name $script:RunOnceValueName `
        -Value "!$cmd" -PropertyType String -Force | Out-Null
    Write-Status "Registered best-effort reboot resume command."
}

function Get-ManualResumeCommand {
    $argumentLine = (Get-ScriptInvocationArguments -ResumeRun | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '
    return "powershell.exe $argumentLine"
}

function Unregister-ResumeRunOnce {
    if (-not (Test-Path -LiteralPath $script:RunOnceKey)) {
        return
    }
    $existing = Get-ItemProperty -Path $script:RunOnceKey -ErrorAction SilentlyContinue
    if ($existing -and $existing.PSObject.Properties.Name -contains $script:RunOnceValueName) {
        Remove-ItemProperty -Path $script:RunOnceKey -Name $script:RunOnceValueName -Force
        Write-Status 'Cleared reboot resume command.'
    }
}

function Request-Reboot {
    Register-ResumeRunOnce
    $manualResumeCommand = Get-ManualResumeCommand
    Write-Status -Level WARN 'A reboot is required to finish enabling WSL 2.'
    Write-Host ''
    Write-Host 'This bootstrap may resume automatically the next time you sign in.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'After reboot/sign-in, if no bootstrap window opens, rerun this command from an elevated PowerShell window:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  $manualResumeCommand" -ForegroundColor White
    Write-Host ''

    if ($AutoReboot) {
        Write-Status -Level WARN 'AutoReboot specified; restarting in 10 seconds. Save your work.'
        Start-Sleep -Seconds 10
        Restart-Computer -Force
        exit 0
    }

    Write-Host ''
    Write-Host 'Please reboot now.' -ForegroundColor Yellow
    Write-Host ''
    $answer = Read-Host 'Reboot now? [Y/n]'
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer.Trim().ToLowerInvariant().StartsWith('y')) {
        Restart-Computer -Force
    }
    exit 0
}

function Enable-WslFeatures {
    Write-Status 'Enabling WSL 2 Windows features...'
    $restartNeeded = $false
    foreach ($feature in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
        $state = Get-WindowsFeatureState -Name $feature
        if ($state -eq 'Enabled') {
            Write-Status "Feature already enabled: $feature"
            continue
        }
        if ($state -eq 'EnablePending') {
            Write-Status -Level WARN "Feature enable is pending reboot: $feature"
            $restartNeeded = $true
            continue
        }
        Write-Status "Enabling Windows feature: $feature"
        $result = Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart
        if ($result.RestartNeeded) {
            $restartNeeded = $true
        }
        $updatedState = Get-WindowsFeatureState -Name $feature
        if ($updatedState -eq 'Enabled') {
            Write-Status "Feature enabled: $feature"
        } elseif ($updatedState -eq 'EnablePending') {
            Write-Status -Level WARN "Feature enable is pending reboot: $feature"
            $restartNeeded = $true
        } else {
            throw "Windows feature $feature was not enabled. Current state: $updatedState"
        }
    }

    if ($restartNeeded) {
        Request-Reboot
    }

}

function Test-WslStatusReportsMissingRuntime {
    param([AllowNull()] [string]$Output)

    if (-not $Output) {
        return $false
    }
    return $Output -match 'Windows Subsystem for Linux is not installed'
}

function Test-WslStatusReportsStartupBlocked {
    param([AllowNull()] [string]$Output)

    if (-not $Output) {
        return $false
    }
    return ($Output -match 'WSL2 is unable to start since virtualization is not enabled') -or
        (($Output -match 'Virtual Machine Platform') -and ($Output -match 'enablevirtualization'))
}

function Write-WslManualInstallGuidance {
    Write-Host 'Manual WSL install links:' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  Offline install docs: $script:WslOfflineInstallDocsUrl" -ForegroundColor Yellow
    Write-Host "  Latest WSL release:  $script:WslLatestReleaseUrl" -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Download the matching .x64.msi or .arm64.msi, install it, reboot if required, then rerun this script.' -ForegroundColor Yellow
}

function Write-WslStartupBlockedNotice {
    Write-Host ''
    Write-Host 'Windows reports that WSL 2 cannot start yet.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'This script will try to repair the required WSL components automatically.' -ForegroundColor Yellow
    Write-Host 'If this persists after repair and reboot, enable virtualization in firmware and confirm Virtual Machine Platform is enabled.' -ForegroundColor Yellow
}

function Write-WslStatusUnavailableNotice {
    param([Parameter(Mandatory)] [int]$ExitCode)

    Write-Host ''
    Write-Host 'Windows Subsystem for Linux could not be verified.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "The command 'wsl --status' exited with code $ExitCode, so this script cannot safely install or run the $DistroName WSL distro yet." -ForegroundColor Yellow
    Write-Host 'This script will try to repair the required WSL components automatically.' -ForegroundColor Yellow
}

function Test-WslRepairOutputReportsForbidden {
    param([AllowNull()] [string]$Output)

    if (-not $Output) {
        return $false
    }
    return $Output -match 'Forbidden\s*\(403\)'
}

function Test-WslOutputRequiresReboot {
    param([AllowNull()] [string]$Output)

    if (-not $Output) {
        return $false
    }
    return $Output -match 'Changes will not be effective until the system is rebooted'
}

function Write-WslRepairInstructions {
    param(
        [Parameter(Mandatory)] [int]$ExitCode,
        [AllowNull()] [string]$Output
    )

    Write-Host ''
    Write-Host 'Automatic WSL repair did not complete.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "The command 'wsl --install --no-distribution' exited with code $ExitCode." -ForegroundColor Yellow
    if (Test-WslRepairOutputReportsForbidden -Output $Output) {
        Write-Host 'The online WSL installer returned Forbidden (403), so this machine may require the manual/offline WSL install path.' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host 'Repair WSL, then rerun this script:' -ForegroundColor Yellow
    Write-Host '  1. Check VPN, proxy, firewall, or Windows image policy that may block the online WSL installer.' -ForegroundColor Yellow
    Write-Host '  2. Run: wsl --install --no-distribution' -ForegroundColor Yellow
    Write-Host '  3. Reboot if Windows requests it.' -ForegroundColor Yellow
    Write-Host '  4. If the online installer returns Forbidden (403) or remains blocked, install WSL manually.' -ForegroundColor Yellow
    Write-Host ''
    Write-WslManualInstallGuidance
    Write-Host ''
}

function Write-WslRepairDidNotVerifyInstructions {
    param(
        [Parameter(Mandatory)] [int]$StatusExitCode,
        [AllowNull()] [string]$StatusOutput
    )

    Write-Host ''
    Write-Host 'Automatic WSL repair completed, but WSL still could not be verified.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "After repair, 'wsl --status' exited with code $StatusExitCode." -ForegroundColor Yellow
    if (-not [string]::IsNullOrWhiteSpace($StatusOutput)) {
        Write-Host ''
        Write-Host 'wsl --status output:' -ForegroundColor Yellow
        Write-CompactNativeOutput -Value $StatusOutput
    }
    Write-Host ''
    Write-Host 'Repair WSL, then rerun this script:' -ForegroundColor Yellow
    Write-Host '  1. Reboot if Windows requested it.' -ForegroundColor Yellow
    Write-Host '  2. Run: wsl --status' -ForegroundColor Yellow
    Write-Host '  3. If WSL remains unavailable, run: wsl --install --no-distribution' -ForegroundColor Yellow
    Write-Host '  4. If the online installer returns Forbidden (403) or remains blocked, install WSL manually.' -ForegroundColor Yellow
    Write-Host ''
    Write-WslManualInstallGuidance
    Write-Host ''
}

function Invoke-WslNoDistributionInstallRepair {
    $wsl = Resolve-WslExe
    Write-Host ''
    Write-Host "Attempting WSL repair: wsl --install --no-distribution" -ForegroundColor Yellow
    Write-Host ''
    $repairResult = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('--install', '--no-distribution') -MergeError
    Write-CompactNativeOutput -Value $repairResult.Output

    if ($repairResult.ExitCode -eq 0) {
        Write-Status 'WSL repair command completed successfully.'
        if (Test-WslOutputRequiresReboot -Output $repairResult.Output) {
            Request-Reboot
            return
        }

        $statusResult = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('--status') -MergeError
        $statusOutput = [string]$statusResult.Output
        if (
            $statusResult.ExitCode -eq 0 -and
            -not (Test-WslStatusReportsMissingRuntime -Output $statusOutput) -and
            -not (Test-WslStatusReportsStartupBlocked -Output $statusOutput)
        ) {
            Write-Status 'WSL status verified after repair.'
            return
        }

        Write-WslRepairDidNotVerifyInstructions -StatusExitCode $statusResult.ExitCode -StatusOutput $statusResult.Output
        throw "wsl --install --no-distribution completed, but 'wsl --status' still exited with code $($statusResult.ExitCode). Repair WSL, then rerun this script."
    }

    Write-WslRepairInstructions -ExitCode $repairResult.ExitCode -Output $repairResult.Output
    throw "wsl --install --no-distribution failed with exit code $($repairResult.ExitCode). Repair WSL, then rerun this script."
}

function Assert-WslRuntimeAvailable {
    $wsl = Resolve-WslExe
    $result = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('--status') -MergeError
    $statusOutput = [string]$result.Output

    if (Test-WslStatusReportsMissingRuntime -Output $statusOutput) {
        Write-WslSubsystemMissingNotice -Name $DistroName
        Invoke-WslNoDistributionInstallRepair
        return
    }

    if (Test-WslStatusReportsStartupBlocked -Output $statusOutput) {
        Write-WslStartupBlockedNotice
        Invoke-WslNoDistributionInstallRepair
        return
    }

    if ($result.ExitCode -ne 0) {
        Write-WslStatusUnavailableNotice -ExitCode $result.ExitCode
        Invoke-WslNoDistributionInstallRepair
        return
    }
}

function Get-WslDistros {
    $wsl = Resolve-WslExe
    $previous = $env:WSL_UTF8
    $env:WSL_UTF8 = '1'
    try {
        $result = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('-l', '-q')
    } finally {
        if ($null -eq $previous) {
            Remove-Item Env:WSL_UTF8 -ErrorAction SilentlyContinue
        } else {
            $env:WSL_UTF8 = $previous
        }
    }
    if ($result.ExitCode -ne 0) {
        return @()
    }
    return @(
        $result.Output -split "`r?`n" |
            ForEach-Object { $_.Trim().Trim([char]0) } |
            Where-Object { $_ }
    )
}

function Get-WslDistroVersion {
    param([Parameter(Mandatory)] [string]$Name)

    $wsl = Resolve-WslExe
    $result = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('-l', '-v')
    if ($result.ExitCode -ne 0) {
        return $null
    }

    foreach ($line in ($result.Output -split "`r?`n")) {
        $clean = ($line -replace [char]0, '').Trim()
        if (-not $clean) {
            continue
        }
        $clean = $clean -replace '^\*\s*', ''
        $pattern = '^' + [regex]::Escape($Name) + '\s+\S+\s+(?<version>[12])$'
        if ($clean -match $pattern) {
            return [int]$Matches['version']
        }
    }

    return $null
}

function Ensure-WslDistroVersion2 {
    param([Parameter(Mandatory)] [string]$Name)

    $wsl = Resolve-WslExe
    $version = Get-WslDistroVersion -Name $Name
    if ($version -eq 2) {
        Write-Status "$Name is already WSL 2."
        return
    }
    if ($version -ne 1) {
        Write-Status -Level WARN "Could not determine the WSL version for $Name; continuing without changing it."
        return
    }

    Write-Status "Converting $Name from WSL 1 to WSL 2..."
    $setVersionExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('--set-version', $Name, '2')
    if ($setVersionExitCode -ne 0) {
        throw "wsl --set-version failed with exit code $setVersionExitCode"
    }

    $updatedVersion = Get-WslDistroVersion -Name $Name
    if ($updatedVersion -ne 2) {
        throw "Could not verify $Name is WSL 2 after conversion. Current version: $updatedVersion"
    }
    Write-Status "$Name is now WSL 2."
}

function Get-WslInstallCommandText {
    param([Parameter(Mandatory)] [string]$Name)

    return "wsl --install -d $Name"
}

function Get-WslDistroRegistryProperties {
    param([Parameter(Mandatory)] [string]$Name)

    $lxssPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
    if (-not (Test-Path -LiteralPath $lxssPath)) {
        return $null
    }

    foreach ($key in (Get-ChildItem -Path $lxssPath -ErrorAction SilentlyContinue)) {
        $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
        if (-not $properties) {
            continue
        }
        $distributionName = $properties.PSObject.Properties['DistributionName']
        if ($null -ne $distributionName -and $distributionName.Value -eq $Name) {
            return $properties
        }
    }

    return $null
}

function Get-WslDistroDefaultUid {
    param([Parameter(Mandatory)] [string]$Name)

    $properties = Get-WslDistroRegistryProperties -Name $Name
    if (-not $properties) {
        return $null
    }

    $defaultUid = $properties.PSObject.Properties['DefaultUid']
    if ($null -eq $defaultUid -or $null -eq $defaultUid.Value) {
        return $null
    }

    return [int]$defaultUid.Value
}

function Wait-WslDefaultUserReady {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [int]$TimeoutSeconds = 600
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $uid = Get-WslDistroDefaultUid -Name $Name
        if ($null -ne $uid -and $uid -gt 0) {
            return $uid
        }
        Start-Sleep -Seconds 2
    }

    return $null
}

function Start-WslInstallInPowerShellWindow {
    param([Parameter(Mandatory)] [string]$Name)

    $wsl = Resolve-WslExe
    $statusPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('nemoclaw-wsl-install-{0}-{1}.status' -f $PID, [guid]::NewGuid().ToString('N'))
    $logPath = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ('nemoclaw-wsl-install-{0}-{1}.log' -f $PID, [guid]::NewGuid().ToString('N'))
    $failurePrefix = "wsl --install -d $Name failed with exit code "
    $successMessage = "Ubuntu installer command exited. This window will close automatically."
    $installCommand = @(
        '$ErrorActionPreference = ''Continue'''
        ('$statusPath = {0}' -f (ConvertTo-PowerShellLiteral -Value $statusPath))
        ('$logPath = {0}' -f (ConvertTo-PowerShellLiteral -Value $logPath))
        '$transcriptStarted = $false'
        'try { Start-Transcript -Path $logPath -Force | Out-Null; $transcriptStarted = $true } catch { }'
        ('& {0} --install -d {1}' -f (ConvertTo-PowerShellLiteral -Value $wsl), (ConvertTo-PowerShellLiteral -Value $Name))
        '$wslExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }'
        "Write-Host ''"
        'if ($wslExitCode -ne 0) {'
        ('    Write-Host ({0} + $wslExitCode) -ForegroundColor Red' -f (ConvertTo-PowerShellLiteral -Value $failurePrefix))
        '    Write-Host ''Resolve the error above, then rerun the NemoClaw Windows bootstrap.'' -ForegroundColor Yellow'
        '} else {'
        ('    Write-Host {0} -ForegroundColor Cyan' -f (ConvertTo-PowerShellLiteral -Value $successMessage))
        '}'
        'if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch { } }'
        'try { [System.IO.File]::WriteAllText($statusPath, [string]$wslExitCode) } catch { }'
        'if ($wslExitCode -ne 0) { exit $wslExitCode }'
    ) -join "`n"
    $installArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        $installCommand
    )
    $installArgumentLine = ($installArguments | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '

    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $installArgumentLine -PassThru
    $processId = $null
    if ($process) {
        $idProperty = $process.PSObject.Properties['Id']
        if ($null -ne $idProperty -and $null -ne $idProperty.Value) {
            $processId = [int]$idProperty.Value
        }
    }

    return [pscustomobject]@{
        StatusPath = $statusPath
        LogPath = $logPath
        ProcessId = $processId
    }
}

function Get-WslInstallExitCode {
    param([AllowNull()] [string]$StatusPath)

    if ([string]::IsNullOrWhiteSpace($StatusPath)) {
        return $null
    }

    try {
        if (-not (Test-Path -LiteralPath $StatusPath)) {
            return $null
        }
        $rawStatus = (Get-Content -LiteralPath $StatusPath -Raw).Trim()
        if ([string]::IsNullOrWhiteSpace($rawStatus)) {
            return $null
        }
        return [int]$rawStatus
    } catch {
        Write-Status -Level WARN "Could not read WSL install status file: $($_.Exception.Message)"
        return $null
    }
}

function Wait-WslDistroRegistrationOrInstallExit {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [AllowNull()] [string]$StatusPath,
        [int]$TimeoutSeconds = 300
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Get-WslDistros) -contains $Name) {
            return [pscustomobject]@{
                Registered = $true
                ExitCode = Get-WslInstallExitCode -StatusPath $StatusPath
            }
        }

        $exitCode = Get-WslInstallExitCode -StatusPath $StatusPath
        if ($null -ne $exitCode) {
            return [pscustomobject]@{
                Registered = (Get-WslDistros) -contains $Name
                ExitCode = $exitCode
            }
        }

        Start-Sleep -Seconds 2
    }

    $finalExitCode = Get-WslInstallExitCode -StatusPath $StatusPath
    return [pscustomobject]@{
        Registered = (Get-WslDistros) -contains $Name
        ExitCode = $finalExitCode
    }
}

function Get-WslInstallLog {
    param(
        [AllowNull()] [string]$LogPath,
        [switch]$SuppressWarnings
    )

    if ([string]::IsNullOrWhiteSpace($LogPath)) {
        return $null
    }
    if (-not (Test-Path -LiteralPath $LogPath)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $LogPath -Raw
    } catch {
        if (-not $SuppressWarnings) {
            Write-Status -Level WARN "Could not read WSL install log: $($_.Exception.Message)"
        }
        return $null
    }
}

function Convert-WslInstallLogForDisplay {
    param(
        [AllowNull()] [string]$Log,
        [AllowNull()] [string[]]$SensitivePaths = @()
    )

    if ([string]::IsNullOrWhiteSpace($Log)) {
        return $Log
    }

    $redactedMarker = '[PowerShell transcript metadata redacted.]'
    $lines = (($Log -replace "`r`n", "`n") -replace "`r", "`n") -split "`n"
    $separatorPattern = '^[\s\uFEFF]*\*{6,}\s*$'
    $firstSeparator = -1

    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $separatorPattern) {
            $firstSeparator = $i
            break
        }
    }

    if ($firstSeparator -lt 0) {
        $transcriptEvidencePatterns = @(
            '(?im)^\s*(?:Windows\s+)?PowerShell transcript (?:start|end)\s*$',
            '(?i)\b(?:Start|Stop)-Transcript\b',
            '(?i)\$transcriptStarted\b'
        )
        foreach ($pattern in $transcriptEvidencePatterns) {
            if ($Log -match $pattern) {
                return $redactedMarker
            }
        }
        foreach ($path in $SensitivePaths) {
            if (
                -not [string]::IsNullOrWhiteSpace($path) -and
                $Log.IndexOf($path, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            ) {
                return $redactedMarker
            }
        }
        return $Log
    }

    $headerEnd = -1
    for ($i = $firstSeparator + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $separatorPattern) {
            $headerEnd = $i
            break
        }
    }

    if ($headerEnd -lt 0) {
        return $redactedMarker
    }

    if (($headerEnd + 1) -lt $lines.Count) {
        $bodyLines = @($lines[($headerEnd + 1)..($lines.Count - 1)])
    } else {
        $bodyLines = @()
    }

    $bodySeparators = @()
    for ($i = 0; $i -lt $bodyLines.Count; $i++) {
        if ($bodyLines[$i] -match $separatorPattern) {
            $bodySeparators += $i
        }
    }

    $footerStart = -1
    if ($bodySeparators.Count -ge 2) {
        $footerStart = $bodySeparators[$bodySeparators.Count - 2]
    } elseif ($bodySeparators.Count -eq 1) {
        $footerStart = $bodySeparators[0]
    }

    if ($footerStart -ge 0) {
        if ($footerStart -eq 0) {
            $bodyLines = @()
        } else {
            $bodyLines = @($bodyLines[0..($footerStart - 1)])
        }
    }

    $filteredBodyLines = @()
    foreach ($line in $bodyLines) {
        $containsSensitivePath = $false
        foreach ($path in $SensitivePaths) {
            if (
                -not [string]::IsNullOrWhiteSpace($path) -and
                $line.IndexOf($path, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            ) {
                $containsSensitivePath = $true
                break
            }
        }
        if (-not $containsSensitivePath) {
            $filteredBodyLines += $line
        }
    }
    $bodyLines = $filteredBodyLines

    $bodyStart = 0
    $bodyEnd = $bodyLines.Count - 1
    while ($bodyStart -le $bodyEnd -and [string]::IsNullOrWhiteSpace($bodyLines[$bodyStart])) {
        $bodyStart++
    }
    while ($bodyEnd -ge $bodyStart -and [string]::IsNullOrWhiteSpace($bodyLines[$bodyEnd])) {
        $bodyEnd--
    }
    if ($bodyStart -le $bodyEnd) {
        $bodyLines = @($bodyLines[($bodyStart)..($bodyEnd)])
    } else {
        $bodyLines = @()
    }

    return (@($redactedMarker) + $bodyLines) -join "`n"
}

function Write-WslInstallLog {
    param(
        [AllowNull()] [string]$LogPath,
        [AllowNull()] [string]$StatusPath
    )

    $log = Get-WslInstallLog -LogPath $LogPath
    if ([string]::IsNullOrWhiteSpace($log)) {
        return
    }
    $displayLog = Convert-WslInstallLogForDisplay -Log $log -SensitivePaths @($StatusPath, $LogPath)
    if ([string]::IsNullOrWhiteSpace($displayLog)) {
        return
    }

    Write-Host ''
    Write-Host 'WSL install output:' -ForegroundColor Yellow
    Write-NativeOutput -Value $displayLog
    Write-Host ''
}

function Test-WslInstallLogRequiresReboot {
    param([AllowNull()] [string]$LogPath)

    $log = Get-WslInstallLog -LogPath $LogPath -SuppressWarnings
    return Test-WslOutputRequiresReboot -Output $log
}

function Remove-WslInstallArtifacts {
    param(
        [AllowNull()] [string]$StatusPath,
        [AllowNull()] [string]$LogPath
    )

    foreach ($path in @($StatusPath, $LogPath)) {
        if (-not [string]::IsNullOrWhiteSpace($path)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-WslDistroForDockerIntegration {
    param(
        [Parameter(Mandatory)] [string]$Name,
        [string]$Reason = 'so Docker Desktop integration is applied on next launch'
    )

    $wsl = Resolve-WslExe
    Write-Status "Terminating WSL distro '$Name' $Reason..."
    $terminateExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('--terminate', $Name) -SuppressOutput
    if ($terminateExitCode -ne 0) {
        Write-Status -Level WARN "wsl --terminate $Name exited with code $terminateExitCode."
    }
}

function Assert-WslDistroStarts {
    param([Parameter(Mandatory)] [string]$Name)

    $wsl = Resolve-WslExe
    Write-Status "Verifying WSL distro '$Name' starts..."
    $startExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('-d', $Name, '--', 'echo', 'WSL_OK') -SuppressOutput
    if ($startExitCode -ne 0) {
        throw "WSL distro '$Name' is registered but could not start. Run 'wsl -d $Name' from PowerShell, resolve the startup error, then rerun this script."
    }
    Write-Status "Verified WSL distro '$Name' starts."
}

function Ensure-WslDockerCliConfigDirectory {
    param([Parameter(Mandatory)] [string]$Name)

    if (-not $InstallDockerDesktop) {
        return
    }

    $wsl = Resolve-WslExe
    Write-Status "Preparing Docker CLI config directory in '$Name'..."
    $mkdirExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('-d', $Name, '--', 'sh', '-lc', 'mkdir -p "$HOME/.docker"') -SuppressOutput
    if ($mkdirExitCode -ne 0) {
        Write-Status -Level WARN "Could not prepare ~/.docker in '$Name'; Docker Desktop may need to retry WSL integration."
    } else {
        Write-Status "Prepared Docker CLI config directory in '$Name'."
    }

    Stop-WslDistroForDockerIntegration -Name $Name -Reason 'after preparing Docker CLI config directory'
}

function Write-WslUbuntuRequiredNotice {
    param([Parameter(Mandatory)] [string]$Name)

    Write-Host ''
    if ($Name -eq 'Ubuntu-24.04') {
        Write-Host 'NemoClaw on Windows ARM requires WSL2 Ubuntu 24.04.' -ForegroundColor Yellow
        Write-Host "Please run: $(Get-WslInstallCommandText -Name $Name)" -ForegroundColor Yellow
        Write-Host 'Then re-run this installer.' -ForegroundColor Yellow
    } else {
        Write-Host "NemoClaw on Windows requires a WSL2 distro named $Name." -ForegroundColor Yellow
        Write-Host "Please run: $(Get-WslInstallCommandText -Name $Name)" -ForegroundColor Yellow
        Write-Host 'Then re-run this installer.' -ForegroundColor Yellow
    }
    Write-Host ''
}

function Ensure-UbuntuWsl {
    $script:InstallDistroAtHandoff = $false

    $distros = Get-WslDistros
    if ($distros -notcontains $DistroName) {
        Write-Host ''
        Write-Host "$DistroName is not registered yet. Installing it in a separate PowerShell window..." -ForegroundColor Cyan
        Write-Host 'Create the Unix user in that window if prompted. This script will continue after setup completes.' -ForegroundColor Cyan
        Write-Host ''
        $installResult = Start-WslInstallInPowerShellWindow -Name $DistroName
        $installArtifactsRemoved = $false
        $registrationResult = Wait-WslDistroRegistrationOrInstallExit -Name $DistroName -StatusPath $installResult.StatusPath

        if ($null -ne $registrationResult.ExitCode -and $registrationResult.ExitCode -ne 0) {
            Write-WslInstallLog -LogPath $installResult.LogPath -StatusPath $installResult.StatusPath
            Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
            $installArtifactsRemoved = $true
            Write-WslUbuntuRequiredNotice -Name $DistroName
            throw "WSL distro install command failed with exit code $($registrationResult.ExitCode)."
        }

        if (-not $registrationResult.Registered) {
            if ($null -ne $registrationResult.ExitCode) {
                $installRequiresReboot = Test-WslInstallLogRequiresReboot -LogPath $installResult.LogPath
                Write-WslInstallLog -LogPath $installResult.LogPath -StatusPath $installResult.StatusPath
                Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
                $installArtifactsRemoved = $true
                Write-Status -Level WARN "$DistroName install command completed, but the distro is not registered yet."
                if ($installRequiresReboot) {
                    Write-Status -Level WARN 'A reboot is required before WSL can finish registering the distro.'
                    Request-Reboot
                    return
                }

                Write-Status -Level WARN 'The install output did not report that a reboot is required.'
                Write-WslUbuntuRequiredNotice -Name $DistroName
                throw "WSL distro '$DistroName' is still not registered after install."
            }

            Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
            $installArtifactsRemoved = $true
            Write-WslUbuntuRequiredNotice -Name $DistroName
            throw "WSL distro '$DistroName' is still not registered after install."
        }

        if ($null -ne $registrationResult.ExitCode) {
            Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
            $installArtifactsRemoved = $true
        }

        Write-Status "WSL distro registered: $DistroName"
        $defaultUid = Wait-WslDefaultUserReady -Name $DistroName
        if ($null -eq $defaultUid) {
            if (-not $installArtifactsRemoved) {
                Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
                $installArtifactsRemoved = $true
            }
            throw "Timed out waiting for $DistroName first-run user creation."
        }

        if (-not $installArtifactsRemoved) {
            Remove-WslInstallArtifacts -StatusPath $installResult.StatusPath -LogPath $installResult.LogPath
            $installArtifactsRemoved = $true
        }
        Write-Status "$DistroName first-run user is registered (UID $defaultUid)."
        Stop-WslDistroForDockerIntegration -Name $DistroName -Reason 'after first-run setup so Docker Desktop sees a settled user profile'
    } else {
        Write-Status "WSL distro already registered: $DistroName"
    }

    Ensure-WslDistroVersion2 -Name $DistroName
    Assert-WslDistroStarts -Name $DistroName
    Ensure-WslDockerCliConfigDirectory -Name $DistroName

    Write-Status "$DistroName is ready."
}

function Write-WslSubsystemMissingNotice {
    param([Parameter(Mandatory)] [string]$Name)

    Write-Host ''
    Write-Host 'Windows Subsystem for Linux is not fully installed.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "Windows reports that the WSL runtime is not installed, so this script cannot install or run the $Name WSL distro yet." -ForegroundColor Yellow
    Write-Host 'This script will try to repair the required WSL components automatically.' -ForegroundColor Yellow
}

function Write-DockerDesktopNotice {
    if ((Test-Path -LiteralPath $script:DockerDesktopExe) -or (Test-Path -LiteralPath $script:DockerCli)) {
        return
    }
    Write-Status -Level WARN 'Docker Desktop was not detected. The standard installer/onboard flow will need Docker available from WSL.'
}

function Escape-BashArgument {
    param([Parameter(Mandatory)] [AllowEmptyString()] [string]$Value)

    $singleQuote = "'"
    $escapedSingleQuote = "'\''"
    return $singleQuote + $Value.Replace($singleQuote, $escapedSingleQuote) + $singleQuote
}

function Split-InstallerArgumentString {
    param([Parameter(Mandatory)] [string]$Value)

    $tokens = @()
    $current = [System.Text.StringBuilder]::new()
    $quote = [char]0

    for ($i = 0; $i -lt $Value.Length; $i++) {
        $char = $Value[$i]
        if ($quote -ne [char]0) {
            if ($char -eq $quote) {
                $quote = [char]0
            } else {
                [void]$current.Append($char)
            }
            continue
        }

        if ($char -eq "'" -or $char -eq '"') {
            $quote = $char
            continue
        }

        if ([char]::IsWhiteSpace($char)) {
            if ($current.Length -gt 0) {
                $tokens += $current.ToString()
                [void]$current.Clear()
            }
            continue
        }

        [void]$current.Append($char)
    }

    if ($quote -ne [char]0) {
        throw 'InstallerArgs contains an unterminated quote.'
    }
    if ($current.Length -gt 0) {
        $tokens += $current.ToString()
    }

    return $tokens
}

function Assert-InstallerUrl {
    param([Parameter(Mandatory)] [string]$Url)

    if (-not [System.Uri]::IsWellFormedUriString($Url, [System.UriKind]::Absolute)) {
        throw "InstallerUrl is not a valid absolute URL: $Url"
    }

    $uri = [System.Uri]::new($Url)
    if ($uri.Scheme -notin @('http', 'https')) {
        throw "InstallerUrl must use http or https: $Url"
    }
}

function Get-NemoClawInstallerCommand {
    Assert-InstallerUrl -Url $InstallerUrl

    $escapedUrl = Escape-BashArgument -Value $InstallerUrl
    $installerCommand = "curl -fsSL $escapedUrl | bash"
    if (-not [string]::IsNullOrWhiteSpace($InstallerArgs)) {
        $escapedArgs = Split-InstallerArgumentString -Value $InstallerArgs |
            ForEach-Object { Escape-BashArgument -Value $_ }
        if ($escapedArgs.Count -gt 0) {
            $installerCommand += " -s -- $($escapedArgs -join ' ')"
        }
    }
    return $installerCommand
}

function Open-WslInPowerShellWindow {
    param([Parameter(Mandatory)] [string]$Name)

    $wsl = Resolve-WslExe
    $launchCommand = '& {0} -d {1}' -f (ConvertTo-PowerShellLiteral -Value $wsl), (ConvertTo-PowerShellLiteral -Value $Name)
    $launchArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        $launchCommand
    )
    $launchArgumentLine = ($launchArguments | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '

    Start-Process -FilePath 'powershell.exe' -ArgumentList $launchArgumentLine | Out-Null
}

function Open-UbuntuForInstaller {
    $wsl = Resolve-WslExe
    try {
        if ($script:InstallDistroAtHandoff) {
            Start-Process -FilePath $wsl -ArgumentList @('--install', '-d', $DistroName) | Out-Null
            return
        }
        Open-WslInPowerShellWindow -Name $DistroName
    } catch {
        Write-Status -Level WARN "Could not open $DistroName automatically: $($_.Exception.Message)"
        if ($script:InstallDistroAtHandoff) {
            Write-WslUbuntuRequiredNotice -Name $DistroName
            throw
        }
    }
}

function Write-InstallerHandoff {
    $installerCommand = Get-NemoClawInstallerCommand

    Write-Host ''
    Write-Host 'Windows preparation is complete.' -ForegroundColor Green
    Write-Host ''
    if ($script:InstallDistroAtHandoff) {
        Write-Host "Ubuntu will install and launch in a separate window. After first-run setup completes, run this command inside Ubuntu to install NemoClaw:" -ForegroundColor Cyan
    } else {
        Write-Host "An Ubuntu window is opening. Run this command inside Ubuntu to install NemoClaw:" -ForegroundColor Cyan
    }
    Write-Host ''
    Write-Host "  $installerCommand" -ForegroundColor White
    Write-Host ''
    Open-UbuntuForInstaller
}

function Invoke-Main {
    Invoke-SelfElevation
    Initialize-InstallerWindowTitle
    if ($Resume) {
        Unregister-ResumeRunOnce
        Write-Status 'Resuming after reboot...'
    }

    Enable-WslFeatures
    Assert-WslRuntimeAvailable
    Ensure-UbuntuWsl
    Install-DockerDesktop
    Enable-DockerDesktopWslIntegration -Name $DistroName
    Start-DockerDesktop
    if ($script:InstallDistroAtHandoff) {
        Write-Status "Skipping Docker-in-WSL verification until $DistroName first-run setup completes."
    } else {
        Ensure-DockerWslIntegration
    }
    Write-DockerDesktopNotice
    Unregister-ResumeRunOnce
    Write-Status 'Windows preparation completed successfully.'
    Write-InstallerHandoff
}

if ($env:NEMOCLAW_BOOTSTRAP_WINDOWS_SOURCE_ONLY -ne '1') {
    Invoke-Main
}
