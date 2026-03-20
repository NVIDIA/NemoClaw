# Phase 3: Lifecycle Management - Research

**Researched:** 2026-03-20
**Domain:** Docker container lifecycle (start/stop/restart/status/uninstall) via PowerShell, Docker Desktop programmatic launch, winget silent uninstall
**Confidence:** HIGH

## Summary

Phase 3 adds command routing to the existing `windows/install.ps1` script so that users can run `install.bat start`, `install.bat stop`, `install.bat restart`, `install.bat status`, and `install.bat uninstall` without any Docker CLI knowledge. The infrastructure is already 90% in place: the `.bat` launcher passes `%*` args to PowerShell, the container is named `nemoclaw`, and `Wait-DockerReady` already launches Docker Desktop if it is not running. What is missing is (1) a `param()` block and `switch` statement for command routing, (2) individual lifecycle functions, and (3) an uninstall function with confirmation prompt and optional Docker Desktop removal.

A critical issue was identified: `nemoclaw-start.sh` backgrounds the gateway process and exits, which means the container CMD terminates and Docker stops the container. Phase 3 must fix this by appending a foreground wait (e.g., `exec tail -f /tmp/gateway.log`) to the entrypoint script, or the container will never stay running after `docker start`. This affects both Phase 2's initial setup and Phase 3's `start` command.

The existing code already has `Remove-ExistingContainer` (stop + rm), `Wait-DockerReady` (start Docker Desktop + poll), and `Test-DashboardReady` (HTTP health poll). Phase 3 reuses these heavily and adds thin wrappers for the new commands.

**Primary recommendation:** Add a `param([string]$Command = "install")` block at the entry point, route through a `switch` statement, and implement five new functions (`Start-NemoClaw`, `Stop-NemoClaw`, `Restart-NemoClaw`, `Get-NemoClawStatus`, `Uninstall-NemoClaw`) that wrap Docker CLI commands with user-friendly output. Fix `nemoclaw-start.sh` to keep a foreground process alive so `docker start`/`docker stop` work correctly.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| LIFE-01 | User can start the NemoClaw container (launching Docker Desktop if needed) | Reuse `Wait-DockerReady` for Docker Desktop launch + `docker start nemoclaw` + `Test-DashboardReady` for confirmation |
| LIFE-02 | User can stop the NemoClaw container | `docker stop nemoclaw` with graceful SIGTERM + user-friendly status message |
| LIFE-03 | User can restart the NemoClaw container | `docker restart nemoclaw` (or stop + start) + `Test-DashboardReady` for confirmation |
| LIFE-04 | User can check container status and port reachability | `docker inspect --format '{{.State.Status}}' nemoclaw` + `Test-Net-Connection localhost -Port 18789` or `Invoke-WebRequest` health check |
| LIFE-05 | User can uninstall (remove container, image, and optionally Docker Desktop) | `docker stop/rm nemoclaw` + `docker rmi nemoclaw` + confirmation prompt + optional `winget uninstall Docker.DockerDesktop --silent` |
</phase_requirements>

## Standard Stack

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Docker CLI | (bundled with Docker Desktop) | Container lifecycle commands | Already installed by Phase 1 |
| PowerShell 5.1+ | (Windows built-in) | Script host with command routing | Phases 1-2 established this |
| Pester | 5.x | Test framework | Phases 1-2 test suite uses it |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| `docker start/stop/restart` | Container lifecycle | Start, stop, restart commands |
| `docker inspect` | Container state query | Status command |
| `docker rm` / `docker rmi` | Container and image cleanup | Uninstall command |
| `Invoke-WebRequest` | HTTP health check | Confirm dashboard reachable after start/restart |
| `winget uninstall` | Docker Desktop removal | Optional step in uninstall command |
| `Test-NetConnection` | TCP port check | Quick port reachability test for status |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `docker restart` | `docker stop` + `docker start` | `docker restart` is atomic and simpler; stop+start gives more control over error handling between steps |
| `docker inspect` for status | `docker ps --filter` | `inspect` gives structured JSON; `ps --filter --format` is simpler for basic running/stopped check |
| `winget uninstall` for Docker removal | Direct EXE uninstaller | winget is cleaner and already used for install; EXE path is a fallback |
| `Test-NetConnection` for port check | `Invoke-WebRequest` | `Test-NetConnection` tests TCP only; `Invoke-WebRequest` validates HTTP 200. Use both: TCP for quick check, HTTP for full validation |

