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

# --- Validation and Installation Functions ---

# --- Main Orchestrator ---
