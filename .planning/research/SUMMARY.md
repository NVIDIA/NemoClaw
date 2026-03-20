# Project Research Summary

**Project:** NemoClaw Windows Installer
**Domain:** Windows PowerShell Docker installer for a Node.js/AI application
**Researched:** 2026-03-20
**Confidence:** HIGH

## Executive Summary

NemoClaw Windows Installer is a zero-prerequisite PowerShell script that provisions a Docker Desktop environment on Windows 10/11, creates an Ubuntu 22.04 container, and runs the existing `install.sh` inside it to deliver the NemoClaw dashboard accessible at `http://localhost:18789`. The key constraint is that the target audience has no Linux or Docker experience — every prerequisite must be detected and handled automatically, and every error must produce a plain-English next-step, not a stack trace. The recommended delivery format is a single `.ps1` file (with a `.bat` wrapper to bypass execution policy) targeting Windows PowerShell 5.1, which is universally present and requires no separate install.

The recommended approach is to build a verb-dispatched script (`install.ps1 install|start|stop|restart|status`) with a state-machine installation flow that survives the multi-reboot WSL2/Docker Desktop setup sequence. Container management uses a named persistent container (`nemoclaw`) backed by Ubuntu 22.04, with `install.sh` executed non-interactively inside it via `docker exec`. The NVIDIA API key is collected once in PowerShell and injected as a container environment variable, bypassing the interactive onboarding problem entirely. All Docker operations go through the Docker CLI (`docker.exe`) directly — no wrapper modules needed.

The primary risk cluster is the Windows prerequisites gauntlet: execution policy blocks, WSL2 not enabled, Docker daemon not running, and `docker-users` group membership missing are all silent failure modes that will kill the user experience if not handled proactively. A secondary risk is CRLF line endings corrupting `install.sh` when the repo is cloned on Windows — this must be solved with `.gitattributes` before the first container run attempt. Overall the patterns are well-documented and the technologies are stable; implementation risk is in thoroughness of edge-case handling, not in technology choices.

## Key Findings

### Recommended Stack

The entire stack runs on technologies already present on a clean Windows 10/11 machine. Windows PowerShell 5.1 is the execution engine — it ships with every target OS and has all needed cmdlets. PowerShell 7 is explicitly ruled out because it must be separately installed, defeating the zero-prerequisite goal. Docker Desktop (latest 4.x) is the only supported container runtime for Windows desktop; it installs via `winget` with a direct `.exe` download as fallback. WSL2 is a required prerequisite installed via `wsl --install --no-distribution`. The container base is Ubuntu 22.04 LTS, matching the `install.sh` expectations (apt-get, bash, nvm).

**Core technologies:**
- **Windows PowerShell 5.1**: Script runtime — preinstalled on Windows 10/11, no prerequisites
- **winget + direct EXE fallback**: Docker Desktop installation — native Windows package manager with no third-party dependency
- **Start-BitsTransfer**: Large file download — buffers to disk (not memory), supports resume; critical for 500MB+ Docker installer
- **Docker Desktop (WSL2 backend)**: Container runtime — only supported desktop Docker option; WSL2 backend required (Hyper-V not available on Home edition)
- **Docker CLI (docker.exe)**: Container management — bundled with Docker Desktop; call directly, do not use the archived Docker-PowerShell module
- **Ubuntu 22.04 LTS**: Container base image — matches `install.sh` expectations; LTS support through 2027

### Expected Features

