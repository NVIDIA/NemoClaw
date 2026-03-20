---
phase: 01-prerequisites-and-docker-desktop
verified: 2026-03-20T12:00:00Z
status: passed
score: 12/12 must-haves verified
re_verification: false
---

# Phase 1: Prerequisites and Docker Desktop Verification Report

**Phase Goal:** Deliver a double-click Windows installer that takes a clean Windows 10/11 machine from zero to a running Docker daemon, handling WSL2 enablement, Docker Desktop installation, reboots, and daemon verification.
**Verified:** 2026-03-20
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | User can double-click install.bat and PowerShell runs without execution policy errors | VERIFIED | `install.bat` line 4: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*` |
| 2  | Script requests admin rights via UAC if not already elevated | VERIFIED | `Assert-Administrator` uses `WindowsPrincipal.IsInRole` + `Start-Process -Verb RunAs`; called at entry point |
| 3  | Script rejects machines below Windows 10 build 19041 with a plain-English error | VERIFIED | `Assert-WindowsVersion` checks `$build -lt 19041` and calls `exit 1` with human-readable message |
| 4  | Script checks for 10GB free disk space and hard-stops if insufficient | VERIFIED | `Assert-DiskSpace` checks `$freeGB -lt $RequiredGB` (default 10) and calls `exit 1` |
| 5  | Script warns about known problematic antivirus but continues | VERIFIED | `Test-AntivirusInterference` checks avastui/avgui/bdagent/avp/norton/mcshield, emits `Write-Warn`, does not exit; msmpeng excluded |
| 6  | Script enables WSL2 if not present and prompts for reboot | VERIFIED | `Enable-WSL2` runs `wsl --install --no-distribution` with DISM fallback; `Request-Reboot` prompts with exact wording "WSL2 is enabled. A reboot is required." |
| 7  | Script resumes from last successful stage after reboot via registry breadcrumb | VERIFIED | `Get-InstallStage`/`Set-InstallStage` read/write `HKCU:\Software\NemoClaw\InstallStage`; orchestrator reads stage on entry and falls through from resume point |
| 8  | Script installs Docker Desktop via winget (with EXE fallback) | VERIFIED | `Install-DockerDesktop` checks `Get-Command winget` first; `Install-DockerDesktopFromExe` downloads from `desktop.docker.com` with `--backend=wsl-2` |
| 9  | Script adds current user to docker-users group | VERIFIED | `Add-DockerUsersGroup` calls `Add-LocalGroupMember -Group "docker-users" -Member $env:USERNAME`; handles "already a member" gracefully |
| 10 | Script polls docker info every 5 seconds up to 120 seconds for daemon readiness | VERIFIED | `Wait-DockerReady -TimeoutSeconds 120 -IntervalSeconds 5` polls `docker info` in loop with spinner |
| 11 | Registry breadcrumb is cleaned up after successful completion | VERIFIED | `Remove-InstallStage` called in orchestrator at DOCKER_READY stage (line 362) before `Show-SuccessBanner` |
| 12 | Green success banner displays at completion | VERIFIED | `Show-SuccessBanner` uses `-ForegroundColor Green` on banner lines and `Write-Ok` for status lines |

**Score:** 12/12 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `windows/install.bat` | Double-click entry point that launches PowerShell with bypass | VERIFIED | 6 lines; contains `-ExecutionPolicy Bypass`, `%~dp0install.ps1`, error pause, and final pause |
| `windows/install.ps1` | Main PowerShell installer with state machine | VERIFIED | 378 lines; all 23 functions present; substantive implementations (no stubs) |
| `windows/tests/Install.Tests.ps1` | Pester 5.x test suite for all installer functions | VERIFIED | 400 lines (exceeds 150-line minimum); 15 Describe blocks; all 10 PREREQ IDs tagged |

**Artifact detail — install.ps1 function inventory (23/23):**
Assert-Administrator, Assert-WindowsVersion, Assert-DiskSpace, Test-AntivirusInterference, Enable-WSL2, Install-DockerDesktop, Install-DockerDesktopFromExe, Disable-DockerAutoStart, Add-DockerUsersGroup, Wait-DockerReady, Install-Prerequisites, Request-Reboot, Show-SuccessBanner, Get-InstallStage, Set-InstallStage, Remove-InstallStage, Write-Info, Write-Warn, Write-Err, Write-Ok, Write-Step, Show-Spinner, Invoke-WithRetry

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `windows/install.bat` | `windows/install.ps1` | `powershell.exe -File` invocation | WIRED | Line 4: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*` — exact match |
| `install.ps1` main orchestrator | `HKCU:\Software\NemoClaw\InstallStage` | Registry state machine read/write | WIRED | `Get-InstallStage` called on orchestrator entry; `Set-InstallStage` called after each stage; 8 total usages |
| `install.ps1 Install-DockerDesktop` | winget or direct EXE download | `winget install` or `Invoke-WebRequest` fallback | WIRED | `winget install --exact --id Docker.DockerDesktop` as primary; `Invoke-WebRequest` to `desktop.docker.com` as fallback |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PREREQ-01 | 01-01-PLAN, 01-02-PLAN | .bat launcher bypasses PowerShell execution policy | SATISFIED | `install.bat` with `-ExecutionPolicy Bypass`; test in `Install.Tests.ps1` Describe "install.bat Launcher" |
| PREREQ-02 | 01-01-PLAN, 01-02-PLAN | Script self-elevates to administrator via UAC prompt | SATISFIED | `Assert-Administrator` with `IsInRole` + `RunAs`; tested in "UAC Self-Elevation" Describe block |
| PREREQ-03 | 01-01-PLAN, 01-02-PLAN | Validates Windows 10 build 19041+ or Windows 11 | SATISFIED | `Assert-WindowsVersion` checks build 19041/22000; tested in "Windows Version Check" |
| PREREQ-04 | 01-01-PLAN, 01-02-PLAN | Checks available disk space before installing | SATISFIED | `Assert-DiskSpace` 10GB threshold; tested with mock `Get-PSDrive` in both pass/fail paths |
| PREREQ-05 | 01-01-PLAN, 01-02-PLAN | Warns if known antivirus may interfere with Docker | SATISFIED | `Test-AntivirusInterference` checks 6 AV processes, excludes msmpeng; tested in "Antivirus Detection" |
| PREREQ-06 | 01-01-PLAN, 01-02-PLAN | Detects and enables WSL2 if not present | SATISFIED | `Enable-WSL2` with `--no-distribution` flag and DISM fallback; tested in "WSL2 Enablement" |
| PREREQ-07 | 01-01-PLAN, 01-02-PLAN | Handles reboot-required scenario with resume capability | SATISFIED | Registry state machine with 6-stage progression and cleanup; tested in "Registry State Machine" |
| PREREQ-08 | 01-01-PLAN, 01-02-PLAN | Installs Docker Desktop silently (winget with EXE fallback) | SATISFIED | `Install-DockerDesktop` + `Install-DockerDesktopFromExe` with `--backend=wsl-2`; tested in "Docker Desktop Installation" |
| PREREQ-09 | 01-01-PLAN, 01-02-PLAN | Adds current user to docker-users group | SATISFIED | `Add-DockerUsersGroup` with `Add-LocalGroupMember`; tested in "Docker Users Group" |
| PREREQ-10 | 01-01-PLAN, 01-02-PLAN | Polls for Docker daemon readiness with timeout | SATISFIED | `Wait-DockerReady` 120s/5s polling; tested in "Docker Daemon Readiness" |

