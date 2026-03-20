# Phase 1: Prerequisites and Docker Desktop - Research

**Researched:** 2026-03-20
**Domain:** Windows batch/PowerShell scripting, Docker Desktop installation, WSL2 enablement
**Confidence:** HIGH

## Summary

This phase implements a `.bat`-launched PowerShell installer that takes a clean Windows machine from zero to a running Docker daemon. The core technical challenges are: (1) bypassing PowerShell execution policy via a `.bat` wrapper, (2) self-elevating to admin via UAC, (3) enabling WSL2 with a reboot-resume mechanism using registry breadcrumbs, (4) installing Docker Desktop silently via winget with a direct-download EXE fallback, and (5) polling for Docker daemon readiness.

All of these are well-understood Windows administration patterns. The PowerShell commands for WSL enablement (`wsl --install --no-distribution`), Docker Desktop silent install (`winget install Docker.DockerDesktop` or EXE with `--quiet --accept-license --backend=wsl-2`), and registry-based state tracking (`HKCU:\Software\NemoClaw\InstallStage`) are documented and stable. The main risk is edge cases: machines with partial WSL installs, antivirus interference, and Docker Desktop's sometimes-unreliable silent mode.

**Primary recommendation:** Build a single `install.ps1` with a state-machine driven by registry breadcrumbs, launched by a thin `install.bat` wrapper. Each stage is idempotent -- re-running after reboot or failure safely resumes from the last successful stage.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- Registry breadcrumb at `HKCU\Software\NemoClaw\InstallStage` tracks granular stages (e.g., WSL_ENABLED, DOCKER_INSTALLING, DOCKER_READY)
- On re-run after reboot, script reads the registry key and picks up where it left off
- Registry key is cleaned up (deleted) after successful completion
- When reboot is required: "WSL2 is enabled. A reboot is required. Press Enter to reboot now, or reboot manually and re-run this script."
- Colored status lines: `[INFO]` blue, `[WARN]` yellow, `[ERROR]` red (matching install.sh)
- Numbered step headers: `[1/5] Checking Windows version...`
- Animated spinner with status text during long waits
- Green success banner at completion
- Docker Desktop already installed: skip to daemon readiness, print "Docker Desktop already installed -- skipping."
- On failure: retry failed step once, then fail with actionable message
- Antivirus detection: check for known problematic AV, print yellow warning, continue anyway
- Disk space check: require ~10GB free on C:, hard stop if below
- winget is preferred install path, direct EXE download as fallback
- Force WSL2 backend -- do not allow Hyper-V fallback
- Disable Docker Desktop auto-start on Windows login
- Daemon readiness poll: `docker info` every 5 seconds, timeout after 120 seconds

### Claude's Discretion
- Exact registry key stage names and progression
- PowerShell spinner implementation details
- Specific antivirus detection method (registry check, process list, etc.)
- Docker Desktop silent install flags and settings.json manipulation
- .bat launcher implementation for execution policy bypass

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PREREQ-01 | Script has a .bat launcher that bypasses PowerShell execution policy | .bat wrapper using `powershell -ExecutionPolicy Bypass -File` is the standard pattern |
| PREREQ-02 | Script self-elevates to administrator via UAC prompt | Standard pattern: check `([Security.Principal.WindowsPrincipal]...IsInRole(...Administrator))`, re-launch with `-Verb RunAs` |
| PREREQ-03 | Script validates Windows 10 build 19041+ or Windows 11 | Use `[System.Environment]::OSVersion.Version.Build` or `Get-CimInstance Win32_OperatingSystem` |
| PREREQ-04 | Script checks available disk space before installing | `Get-PSDrive C` returns `Free` property in bytes |
| PREREQ-05 | Script warns if known antivirus may interfere with Docker | Check running processes (`Get-Process`) for known AV process names |
| PREREQ-06 | Script detects and enables WSL2 if not present | `wsl --status` to detect, `wsl --install --no-distribution` to enable |
| PREREQ-07 | Script handles reboot-required scenario with resume capability | Registry breadcrumb at `HKCU:\Software\NemoClaw\InstallStage` with stage-based state machine |
| PREREQ-08 | Script installs Docker Desktop silently (winget with EXE fallback) | `winget install Docker.DockerDesktop --silent`, fallback to direct EXE with `--quiet --accept-license --backend=wsl-2` |
| PREREQ-09 | Script adds current user to docker-users group | `Add-LocalGroupMember -Group "docker-users" -Member $env:USERNAME` |
| PREREQ-10 | Script polls for Docker daemon readiness with timeout | Loop `docker info` every 5 seconds, timeout at 120 seconds |

