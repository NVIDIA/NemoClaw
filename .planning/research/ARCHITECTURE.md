# Architecture Patterns

**Domain:** Windows PowerShell Docker installer for NemoClaw
**Researched:** 2026-03-20

## Recommended Architecture

The installer is a single PowerShell script (`install.ps1`) with a verb-based dispatch pattern. The user invokes it with subcommands: `install`, `start`, `stop`, `restart`, `status`, `uninstall`. Internally the script is organized into discrete sections that mirror the existing `install.sh` structure but adapted for Windows/Docker Desktop/WSL2 realities.

The architecture has three layers:

```
+---------------------------+
|  PowerShell Script        |  Host layer (Windows)
|  install.ps1              |
|  - Prerequisites check    |
|  - Docker Desktop install |
|  - Container lifecycle    |
|  - User interaction       |
+---------------------------+
            |
            | docker CLI commands
            v
+---------------------------+
|  Docker Desktop           |  Docker layer (WSL2 backend)
|  - WSL2 integration       |
|  - Port forwarding 18789  |
|  - Volume mount            |
+---------------------------+
            |
            | container runtime
            v
+---------------------------+
|  Ubuntu 22.04 Container   |  Container layer
|  - install.sh execution   |
|  - NemoClaw + OpenClaw    |
|  - Gateway on :18789      |
|  - nemoclaw-start.sh      |
+---------------------------+
            |
            | HTTP :18789
            v
+---------------------------+
|  User's Browser           |  Access layer
|  http://localhost:18789   |
+---------------------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **Helpers module** | Colored output (`Write-Host`), version comparison, admin elevation check | All other components |
| **Prerequisites checker** | Detect Windows version, WSL2 status, Docker Desktop presence, free disk space | Docker installer |
| **Docker Desktop installer** | Download, silent install, WSL2 backend enable, docker-users group, wait-for-ready | Prerequisites checker, Container builder |
| **Container builder** | `docker build` or `docker run` with Ubuntu 22.04, execute `install.sh` inside, configure NVIDIA API key | Docker Desktop installer, Container manager |
| **Container manager** | Start/stop/restart/status via named container, port forwarding, volume mount | Container builder, User |
| **Shared folder manager** | Create `$HOME\Desktop\NemoClaw`, validate mount path, handle path with spaces | Container manager |
| **Post-install verifier** | Hit `http://localhost:18789` health check, print dashboard URL, open browser | Container manager |

### Data Flow

**Installation flow (first run):**

```
User runs install.ps1
  |
  +--> Check admin privileges (elevate if needed for Docker install)
  |
  +--> Check Windows version >= 10 build 19041
  |
  +--> Check/enable WSL2
  |     |
  |     +--> If WSL2 not enabled: enable via DISM, prompt reboot
  |           (Script must handle resume-after-reboot scenario)
  |
  +--> Check/install Docker Desktop
  |     |
  |     +--> Download installer from docker.com
  |     +--> Start-Process with --quiet --accept-license --backend=wsl-2
  |     +--> Add user to docker-users group
  |     +--> Start Docker Desktop
  |     +--> Poll `docker info` in loop until ready (timeout 120s)
  |
  +--> Prompt for NVIDIA API key (Read-Host -AsSecureString)
  |
  +--> Create Desktop\NemoClaw folder
  |
  +--> docker run -d --name nemoclaw \
  |      -p 18789:18789 \
  |      -v "$HOME\Desktop\NemoClaw:/shared" \
  |      -e NVIDIA_API_KEY=$key \
  |      ubuntu:22.04 /bin/bash -c "apt-get update && <bootstrap>"
  |
  +--> Copy install.sh into container, execute it (non-interactive)
  |
  +--> Execute nemoclaw-start.sh inside container
  |
  +--> Verify http://localhost:18789 responds
  |
  +--> Print success message with dashboard URL
```

**Management flow (subsequent runs):**

```
User runs: .\install.ps1 start|stop|restart|status
  |
  +--> Check Docker Desktop running (start if needed)
  |
  +--> docker start/stop/restart/inspect nemoclaw
  |
  +--> For start: wait for :18789 to respond, print URL
  +--> For status: show container state, port, uptime
```

## Patterns to Follow

### Pattern 1: Verb-Based Dispatch

**What:** Single script file with `param()` block accepting a verb argument. Switch statement routes to handler functions.
**When:** Always -- this is the standard PowerShell CLI tool pattern.
**Why:** Users get a single entry point. No multiple script files to track.