## Architecture Patterns

### Command Routing Pattern

**What:** Add a `param()` block to accept a command argument and route to the appropriate function via `switch`
**When to use:** This is the entry point change -- all lifecycle commands flow through this

```powershell
# At the very top of install.ps1, before any function definitions:
param(
    [Parameter(Position = 0)]
    [ValidateSet("install", "start", "stop", "restart", "status", "uninstall")]
    [string]$Command = "install"
)

# At the bottom, replacing the current entry point:
if ($env:NEMOCLAW_TESTING) { return }

switch ($Command) {
    "install" {
        Assert-Administrator
        Install-Prerequisites
        Install-NemoClawContainer
    }
    "start"     { Start-NemoClaw }
    "stop"      { Stop-NemoClaw }
    "restart"   { Restart-NemoClaw }
    "status"    { Get-NemoClawStatus }
    "uninstall" { Uninstall-NemoClaw }
}
```

**Key detail:** The `.bat` launcher already passes `%*` to PowerShell, so `install.bat start` becomes `install.ps1 -Command start` automatically via positional binding. `ValidateSet` gives free input validation with a helpful error message.

**Confidence:** HIGH -- PowerShell param() with ValidateSet is standard.

### Container Existence Guard Pattern

**What:** Check that the `nemoclaw` container exists before trying lifecycle operations
**When to use:** All lifecycle commands except install and uninstall (uninstall handles missing gracefully)

```powershell
function Assert-ContainerExists {
    $exists = docker ps -a --filter "name=^nemoclaw$" --format "{{.Names}}" 2>&1
    if ($exists -ne "nemoclaw") {
        Write-Err "NemoClaw container not found. Run 'install.bat' first to set up NemoClaw."
        exit 1
    }
}
```

**Confidence:** HIGH -- reuses the exact filter pattern from `Remove-ExistingContainer`.

### Docker Desktop Auto-Launch Pattern

**What:** For `start` and `restart`, ensure Docker Desktop is running before issuing container commands
**When to use:** Any command that needs the Docker daemon

```powershell
function Assert-DockerRunning {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $ready = Wait-DockerReady
        if (-not $ready) {
            Write-Err "Docker Desktop is not running and could not be started."
            Write-Err "Open Docker Desktop manually and try again."
            exit 1
        }
    }
}
```

**Confidence:** HIGH -- reuses `Wait-DockerReady` from Phase 1.

### Uninstall with Confirmation Prompt Pattern

**What:** Two-stage confirmation for destructive operations
**When to use:** Uninstall command

```powershell
function Uninstall-NemoClaw {
    Write-Warn "This will remove the NemoClaw container and Docker image."
    Write-Warn "Your Desktop\NemoClaw folder will NOT be deleted."
    $confirm = Read-Host "Type 'yes' to confirm"
    if ($confirm -ne "yes") {
        Write-Info "Uninstall cancelled."
        return
    }

    # Remove container
    $existing = docker ps -a --filter "name=^nemoclaw$" --format "{{.Names}}" 2>&1
    if ($existing -eq "nemoclaw") {
        docker stop nemoclaw 2>&1 | Out-Null
        docker rm nemoclaw 2>&1 | Out-Null
        Write-Ok "Container removed."
    }

    # Remove image
    $image = docker images nemoclaw --quiet 2>&1
    if ($image) {
        docker rmi nemoclaw 2>&1 | Out-Null
        Write-Ok "Image removed."
    }

    # Clean registry
    Remove-Item -Path "HKCU:\Software\NemoClaw" -Recurse -ErrorAction SilentlyContinue
    Write-Ok "Registry entries cleaned."

    # Optional: Remove Docker Desktop
    Write-Host ""
    $removeDocker = Read-Host "Also remove Docker Desktop? (yes/no)"
    if ($removeDocker -eq "yes") {
        Write-Info "Removing Docker Desktop..."
        winget uninstall --id Docker.DockerDesktop --silent 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "winget uninstall failed. You can remove Docker Desktop from Settings > Apps."
        } else {
            Write-Ok "Docker Desktop removed."
        }
    }

    Write-Host ""
    Write-Ok "NemoClaw has been uninstalled."
}
```

**Confidence:** HIGH -- straightforward Docker CLI + winget commands.

