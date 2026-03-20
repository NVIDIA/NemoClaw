# Phase 2: Container Setup and NemoClaw Install - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Create a named Ubuntu 22.04 Docker container with port 18789 forwarded, Desktop/NemoClaw shared folder mounted, install.sh run non-interactively inside it, and the OpenClaw dashboard confirmed reachable at http://localhost:18789. Lifecycle commands (start/stop/restart/status) are Phase 3.

</domain>

<decisions>
## Implementation Decisions

### API key handling
- Prompt user for NVIDIA API key with masked input (Read-Host -AsSecureString or equivalent)
- Persist in registry at `HKCU:\Software\NemoClaw\ApiKey` — consistent with Phase 1's registry pattern
- On re-run: if key already exists in registry, skip prompt silently (no re-ask)
- Pass key into container as Docker env var: `-e NVIDIA_API_KEY=...` at container run time

### Container strategy
- Dockerfile build approach: FROM ubuntu:22.04, copy install.sh, run it during build
- Container named `nemoclaw`
- If container `nemoclaw` already exists: stop, remove, and rebuild from scratch (clean slate)
- Image rebuild ensures reproducible state; user's Desktop/NemoClaw folder is untouched by rebuild
- Run install.sh with `--non-interactive` flag (confirmed: install.sh supports this via `NON_INTERACTIVE` env var and `--non-interactive` CLI flag)

### Shared folder
- Create `$HOME\Desktop\NemoClaw` on host if it doesn't exist
- Mount into container at `/home/nemoclaw/shared`
- If folder already exists with files: keep everything, just mount as-is
- Files survive container rebuilds since the folder lives on the host

### Health verification
- After container starts, HTTP poll `http://localhost:18789` using Invoke-WebRequest
- Poll every 5 seconds, timeout after 180 seconds (3 minutes)
- Reuse spinner pattern from Phase 1's Wait-DockerReady
- Do NOT auto-open browser — just print the URL
- On success: green banner matching Phase 1 style with checkmarks (container running, folder mounted, dashboard reachable, URL)

### Claude's Discretion
- Dockerfile contents and build optimization (layer caching, apt cleanup)
- How to handle install.sh failures inside the container (build-time vs run-time error reporting)
- Exact spinner implementation during image build and health check
- Whether to create a non-root user inside the container or run as root
- Container restart policy (--restart unless-stopped vs none — Phase 3 manages lifecycle)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing installer
- `install.sh` — Linux NemoClaw installer. Lines 278-337: non-interactive mode (`--non-interactive` flag, `NEMOCLAW_NON_INTERACTIVE` env var). Lines 12-14: colored output helpers. Lines 328-353: main() flow (install_nodejs, ensure_supported_runtime, install_nemoclaw, verify_nemoclaw, run_onboard).
- `windows/install.ps1` — Phase 1 Windows installer with output helpers, spinner, retry wrapper, registry state machine, and all prerequisite functions. Phase 2 extends this file.

### Requirements
- `.planning/REQUIREMENTS.md` — SETUP-01 through SETUP-05 define all Phase 2 requirements
- `.planning/ROADMAP.md` — Phase 2 success criteria (4 criteria that must be TRUE)

### Prior phase context
- `.planning/phases/01-prerequisites-and-docker-desktop/01-CONTEXT.md` — Phase 1 decisions on registry state machine, output helpers, error handling patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `windows/install.ps1` Write-Info/Warn/Err/Ok/Step functions: Phase 2 uses these directly
- `windows/install.ps1` Show-Spinner: reuse for image build and health check waits
- `windows/install.ps1` Invoke-WithRetry: reuse for docker build/run retry
- `windows/install.ps1` registry functions (Get/Set/Remove-InstallStage): extend state machine for Phase 2 stages
- `install.sh` non-interactive mode: confirmed working, use `--non-interactive` flag in Dockerfile RUN

### Established Patterns
- Registry state machine at `HKCU:\Software\NemoClaw\InstallStage` for multi-step operations
- `$env:NEMOCLAW_TESTING` guard for Pester test safety (dot-source without executing)
- Step counter pattern: `[N/Total] Message...` for user progress awareness
- Retry-once-then-fail pattern via Invoke-WithRetry

### Integration Points
- Phase 2 extends `windows/install.ps1` — adds container setup functions after Install-Prerequisites
- Phase 1 ends at `DOCKER_READY` stage; Phase 2 continues from there
- Phase 3 will use the container name `nemoclaw` for start/stop/restart/status commands
- The `.bat` launcher from Phase 1 is the entry point for all phases

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

*Phase: 02-container-setup-and-nemoclaw-install*
*Context gathered: 2026-03-20*
