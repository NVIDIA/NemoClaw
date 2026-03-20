# Phase 2: Container Setup and NemoClaw Install - Research

**Researched:** 2026-03-20
**Domain:** Docker container builds from PowerShell, volume mounts on Windows/WSL2, API key handling, health-check polling
**Confidence:** HIGH

## Summary

Phase 2 extends the existing `windows/install.ps1` script to build a Docker image from a custom Dockerfile (FROM ubuntu:22.04), run install.sh non-interactively inside it, mount `Desktop\NemoClaw` as a shared volume, prompt the user for their NVIDIA API key (persisted in registry via DPAPI), and poll `http://localhost:18789` until the OpenClaw dashboard responds. All decisions from CONTEXT.md are locked: Dockerfile build approach, named container `nemoclaw`, registry-persisted API key at `HKCU:\Software\NemoClaw\ApiKey`, and HTTP health polling with 180s timeout.

The primary technical concerns are: (1) correct Windows-to-Linux volume mount path format for Docker Desktop WSL2 backend, (2) converting SecureString API key back to plaintext for docker run `-e` injection, (3) Dockerfile layer ordering so that install.sh runs reliably in non-interactive mode, and (4) extending the existing registry state machine to cover Phase 2 stages without conflicting with Phase 1's DOCKER_READY terminal state.

**Primary recommendation:** Use a Dockerfile that installs dependencies and runs install.sh at build time, then `docker run` the resulting image with the API key as an environment variable and the Desktop\NemoClaw folder bind-mounted using standard Windows path format (Docker Desktop WSL2 auto-shares C: drive -- no file sharing configuration needed).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Prompt user for NVIDIA API key with masked input (Read-Host -AsSecureString or equivalent)
- Persist in registry at `HKCU:\Software\NemoClaw\ApiKey` -- consistent with Phase 1's registry pattern
- On re-run: if key already exists in registry, skip prompt silently (no re-ask)
- Pass key into container as Docker env var: `-e NVIDIA_API_KEY=...` at container run time
- Dockerfile build approach: FROM ubuntu:22.04, copy install.sh, run it during build
- Container named `nemoclaw`
- If container `nemoclaw` already exists: stop, remove, and rebuild from scratch (clean slate)
- Image rebuild ensures reproducible state; user's Desktop/NemoClaw folder is untouched by rebuild
- Run install.sh with `--non-interactive` flag (confirmed: install.sh supports this via `NON_INTERACTIVE` env var and `--non-interactive` CLI flag)
- Create `$HOME\Desktop\NemoClaw` on host if it doesn't exist
- Mount into container at `/home/nemoclaw/shared`
- If folder already exists with files: keep everything, just mount as-is
- Files survive container rebuilds since the folder lives on the host
- After container starts, HTTP poll `http://localhost:18789` using Invoke-WebRequest
- Poll every 5 seconds, timeout after 180 seconds (3 minutes)
- Reuse spinner pattern from Phase 1's Wait-DockerReady
- Do NOT auto-open browser -- just print the URL
- On success: green banner matching Phase 1 style with checkmarks (container running, folder mounted, dashboard reachable, URL)

### Claude's Discretion
- Dockerfile contents and build optimization (layer caching, apt cleanup)
- How to handle install.sh failures inside the container (build-time vs run-time error reporting)
- Exact spinner implementation during image build and health check
- Whether to create a non-root user inside the container or run as root
- Container restart policy (--restart unless-stopped vs none -- Phase 3 manages lifecycle)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SETUP-01 | Script creates a named Ubuntu 22.04 container with port 18789 forwarded | Dockerfile FROM ubuntu:22.04, `docker build`, `docker run --name nemoclaw -p 18789:18789` |
| SETUP-02 | Script creates Desktop/NemoClaw folder and mounts it into the container | `New-Item -ItemType Directory`, bind mount via `-v "$desktopPath\NemoClaw:/home/nemoclaw/shared"` |
| SETUP-03 | Script prompts user for NVIDIA API key and passes it to the container | Read-Host -AsSecureString + DPAPI registry persistence + `-e NVIDIA_API_KEY=...` on docker run |
| SETUP-04 | Script runs install.sh non-interactively inside the container | Dockerfile RUN with `--non-interactive` flag; `NEMOCLAW_NON_INTERACTIVE=1` env var during build |
| SETUP-05 | Script verifies container health and dashboard reachability after setup | Invoke-WebRequest polling loop on http://localhost:18789 with 5s interval, 180s timeout |
</phase_requirements>

