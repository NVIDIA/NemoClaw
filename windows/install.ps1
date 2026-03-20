# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw Windows Installer
# Installs WSL2 and Docker Desktop, handling reboots and daemon verification.
# Usage: Run install.bat (double-click) or: powershell -ExecutionPolicy Bypass -File install.ps1

# ---------------------------------------------------------------------------
# Output Helpers
# ---------------------------------------------------------------------------

function Write-Info  { param([string]$Message) Write-Host "[INFO]  $Message" -ForegroundColor Blue }
function Write-Warn  { param([string]$Message) Write-Host "[WARN]  $Message" -ForegroundColor Yellow }
function Write-Err   { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }
function Write-Ok    { param([string]$Message) Write-Host "[OK]    $Message" -ForegroundColor Green }
function Write-Step  { param([int]$Current, [int]$Total, [string]$Message) Write-Host "[$Current/$Total] $Message" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# Spinner for Long Operations
# ---------------------------------------------------------------------------

function Show-Spinner {
    param([string]$Message, [scriptblock]$Action)
    $spinChars = @('|', '/', '-', '\')
    $job = Start-Job -ScriptBlock $Action
    $i = 0
    while ($job.State -eq 'Running') {
        $char = $spinChars[$i % $spinChars.Length]
        Write-Host "`r$char $Message" -NoNewline
        Start-Sleep -Milliseconds 250
        $i++
    }
    Write-Host "`r  $Message"
    $result = Receive-Job $job
    Remove-Job $job
    return $result
}

# ---------------------------------------------------------------------------
# Retry Wrapper
# ---------------------------------------------------------------------------

function Invoke-WithRetry {
    param([scriptblock]$Action, [string]$StepName, [int]$MaxRetries = 1)
    $attempt = 0
    while ($attempt -le $MaxRetries) {
        try {
            & $Action
            return
        } catch {
            $attempt++
            if ($attempt -gt $MaxRetries) {
                Write-Err "$StepName failed after $($MaxRetries + 1) attempts: $_"
                Write-Err "Please check the error above and try again."
                exit 1
            }
            Write-Warn "$StepName failed, retrying... (attempt $($attempt + 1))"
            Start-Sleep -Seconds 2
        }
    }
}

# ---------------------------------------------------------------------------
# UAC Self-Elevation
# ---------------------------------------------------------------------------

function Assert-Administrator {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $currentPrincipal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Info "Requesting administrator privileges..."
        $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process powershell.exe -Verb RunAs -ArgumentList $psArgs
        exit
    }
}

# ---------------------------------------------------------------------------
# Registry State Machine
# ---------------------------------------------------------------------------

$script:RegPath = "HKCU:\Software\NemoClaw"

function Get-InstallStage {
    try {
        (Get-ItemProperty -Path $script:RegPath -Name InstallStage -ErrorAction Stop).InstallStage
    } catch {
        $null
    }
}

function Set-InstallStage {
    param([string]$Stage)
    if (-not (Test-Path $script:RegPath)) {
        New-Item -Path $script:RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $script:RegPath -Name InstallStage -Value $Stage
}

function Remove-InstallStage {
    Remove-Item -Path $script:RegPath -Recurse -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Validation and Installation Functions
# ---------------------------------------------------------------------------

function Assert-WindowsVersion {
    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        Write-Err "Windows 10 build 19041 or later is required. Your build: $build"
        Write-Err "Please update Windows via Settings > Update & Security > Windows Update and re-run this script."
        exit 1
    }
    $friendlyName = if ($build -ge 22000) { "Windows 11 (build $build)" } else { "Windows 10 (build $build)" }
    Write-Info "Windows version OK: $friendlyName"
}

function Assert-DiskSpace {
    param([int]$RequiredGB = 10)
    $drive = Get-PSDrive C
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    if ($freeGB -lt $RequiredGB) {
        Write-Err "Only $freeGB GB free on C: -- Docker Desktop needs ~${RequiredGB}GB. Free up space and re-run."
        exit 1
    }
    Write-Info "Disk space OK: $freeGB GB free on C:"
}

function Test-AntivirusInterference {
    $knownAV = @{
        "avastui"  = "Avast"
        "avgui"    = "AVG"
        "bdagent"  = "Bitdefender"
        "avp"      = "Kaspersky"
        "norton"   = "Norton"
        "mcshield" = "McAfee"
    }
    $found = $false
    foreach ($procName in $knownAV.Keys) {
        if (Get-Process $procName -ErrorAction SilentlyContinue) {
            $avName = $knownAV[$procName]
            Write-Warn "$avName detected -- may interfere with Docker. If installation fails, temporarily disable it."
            $found = $true
        }
    }
    if (-not $found) {
        Write-Info "No known problematic antivirus detected."
    }
}

function Enable-WSL2 {
    $wslCheck = wsl --status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Info "WSL2 is already enabled."
        return $false
    }
    Write-Info "Enabling WSL2..."
    wsl --install --no-distribution 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Falling back to DISM for WSL2 enablement..."
        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart 2>&1 | Out-Null
        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart 2>&1 | Out-Null
    }
    return $true
}

