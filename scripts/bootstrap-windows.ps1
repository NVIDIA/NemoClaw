# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
    Minimal Windows bootstrap for the standard NemoClaw installer.

.DESCRIPTION
    Prepares a Windows host for NemoClaw by enabling WSL 2, installing an
    Ubuntu WSL distro when needed, installing Docker Desktop, verifying Docker
    from WSL, and then opening Ubuntu so the user can run the standard
    curl|bash installer in a native Linux terminal:

        curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

    This script intentionally does not duplicate the full Windows installer.
    It leaves Node.js, NemoClaw CLI installation, Ollama/provider setup, and
    onboarding to scripts/install.sh and nemoclaw onboard.

.PARAMETER DistroName
    WSL distro to install/use. Defaults to Ubuntu.

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
    [string]$DistroName = 'Ubuntu',
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

function Resolve-UbuntuLauncher {
    $names = @('ubuntu.exe')
    $sanitizedName = $DistroName -replace '[^A-Za-z0-9]', ''
    if ($sanitizedName) {
        $names += "$sanitizedName.exe"
    }
    foreach ($name in ($names | Select-Object -Unique)) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
        $alias = Join-Path -Path $env:LOCALAPPDATA -ChildPath "Microsoft\WindowsApps\$name"
        if (Test-Path -LiteralPath $alias) {
            return $alias
        }
    }
    return $null
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
        throw 'winget.exe not found. Install App Installer from the Microsoft Store and re-run.'
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

    Write-Status 'Launching Docker Desktop...'
    Start-Process -FilePath $script:DockerDesktopExe | Out-Null

    if (-not (Test-Path -LiteralPath $script:DockerCli)) {
        Write-Status -Level WARN "Docker CLI not found at $script:DockerCli; skipping Docker readiness wait."
        return
    }

    Wait-DockerDesktopEngine -TimeoutSeconds 120 | Out-Null
    Write-Status 'Restarting Docker Desktop so WSL integration picks up the default distro...'
    Restart-DockerDesktop
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
    $argumentLine = (Get-ScriptInvocationArguments -ResumeRun | ForEach-Object { ConvertTo-ProcessArgument -Value $_ }) -join ' '
    $cmd = "powershell.exe $argumentLine"
    New-ItemProperty -Path $script:RunOnceKey -Name $script:RunOnceValueName `
        -Value "!$cmd" -PropertyType String -Force | Out-Null
    Write-Status "Registered reboot resume command."
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
    Write-Status -Level WARN 'A reboot is required to finish enabling WSL 2.'
    if ($AutoReboot) {
        Write-Status -Level WARN 'AutoReboot specified; restarting in 10 seconds. Save your work.'
        Start-Sleep -Seconds 10
        Restart-Computer -Force
        exit 0
    }

    Write-Host ''
    Write-Host 'Please reboot now. This bootstrap will resume automatically the next time you sign in.' -ForegroundColor Yellow
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

function Ensure-UbuntuWsl {
    $wsl = Resolve-WslExe
    $script:InstallDistroAtHandoff = $false

    $distros = Get-WslDistros
    if ($distros -notcontains $DistroName) {
        Write-Status "$DistroName is not registered yet. It will be installed during the final Ubuntu handoff."
        $script:InstallDistroAtHandoff = $true
        return
    }

    Write-Status "WSL distro already registered: $DistroName"

    Ensure-WslDistroVersion2 -Name $DistroName

    $setDefaultExitCode = Invoke-NativeCommand -FilePath $wsl -ArgumentList @('--set-default', $DistroName)
    if ($setDefaultExitCode -ne 0) {
        throw "wsl --set-default failed with exit code $setDefaultExitCode"
    }

    $verify = Invoke-NativeCommandOutput -FilePath $wsl -ArgumentList @('-d', $DistroName, '--', 'echo', 'WSL_OK') -MergeError
    if ($verify.ExitCode -ne 0 -or $verify.Output -notmatch 'WSL_OK') {
        throw "Could not start WSL distro '$DistroName'. Output: $($verify.Output)"
    }
    Write-Status "$DistroName is ready."
}

function Write-WslSubsystemMissingNotice {
    param([Parameter(Mandatory)] [string]$Name)

    Write-Host ''
    Write-Host 'Windows Subsystem for Linux is not fully installed.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "The required Windows optional features are enabled, but Windows could not install or run the $Name WSL distro automatically." -ForegroundColor Yellow
    Write-Host 'Rerun this script after WSL is available on this machine.' -ForegroundColor Yellow
    Write-Host ''
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

function Open-UbuntuForInstaller {
    $wsl = Resolve-WslExe
    try {
        if ($script:InstallDistroAtHandoff) {
            Start-Process -FilePath $wsl -ArgumentList @('--install', '-d', $DistroName) | Out-Null
            return
        }

        $ubuntuLauncher = Resolve-UbuntuLauncher
        $windowsTerminal = Get-Command 'wt.exe' -ErrorAction SilentlyContinue
        if ($windowsTerminal) {
            if ($ubuntuLauncher) {
                Start-Process -FilePath $windowsTerminal.Source -ArgumentList @($ubuntuLauncher) | Out-Null
            } else {
                Start-Process -FilePath $windowsTerminal.Source -ArgumentList @('wsl.exe', '-d', $DistroName) | Out-Null
            }
            return
        }
        if ($ubuntuLauncher) {
            Start-Process -FilePath $ubuntuLauncher | Out-Null
            return
        }
        Start-Process -FilePath $wsl -ArgumentList @('-d', $DistroName) | Out-Null
    } catch {
        Write-Status -Level WARN "Could not open $DistroName automatically: $($_.Exception.Message)"
        if ($script:InstallDistroAtHandoff) {
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
        Write-Host "Ubuntu will install and launch now. After first-run setup completes, run this command inside Ubuntu to install NemoClaw:" -ForegroundColor Cyan
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
    Ensure-UbuntuWsl
    Install-DockerDesktop
    Start-DockerDesktop
    if ($script:InstallDistroAtHandoff) {
        Write-Status "Skipping Docker-in-WSL verification until $DistroName is installed and first-run setup completes."
    } else {
        Ensure-DockerWslIntegration
    }
    Write-DockerDesktopNotice
    Unregister-ResumeRunOnce
    Write-Status 'Windows preparation completed successfully.'
    Write-InstallerHandoff
}

Invoke-Main