**Must have (table stakes):**
- Admin privilege check with automatic self-elevation — gate everything else; Docker Desktop install requires elevation
- WSL2 prerequisite detection and installation — `wsl --install --no-distribution`; reboot likely required on clean machines
- Docker Desktop silent install — winget primary, direct `.exe` download fallback; must handle reboot-required case
- Reboot handling with resume guidance — state-machine approach, marker file in `$env:LOCALAPPDATA\NemoClaw\`
- Docker daemon readiness polling — poll `docker info` with 120s timeout before any container operations
- Container creation with port forwarding, shared folder, and API key — the actual deliverable
- Start/stop/restart/status subcommands — thin wrappers, users must never need Docker CLI
- Idempotent re-runs — check each step before doing it; users will re-run after reboots
- Error handling with actionable messages — `try/catch` everywhere; map Docker errors to plain English
- Colored prefixed console output (`[INFO]`, `[WARN]`, `[ERROR]`) — low effort, high polish

**Should have (competitive):**
- Automatic browser launch to dashboard after setup — eliminates "now what?" moment
- Health check with dashboard URL output in `status` command — makes the status subcommand useful
- Automatic `docker-users` group membership check and add — prevents a common silent failure mode
- Log file via `Start-Transcript` — one line of PowerShell, massive support value
- System requirements pre-check (Windows version, RAM, disk, virtualization) — fail fast with clear message
- Desktop shortcut for management — `.lnk` via WScript.Shell COM object, discoverability for non-terminal users

**Defer (v2+):**
- Container auto-start on boot — nice-to-have, not essential for first release
- `update` command — requires container image versioning strategy first
- `uninstall` command — can be documented as manual Docker steps initially
- Progress indicators during downloads — `docker pull` already shows progress; cosmetic only

### Architecture Approach

The installer is a single `install.ps1` with a verb-based dispatch pattern (param block + switch statement routing to handler functions). It has three runtime layers: the PowerShell host layer (Windows) communicates with the Docker Desktop layer (WSL2 backend) via Docker CLI commands, which manages the Ubuntu 22.04 container layer running NemoClaw. Container setup uses a two-phase pattern: phase 1 creates the container with `docker run -d ubuntu:22.04 tail -f /dev/null`, phase 2 runs `install.sh --non-interactive` via `docker exec`. The named container (`nemoclaw`) is persistent — created once, then started/stopped, never re-created on each use.

**Major components:**
1. **Helpers** — colored output, version checks, admin elevation detection; depended on by all other components
2. **Prerequisites checker** — Windows version, WSL2 status, Docker Desktop presence, disk space, virtualization
3. **Docker Desktop installer** — winget/download/silent install, WSL2 backend enable, docker-users group, daemon readiness polling
4. **Container builder** — `docker run` ubuntu:22.04, copy and execute `install.sh` non-interactively, inject API key
5. **Shared folder manager** — create `Desktop\NemoClaw`, handle OneDrive-redirected paths via `[Environment]::GetFolderPath('Desktop')`
6. **Container lifecycle manager** — start/stop/restart/status with named container; detect missing container and offer re-create
7. **Post-install verifier** — HTTP health check on `:18789`, print dashboard URL, open browser

**Build order is strictly sequential:** Helpers → Prerequisites → Docker installer → Container builder → Lifecycle manager → Verifier. Steps 3 and 5 (Docker installer and shared folder manager) can be developed in parallel.

### Critical Pitfalls

1. **Multi-reboot WSL2/Docker Desktop setup sequence** — implement a state machine with resume-after-reboot; store stage in `$env:LOCALAPPDATA\NemoClaw\install-state.json`; this is the single most likely installer failure on a clean machine
2. **Execution policy blocks script startup** — provide a `.bat` wrapper calling `powershell -ExecutionPolicy Bypass -File install.ps1`; make this the primary install instruction; never tell users to `Set-ExecutionPolicy` globally
3. **CRLF line endings corrupt shell scripts inside container** — add `.gitattributes` with `*.sh text eol=lf` before any container work; also strip `\r` via PowerShell before `docker cp` as a safety net
4. **Docker daemon not running after install** — auto-start Docker Desktop with `Start-Process`; poll `docker info` with 120s timeout; give user a clear "waiting for Docker to start..." message, not a generic connection error
5. **User not in docker-users group** — explicitly add user to group post-install with `Add-LocalGroupMember`; warn that sign-out/sign-in is required; combine with WSL2 reboot to minimize restart count

**Additional moderate pitfalls to address in phase 2:**
- Volume mount paths with spaces or OneDrive redirection — use `[Environment]::GetFolderPath('Desktop')`, always double-quote Docker `-v` arguments
- Interactive onboard TTY requirement — pass NVIDIA API key as `-e NVIDIA_API_KEY=...` and run `install.sh --non-interactive`
- Silent container setup failure — verify `nemoclaw --version` after install; fail loudly if exit code is non-zero

## Implications for Roadmap

Based on research, the dependency chain is clear and dictates a 4-phase structure. Nothing in container management works until Docker Desktop is running. Docker Desktop won't install cleanly until WSL2 prerequisites are handled. And handling WSL2 requires a reboot strategy. Build bottom-up.

### Phase 1: Foundation — Prerequisites and Docker Desktop

**Rationale:** Every subsequent phase depends on Docker Desktop being installed and the daemon running. The multi-reboot sequence (Pitfall 1) and execution policy issue (Pitfall 2) are Phase 1 killers that must be solved first. This phase has no Docker dependency — it's pure PowerShell and Windows APIs.

**Delivers:** A working Docker daemon on the user's machine; a `.bat` launcher; the helpers library used by all later phases; a state machine that survives reboots

**Addresses features:** Admin elevation, WSL2 install, Docker Desktop silent install, reboot handling, daemon readiness polling, idempotent re-runs, execution policy bypass, `#Requires -Version 5.1` guard