### Anti-Patterns to Avoid
- **Requiring administrator for lifecycle commands:** Only `install` and `uninstall` (Docker Desktop removal) need admin. Start/stop/restart/status should work as a normal user in the docker-users group.
- **Using `docker kill` instead of `docker stop`:** `docker stop` sends SIGTERM for graceful shutdown; `kill` sends SIGKILL immediately.
- **Forgetting to check Docker daemon before container commands:** If Docker Desktop is closed, `docker start nemoclaw` fails with a confusing error. Always check daemon first.
- **Not clearing the spinner line before printing status:** The polling loop uses `\r` for progress. Print a blank line or carriage return before final output.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Container state query | Parse `docker ps` text output | `docker inspect --format '{{.State.Status}}' nemoclaw` | Returns exact state string (running/exited/created/paused) |
| Port reachability check | Raw TCP socket code | `Test-NetConnection localhost -Port 18789` + `Invoke-WebRequest` | Built-in PowerShell, handles edge cases |
| Docker Desktop uninstall | Registry hacking or EXE uninstaller | `winget uninstall --id Docker.DockerDesktop --silent` | Clean, consistent with Phase 1 install path |
| Command argument validation | Manual string matching | `[ValidateSet()]` parameter attribute | PowerShell built-in, auto-generates error messages |
| Container existence check | Custom `docker ps` parsing | `docker ps -a --filter "name=^nemoclaw$" --format "{{.Names}}"` | Already established pattern from Phase 2 |

## Common Pitfalls

### Pitfall 1: Container Entrypoint Exits Immediately
**What goes wrong:** `docker start nemoclaw` succeeds but the container exits within seconds
**Why it happens:** `nemoclaw-start.sh` backgrounds the gateway with `nohup ... &` and then the script exits. When CMD finishes, Docker stops the container.
**How to avoid:** Append `exec tail -f /tmp/gateway.log` (or `wait` or `sleep infinity`) at the end of `nemoclaw-start.sh` so the CMD process stays in the foreground. `tail -f /tmp/gateway.log` is ideal because it also streams gateway logs to `docker logs`.
**Warning signs:** Container shows "Exited (0)" immediately after start. `docker logs nemoclaw` shows the setup output but no ongoing gateway logs.

### Pitfall 2: Docker Desktop Not Running for Lifecycle Commands
**What goes wrong:** `docker start nemoclaw` fails with "Cannot connect to the Docker daemon"
**Why it happens:** User closed Docker Desktop or it was never set to auto-start (Phase 1 explicitly disables auto-start)
**How to avoid:** Always run `docker info` check before any Docker command. If it fails, call `Wait-DockerReady` to launch Docker Desktop and poll for daemon readiness.
**Warning signs:** "error during connect" or "Is the docker daemon running?" errors

### Pitfall 3: UAC Elevation Unnecessary for Lifecycle Commands
**What goes wrong:** User gets a UAC prompt every time they run `install.bat start`
**Why it happens:** Current entry point always calls `Assert-Administrator`
**How to avoid:** Only call `Assert-Administrator` for `install` and `uninstall` (when Docker Desktop removal is involved). Start/stop/restart/status work fine as a normal user who is in the docker-users group.
**Warning signs:** Unnecessary UAC prompts for routine operations

### Pitfall 4: ValidateSet Breaks Existing install.bat Behavior
**What goes wrong:** Running `install.bat` without arguments fails validation
**Why it happens:** If `param()` is misconfigured, it might require an explicit command
**How to avoid:** Default `$Command = "install"` ensures backward compatibility. Running `install.bat` with no args behaves exactly as before.
**Warning signs:** "Cannot validate argument on parameter 'Command'" when running bare `install.bat`

### Pitfall 5: Uninstall Leaves Orphaned WSL Distributions
**What goes wrong:** Docker Desktop creates WSL distributions (docker-desktop, docker-desktop-data) that are not removed when Docker Desktop is uninstalled
**Why it happens:** winget/EXE uninstaller does not always clean up WSL distributions
**How to avoid:** After Docker Desktop removal, optionally run `wsl --unregister docker-desktop-data` and `wsl --unregister docker-desktop`. Mention this in the uninstall output if Docker Desktop was removed.
**Warning signs:** `wsl --list` still shows docker-desktop distributions after uninstall

### Pitfall 6: Status Command Confusing When Container Was Never Created
**What goes wrong:** Status shows cryptic Docker error instead of friendly message
**Why it happens:** `docker inspect nemoclaw` fails with "No such container" if the container was never created
**How to avoid:** Check container existence first with the filter pattern. If no container, print "NemoClaw is not installed. Run 'install.bat' to set up."
**Warning signs:** Raw Docker error messages shown to user

