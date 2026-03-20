# Phase 1: Prerequisites and Docker Desktop - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

A `.bat`-launched PowerShell script that installs Docker Desktop on Windows, handling WSL2 enablement, multi-reboot resume, and daemon readiness verification. The user ends up with a working `docker` command. Container creation and NemoClaw setup are Phase 2.

</domain>

<decisions>
## Implementation Decisions

### Reboot & resume strategy
- Registry breadcrumb at `HKCU\Software\NemoClaw\InstallStage` tracks granular stages (e.g., WSL_ENABLED, DOCKER_INSTALLING, DOCKER_READY)
- On re-run after reboot, script reads the registry key and picks up where it left off
- Registry key is cleaned up (deleted) after successful completion — no leftover state
- When reboot is required: "WSL2 is enabled. A reboot is required. Press Enter to reboot now, or reboot manually and re-run this script." — user gets control with a convenience offer

### User communication
- Colored status lines matching existing `install.sh` style: `[INFO]` blue, `[WARN]` yellow, `[ERROR]` red
- Numbered step headers: `[1/5] Checking Windows version...` so user knows overall progress
- Animated spinner with status text during long waits (Docker Desktop download, daemon startup polling)
- Green success banner at completion summarizing what was done (WSL2 enabled, Docker installed, daemon running, etc.)

### Error & edge cases
- If Docker Desktop is already installed: skip installation, go straight to daemon readiness verification. Print "Docker Desktop already installed — skipping."
- On failure: retry the failed step once automatically, then fail with an actionable error message telling the user exactly what went wrong and what to try
- Antivirus detection (PREREQ-05): check for known problematic AV (Avast, Kaspersky, Norton, etc.). If found, print yellow warning: "[WARN] [AV name] detected — may interfere with Docker. If installation fails, temporarily disable it." Continue anyway.
- Disk space check (PREREQ-04): require ~10GB free on C: drive. If below threshold, hard stop with clear message: "[ERROR] Only X GB free on C: — Docker Desktop needs ~10GB. Free up space and re-run."

### Installation method
- winget is the preferred install path for Docker Desktop
- Fallback: direct EXE download from official Docker URL when winget is unavailable (older Windows 10)
- Force WSL2 backend via Docker Desktop settings/install flags — do not allow Hyper-V fallback
- Disable Docker Desktop auto-start on Windows login (Phase 3's start command handles launching)
- Daemon readiness poll: check `docker info` every 5 seconds, timeout after 120 seconds

### Claude's Discretion
- Exact registry key stage names and progression
- PowerShell spinner implementation details
- Specific antivirus detection method (registry check, process list, etc.)
- Docker Desktop silent install flags and settings.json manipulation
- .bat launcher implementation for execution policy bypass

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing installer reference
- `install.sh` — Linux NemoClaw installer with colored output helpers (`info`, `warn`, `error` functions at lines 12-14), non-interactive mode support (`--non-interactive` flag and `NEMOCLAW_NON_INTERACTIVE` env var at lines 278-337). Use as style reference for output formatting.
- `Dockerfile` — Existing container definition (node:22-slim base). Phase 1 does NOT use this — project chose fresh Ubuntu 22.04 path. But useful context for understanding the NemoClaw stack.

### Requirements
- `.planning/REQUIREMENTS.md` — PREREQ-01 through PREREQ-10 define all Phase 1 requirements
- `.planning/ROADMAP.md` — Phase 1 success criteria (5 criteria that must be TRUE)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `install.sh` colored output pattern (`info`, `warn`, `error` functions): PowerShell script should mirror this style for consistency across Linux and Windows installers
- `install.sh` non-interactive mode: established pattern for `--non-interactive` flag — Windows script should follow a similar convention

### Established Patterns
- No PowerShell or `.bat` files exist yet — this is greenfield for Windows
- Project uses bash scripts extensively (`scripts/` directory) — the PowerShell script is a new pattern

### Integration Points
- Phase 2 will assume Docker daemon is running and `docker` CLI is available
- The `.bat` launcher is the user's entry point for all phases — Phase 2 and 3 will extend it with subcommands

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-prerequisites-and-docker-desktop*
*Context gathered: 2026-03-20*