**Orphaned requirements:** None. All Phase 1 requirements (PREREQ-01 through PREREQ-10) are claimed by plans and verified.

**Out-of-phase requirements:** SETUP-01 through SETUP-05 (Phase 2) and LIFE-01 through LIFE-05 (Phase 3) are correctly deferred and not claimed by this phase.

---

### Anti-Patterns Found

No anti-patterns found. Scanned both `windows/install.ps1` and `windows/tests/Install.Tests.ps1` for TODO/FIXME/XXX/HACK/PLACEHOLDER comments, placeholder returns (`return null`, `return {}`), and empty handlers. None detected.

---

### Human Verification Required

The following behaviors cannot be verified programmatically on a Linux development machine and require a Windows 10/11 test environment:

#### 1. End-to-End Double-Click Flow

**Test:** On a clean Windows 10/11 machine without Docker or WSL2, double-click `windows/install.bat`.
**Expected:** UAC prompt appears, script runs with colored output, WSL2 enables, reboot prompt shows with exact wording "WSL2 is enabled. A reboot is required.", after reboot script resumes at WSL_ENABLED stage, Docker Desktop installs silently, docker-users group is populated, daemon becomes ready, green success banner appears.
**Why human:** Full reboot-resume flow, UAC prompt appearance, colored output rendering, and Docker daemon startup cannot be simulated in a Linux environment.