## Code Examples

### Start Command (LIFE-01)
```powershell
function Start-NemoClaw {
    Assert-DockerRunning
    Assert-ContainerExists

    $state = docker inspect --format "{{.State.Status}}" nemoclaw 2>&1
    if ($state -eq "running") {
        Write-Info "NemoClaw is already running."
        Write-Info "Dashboard: http://localhost:18789"
        return
    }

    Write-Info "Starting NemoClaw container..."
    docker start nemoclaw 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to start NemoClaw container."
        exit 1
    }

    $ready = Test-DashboardReady -TimeoutSeconds 60 -IntervalSeconds 3
    if ($ready) {
        Write-Ok "NemoClaw is running."
        Write-Ok "Dashboard: http://localhost:18789"
    } else {
        Write-Warn "Container started but dashboard is not responding yet."
        Write-Warn "Check logs with: docker logs nemoclaw"
    }
}
```

### Stop Command (LIFE-02)
```powershell
function Stop-NemoClaw {
    Assert-DockerRunning
    Assert-ContainerExists

    $state = docker inspect --format "{{.State.Status}}" nemoclaw 2>&1
    if ($state -ne "running") {
        Write-Info "NemoClaw is not running."
        return
    }

    Write-Info "Stopping NemoClaw container..."
    docker stop nemoclaw 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to stop NemoClaw container."
        exit 1
    }
    Write-Ok "NemoClaw stopped."
}
```

### Restart Command (LIFE-03)
```powershell
function Restart-NemoClaw {
    Assert-DockerRunning
    Assert-ContainerExists

    Write-Info "Restarting NemoClaw container..."
    docker restart nemoclaw 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to restart NemoClaw container."
        exit 1
    }

    $ready = Test-DashboardReady -TimeoutSeconds 60 -IntervalSeconds 3
    if ($ready) {
        Write-Ok "NemoClaw restarted."
        Write-Ok "Dashboard: http://localhost:18789"
    } else {
        Write-Warn "Container restarted but dashboard is not responding yet."
        Write-Warn "Check logs with: docker logs nemoclaw"
    }
}
```

### Status Command (LIFE-04)
```powershell
function Get-NemoClawStatus {
    # Check Docker daemon
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Docker Desktop is not running."
        Write-Info "NemoClaw status: unknown (Docker not available)"
        return
    }

    # Check container existence
    $exists = docker ps -a --filter "name=^nemoclaw$" --format "{{.Names}}" 2>&1
    if ($exists -ne "nemoclaw") {
        Write-Info "NemoClaw is not installed. Run 'install.bat' to set up."
        return
    }

    # Check container state
    $state = docker inspect --format "{{.State.Status}}" nemoclaw 2>&1
    switch ($state) {
        "running" {
            Write-Ok "NemoClaw container is running."
            # Check port reachability
            try {
                $response = Invoke-WebRequest -Uri "http://localhost:18789" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
                Write-Ok "Dashboard is reachable at http://localhost:18789"
            } catch {
                Write-Warn "Container is running but dashboard is not responding on port 18789."
            }
        }
        "exited" {
            Write-Info "NemoClaw container is stopped."
            Write-Info "Run 'install.bat start' to start it."
        }
        default {
            Write-Info "NemoClaw container state: $state"
        }
    }
}
```