```powershell
param(
    [Parameter(Position = 0)]
    [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'uninstall')]
    [string]$Command = 'install'
)

switch ($Command) {
    'install'   { Install-NemoClaw }
    'start'     { Start-NemoClaw }
    'stop'      { Stop-NemoClaw }
    'restart'   { Restart-NemoClaw }
    'status'    { Get-NemoClawStatus }
    'uninstall' { Uninstall-NemoClaw }
}
```

### Pattern 2: Docker Readiness Polling

**What:** After starting Docker Desktop, poll `docker info` in a loop with timeout before proceeding.
**When:** After Docker Desktop install or launch, before any `docker run` commands.
**Why:** Docker Desktop takes 30-90 seconds to fully start. Running `docker run` before the daemon is ready causes cryptic errors.

```powershell
function Wait-DockerReady {
    param([int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = docker info 2>&1
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
        Start-Sleep -Seconds 3
    }
    return $false
}
```

### Pattern 3: Named Container with Idempotent Create

**What:** Always use `--name nemoclaw` for the container. Before creating, check if a container with that name exists (running or stopped) and handle accordingly.
**When:** Every `install` and `start` command.
**Why:** Prevents orphan containers. Makes stop/restart/status reliable without tracking container IDs.

```powershell
function Get-ContainerState {
    $state = docker inspect --format '{{.State.Status}}' nemoclaw 2>$null
    if ($LASTEXITCODE -ne 0) { return 'absent' }
    return $state  # running, exited, paused, etc.
}
```

### Pattern 4: Two-Phase Container Setup (Build Then Configure)

**What:** Use `docker run` with Ubuntu 22.04 base to create the container, then `docker exec` to run `install.sh` and configuration steps. Do NOT try to do everything in a single `docker run` command.
**When:** During initial install.
**Why:** The existing `install.sh` is interactive (onboard step), expects a TTY, and installs nvm/node/nemoclaw. Running it as a multi-line RUN in a Dockerfile would require a custom Dockerfile (which the project wants to avoid -- the goal is to reuse install.sh from the repo as-is). Two-phase keeps the container alive while setup runs inside it.

```
Phase 1: docker run -d --name nemoclaw ubuntu:22.04 tail -f /dev/null
         docker cp install.sh nemoclaw:/tmp/install.sh
Phase 2: docker exec nemoclaw bash /tmp/install.sh --non-interactive
         docker exec nemoclaw bash /usr/local/bin/nemoclaw-start
```

### Pattern 5: Persistent Container (Not Ephemeral)

**What:** Create the container once, then start/stop it. Do NOT `docker run` a new container each time.
**When:** All lifecycle management.
**Why:** NemoClaw installs globally inside the container (npm install -g). Creating a new container each start would require re-running the full install. A persistent container preserves the installed state.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Building a Custom Dockerfile for the Windows Installer

**What:** Creating a separate Dockerfile that installs NemoClaw at build time.
**Why bad:** The existing `Dockerfile` in the repo is for the sandbox image (OpenShell/k3s environment), not for this Windows installer use case. Creating another Dockerfile diverges from the documented bare-metal install path and adds maintenance burden for keeping two install paths in sync.
**Instead:** Use `ubuntu:22.04` as base image and run the existing `install.sh` inside it via `docker exec`. This way the install.sh is the single source of truth.

### Anti-Pattern 2: Requiring Manual PATH or Environment Edits

**What:** Asking users to edit their PowerShell profile, add things to PATH, or set environment variables manually.
**Why bad:** Target users are Windows users with no Linux/Docker knowledge. Any manual step is a support burden.
**Instead:** The script handles everything. API key is prompted once and stored as a Docker environment variable on the container.

### Anti-Pattern 3: Using docker-compose for a Single Container

**What:** Introducing docker-compose.yml for managing one container.
**Why bad:** Adds a dependency (Docker Compose), a second file to distribute, and cognitive overhead for a single-container setup.
**Instead:** Plain `docker run` / `docker start` / `docker stop` with the named container.

### Anti-Pattern 4: Running the Script Exclusively as Administrator

**What:** Requiring the entire script to run elevated.
**Why bad:** After Docker Desktop is installed, container management does NOT require admin. Running everything as admin is a security concern and confuses UAC prompts.
**Instead:** Elevate only for the Docker Desktop installation phase (WSL enable, Docker install, docker-users group). Container management runs as normal user.

## Key Design Decisions