function Install-DockerDesktop {
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Write-Info "Docker Desktop already installed -- skipping."
        return
    }
    $wingetAvailable = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetAvailable) {
        Write-Info "Installing Docker Desktop via winget..."
        winget install --exact --id Docker.DockerDesktop --silent --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "winget install failed, falling back to direct download..."
            Install-DockerDesktopFromExe
        }
    } else {
        Write-Info "winget not available, downloading Docker Desktop installer..."
        Install-DockerDesktopFromExe
    }
}

function Install-DockerDesktopFromExe {
    $installerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    $installerPath = "$env:TEMP\DockerDesktopInstaller.exe"
    Write-Info "Downloading Docker Desktop..."
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
    Write-Info "Running Docker Desktop installer..."
    Start-Process -FilePath $installerPath -ArgumentList "install", "--quiet", "--accept-license", "--backend=wsl-2" -Wait
    Remove-Item $installerPath -ErrorAction SilentlyContinue
}

function Disable-DockerAutoStart {
    # Method 1: settings.json
    $settingsPath = "$env:APPDATA\Docker\settings.json"
    if (Test-Path $settingsPath) {
        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $settings.openAtLogin = $false
        $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsPath -Encoding UTF8
        Write-Info "Docker Desktop auto-start disabled in settings.json."
    }
    # Method 2: Remove auto-start registry entry (belt and suspenders)
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    Remove-ItemProperty -Path $runKey -Name "Docker Desktop" -ErrorAction SilentlyContinue
}

function Add-DockerUsersGroup {
    try {
        Add-LocalGroupMember -Group "docker-users" -Member $env:USERNAME -ErrorAction Stop
        Write-Info "Added $env:USERNAME to docker-users group."
    } catch {
        if ($_.Exception.Message -match "already a member") {
            Write-Info "$env:USERNAME is already in docker-users group."
        } else {
            Write-Warn "Could not add $env:USERNAME to docker-users group: $_"
        }
    }
}

function Wait-DockerReady {
    param([int]$TimeoutSeconds = 120, [int]$IntervalSeconds = 5)
    $dockerExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    $dockerProcess = Get-Process "Docker Desktop" -ErrorAction SilentlyContinue
    if (-not $dockerProcess) {
        if (Test-Path $dockerExe) {
            Write-Info "Starting Docker Desktop..."
            Start-Process $dockerExe
        } else {
            Write-Err "Docker Desktop not found at expected path."
            return $false
        }
    }
    Write-Info "Waiting for Docker daemon to be ready (up to ${TimeoutSeconds}s)..."
    $elapsed = 0
    $spinChars = @('|', '/', '-', '\')
    while ($elapsed -lt $TimeoutSeconds) {
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Ok "Docker daemon is ready."
            return $true
        }
        $char = $spinChars[($elapsed / $IntervalSeconds) % $spinChars.Length]
        Write-Host "`r$char Waiting for Docker daemon... (${elapsed}s / ${TimeoutSeconds}s)" -NoNewline
        Start-Sleep -Seconds $IntervalSeconds
        $elapsed += $IntervalSeconds
    }
    Write-Host ""
    Write-Err "Docker daemon did not start within ${TimeoutSeconds} seconds."
    Write-Err "Try launching Docker Desktop manually and re-running this script."
    return $false
}

# --- Main Orchestrator ---