**Avoids pitfalls:** Pitfall 1 (multi-reboot), Pitfall 2 (execution policy), Pitfall 4 (daemon not running), Pitfall 5 (docker-users group), Pitfall 14 (PS version differences)

**Research flag:** Standard well-documented patterns. Skip `/gsd:research-phase`. Reference scripts exist (chamindac gist).

### Phase 2: Container Creation and NemoClaw Setup

**Rationale:** With Docker Desktop confirmed working, this phase delivers the actual NemoClaw deployment. The two-phase container setup pattern (create then exec) avoids the Dockerfile maintenance problem. CRLF handling (Pitfall 3) and non-interactive install (Pitfall 9) must be solved here before any install attempt.

**Delivers:** Running NemoClaw container with port 18789 forwarded, Desktop\NemoClaw shared folder mounted, NVIDIA API key injected, NemoClaw verified functional

**Addresses features:** Container creation, port forwarding (18789), shared folder mount, NVIDIA API key prompt, idempotent container recreation check

**Uses:** Ubuntu 22.04, Docker CLI `docker run` + `docker exec`, `[Environment]::GetFolderPath('Desktop')`, `.gitattributes` CRLF fix

**Avoids pitfalls:** Pitfall 3 (CRLF), Pitfall 6 (volume mount paths), Pitfall 9 (interactive onboard), Pitfall 11 (Desktop path with OneDrive), Pitfall 12 (silent install failure)

**Research flag:** The non-interactive mode of `install.sh` needs validation against the actual script behavior. Confirm `--non-interactive` flag and `NEMOCLAW_NON_INTERACTIVE=1` env var work as documented before coding this phase.

### Phase 3: Lifecycle Management and Daily Use Commands

**Rationale:** Once the container exists, users need reliable start/stop/restart/status commands. This phase also covers the networking verification that makes `status` actually useful (Pitfall 7 and 8 surface here). The named container pattern (Pattern 3) makes this straightforward, but resilience to a missing container (Pitfall 13) is required.

**Delivers:** `install.ps1 start|stop|restart|status` subcommands; health check on `:18789`; dashboard URL and token output; browser auto-launch; graceful handling of missing container

**Addresses features:** Start/stop/restart/status, automatic browser launch, health check with URL output, container auto-start detection

**Avoids pitfalls:** Pitfall 7 (port blocked), Pitfall 8 (WSL2 mirrored networking), Pitfall 13 (container lost on Docker Desktop update)

**Research flag:** WSL2 `networkingMode=mirrored` detection may need validation; check `.wslconfig` parsing approach. Otherwise standard patterns apply.

### Phase 4: Polish, Error Hardening, and Support Tooling

**Rationale:** After core flows work end-to-end, harden edge cases and add the UX polish that reduces support burden. Antivirus interference (Pitfall 10) and Desktop path variations (Pitfall 11) are addressed here with warnings and better detection. Log file and pre-check features have outsized support value for minimal code.

**Delivers:** `Start-Transcript` log file, system requirements pre-check, Desktop shortcut (`.lnk`), antivirus detection and warning, WSL2 networking diagnostic, improved error messages throughout

**Addresses features:** Log file for troubleshooting, system requirements pre-check, Desktop shortcut, progress indicators

**Avoids pitfalls:** Pitfall 10 (antivirus), Pitfall 11 (Desktop path edge cases — final hardening)

**Research flag:** Desktop shortcut creation via WScript.Shell COM object is a standard pattern. No additional research needed.

### Phase Ordering Rationale

- Phase 1 before everything: Docker must run before any container operation. The reboot state machine is foundational — without it, the script fails on every clean machine.
- Phase 2 before lifecycle: The named container must exist before start/stop/restart have anything to act on.
- Phase 3 before Phase 4: Core functionality before polish. Phase 4 adds value but nothing in Phase 4 is blocking for a usable release.
- Pitfall 3 (CRLF) solved in Phase 2, not Phase 4: It silently breaks every shell script the container runs. It is a Phase 2 prerequisite, not a polish item.

