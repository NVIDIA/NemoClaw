---
phase: 1
slug: prerequisites-and-docker-desktop
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Pester 5.x (PowerShell testing framework) |
| **Config file** | none — Wave 0 installs |
| **Quick run command** | `Invoke-Pester -Path tests/ -Tag "Unit" -CI` |
| **Full suite command** | `Invoke-Pester -Path tests/ -CI` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `Invoke-Pester -Path tests/ -Tag "Unit" -CI`
- **After every plan wave:** Run `Invoke-Pester -Path tests/ -CI`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 0 | PREREQ-01 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Launcher"` | ❌ W0 | ⬜ pending |
| 1-01-02 | 01 | 0 | PREREQ-02 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Elevation"` | ❌ W0 | ⬜ pending |
| 1-01-03 | 01 | 0 | PREREQ-03 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "VersionCheck"` | ❌ W0 | ⬜ pending |
| 1-01-04 | 01 | 0 | PREREQ-04 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DiskSpace"` | ❌ W0 | ⬜ pending |
| 1-01-05 | 01 | 0 | PREREQ-05 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "Antivirus"` | ❌ W0 | ⬜ pending |
| 1-01-06 | 01 | 0 | PREREQ-06 | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "WSL"` | ❌ W0 | ⬜ pending |
| 1-01-07 | 01 | 0 | PREREQ-07 | unit | `Invoke-Pester tests/Install.Tests.ps1 -Tag "StateMachine"` | ❌ W0 | ⬜ pending |
| 1-01-08 | 01 | 0 | PREREQ-08 | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DockerInstall"` | ❌ W0 | ⬜ pending |
| 1-01-09 | 01 | 0 | PREREQ-09 | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DockerGroup"` | ❌ W0 | ⬜ pending |
| 1-01-10 | 01 | 0 | PREREQ-10 | unit (mocked) | `Invoke-Pester tests/Install.Tests.ps1 -Tag "DaemonReady"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/Install.Tests.ps1` — Pester test file covering all PREREQ requirements with mocked system commands
- [ ] Pester 5.x module install: `Install-Module -Name Pester -Force -SkipPublisherCheck` — if not already available
- [ ] Note: Unit tests will heavily use Pester's `Mock` capability to simulate Windows APIs (Get-Process, Get-PSDrive, registry access, wsl.exe, docker.exe, winget.exe) since actual installation cannot run in CI

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full end-to-end install on clean Windows | PREREQ-06, PREREQ-08 | Requires actual WSL2 enablement, reboot, Docker Desktop install | Run install.bat on a clean Windows 10/11 VM; verify WSL2 enabled, reboot resumes, Docker daemon starts |
| UAC elevation prompt appears | PREREQ-02 | Requires interactive Windows desktop session | Double-click install.bat as non-admin user; verify UAC prompt appears |
| Reboot and resume | PREREQ-07 | Requires actual system reboot | Run install.bat, allow reboot at WSL stage, re-run after reboot, verify it resumes from correct stage |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
