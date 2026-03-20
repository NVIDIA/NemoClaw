# Technology Stack

**Project:** NemoClaw Windows Installer
**Researched:** 2026-03-20

## Recommended Stack

### Scripting Runtime

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Windows PowerShell | 5.1 | Script execution engine | Ships with every Windows 10/11 machine. No install step required. PowerShell 7 is better but is NOT preinstalled -- requiring users to install PS7 first defeats the purpose of a one-click installer. Target the runtime that is already there. | HIGH |

**Do NOT use PowerShell 7 (pwsh).** It must be installed separately. The whole point of this installer is zero prerequisites. Windows PowerShell 5.1 is built into Windows 10 1809+ and all Windows 11 builds. Every feature we need (Invoke-WebRequest, Start-Process, Test-Path, registry reads, service management) exists in 5.1.

**Do NOT use the Microsoft Docker-PowerShell module.** It was archived in April 2018 and is unmaintained. Use the Docker CLI (`docker.exe`) directly from PowerShell, which is what Docker Desktop installs.

### Package Management

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| winget | 1.x (system) | Install Docker Desktop | Preinstalled on Windows 10 1809+ and Windows 11 via App Installer. The standard Windows package manager. Falls back to direct download if unavailable (LTSC/corporate images strip it). | HIGH |
| Direct EXE download | N/A | Fallback Docker Desktop install | For machines where winget is missing. Download from `https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe` | HIGH |

**Do NOT use Chocolatey or Scoop.** They are not preinstalled. Adding a third-party package manager as a dependency for installing Docker is unnecessary complexity. winget is the native Windows solution and is already present.

### File Download

| Technology | Method | Purpose | Why | Confidence |
|------------|--------|---------|-----|------------|
| Start-BitsTransfer | PowerShell 5.1 built-in | Download Docker Desktop installer | Faster than Invoke-WebRequest for large files (500MB+). Buffers to disk instead of memory. Supports resume on failure. Native to Windows via BITS service. | HIGH |
| Invoke-WebRequest | PowerShell 5.1 built-in | Fallback / small downloads | Use as fallback if BITS service is disabled (rare). Fine for small files like verification checksums. | HIGH |

**Do NOT use `curl.exe` or `wget`.** While `curl.exe` ships with recent Windows 10 builds, it is not available on all target versions. PowerShell native cmdlets are universally available.

### Docker Runtime

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Docker Desktop | Latest stable (4.x) | Container runtime with WSL2 backend | The only supported Docker runtime for Windows desktop users. Provides Docker Engine, Docker CLI, and Docker Compose. WSL2 backend is default and required for Linux containers. | HIGH |
| Docker CLI (docker.exe) | Bundled with Desktop | Container lifecycle management | Installed automatically with Docker Desktop. All container operations (create, start, stop, exec, logs) go through `docker` commands invoked from PowerShell. No PowerShell wrapper module needed. | HIGH |

**Do NOT use Docker Engine in WSL2 directly (without Docker Desktop).** This requires manual WSL distro setup, systemd configuration, and is fragile. Docker Desktop handles all of this and provides a GUI for troubleshooting. The target audience has no Linux experience.

**Do NOT use Hyper-V backend.** WSL2 is the default and recommended backend. Hyper-V requires Windows Pro/Enterprise (not available on Home) and is slower for Linux containers.

### WSL2 (Prerequisite)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| WSL2 | System component | Required backend for Docker Desktop | Docker Desktop with WSL2 backend needs WSL enabled. Install via `wsl --install --no-distribution` (installs WSL kernel without a default distro -- Docker Desktop manages its own distros). | HIGH |

**Important:** `wsl --install` requires Windows 10 build 19041+ (version 2004) or Windows 11. This is the minimum OS requirement for the installer. On Windows 10 builds older than 19041, WSL2 requires manual enablement of "Virtual Machine Platform" and "Windows Subsystem for Linux" features via `dism.exe` -- but these builds are from 2019 and increasingly rare.

### Container Image

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Ubuntu | 22.04 LTS | Container base OS | Matches the documented NemoClaw bare-metal install path. The existing `install.sh` targets Ubuntu/Debian. LTS means security updates through 2027. | HIGH |

**Do NOT use the existing `node:22-slim` Dockerfile approach.** The PROJECT.md explicitly states the user wants a fresh Ubuntu 22.04 container with `install.sh` run inside it, closer to the documented bare-metal install. The existing Dockerfile is for the OpenShell sandbox environment, which is a different deployment model.

### Script Distribution

| Technology | Method | Purpose | Why | Confidence |
|------------|--------|---------|-----|------------|
| Single `.ps1` file | Raw GitHub download | Installer distribution | Users run a one-liner: `irm https://raw.githubusercontent.com/.../install.ps1 \| iex` or download and right-click "Run with PowerShell". Single file is simplest. No zip, no MSI, no module. | HIGH |
| `-ExecutionPolicy Bypass` | PowerShell flag | Allow script execution | Default execution policy is Restricted. The one-liner approach (`irm | iex`) bypasses this automatically. For downloaded files, instruct users to run `powershell -ExecutionPolicy Bypass -File install.ps1`. This is the standard pattern used by installers (winget itself, Scoop, etc.). | HIGH |

