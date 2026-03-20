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

# ---------------------------------------------------------------------------
# Reboot Prompt
# ---------------------------------------------------------------------------

function Request-Reboot {
    Write-Warn "WSL2 is enabled. A reboot is required."
    Write-Warn "Press Enter to reboot now, or reboot manually and re-run this script."
    Read-Host
    Restart-Computer -Force
}

# ---------------------------------------------------------------------------
# Success Banner
# ---------------------------------------------------------------------------

function Show-SuccessBanner {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  NemoClaw Prerequisites - Complete!    " -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Ok "WSL2 is enabled"
    Write-Ok "Docker Desktop is installed"
    Write-Ok "Docker daemon is running"
    Write-Ok "$env:USERNAME is in docker-users group"
    Write-Host ""
    Write-Info "You can now proceed with NemoClaw container setup."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Main Orchestrator
# ---------------------------------------------------------------------------

function Install-Prerequisites {
    $stage = Get-InstallStage
    $totalSteps = 6

    # Step 1: Windows version check
    if (-not $stage -or $stage -eq $null) {
        Write-Step -Current 1 -Total $totalSteps -Message "Checking Windows version..."
        Assert-WindowsVersion
        Write-Step -Current 1 -Total $totalSteps -Message "Checking disk space..."
        Assert-DiskSpace
        Write-Step -Current 1 -Total $totalSteps -Message "Checking for antivirus..."
        Test-AntivirusInterference
        Set-InstallStage "VERSION_OK"
        $stage = "VERSION_OK"
    }

    # Step 2: Enable WSL2
    if ($stage -eq "VERSION_OK") {
        Write-Step -Current 2 -Total $totalSteps -Message "Enabling WSL2..."
        $rebootNeeded = Invoke-WithRetry -StepName "WSL2 enablement" -Action {
            Enable-WSL2
        }
        Set-InstallStage "WSL_ENABLED"
        if ($rebootNeeded) {
            Request-Reboot
            return  # Script ends; user reboots and re-runs
        }
        $stage = "WSL_ENABLED"
    }

    # Step 3: Install Docker Desktop
    if ($stage -eq "WSL_ENABLED") {
        Write-Step -Current 3 -Total $totalSteps -Message "Installing Docker Desktop..."
        Invoke-WithRetry -StepName "Docker Desktop installation" -Action {
            Install-DockerDesktop
        }
        Set-InstallStage "DOCKER_INSTALLED"
        $stage = "DOCKER_INSTALLED"
    }

    # Step 4: Configure Docker Desktop
    if ($stage -eq "DOCKER_INSTALLED") {
        Write-Step -Current 4 -Total $totalSteps -Message "Configuring Docker Desktop..."
        Disable-DockerAutoStart
        Add-DockerUsersGroup
        Set-InstallStage "DOCKER_CONFIGURED"
        $stage = "DOCKER_CONFIGURED"
    }

    # Step 5: Wait for Docker daemon
    if ($stage -eq "DOCKER_CONFIGURED") {
        Write-Step -Current 5 -Total $totalSteps -Message "Waiting for Docker daemon..."
        $ready = Wait-DockerReady
        if (-not $ready) {
            Write-Err "Docker daemon is not responding. Please:"
            Write-Err "  1. Open Docker Desktop manually"
            Write-Err "  2. Accept any license agreements"
            Write-Err "  3. Re-run this script"
            exit 1
        }
        Set-InstallStage "DOCKER_READY"
        $stage = "DOCKER_READY"
    }

    # Step 6: Complete
    if ($stage -eq "DOCKER_READY") {
        Write-Step -Current 6 -Total $totalSteps -Message "Finishing up..."
        Remove-InstallStage
        Show-SuccessBanner
    }
}

# Stage progression:
#   (null)           -> VERSION_OK       : Version, disk, AV checks passed
#   VERSION_OK       -> WSL_ENABLED      : WSL2 enabled (may reboot here)
#   WSL_ENABLED      -> DOCKER_INSTALLED : Docker Desktop installed
#   DOCKER_INSTALLED -> DOCKER_CONFIGURED: Auto-start disabled, user in docker-users
#   DOCKER_CONFIGURED-> DOCKER_READY     : Docker daemon responding
#   DOCKER_READY     -> (deleted)        : Success, registry cleaned up

# ---------------------------------------------------------------------------
# Phase 2: Container Setup and NemoClaw Install
# ---------------------------------------------------------------------------

# --- API Key Handling ---

function Save-NvidiaApiKey {
    param([SecureString]$ApiKey)
    $encrypted = ConvertFrom-SecureString -SecureString $ApiKey
    if (-not (Test-Path $script:RegPath)) {
        New-Item -Path $script:RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $script:RegPath -Name ApiKey -Value $encrypted
}

function Get-NvidiaApiKey {
    try {
        $encrypted = (Get-ItemProperty -Path $script:RegPath -Name ApiKey -ErrorAction Stop).ApiKey
        $secure = ConvertTo-SecureString -String $encrypted
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    } catch {
        $null
    }
}

function Request-NvidiaApiKey {
    $existing = Get-NvidiaApiKey
    if ($existing) {
        Write-Info "NVIDIA API key found in registry -- skipping prompt."
        return $existing
    }
    Write-Host ""
    Write-Info "An NVIDIA API key is required for NemoClaw."
    Write-Info "Get one at: https://build.nvidia.com/settings/api-key"
    Write-Host ""
    $secure = Read-Host -Prompt "Enter your NVIDIA API key" -AsSecureString
    # Convert to plaintext to validate non-empty
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ([string]::IsNullOrWhiteSpace($plain)) {
        Write-Err "API key cannot be empty."
        exit 1
    }
    Save-NvidiaApiKey -ApiKey $secure
    Write-Ok "API key saved."
    return $plain
}

# --- Shared Folder ---

function New-NemoClawFolder {
    $desktopPath = [Environment]::GetFolderPath("Desktop")
    $sharedFolder = Join-Path $desktopPath "NemoClaw"
    if (-not (Test-Path $sharedFolder)) {
        New-Item -ItemType Directory -Path $sharedFolder -Force | Out-Null
        Write-Ok "Created shared folder: $sharedFolder"
    } else {
        Write-Info "Shared folder already exists: $sharedFolder"
    }
    return $sharedFolder
}

# --- Container Management ---

function Remove-ExistingContainer {
    $existing = docker ps -a --filter "name=^nemoclaw$" --format "{{.Names}}" 2>&1
    if ($existing -eq "nemoclaw") {
        Write-Info "Removing existing nemoclaw container..."
        docker stop nemoclaw 2>&1 | Out-Null
        docker rm nemoclaw 2>&1 | Out-Null
        Write-Ok "Old container removed."
    }
}

function Build-NemoClawImage {
    Write-Info "Building NemoClaw Docker image (this may take several minutes)..."
    $dockerfilePath = Join-Path $PSScriptRoot "Dockerfile.nemoclaw"
    $contextPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    docker build -t nemoclaw -f $dockerfilePath $contextPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker image build failed. Check the output above for details."
        exit 1
    }
    Write-Ok "NemoClaw image built successfully."
}

function Start-NemoClawContainer {
    param([string]$ApiKey, [string]$SharedFolder)
    Write-Info "Starting NemoClaw container..."
    docker run -d `
        --name nemoclaw `
        -p 18789:18789 `
        -v "${SharedFolder}:/home/nemoclaw/shared" `
        -e "NVIDIA_API_KEY=$ApiKey" `
        nemoclaw 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to start NemoClaw container. Check the output above for details."
        exit 1
    }
    Write-Ok "Container 'nemoclaw' started."
}

# --- Health Check ---

function Test-DashboardReady {
    param([int]$TimeoutSeconds = 180, [int]$IntervalSeconds = 5)
    Write-Info "Waiting for OpenClaw dashboard (up to ${TimeoutSeconds}s)..."
    $elapsed = 0
    $spinChars = @('|', '/', '-', '\')
    while ($elapsed -lt $TimeoutSeconds) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:18789" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                Write-Host ""
                return $true
            }
        } catch {
            # Connection refused or timeout -- keep polling
        }
        $char = $spinChars[($elapsed / $IntervalSeconds) % $spinChars.Length]
        Write-Host "`r$char Waiting for OpenClaw dashboard... (${elapsed}s / ${TimeoutSeconds}s)" -NoNewline
        Start-Sleep -Seconds $IntervalSeconds
        $elapsed += $IntervalSeconds
    }
    Write-Host ""
    return $false
}