## Standard Stack

### Core
| Tool | Version | Purpose | Why Standard |
|------|---------|---------|--------------|
| Docker CLI | (bundled with Docker Desktop) | Build images, run containers | Already installed by Phase 1 |
| PowerShell 5.1+ | (Windows built-in) | Script host | Phase 1 established this |
| Pester | 5.x | Test framework | Phase 1 test suite uses it |

### Supporting
| Tool | Purpose | When to Use |
|------|---------|-------------|
| Invoke-WebRequest | HTTP health check polling | Dashboard reachability verification |
| ConvertFrom-SecureString | DPAPI encryption for API key | Registry persistence of sensitive value |
| docker build / docker run | Image creation and container lifecycle | Core container setup flow |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Dockerfile build | `docker run` + `docker exec` install.sh | Dockerfile is more reproducible; exec approach leaves container in unknown state on failure |
| DPAPI (ConvertFrom-SecureString) | Plaintext registry value | DPAPI encrypts with current user's credentials -- only same user on same machine can decrypt |
| Read-Host -AsSecureString | Read-Host (plaintext) | SecureString masks input on screen -- better UX for API keys |

## Architecture Patterns

### Recommended Function Structure (extends install.ps1)

New functions to add to `windows/install.ps1`:

```
# New functions for Phase 2:
Get-NvidiaApiKey          # Prompt or load from registry
Save-NvidiaApiKey         # Persist encrypted key to registry
New-NemoClawFolder        # Create Desktop\NemoClaw if missing
Build-NemoClawImage       # docker build with Dockerfile
Start-NemoClawContainer   # docker run with volume mount + env var + port
Test-DashboardReady       # HTTP poll loop
Install-NemoClawContainer # Orchestrator that calls the above in sequence
Show-ContainerBanner      # Green success banner
```

### Pattern 1: API Key Registry Persistence with DPAPI

**What:** Store NVIDIA API key encrypted in registry using Windows DPAPI via SecureString
**When to use:** Any time a secret needs to persist across script runs for the same Windows user

```powershell
# Store (encrypt with DPAPI -- only current user on this machine can decrypt)
function Save-NvidiaApiKey {
    param([SecureString]$ApiKey)
    $encrypted = ConvertFrom-SecureString -SecureString $ApiKey
    if (-not (Test-Path $script:RegPath)) {
        New-Item -Path $script:RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $script:RegPath -Name ApiKey -Value $encrypted
}

# Retrieve and decrypt
function Get-NvidiaApiKey {
    try {
        $encrypted = (Get-ItemProperty -Path $script:RegPath -Name ApiKey -ErrorAction Stop).ApiKey
        $secure = ConvertTo-SecureString -String $encrypted
        # Convert to plaintext for docker -e
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    } catch {
        $null
    }
}
```

**Confidence:** HIGH -- ConvertFrom-SecureString without -Key parameter uses DPAPI by default (verified via Microsoft docs).

### Pattern 2: Docker Build with Inline Dockerfile

**What:** Generate Dockerfile content in PowerShell and pipe to docker build via stdin
**When to use:** When the Dockerfile is tightly coupled to the installer script and doesn't warrant a separate file

```powershell
# Option A: Separate Dockerfile in windows/ directory (recommended for clarity)
docker build -t nemoclaw -f "$PSScriptRoot\Dockerfile.nemoclaw" "$PSScriptRoot\.."

# Option B: Heredoc-style via stdin (avoids extra file)
@"
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY install.sh /tmp/install.sh
RUN chmod +x /tmp/install.sh && NEMOCLAW_NON_INTERACTIVE=1 /tmp/install.sh --non-interactive
EXPOSE 18789
"@ | docker build -t nemoclaw -f - "$PSScriptRoot\.."
```

**Recommendation:** Use a separate `windows/Dockerfile.nemoclaw` file. It is easier to read, debug, and test. The build context should be the project root so `COPY install.sh` works.

### Pattern 3: Container Cleanup Before Rebuild

**What:** Stop and remove existing container before building fresh
**When to use:** Every run -- ensures clean slate per CONTEXT.md decision

```powershell
function Remove-ExistingContainer {
    $existing = docker ps -a --filter "name=nemoclaw" --format "{{.Names}}" 2>&1
    if ($existing -eq "nemoclaw") {
        Write-Info "Removing existing nemoclaw container..."
        docker stop nemoclaw 2>&1 | Out-Null
        docker rm nemoclaw 2>&1 | Out-Null
    }
}
```

### Pattern 4: Volume Mount Path on Windows

