---
phase: 02-container-setup-and-nemoclaw-install
plan: 01
subsystem: infra
tags: [docker, powershell, nvidia-api, dpapi, container]

# Dependency graph
requires:
  - phase: 01-prerequisites-and-docker-setup
    provides: WSL2, Docker Desktop installed and running, registry state machine
provides:
  - Dockerfile.nemoclaw defining Ubuntu 22.04 container image with NemoClaw
  - 10 Phase 2 PowerShell functions for container lifecycle management
  - DPAPI-encrypted NVIDIA API key storage in Windows registry
  - 5-stage state machine for container setup resumption
affects: [03-lifecycle-commands-and-shortcuts]

# Tech tracking
tech-stack:
  added: [docker-build, dpapi-encryption, invoke-webrequest-polling]
  patterns: [container-lifecycle-state-machine, registry-secret-storage, health-check-polling]

key-files:
  created: [windows/Dockerfile.nemoclaw]
  modified: [windows/install.ps1]

key-decisions:
  - "Root user inside container to avoid volume mount permission issues"
  - "DPAPI via ConvertFrom-SecureString for API key encryption (PS 5.1 compatible)"
  - "Marshal BSTR pattern for SecureString-to-plaintext (no -AsPlainText which is PS7+ only)"
  - "[Environment]::GetFolderPath('Desktop') for OneDrive-safe Desktop path"
  - "180s timeout with 5s polling interval for dashboard health check"

patterns-established:
  - "Phase 2 stage machine: DOCKER_READY -> API_KEY_STORED -> IMAGE_BUILT -> CONTAINER_RUNNING -> DASHBOARD_READY"
  - "Container name 'nemoclaw' with anchored filter for cleanup"
  - "PSScriptRoot-relative Dockerfile path with parent as build context"

requirements-completed: [SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05]

# Metrics
duration: 2min
completed: 2026-03-20
---

# Phase 02 Plan 01: Container Setup and NemoClaw Install Summary

**Dockerfile.nemoclaw with Ubuntu 22.04 image and 10 PowerShell functions for NVIDIA API key management, Docker image build, container lifecycle, and 180s health check polling**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-20T16:31:21Z
- **Completed:** 2026-03-20T16:33:13Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Created Dockerfile.nemoclaw: Ubuntu 22.04 base, system deps, non-interactive install.sh at build time, nemoclaw-start.sh as CMD entrypoint
- Added 10 Phase 2 functions to install.ps1 with DPAPI-encrypted API key storage, container lifecycle management, and dashboard health check
- Extended entry point to chain Install-NemoClawContainer after Install-Prerequisites

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Dockerfile.nemoclaw** - `fd8d498` (feat)
2. **Task 2: Add Phase 2 functions to install.ps1** - `6a0c86e` (feat)

## Files Created/Modified
- `windows/Dockerfile.nemoclaw` - Ubuntu 22.04 container image definition with install.sh at build time and nemoclaw-start as CMD
- `windows/install.ps1` - Added Save-NvidiaApiKey, Get-NvidiaApiKey, Request-NvidiaApiKey, New-NemoClawFolder, Remove-ExistingContainer, Build-NemoClawImage, Start-NemoClawContainer, Test-DashboardReady, Show-ContainerBanner, Install-NemoClawContainer

## Decisions Made
- Root user inside container to avoid volume mount permission issues on Windows (per RESEARCH.md Pitfall 7)
- DPAPI via ConvertFrom-SecureString for API key encryption -- PS 5.1 compatible, no external deps
- Marshal BSTR pattern instead of -AsPlainText (PS7+ only) for SecureString conversion
- [Environment]::GetFolderPath("Desktop") for OneDrive-safe Desktop path resolution
- 180s timeout / 5s interval for dashboard health check -- enough time for openclaw gateway startup

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Dockerfile.nemoclaw and all container lifecycle functions are in place
- Ready for Phase 3: lifecycle commands (start/stop/restart/status) and Desktop shortcuts
- Container can be built and run once a machine has Docker Desktop ready from Phase 1

---
*Phase: 02-container-setup-and-nemoclaw-install*
*Completed: 2026-03-20*