#### 2. Winget Path vs. EXE Fallback Path

**Test:** Run on a machine where winget is unavailable (older Windows 10 without App Installer). Confirm installer downloads Docker Desktop via `Invoke-WebRequest`.
**Expected:** `[INFO] winget not available, downloading Docker Desktop installer...` message appears; Docker Desktop installer downloads and runs silently with `--backend=wsl-2`.
**Why human:** Requires actual Windows environment without winget; Pester mock verifies the branching logic but not the real download.

#### 3. Registry State Machine Persistence Across Reboot

**Test:** Run installer, interrupt at the WSL_ENABLED stage (after reboot but before Docker install), then re-run the script.
**Expected:** Script reads `HKCU:\Software\NemoClaw\InstallStage = WSL_ENABLED` from registry and skips version/disk/AV checks, resuming from Docker Desktop installation.
**Why human:** Requires actual registry persistence and reboot; mocked tests verify the logic paths but not real registry I/O.

#### 4. Pester Tests on Windows

**Test:** On a Windows machine with PowerShell 7+ and Pester 5.x installed, run `Invoke-Pester windows/tests/Install.Tests.ps1 -CI`.
**Expected:** All tests pass. Some mocking behavior (e.g., `Mock wsl`, `Mock docker`) depends on PowerShell's command resolution which behaves differently on Windows vs. Linux.
**Why human:** Pester must run on Windows PowerShell to exercise real mock/override behavior for native commands like `wsl.exe` and `docker.exe`.

---

## Verification Summary

Phase 1 goal is fully achieved. All 12 observable truths are verified against the actual codebase:

- `windows/install.bat` (6 lines) is a correct thin launcher with execution policy bypass, `%~dp0` path resolution, and error/success pause behavior.
- `windows/install.ps1` (378 lines) contains all 23 required functions with substantive, non-stub implementations. The 6-stage registry state machine (`null -> VERSION_OK -> WSL_ENABLED -> DOCKER_INSTALLED -> DOCKER_CONFIGURED -> DOCKER_READY -> deleted`) is fully wired with the orchestrator calling each function in correct sequence, using `Invoke-WithRetry` for fallible operations, and cleaning up the registry breadcrumb on success.
- `windows/tests/Install.Tests.ps1` (400 lines, 15 Describe blocks) covers all 10 PREREQ requirements with tagged tests. The test file dot-sources `install.ps1` safely via the `$env:NEMOCLAW_TESTING` guard added during Plan 02 execution.
- All 3 key links verified: bat->ps1 invocation, registry state machine read/write, and winget/EXE installation paths.
- No orphaned requirements, no anti-patterns, no stubs detected.

Four items require human verification on a Windows machine (actual UAC behavior, reboot persistence, winget fallback path, and Pester execution under Windows PowerShell), but these do not block the automated assessment of goal achievement.

---

_Verified: 2026-03-20_
_Verifier: Claude (gsd-verifier)_
