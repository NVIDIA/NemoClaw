param(
    [string]$Profile
)

$profileDir = Join-Path $PSScriptRoot 'profiles'

# List available profiles if none specified
if (-not $Profile) {
    Write-Host 'Available HSB profiles:' -ForegroundColor Cyan
    $found = $false
    if (Test-Path $profileDir) {
        Get-ChildItem -Path $profileDir -Filter '*-env.ps1' | ForEach-Object {
            $name = $_.BaseName -replace '-env$', ''
            Write-Host "  $name"
            $found = $true
        }
    }
    if (-not $found) {
        Write-Host '  (none found)'
        Write-Host ''
        Write-Host "Create a profile by copying profiles\example-env.ps1 to profiles\<name>-env.ps1" -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host 'Usage:  .\set-hsb-env.ps1 -Profile <name>' -ForegroundColor Yellow
    exit 0
}

$configFile = Join-Path $profileDir "$Profile-env.ps1"

if (-not (Test-Path $configFile)) {
    Write-Error "Profile not found: $configFile`nCreate it by copying profiles\example-env.ps1 to profiles\$Profile-env.ps1"
    exit 1
}

. $configFile

$required = @('SSH_TARGET', 'REMOTE_ROOT')
foreach ($name in $required) {
    if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue)) {
        Write-Error "Missing required environment variable: $name"
        exit 1
    }
}

Write-Host "Loaded HSB profile: $Profile" -ForegroundColor Green
Write-Host "  SSH_TARGET  = $env:SSH_TARGET"
Write-Host "  REMOTE_ROOT = $env:REMOTE_ROOT"
Write-Host "  REMOTE_SUDO = $env:REMOTE_SUDO"
Write-Host "  SSH_OPTS    = $env:REMOTE_SSH_OPTS"
Write-Host "  PLATFORM    = $env:HSB_PLATFORM"
Write-Host ''
Write-Host 'Start Claude Code in this same shell with: claude'
