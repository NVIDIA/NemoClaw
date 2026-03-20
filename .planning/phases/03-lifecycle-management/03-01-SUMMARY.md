---
phase: 03-lifecycle-management
plan: 01
subsystem: infra
tags: [powershell, docker, lifecycle, bash, container-management]

# Dependency graph
requires:
  - phase: 02-container-setup
    provides: install.ps1 with Docker container creation, Wait-DockerReady, Test-DashboardReady functions
provides:
  - Lifecycle commands (start/stop/restart/status/uninstall) via install.bat subcommands
  - Foreground process in nemoclaw-start.sh keeping container alive for docker start/stop
  - Command routing via param()/switch in install.ps1
affects: [03-lifecycle-management]

# Tech tracking
tech-stack:
  added: []
  patterns: [param-switch command routing, Assert-guard functions, exec-tail foreground pattern]

key-files:
  created: []
  modified: [scripts/nemoclaw-start.sh, windows/install.ps1]

key-decisions:
  - "Only install command requires administrator elevation; lifecycle commands run as normal user"
  - "exec tail -f replaces shell as PID 1 to keep container alive and pipe logs to docker logs"

patterns-established:
  - "Assert-guard pattern: Assert-DockerRunning and Assert-ContainerExists validate preconditions before lifecycle operations"
  - "Command routing: param() with ValidateSet + switch at entry point for subcommand dispatch"

requirements-completed: [LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05]

# Metrics
duration: 2min
completed: 2026-03-20
---

# Phase 03 Plan 01: Lifecycle Management Summary

**Lifecycle commands (start/stop/restart/status/uninstall) via install.bat subcommands with exec tail -f foreground process for container stability**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-20T19:27:08Z
- **Completed:** 2026-03-20T19:28:45Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Fixed nemoclaw-start.sh to keep container alive with exec tail -f /tmp/gateway.log as PID 1
- Added 7 lifecycle functions to install.ps1: Assert-ContainerExists, Assert-DockerRunning, Start-NemoClaw, Stop-NemoClaw, Restart-NemoClaw, Get-NemoClawStatus, Uninstall-NemoClaw
- Added param()/switch command routing so install.bat accepts start|stop|restart|status|uninstall subcommands
- Backward compatible: install.bat with no args still performs full install

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix nemoclaw-start.sh foreground process** - `9062623` (feat)
2. **Task 2: Add param block, lifecycle functions, and command routing to install.ps1** - `66bfd89` (feat)

## Files Created/Modified
- `scripts/nemoclaw-start.sh` - Added exec tail -f as foreground process to keep container alive; captured GATEWAY_PID variable
- `windows/install.ps1` - Added param() block with ValidateSet, 7 lifecycle functions, and switch-based command routing at entry point

## Decisions Made
- Only the "install" command calls Assert-Administrator; lifecycle commands (start/stop/restart/status) work as normal user since the user is in docker-users group
- exec tail -f replaces the shell process as PID 1, which both keeps the container alive and pipes gateway logs to docker logs output
- Uninstall does not require admin; the optional Docker Desktop removal via winget may fail without admin but provides a clear fallback message

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All lifecycle commands are wired and functional
- Ready for Phase 03 Plan 02 (if any additional lifecycle features are planned)
- Container now properly stays alive after docker start, enabling reliable start/stop cycles

---
*Phase: 03-lifecycle-management*
*Completed: 2026-03-20*