**What:** Bind-mount a Windows host directory into a Linux container
**When to use:** Desktop\NemoClaw shared folder

```powershell
$desktopPath = [Environment]::GetFolderPath("Desktop")
$sharedFolder = Join-Path $desktopPath "NemoClaw"
# Docker Desktop with WSL2 backend accepts native Windows paths
docker run -v "${sharedFolder}:/home/nemoclaw/shared" ...
```

**Key finding:** Docker Desktop with WSL2 backend automatically shares all Windows drives -- no manual file sharing configuration needed. Native Windows paths (e.g., `C:\Users\john\Desktop\NemoClaw`) work directly in `-v` flags.

**Confidence:** HIGH -- Docker official docs confirm WSL2 mode auto-shares all Windows files.

### Pattern 5: Health Check Polling Loop

**What:** Poll HTTP endpoint with spinner until dashboard responds
**When to use:** After container starts, before declaring success

```powershell
function Test-DashboardReady {
    param([int]$TimeoutSeconds = 180, [int]$IntervalSeconds = 5)
    $elapsed = 0
    $spinChars = @('|', '/', '-', '\')
    while ($elapsed -lt $TimeoutSeconds) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:18789" -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -eq 200) {
                Write-Host ""
                return $true
            }
        } catch {
            # Connection refused or timeout -- keep polling
        }
        $char = $spinChars[($elapsed / $IntervalSeconds) % $spinChars.Length]
        Write-Host "`r$char Waiting for OpenClaw dashboard... (${elapsed}s / ${TimeoutSeconds}s)" -NoNewline
        Start-Sleep -Seconds $IntervalSeconds
        $elapsed += $IntervalSeconds
    }
    Write-Host ""
    return $false
}
```

### Anti-Patterns to Avoid
- **Using `docker exec` instead of Dockerfile RUN for install.sh:** Build-time execution is reproducible and cacheable; exec at runtime means every restart re-runs the install
- **Storing API key in plaintext in registry:** DPAPI encryption is trivial to use and prevents casual exposure
- **Hardcoding Desktop path as `C:\Users\$env:USERNAME\Desktop`:** Use `[Environment]::GetFolderPath("Desktop")` which respects OneDrive folder redirection and localized Windows
- **Using `-AsPlainText` on ConvertFrom-SecureString:** Only available in PowerShell 7+; the Marshal approach works on both 5.1 and 7+

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| API key encryption | Custom crypto | ConvertFrom-SecureString (DPAPI) | Windows built-in, user-scoped, no key management |
| Desktop folder path | String concatenation with $env:USERPROFILE | `[Environment]::GetFolderPath("Desktop")` | Handles OneDrive redirection, localized Windows |
| Container existence check | Parsing `docker ps` text output | `docker ps -a --filter "name=nemoclaw" --format "{{.Names}}"` | Structured output, no regex needed |
| HTTP health check | Raw TCP socket test | Invoke-WebRequest -UseBasicParsing | Validates actual HTTP 200 response, not just port open |

## Common Pitfalls

### Pitfall 1: Desktop Path on OneDrive-synced systems
**What goes wrong:** `$env:USERPROFILE\Desktop` doesn't exist because OneDrive moves Desktop to `$env:USERPROFILE\OneDrive\Desktop`
**Why it happens:** Windows OneDrive folder protection (enabled by default on many systems) redirects known folders
**How to avoid:** Always use `[Environment]::GetFolderPath("Desktop")` -- it returns the actual current Desktop path
**Warning signs:** "Path not found" errors on machines with OneDrive

### Pitfall 2: install.sh requires curl, git, and ca-certificates
**What goes wrong:** install.sh fails inside a bare ubuntu:22.04 because curl/git are not installed
**Why it happens:** ubuntu:22.04 is minimal -- no curl, no git, no ca-certificates
**How to avoid:** Dockerfile must `apt-get install curl git ca-certificates` before running install.sh
**Warning signs:** "curl: command not found" or SSL certificate errors during build

### Pitfall 3: PowerShell 5.1 SecureString compatibility
**What goes wrong:** Using `ConvertFrom-SecureString -AsPlainText` which is PowerShell 7+ only
**Why it happens:** Developer tests on PowerShell 7 but users run Windows PowerShell 5.1
**How to avoid:** Use the Marshal BSTR approach for converting SecureString to plaintext (works on all versions)
**Warning signs:** "A parameter cannot be found that matches parameter name 'AsPlainText'" error

### Pitfall 4: Docker build context must include install.sh
**What goes wrong:** `COPY install.sh /tmp/install.sh` fails with "file not found"
**Why it happens:** Build context doesn't include the project root where install.sh lives
**How to avoid:** Set build context to project root: `docker build -t nemoclaw -f windows/Dockerfile.nemoclaw .`
**Warning signs:** "COPY failed: file not found in build context"

### Pitfall 5: Phase 1 removes registry key on completion
**What goes wrong:** Phase 1's `Remove-InstallStage` deletes the entire `HKCU:\Software\NemoClaw` key including any Phase 2 data stored there
**Why it happens:** Phase 1 calls `Remove-Item -Path $script:RegPath -Recurse` which wipes everything under NemoClaw
**How to avoid:** Phase 2 must either (a) store ApiKey BEFORE Phase 1 cleanup runs (unlikely), or (b) Phase 1's cleanup should only remove the InstallStage property, not the entire key. Since Phase 1 is already complete, Phase 2 should recreate the key if needed -- `Save-NvidiaApiKey` already handles this with `New-Item -Force`.
**Warning signs:** API key disappears after Phase 1 completes on a fresh install

### Pitfall 6: Container port not immediately available
**What goes wrong:** `Invoke-WebRequest` fails with connection refused right after `docker run`
**Why it happens:** NemoClaw inside the container needs time to start its web server
**How to avoid:** The 180-second polling loop with 5-second intervals handles this gracefully
**Warning signs:** Immediate failure without retry

### Pitfall 7: Non-root user and file permissions on mounted volume
**What goes wrong:** Container process can't write to /home/nemoclaw/shared
**Why it happens:** Volume is mounted as root:root but container runs as non-root user
**How to avoid:** Either run as root inside the container (simpler, acceptable for local dev tool) or ensure the mount point permissions are set correctly. Running as root is the simpler choice since this is a local development tool, not a production server.
**Warning signs:** "Permission denied" when writing to shared folder

## Code Examples

### Dockerfile.nemoclaw (Recommended)

```dockerfile
# NemoClaw Windows installer -- container image
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies needed by install.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Copy and run the NemoClaw installer
COPY install.sh /tmp/install.sh
RUN chmod +x /tmp/install.sh \
    && NEMOCLAW_NON_INTERACTIVE=1 /tmp/install.sh --non-interactive