### Research Flags

Phases needing deeper research during planning:
- **Phase 2:** Validate that `install.sh --non-interactive` and `NEMOCLAW_NON_INTERACTIVE=1` fully bypass all TTY prompts. Read `install.sh` lines 278-331 before implementing container exec strategy. If non-interactive mode is incomplete, a pre-baked Dockerfile approach may be preferable.

Phases with standard patterns (skip research):
- **Phase 1:** winget + Docker Desktop silent install is thoroughly documented. Reference gist (chamindac) covers the WSL2 + Docker Desktop PowerShell pattern end-to-end.
- **Phase 3:** Named container lifecycle management is idiomatic Docker. `docker inspect --format '{{.State.Status}}'` is stable.
- **Phase 4:** `Start-Transcript`, system requirements checks, and WScript.Shell shortcut creation are standard PowerShell 5.1 patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies are official Microsoft/Docker documentation. PS 5.1, winget, Docker Desktop, WSL2 — no ambiguity. |
| Features | HIGH | Features derived from PROJECT.md requirements plus well-documented Windows installer patterns. MVP vs defer split is well-reasoned. |
| Architecture | HIGH | Three-layer architecture is the only viable approach given constraints. Verb dispatch + persistent named container are established patterns. |
| Pitfalls | HIGH | All pitfalls sourced from official Docker/Microsoft docs and active GitHub issues. CRLF and reboot issues are extensively documented real failures. |

**Overall confidence:** HIGH

### Gaps to Address

- **`install.sh` non-interactive mode completeness**: The PITFALLS research references lines 278-292 and 331 of `install.sh` as having `--non-interactive` support, but this was inferred from the research — the actual script behavior must be verified by reading `install.sh` before implementing Phase 2. If the flag is missing or incomplete, the container exec strategy changes significantly.
- **Exact Docker Desktop silent install flags on WSL2 backend**: The `--backend=wsl-2` flag is referenced in multiple sources but should be confirmed against the current Docker Desktop installer version before coding Phase 1. Flags can change between Docker Desktop major versions.
- **Port 18789 firewall behavior on Windows 11**: WSL2 networking on Windows 11 has changed across OS updates. The automatic Windows Firewall rule approach (`New-NetFirewallRule`) should be tested on a clean Windows 11 install before the Phase 3 health check is considered done.

## Sources

### Primary (HIGH confidence)
- [PowerShell 5.1 vs 7.x differences — Microsoft Learn](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell?view=powershell-7.5)
- [Docker Desktop Windows Install Docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop WSL2 Backend Docs](https://docs.docker.com/desktop/features/wsl/)
- [winget usage — Microsoft Learn](https://learn.microsoft.com/en-us/windows/package-manager/winget/)
- [WSL Installation Guide — Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/install)
- [Docker Windows Permission Requirements](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)
- [PowerShell Execution Policies — Microsoft Learn](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)
- [Docker Antivirus Guidance](https://docs.docker.com/engine/security/antivirus/)

### Secondary (MEDIUM confidence)
- [Automated Docker Desktop + WSL2 PowerShell Script (chamindac gist)](https://gist.github.com/chamindac/6045561f84f8548b052f523114583d41) — reference implementation for Phase 1
- [Docker Desktop Silent Install Guide (Silent Install HQ)](https://silentinstallhq.com/docker-desktop-silent-install-how-to-guide/) — silent install flags
- [PowerShell Docker Start/Stop/Restart Pattern (BernCarney gist)](https://gist.github.com/BernCarney/c016829743864cb0ca7178beb86d4d7f) — Phase 3 reference
- [Start-BitsTransfer vs Invoke-WebRequest comparison](https://blog.wuibaille.fr/2023/09/invoke-webrequest-vs-webclient-vs-bitstransfer/)

### Tertiary (LOW confidence — validate during implementation)
- [WSL2 Mirrored Networking Issue (microsoft/WSL#10494)](https://github.com/microsoft/WSL/issues/10494) — detection approach needs testing
- [Docker for Windows: CRLF Line Endings](https://willi.am/blog/2016/08/11/docker-for-windows-dealing-with-windows-line-endings/) — older article; `.gitattributes` approach still valid
- [Docker for Windows WSL2 Port Forwarding Issues (docker/for-win#13182)](https://github.com/docker/for-win/issues/13182) — firewall rule approach needs Windows 11 validation

---
*Research completed: 2026-03-20*
*Ready for roadmap: yes*