</phase_requirements>

## Standard Stack

### Core
| Tool | Purpose | Why Standard |
|------|---------|--------------|
| PowerShell 5.1 | Main scripting engine | Ships with all Windows 10/11; no install needed |
| CMD batch (.bat) | Entry point launcher | Double-clickable, no execution policy issues |
| Windows Registry (HKCU) | State persistence across reboots | Native Windows API, no file dependency |
| winget | Package manager for Docker Desktop | Ships with modern Windows 10/11, cleanest install path |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| Invoke-WebRequest | Download Docker Desktop EXE | Fallback when winget is unavailable |
| Get-CimInstance | OS version detection | More reliable than `[Environment]::OSVersion` on Win10/11 |
| Start-Process | Launch installers, UAC elevation | Docker Desktop EXE install, self-elevation |
| Add-LocalGroupMember | docker-users group management | After Docker Desktop install |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| PowerShell 5.1 | PowerShell 7 | Not pre-installed on Windows; adds dependency |
| Registry breadcrumbs | Temp file breadcrumbs | File can be accidentally deleted; registry is more robust |
| winget | Chocolatey | Not pre-installed; requires separate bootstrap |

## Architecture Patterns

### Recommended Project Structure
```
windows/
  install.bat          # Double-click entry point (.bat launcher)
  install.ps1          # Main PowerShell installer (state machine)
```

### Pattern 1: .bat Launcher (PREREQ-01)
**What:** Thin batch file that launches PowerShell with execution policy bypass
**When to use:** Always -- this is the user's entry point

```batch
@echo off
:: NemoClaw Windows Installer
:: Double-click this file to begin installation.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if %ERRORLEVEL% neq 0 pause
```

Key details:
- `%~dp0` resolves to the directory containing the .bat file, so install.ps1 is found regardless of working directory
- `-NoProfile` prevents user profile scripts from interfering
- `-ExecutionPolicy Bypass` bypasses the system execution policy for this session only
- `%*` passes through any arguments (e.g., `--non-interactive`)
- `pause` on error keeps the window open so the user sees the error message

### Pattern 2: UAC Self-Elevation (PREREQ-02)
**What:** Script detects if running as admin; if not, re-launches itself elevated
**When to use:** At the very start of install.ps1

```powershell
function Assert-Administrator {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $currentPrincipal.IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
        # Re-launch self with elevation
        $args = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
        Start-Process powershell.exe -Verb RunAs -ArgumentList $args
        exit
    }
}
```

**Important:** The re-launched process opens a new console window. The original window closes via `exit`. This is expected behavior.

### Pattern 3: Registry State Machine (PREREQ-07)
**What:** Tracks installation progress across reboots using registry keys
**When to use:** Core orchestration pattern for the entire script

Recommended stage progression:
```
(no key)        -> Fresh start, begin from step 1
VERSION_OK      -> Windows version validated
WSL_ENABLED     -> WSL2 features enabled (may need reboot)
DOCKER_INSTALLED -> Docker Desktop installed
DOCKER_READY    -> Docker daemon responding
COMPLETED       -> All done (key gets deleted)
```

```powershell
$RegPath = "HKCU:\Software\NemoClaw"

function Get-InstallStage {
    try {
        (Get-ItemProperty -Path $RegPath -Name InstallStage -ErrorAction Stop).InstallStage
    } catch {
        $null
    }
}

function Set-InstallStage {
    param([string]$Stage)
    if (-not (Test-Path $RegPath)) {
        New-Item -Path $RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $RegPath -Name InstallStage -Value $Stage
}

function Remove-InstallStage {
    Remove-Item -Path $RegPath -Recurse -ErrorAction SilentlyContinue
}
```

The main function reads the current stage and uses a switch/if-chain to skip completed stages and resume from the right point.