EXPOSE 18789
```

**Notes:**
- `DEBIAN_FRONTEND=noninteractive` suppresses apt prompts
- `--no-install-recommends` minimizes image size
- `rm -rf /var/lib/apt/lists/*` cleans apt cache in same layer
- install.sh is run at build time so the image is ready to use
- Build context must be project root so `COPY install.sh` resolves

### Registry State Machine Extension

Phase 2 should extend the state machine with new stages:

```
# Phase 1 stages (already complete):
#   (null) -> VERSION_OK -> WSL_ENABLED -> DOCKER_INSTALLED -> DOCKER_CONFIGURED -> DOCKER_READY -> (deleted)
#
# Phase 2 stages:
#   (null/DOCKER_READY) -> API_KEY_STORED -> IMAGE_BUILT -> CONTAINER_RUNNING -> DASHBOARD_READY -> (deleted)
```

Phase 2 orchestrator picks up after Phase 1 is complete (DOCKER_READY or null).

### Complete Docker Run Command

```powershell
$apiKey = Get-NvidiaApiKey
$desktopPath = [Environment]::GetFolderPath("Desktop")
$sharedFolder = Join-Path $desktopPath "NemoClaw"

docker run -d `
    --name nemoclaw `
    -p 18789:18789 `
    -v "${sharedFolder}:/home/nemoclaw/shared" `
    -e "NVIDIA_API_KEY=$apiKey" `
    nemoclaw
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hyper-V file sharing (manual config) | WSL2 auto-shares all Windows drives | Docker Desktop 2.3+ (2020) | No file sharing setup needed |
| `docker exec` post-run installs | Dockerfile RUN at build time | Docker best practice | Reproducible, cacheable builds |
| Plaintext secrets in env files | DPAPI-encrypted registry values | Windows built-in | User-scoped encryption with no key management |

## Open Questions

1. **What entrypoint/CMD should the container use?**
   - What we know: install.sh installs NemoClaw and runs onboard. The existing Dockerfile uses `ENTRYPOINT ["/bin/bash"]`. The dashboard needs to be running on port 18789.
   - What's unclear: What command actually starts the OpenClaw dashboard server? The existing Dockerfile references `nemoclaw-start.sh` script. install.sh's `run_onboard` runs `nemoclaw onboard` which may start the server.
   - Recommendation: Investigate what command starts the dashboard. Likely `nemoclaw onboard --non-interactive` or a dedicated start command. The Dockerfile CMD or container entrypoint must launch this.

2. **Should Phase 1's Remove-InstallStage be patched?**
   - What we know: Phase 1 deletes the entire `HKCU:\Software\NemoClaw` registry key. Phase 2 stores ApiKey under the same key.
   - What's unclear: Whether Phase 1 and Phase 2 run in the same script invocation (in which case the key is recreated by Phase 2) or separately.
   - Recommendation: Phase 2 should handle the key not existing gracefully. `Save-NvidiaApiKey` already creates the key if missing. No Phase 1 patch needed.

3. **Does install.sh's `run_onboard` work fully in non-interactive mode?**
   - What we know: `NON_INTERACTIVE=1` triggers `nemoclaw onboard --non-interactive` (install.sh line 279-280). The CONTEXT.md confirms non-interactive mode is supported.
   - What's unclear: Whether `--non-interactive` onboard requires the NVIDIA_API_KEY to be pre-configured or if it skips API key setup entirely.
   - Recommendation: Test during implementation. If onboard needs the API key, it should be available via the `-e NVIDIA_API_KEY` environment variable passed at runtime, but install.sh runs at build time. May need to split: install at build time, onboard at runtime.

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
| SETUP-01 | Named ubuntu container with port 18789 | unit (mock docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-01" -CI` | No -- Wave 0 |
| SETUP-02 | Desktop/NemoClaw folder creation and mount | unit (mock filesystem + docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-02" -CI` | No -- Wave 0 |
| SETUP-03 | API key prompt, persist, and pass to container | unit (mock Read-Host, registry, docker) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-03" -CI` | No -- Wave 0 |
| SETUP-04 | install.sh runs non-interactively | unit (verify Dockerfile content/docker build args) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-04" -CI` | No -- Wave 0 |
| SETUP-05 | Health check and dashboard reachability | unit (mock Invoke-WebRequest) | `Invoke-Pester ./windows/tests/Install.Tests.ps1 -Tag "SETUP-05" -CI` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `Invoke-Pester ./windows/tests/Install.Tests.ps1 -CI`
- **Per wave merge:** `Invoke-Pester ./windows/tests/ -CI`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `windows/tests/Install.Tests.ps1` -- add SETUP-01 through SETUP-05 test blocks (extend existing file)
- [ ] New functions must follow `$env:NEMOCLAW_TESTING` guard pattern for safe dot-sourcing
- [ ] Dockerfile.nemoclaw -- needs to exist before docker build tests can verify its content

## Sources

### Primary (HIGH confidence)
- `windows/install.ps1` -- Phase 1 implementation (read directly), establishes all reusable patterns
- `install.sh` lines 278-353 -- Non-interactive mode confirmed working with `--non-interactive` flag and `NEMOCLAW_NON_INTERACTIVE` env var
- `Dockerfile` (project root) -- Existing container pattern showing OpenClaw/NemoClaw setup approach
- [Docker Desktop WSL2 docs](https://docs.docker.com/desktop/features/wsl/) -- WSL2 auto-shares Windows drives
- [ConvertFrom-SecureString docs](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring?view=powershell-7.5) -- DPAPI encryption default
- [Docker build best practices](https://docs.docker.com/build/building/best-practices/) -- Layer caching, apt cleanup

### Secondary (MEDIUM confidence)
- [Docker build context docs](https://docs.docker.com/build/concepts/context/) -- Build context behavior verified
- [SecureString working patterns](https://igeorgiev.eu/powershell/working-with-secure-string/) -- Marshal BSTR approach for PS 5.1 compat
- [DPAPI registry storage](https://taswar.zeytinsoft.com/powershell-using-dpapi-to-store-secure-data-in-registry/) -- Registry + DPAPI pattern

### Tertiary (LOW confidence)
- Open question on what command starts the OpenClaw dashboard (needs validation during implementation)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- All tools (Docker CLI, PowerShell, Pester) already established in Phase 1
- Architecture: HIGH -- Patterns follow Phase 1 conventions; Docker build approach is standard
- Pitfalls: HIGH -- Common Windows Docker pitfalls are well-documented; SecureString compat verified via MS docs
- Dockerfile contents: MEDIUM -- install.sh non-interactive mode confirmed but entrypoint/CMD for dashboard server needs validation

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (30 days -- stable technologies)