**Do NOT create an MSI/EXE installer.** Overkill for a script that orchestrates other installers. Adds build tooling (WiX, NSIS) and code signing requirements. A PowerShell script is the right tool.

**Do NOT create a PowerShell module.** Modules need to be installed (`Install-Module`), which requires PSGallery trust configuration. A standalone script has zero friction.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Script runtime | PowerShell 5.1 | PowerShell 7 | Not preinstalled; requires separate install step |
| Script runtime | PowerShell 5.1 | Batch (.bat/.cmd) | No structured error handling, no object pipeline, painful string manipulation |
| Script runtime | PowerShell 5.1 | Python | Not preinstalled on Windows |
| Package manager | winget (+ direct download fallback) | Chocolatey | Not preinstalled; adds third-party dependency |
| Docker management | Docker CLI (docker.exe) | Docker-PowerShell module | Archived since 2018, unmaintained |
| Docker management | Docker CLI (docker.exe) | Docker.DotNet library | Requires .NET SDK; overkill for shell-level container management |
| Docker runtime | Docker Desktop | Podman Desktop | Smaller ecosystem on Windows, less documentation, WSL2 integration less mature |
| Container base | Ubuntu 22.04 | Alpine Linux | install.sh uses apt-get, bash, nvm -- Alpine uses apk and ash shell |
| Download method | Start-BitsTransfer | Invoke-WebRequest | Buffers entire file in memory; slow for 500MB+ Docker installer |
| Installer format | .ps1 script | MSI/EXE | Requires build tooling, code signing; script is simpler |

## Docker CLI Commands Reference

The PowerShell script will use these Docker CLI commands directly (no wrapper needed):

```powershell
# Check if Docker is running
docker info 2>$null

# Pull Ubuntu image
docker pull ubuntu:22.04

# Create and configure container
docker run -d `
    --name nemoclaw `
    -p 18789:18789 `
    -v "$env:USERPROFILE\Desktop\NemoClaw:/mnt/shared" `
    -e "NVIDIA_API_KEY=$apiKey" `
    ubuntu:22.04 `
    tail -f /dev/null

# Execute install.sh inside container
docker exec nemoclaw bash -c "curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash"

# Container lifecycle
docker start nemoclaw
docker stop nemoclaw
docker restart nemoclaw
docker inspect --format='{{.State.Status}}' nemoclaw
```

## Key PowerShell 5.1 Patterns

```powershell
# Elevation check (required for Docker Desktop install)
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# winget availability check
$wingetPath = Get-Command winget -ErrorAction SilentlyContinue

# Docker Desktop install via winget
winget install --exact --id Docker.DockerDesktop `
    --accept-source-agreements --accept-package-agreements

# Docker Desktop install via direct download (fallback)
$installerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
$installerPath = "$env:TEMP\DockerDesktopInstaller.exe"
Start-BitsTransfer -Source $installerUrl -Destination $installerPath
Start-Process -FilePath $installerPath `
    -ArgumentList "install","--quiet","--accept-license","--backend=wsl-2" `
    -Wait

# WSL2 enablement
wsl --install --no-distribution

# User prompt for API key
$apiKey = Read-Host "Enter your NVIDIA API key"
```

## Installation One-Liner

The end-user experience should be:

```powershell
# Option A: Pipe to Invoke-Expression (standard pattern)
irm https://raw.githubusercontent.com/NVIDIA/NemoClaw/main/install.ps1 | iex

# Option B: Download and run (for cautious users)
# 1. Download install.ps1 from GitHub
# 2. Right-click > "Run with PowerShell"
# -- OR --
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Version Compatibility Matrix

| Component | Minimum | Recommended | Notes |
|-----------|---------|-------------|-------|
| Windows | 10 build 19041 (v2004) | Windows 11 | WSL2 requires build 19041+ |
| PowerShell | 5.1 | 5.1 | Ships with Windows; do NOT require PS7 |
| Docker Desktop | 4.x latest | 4.x latest | Auto-installs via winget or direct download |
| WSL | 2 | 2 | Installed as prerequisite; `wsl --install` |
| Ubuntu (container) | 22.04 | 22.04 | LTS, matches install.sh expectations |
| Node.js (in container) | 20 | 22 | Installed by install.sh via nvm inside container |

## Sources

- [PowerShell 5.1 vs 7.x differences - Microsoft Learn](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell?view=powershell-7.5)
- [Docker Desktop Windows install docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL2 backend](https://docs.docker.com/desktop/features/wsl/)
- [winget usage - Microsoft Learn](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
- [WSL install and containers - Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/tutorials/wsl-containers)
- [Docker-PowerShell archived repo](https://github.com/microsoft/Docker-PowerShell) (archived April 2018)
- [PowerShell execution policies - Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-7.5)
- [Docker Desktop silent install flags](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Start-BitsTransfer vs Invoke-WebRequest comparison](https://blog.wuibaille.fr/2023/09/invoke-webrequest-vs-webclient-vs-bitstransfer/)