# --- Success Banner ---

function Show-ContainerBanner {
    param([string]$SharedFolder)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  NemoClaw Setup - Complete!            " -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Ok "Container 'nemoclaw' is running"
    Write-Ok "Shared folder: $SharedFolder"
    Write-Ok "Dashboard is reachable"
    Write-Ok "URL: http://localhost:18789"
    Write-Host ""
    Write-Info "Open http://localhost:18789 in your browser to access OpenClaw."
    Write-Host ""
}

# --- Phase 2 Orchestrator ---

function Install-NemoClawContainer {
    $stage = Get-InstallStage
    $totalSteps = 5

    # Step 1: API Key
    if (-not $stage -or $stage -eq "DOCKER_READY" -or $stage -eq $null) {
        Write-Step -Current 1 -Total $totalSteps -Message "Checking NVIDIA API key..."
        $apiKey = Request-NvidiaApiKey
        Set-InstallStage "API_KEY_STORED"
        $stage = "API_KEY_STORED"
    }

    # Step 2: Build image
    if ($stage -eq "API_KEY_STORED") {
        Write-Step -Current 2 -Total $totalSteps -Message "Preparing Docker image..."
        Remove-ExistingContainer
        Invoke-WithRetry -StepName "Docker image build" -Action {
            Build-NemoClawImage
        }
        Set-InstallStage "IMAGE_BUILT"
        $stage = "IMAGE_BUILT"
    }

    # Step 3: Create shared folder and start container
    if ($stage -eq "IMAGE_BUILT") {
        Write-Step -Current 3 -Total $totalSteps -Message "Starting container..."
        $sharedFolder = New-NemoClawFolder
        # Retrieve API key from registry (may have been stored in a prior run)
        if (-not $apiKey) { $apiKey = Get-NvidiaApiKey }
        if (-not $apiKey) {
            Write-Err "NVIDIA API key not found. Please re-run the installer."
            exit 1
        }
        Start-NemoClawContainer -ApiKey $apiKey -SharedFolder $sharedFolder
        Set-InstallStage "CONTAINER_RUNNING"
        $stage = "CONTAINER_RUNNING"
    }

    # Step 4: Health check
    if ($stage -eq "CONTAINER_RUNNING") {
        Write-Step -Current 4 -Total $totalSteps -Message "Verifying dashboard..."
        $ready = Test-DashboardReady
        if (-not $ready) {
            Write-Err "OpenClaw dashboard did not respond within 180 seconds."
            Write-Err "Check container logs: docker logs nemoclaw"
            exit 1
        }
        Set-InstallStage "DASHBOARD_READY"
        $stage = "DASHBOARD_READY"
    }

    # Step 5: Complete
    if ($stage -eq "DASHBOARD_READY") {
        Write-Step -Current 5 -Total $totalSteps -Message "Finishing up..."
        $desktopPath = [Environment]::GetFolderPath("Desktop")
        $sharedFolder = Join-Path $desktopPath "NemoClaw"
        Remove-InstallStage
        Show-ContainerBanner -SharedFolder $sharedFolder
    }
}

# Stage progression (Phase 2):
#   (null/DOCKER_READY) -> API_KEY_STORED  : API key prompted and saved to registry
#   API_KEY_STORED      -> IMAGE_BUILT     : Docker image built from Dockerfile.nemoclaw
#   IMAGE_BUILT         -> CONTAINER_RUNNING: Container started with volume + env + port
#   CONTAINER_RUNNING   -> DASHBOARD_READY : HTTP 200 from localhost:18789
#   DASHBOARD_READY     -> (deleted)       : Success, registry cleaned up

# --- Entry Point ---
if ($env:NEMOCLAW_TESTING) { return }
Assert-Administrator
Install-Prerequisites
Install-NemoClawContainer