### Pattern 4: Windows Version Check (PREREQ-03)
**What:** Validates Windows 10 build 19041+ or Windows 11
**When to use:** First validation step

```powershell
function Assert-WindowsVersion {
    $build = [System.Environment]::OSVersion.Version.Build
    $major = [System.Environment]::OSVersion.Version.Major
    if ($major -lt 10 -or $build -lt 19041) {
        Write-Error "[ERROR] Windows 10 build 19041 or later is required. Your build: $build"
        Write-Error "        Please update Windows and re-run this script."
        exit 1
    }
}
```

Note: `[System.Environment]::OSVersion.Version.Build` returns the actual build number reliably on Windows 10+ even though the Major/Minor can be misleading. Build number is what matters: 19041 = Windows 10 2004. For extra reliability, `(Get-CimInstance Win32_OperatingSystem).BuildNumber` can be used as a cross-check.

### Pattern 5: WSL2 Enablement (PREREQ-06)
**What:** Detect and install WSL2
**When to use:** After version check passes

```powershell
function Enable-WSL2 {
    # Check if WSL is already functional
    $wslStatus = wsl --status 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Info "WSL2 is already enabled."
        return $false  # No reboot needed
    }

    Write-Info "Enabling WSL2..."
    wsl --install --no-distribution
    if ($LASTEXITCODE -ne 0) {
        # Fallback to DISM for older Windows 10
        dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
        dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
    }
    return $true  # Reboot needed
}
```

Key: `--no-distribution` avoids installing a default Ubuntu distro (Docker Desktop manages its own WSL distro).

### Pattern 6: Docker Desktop Install (PREREQ-08)
**What:** Install Docker Desktop via winget, with EXE fallback
**When to use:** After WSL2 is enabled and machine has rebooted