### Entrypoint Fix for nemoclaw-start.sh
```bash
# Append to the end of nemoclaw-start.sh (replace current last lines):
nohup openclaw gateway run > /tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)"
start_auto_pair
print_dashboard_urls

# Keep the container alive by tailing the gateway log.
# This also makes 'docker logs nemoclaw' show gateway output.
exec tail -f /tmp/gateway.log
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate management scripts | Single script with subcommands | Common CLI pattern | One entry point for all operations |
| `docker kill` for stopping | `docker stop` (SIGTERM + grace period) | Docker best practice | Graceful shutdown of gateway process |
| Manual Docker Desktop launch | Automated launch via `Start-Process` + daemon polling | Phase 1 pattern | Transparent Docker management |
| Interactive PowerShell execution | `.bat` launcher with `%*` arg passthrough | Phase 1 design | Double-click or CLI usage |

## Open Questions

1. **Does `docker restart` re-run CMD or resume the process?**
   - What we know: `docker restart` stops and starts the container. On start, CMD runs again.
   - What's unclear: Whether nemoclaw-start.sh's re-initialization (openclaw doctor --fix, config rewrite, plugin install) is safe to run multiple times.
   - Recommendation: The script already uses idempotent operations (`--fix`, `exist_ok=True`, config overwrite). Should be safe. Test during implementation.

2. **Should lifecycle commands require administrator?**
   - What we know: Docker commands work for any user in the docker-users group. Phase 1 adds the user to this group.
   - What's unclear: Whether the user's group membership is effective without a logoff/login after Phase 1.
   - Recommendation: Do NOT require admin for start/stop/restart/status. Only require admin for `uninstall` when Docker Desktop removal is selected. If docker commands fail, suggest the user log out and back in.

3. **Should uninstall remove the Desktop\NemoClaw shared folder?**
   - What we know: The folder contains user files that may be valuable.
   - Recommendation: Do NOT remove it. Print a message telling the user it was preserved and they can delete it manually if desired.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Pester 5.x |
| Config file | None (inline `-CI` flag) |
| Quick run command | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -CI` |
| Full suite command | `Invoke-Pester ./windows/tests/ -CI` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LIFE-01 | Start container (launching Docker Desktop if needed) | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-01" -CI` | No -- Wave 0 |
| LIFE-02 | Stop container | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-02" -CI` | No -- Wave 0 |
| LIFE-03 | Restart container | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-03" -CI` | No -- Wave 0 |
| LIFE-04 | Status and port reachability | unit (mock docker + Invoke-WebRequest) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-04" -CI` | No -- Wave 0 |
| LIFE-05 | Uninstall with confirmation and optional Docker removal | unit (mock docker + winget + Read-Host) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "LIFE-05" -CI` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `Invoke-Pester ./windows/tests/Install.Tests.ps1 -CI`
- **Per wave merge:** `Invoke-Pester ./windows/tests/ -CI`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `windows/tests/Install.Tests.ps1` -- add LIFE-01 through LIFE-05 test blocks (extend existing file)
- [ ] New functions must follow `$env:NEMOCLAW_TESTING` guard pattern for safe dot-sourcing
- [ ] `param()` block at top of install.ps1 must not break existing test dot-source pattern (test sets `$env:NEMOCLAW_TESTING` and dot-sources, which triggers `return` before the switch)
- [ ] `nemoclaw-start.sh` entrypoint fix needs verification (no Pester test -- manual or integration only)

## Sources

### Primary (HIGH confidence)
- `windows/install.ps1` -- Phase 1-2 implementation (read directly), establishes all reusable patterns
- `windows/install.bat` -- Launcher already passes `%*` args to PowerShell
- `scripts/nemoclaw-start.sh` -- Container entrypoint, identified foreground process issue
- `windows/Dockerfile.nemoclaw` -- Container image definition, CMD uses nemoclaw-start
- [Docker container rm docs](https://docs.docker.com/reference/cli/docker/container/rm/) -- Container removal commands
- [Docker image rm docs](https://docs.docker.com/reference/cli/docker/image/rm/) -- Image removal commands
- [Docker auto-start docs](https://docs.docker.com/engine/containers/start-containers-automatically/) -- Restart policies

### Secondary (MEDIUM confidence)
- [Docker Desktop silent uninstall](https://silentinstallhq.com/docker-desktop-silent-uninstall-powershell/) -- winget uninstall pattern verified
- [Docker Desktop uninstall docs](https://docs.docker.com/desktop/uninstall/) -- Official uninstall guidance
- [winget uninstall command](https://learn.microsoft.com/en-us/windows/package-manager/winget/uninstall) -- Microsoft docs for winget uninstall flags
- [Docker Desktop start from PowerShell](https://gist.github.com/Jandini/0da7acf11f3c3c2a772b3e6c8bd6a0c3) -- Start-Process pattern

### Tertiary (LOW confidence)
- WSL distribution cleanup after Docker Desktop removal (needs validation on clean system)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All tools (Docker CLI, PowerShell, Pester) already established in Phases 1-2
- Architecture: HIGH -- Command routing via param()/switch is standard PowerShell; all Docker CLI commands are well-documented
- Pitfalls: HIGH -- Container entrypoint issue identified from code review; Docker Desktop auto-launch pattern proven in Phase 1
- Entrypoint fix: MEDIUM -- `exec tail -f` is standard Docker pattern but needs testing with nemoclaw-start.sh's specific setup

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (30 days -- stable technologies)