### Container Base: ubuntu:22.04 (not the repo's Dockerfile)

The existing Dockerfile uses `node:22-slim` and is designed for the OpenShell sandbox environment. The Windows installer should use `ubuntu:22.04` and run `install.sh` inside it, because:

1. Closer to documented bare-metal install path (per PROJECT.md)
2. `install.sh` handles Node.js installation via nvm
3. Avoids maintaining two parallel install mechanisms
4. `install.sh` already has `--non-interactive` flag support

### Port Strategy: Direct Host Mapping

Map container port 18789 directly to host port 18789 (`-p 18789:18789`). The OpenClaw dashboard binds to `0.0.0.0:18789` inside the container. Docker Desktop on Windows with WSL2 backend handles the port forwarding transparently through to `localhost:18789` on the host.

### Volume Mount: Desktop Folder

Mount `$HOME\Desktop\NemoClaw` on the host to `/shared` in the container. This gives users a drag-and-drop location for files. The path MUST be quoted in the docker command because Windows usernames can contain spaces.

### API Key Storage: Container Environment Variable

The NVIDIA API key is set as an environment variable on the container at creation time (`docker run -e NVIDIA_API_KEY=...`). This persists across `docker stop`/`docker start` cycles without needing a config file on the Windows host.

### Reboot Handling: Marker File

WSL2 enablement may require a reboot. The script should write a marker file (e.g., `$env:TEMP\nemoclaw-install-stage.txt`) before triggering the reboot, and check for it on next run to resume from the correct stage. This is a known pattern for multi-stage Windows installers.

## Scalability Considerations

Not applicable -- this is a single-user local development tool, not a production service. The architecture is designed for exactly one container on one Windows machine.

## Build Order (Dependency Chain)

Components must be built/implemented in this order due to hard dependencies:

```
1. Helpers (logging, version checks, admin detection)
   |-- No dependencies, used by everything
   |
2. Prerequisites checker
   |-- Depends on: Helpers
   |-- Must exist before Docker installer can decide what to install
   |
3. Docker Desktop installer
   |-- Depends on: Helpers, Prerequisites checker
   |-- Must be working before any container operations
   |
4. Container builder (docker run + install.sh execution)
   |-- Depends on: Helpers, Docker Desktop installer
   |-- Must be working before lifecycle management makes sense
   |
5. Shared folder manager
   |-- Depends on: Helpers
   |-- Needed by Container builder (volume mount flag)
   |-- Can be built in parallel with Docker installer
   |
6. Container lifecycle manager (start/stop/restart/status)
   |-- Depends on: Helpers, Container builder (named container must exist)
   |
7. Post-install verifier (health check + URL display)
   |-- Depends on: Container lifecycle manager
   |
8. Uninstall handler
   |-- Depends on: Helpers, Container lifecycle manager
   |-- Can be built last
```

**Parallelizable:** Steps 3 and 5 can be developed in parallel. Everything else is sequential.

**Phase implications:**
- Phase 1: Helpers + Prerequisites + Docker installer (the "can we even run Docker" foundation)
- Phase 2: Container builder + Shared folder (the "create and configure NemoClaw" core)
- Phase 3: Lifecycle manager + Verifier (the "daily use" commands)
- Phase 4: Error handling hardening, uninstall, edge cases

## Sources

- [Docker Desktop Windows Installation Docs](https://docs.docker.com/desktop/setup/install/windows-install/) - Official installation flags and requirements
- [Docker Desktop WSL2 Backend Docs](https://docs.docker.com/desktop/features/wsl/) - WSL2 integration details
- [Docker Desktop Silent Install Guide](https://silentinstallhq.com/docker-desktop-silent-install-how-to-guide/) - Silent installation patterns
- [Automated Docker Desktop WSL2 Install Script](https://gist.github.com/chamindac/6045561f84f8548b052f523114583d41) - Reference PowerShell installer
- [PowerShell Docker Start/Stop/Restart Pattern](https://gist.github.com/BernCarney/c016829743864cb0ca7178beb86d4d7f) - Container management script pattern
- [Docker Bind Mounts Documentation](https://docs.docker.com/get-started/workshop/06_bind_mounts/) - Volume mount reference
- [Docker Desktop MSI Installer Docs](https://docs.docker.com/enterprise/enterprise-deployment/msi-install-and-configure/) - Enterprise deployment options
- [Docker for Windows WSL Timeout Issues](https://github.com/docker/for-win/issues/13357) - WSL2 integration timeout problems and workarounds