```powershell
function Install-DockerDesktop {
    # Check if already installed
    $dockerPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerPath) {
        Write-Info "Docker Desktop already installed -- skipping."
        return
    }

    # Try winget first
    $wingetAvailable = Get-Command winget -ErrorAction SilentlyContinue
    if ($wingetAvailable) {
        winget install --exact --id Docker.DockerDesktop `
            --silent --accept-source-agreements --accept-package-agreements
    } else {
        # Fallback: direct download
        $installerUrl = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
        $installerPath = "$env:TEMP\DockerDesktopInstaller.exe"
        Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
        Start-Process -FilePath $installerPath `
            -ArgumentList "install", "--quiet", "--accept-license", "--backend=wsl-2" `
            -Wait
        Remove-Item $installerPath -ErrorAction SilentlyContinue
    }
}
```

### Pattern 7: Daemon Readiness Polling (PREREQ-10)
**What:** Wait for Docker daemon to be responsive
**When to use:** After Docker Desktop install, and also after Docker Desktop is started

```powershell
function Wait-DockerReady {
    param(
        [int]$TimeoutSeconds = 120,
        [int]$IntervalSeconds = 5
    )

    # Start Docker Desktop if not running
    $dockerProcess = Get-Process "Docker Desktop" -ErrorAction SilentlyContinue
    if (-not $dockerProcess) {
        Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    }

    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        Start-Sleep -Seconds $IntervalSeconds
        $elapsed += $IntervalSeconds
    }
    return $false
}
```

### Anti-Patterns to Avoid
- **Modifying system-wide execution policy:** Never run `Set-ExecutionPolicy` -- use `-ExecutionPolicy Bypass` on the PowerShell invocation instead. Changing system policy is invasive and may conflict with corporate group policy.
- **Using `[System.Environment]::OSVersion.Version.Major` for Windows 10 vs 11 detection:** The major version is 10 for both Windows 10 and Windows 11. Use the build number instead (Windows 11 starts at build 22000).
- **Scheduled tasks for reboot resume:** More complex than registry breadcrumbs and requires cleaning up the scheduled task. Registry read-on-rerun is simpler and the user already knows to re-run the .bat file.
- **Using `Restart-Computer -Force` without user consent:** Always prompt or inform the user before rebooting. The user should have control.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Docker Desktop installation | Custom download + registry manipulation | winget or official EXE installer with `--quiet` flags | Installer handles PATH, services, WSL integration, docker-users group |
| WSL2 enablement | Manual DISM feature enable + kernel download | `wsl --install --no-distribution` | Single command handles all WSL2 prerequisites on modern Windows |
| Package management | Custom download + checksum verification | winget | Handles download, verification, installation, PATH updates |
| Progress bar | Custom console rendering | `Write-Progress` cmdlet or simple spinner function | Built-in cmdlet handles terminal compatibility |

**Key insight:** The Windows ecosystem provides official tools (winget, wsl --install, Docker Desktop installer flags) that handle most of the complexity. The script's job is orchestration and error handling, not reimplementing installation logic.

## Common Pitfalls

### Pitfall 1: WSL2 Requires Reboot Before Docker Desktop Install
**What goes wrong:** Installing Docker Desktop before the WSL2 reboot causes Docker to fall back to Hyper-V backend or fail entirely.
**Why it happens:** WSL2 kernel isn't loaded until after reboot.
**How to avoid:** The registry state machine must enforce the order: enable WSL2 -> reboot -> install Docker Desktop. Never skip the reboot stage.
**Warning signs:** Docker Desktop starts but shows "WSL2 backend not available" error.

### Pitfall 2: winget Not Available on Older Windows 10
**What goes wrong:** `winget` command not found, script crashes.
**Why it happens:** winget requires App Installer from Microsoft Store, which may not be present on older Windows 10 builds or LTSC editions.
**How to avoid:** Always check `Get-Command winget -ErrorAction SilentlyContinue` before using winget. Fall back to direct EXE download.
**Warning signs:** Build number 19041-19044 (Windows 10 2004-21H2) may not have winget pre-installed.

### Pitfall 3: Docker Desktop First Launch Requires User Interaction
**What goes wrong:** Docker Desktop shows a GUI window (license agreement, survey, etc.) on first launch, blocking the daemon from starting.
**Why it happens:** The `--accept-license` flag on install should suppress this, but some versions still show a first-run experience.
**How to avoid:** Use `--accept-license` on the installer. If daemon doesn't respond within timeout, inform the user to accept any Docker Desktop dialogs and re-run.
**Warning signs:** `docker info` keeps timing out even though Docker Desktop process is running.

### Pitfall 4: docker-users Group Membership Requires Logoff
**What goes wrong:** `docker` commands fail with permission errors even after adding user to docker-users group.
**Why it happens:** Windows group membership changes only take effect after logoff/login.
**How to avoid:** Since the script is running elevated (admin), Docker commands should work in the current session. But warn the user that a logoff may be needed for non-elevated usage later.
**Warning signs:** "access denied" errors when running docker without elevation after installation.

### Pitfall 5: Antivirus Blocks Docker Desktop Installer or WSL2
**What goes wrong:** Installation hangs or fails silently.
**Why it happens:** AV software (especially Avast, Kaspersky, Norton, Bitdefender) intercepts the installer or blocks WSL2 kernel operations.
**How to avoid:** Detect known AV processes before installation and warn the user. Continue anyway -- don't block.
**Warning signs:** Installation process running but no progress for > 5 minutes.

### Pitfall 6: Docker Desktop Auto-Start Setting
**What goes wrong:** Docker Desktop starts on every Windows login, consuming resources.
**Why it happens:** Docker Desktop defaults to auto-start on install.
**How to avoid:** After installation, modify the settings file at `%APPDATA%\Docker\settings.json` to set `"openAtLogin": false`. Note: direct JSON modification has been reported as unreliable in some Docker versions. Alternative: remove the Docker Desktop entry from `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` registry key.
**Warning signs:** Docker Desktop icon appears in system tray on every Windows boot.

### Pitfall 7: Script Window Closes on Error
**What goes wrong:** User double-clicks .bat, error occurs, window immediately closes -- user sees nothing.
**Why it happens:** CMD window closes when the batch file finishes.
**How to avoid:** Add `if %ERRORLEVEL% neq 0 pause` at the end of the .bat file. Also consider `pause` at the very end for success too, so the user can read the summary.
**Warning signs:** Users report "nothing happened" when they double-clicked the file.

## Code Examples

### Colored Output Functions (matching install.sh style)
```powershell
function Write-Info  { Write-Host "[INFO]  $args" -ForegroundColor Blue }
function Write-Warn  { Write-Host "[WARN]  $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "[ERROR] $args" -ForegroundColor Red }
function Write-Ok    { Write-Host "[OK]    $args" -ForegroundColor Green }

function Write-Step {
    param([int]$Current, [int]$Total, [string]$Message)
    Write-Host "[$Current/$Total] $Message" -ForegroundColor Cyan
}
```

### Simple Spinner
```powershell
function Start-Spinner {
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
    Write-Host "`r  $Message" -NoNewline
    Write-Host ""
    Receive-Job $job
    Remove-Job $job
}
```

### Disk Space Check
```powershell
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
```

### Antivirus Detection
```powershell
function Test-AntivirusInterference {
    $knownAV = @{
        "avastui"    = "Avast"
        "avgui"      = "AVG"
        "bdagent"    = "Bitdefender"
        "avp"        = "Kaspersky"
        "norton"     = "Norton"
        "mcshield"   = "McAfee"
        "msmpeng"    = "Windows Defender"  # Usually OK, but worth noting
    }
    # Exclude Windows Defender from warnings (it's generally fine)
    $warnAV = @("avastui", "avgui", "bdagent", "avp", "norton", "mcshield")

    foreach ($proc in $warnAV) {
        if (Get-Process $proc -ErrorAction SilentlyContinue) {
            $name = $knownAV[$proc]
            Write-Warn "$name detected -- may interfere with Docker. If installation fails, temporarily disable it."
        }
    }
}
```

### Retry Logic
```powershell
function Invoke-WithRetry {
    param(
        [scriptblock]$Action,
        [string]$StepName,
        [int]$MaxRetries = 1
    )
    $attempt = 0
    while ($attempt -le $MaxRetries) {
        try {
            & $Action
            return
        } catch {
            $attempt++
            if ($attempt -gt $MaxRetries) {
                Write-Err "$StepName failed after $($MaxRetries + 1) attempts: $_"
                exit 1
            }
            Write-Warn "$StepName failed, retrying... (attempt $($attempt + 1))"
        }
    }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual DISM + kernel MSI for WSL2 | `wsl --install --no-distribution` | Windows 10 21H1+ (build 19041+) | Single command replaces 3-step manual process |
| Chocolatey for Docker Desktop | winget (built-in) | Windows 10 2004+ | No bootstrap needed, Microsoft-supported |
| Docker Toolbox | Docker Desktop with WSL2 backend | Docker Desktop 2.3+ (2020) | Native Linux kernel, better performance |
| Hyper-V backend | WSL2 backend | Docker Desktop 4.x default | Lower resource usage, better compatibility |

**Deprecated/outdated:**
- Docker Toolbox: Fully deprecated, replaced by Docker Desktop
- Manual WSL2 kernel MSI install: Replaced by `wsl --install` on supported builds
- `[System.Environment]::OSVersion.Version.Major` for Win10/11 detection: Returns 10 for both; use build number

## Open Questions

1. **Docker Desktop settings.json reliability**
   - What we know: `%APPDATA%\Docker\settings.json` contains `"openAtLogin"` key. Direct modification has been reported unreliable in some versions.
   - What's unclear: Whether recent Docker Desktop versions (2025+) honor direct JSON edits reliably.
   - Recommendation: Try JSON modification first. If Docker Desktop overwrites it, fall back to removing the auto-start registry entry at `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run`.

2. **winget silent mode on Docker Desktop**
   - What we know: There's a reported bug (GitHub issue #45705) where Docker Desktop doesn't install truly silently via winget.
   - What's unclear: Whether this is fixed in current winget/Docker versions.
   - Recommendation: Use `--silent` flag, but don't depend on zero UI. The script should handle the case where Docker Desktop shows a window during install.

3. **Docker Desktop first-run on WSL2 without a distro**
   - What we know: We use `--no-distribution` to avoid installing Ubuntu. Docker Desktop creates its own WSL distro.
   - What's unclear: Whether Docker Desktop's first launch succeeds if no WSL distro was ever installed (only the WSL2 platform feature enabled).
   - Recommendation: This is the documented and expected workflow. Docker Desktop creates `docker-desktop` and `docker-desktop-data` WSL distros itself.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Pester 5.x (PowerShell testing framework) |
| Config file | none -- see Wave 0 |
| Quick run command | `Invoke-Pester -Path tests/ -Tag "Unit" -CI` |
| Full suite command | `Invoke-Pester -Path tests/ -CI` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PREREQ-01 | .bat launcher exists and contains correct PowerShell invocation | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Launcher"` | No -- Wave 0 |
| PREREQ-02 | Self-elevation function detects admin/non-admin correctly | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Elevation"` | No -- Wave 0 |
| PREREQ-03 | Version check rejects build < 19041, accepts >= 19041 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "VersionCheck"` | No -- Wave 0 |
| PREREQ-04 | Disk space check rejects < 10GB, accepts >= 10GB | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DiskSpace"` | No -- Wave 0 |
| PREREQ-05 | AV detection identifies known process names | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Antivirus"` | No -- Wave 0 |
| PREREQ-06 | WSL2 enablement calls correct commands | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "WSL"` | No -- Wave 0 |
| PREREQ-07 | Registry state machine reads/writes/deletes stages correctly | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "StateMachine"` | No -- Wave 0 |
| PREREQ-08 | Docker install detects winget availability and chooses path | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DockerInstall"` | No -- Wave 0 |
| PREREQ-09 | docker-users group add uses correct cmdlet | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DockerGroup"` | No -- Wave 0 |
| PREREQ-10 | Daemon readiness polling respects timeout and interval | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DaemonReady"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `Invoke-Pester tests/ -Tag "Unit" -CI`
- **Per wave merge:** `Invoke-Pester tests/ -CI`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `tests/Install.Tests.ps1` -- Pester test file covering all PREREQ requirements with mocked system commands
- [ ] Pester 5.x module install: `Install-Module -Name Pester -Force -SkipPublisherCheck` -- if not already available
- [ ] Note: Unit tests will heavily use Pester's `Mock` capability to simulate Windows APIs (Get-Process, Get-PSDrive, registry access, wsl.exe, docker.exe, winget.exe) since actual installation cannot run in CI

## Sources

### Primary (HIGH confidence)
- [Docker Desktop Windows Install docs](https://docs.docker.com/desktop/setup/install/windows-install/) -- installer flags, system requirements, download URL
- [Microsoft WSL Install docs](https://learn.microsoft.com/en-us/windows/wsl/install) -- `wsl --install` command, requirements
- [Microsoft WSL Manual Install](https://learn.microsoft.com/en-us/windows/wsl/install-manual) -- DISM fallback commands
- [Microsoft PowerShell Execution Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies) -- bypass flag documentation
- [Microsoft Self-Elevating Script](https://learn.microsoft.com/en-us/archive/blogs/virtual_pc_guy/a-self-elevating-powershell-script) -- UAC elevation pattern
- [Docker Desktop Settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/) -- settings.json location

### Secondary (MEDIUM confidence)
- [GeeksforGeeks docker-users group](https://www.geeksforgeeks.org/devops/add-myself-to-the-docker-users-group-on-windows/) -- verified Add-LocalGroupMember pattern
- [Silent Install HQ Docker Desktop](https://silentinstallhq.com/docker-desktop-silent-install-how-to-guide/) -- silent install flags verified against official docs
- [Docker for-win GitHub Issues](https://github.com/docker/for-win/issues/12746) -- `--backend=wsl-2` flag behavior

### Tertiary (LOW confidence)
- [Docker community forums on settings.json editing](https://forums.docker.com/t/setting-start-docker-desktop-when-you-sign-in-to-your-computer-programming-side/143009) -- reports of unreliable direct JSON modification (needs validation)
- [winget-pkgs issue #45705](https://github.com/microsoft/winget-pkgs/issues/45705) -- Docker Desktop silent install bug report (may be fixed)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- PowerShell 5.1, winget, and Docker Desktop installer are well-documented Microsoft/Docker tools
- Architecture: HIGH -- Registry state machine and .bat wrapper patterns are battle-tested Windows administration techniques
- Pitfalls: HIGH -- Well-documented community experiences with Docker Desktop on Windows, WSL2 reboot requirements, and AV interference
- Validation: MEDIUM -- Pester is the standard PowerShell test framework, but mocking system commands for installer testing has inherent limitations

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (stable domain -- Windows/Docker patterns change slowly)
