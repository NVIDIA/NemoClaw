# Domain Pitfalls

**Domain:** Windows PowerShell Docker installer for NemoClaw
**Researched:** 2026-03-20

## Critical Pitfalls

Mistakes that cause the installer to fail entirely or require a full restart of the setup process.

### Pitfall 1: Multi-Reboot WSL2/Docker Desktop Installation Sequence

**What goes wrong:** Docker Desktop requires WSL2 as a backend. On a clean Windows 10/11 machine, WSL2 may not be enabled, Hyper-V may not be active, and the WSL kernel may need an update. Enabling these features requires one or more reboots. A naive script that tries to install Docker Desktop and immediately run `docker run` will fail silently or with cryptic errors because the WSL2 backend is not ready.

**Why it happens:** The installer script assumes a single-pass execution model (like the Linux `install.sh`), but Windows prerequisite setup is inherently multi-stage with reboots between stages.

**Consequences:** User runs the script, it appears to install Docker Desktop, then fails when trying to create the container. User has no idea they need to reboot and re-run. They assume the installer is broken.

**Prevention:**
- Detect WSL2 status at script start with `wsl --status` or checking for `wslconfig`
- If WSL2 is not enabled, enable it (`wsl --install --no-distribution`), inform the user a reboot is required, and register a RunOnce registry entry or scheduled task to resume after reboot
- Alternatively, implement a state machine: the script checks "where did we leave off?" on each invocation and resumes from that point
- Store installation state in a file (e.g., `$env:LOCALAPPDATA\NemoClaw\install-state.json`)

**Detection:** Test on a fresh Windows VM with no WSL2 or Docker pre-installed.

**Phase:** Phase 1 (core installer logic) -- this is the foundational flow that everything else depends on.

---

### Pitfall 2: PowerShell Execution Policy Blocks Script Startup

**What goes wrong:** Windows ships with PowerShell execution policy set to `Restricted` by default. When a user downloads and double-clicks or runs the `.ps1` file, they get: `"cannot be loaded because running scripts is disabled on this system"`. The script never executes a single line.

**Why it happens:** Windows security defaults prevent unsigned PowerShell scripts from running. Most Windows users have never changed this setting.

**Consequences:** The script is DOA for the exact audience it targets (Windows users without developer tooling experience). They see a scary security error and give up.

**Prevention:**
- Provide a one-line launcher command (not a `.ps1` file to double-click): `powershell -ExecutionPolicy Bypass -File .\Install-NemoClaw.ps1`
- Better: provide a `.bat` or `.cmd` wrapper that calls PowerShell with `-ExecutionPolicy Bypass`
- Document the launcher command prominently -- it should be the primary install instruction
- Do NOT instruct users to globally change their execution policy with `Set-ExecutionPolicy` as this weakens system security
- Note: Group Policy can override even `-ExecutionPolicy Bypass` in corporate environments -- detect and warn

**Detection:** Test with default execution policy on a fresh Windows install.

**Phase:** Phase 1 -- if users cannot run the script, nothing else matters.

---

### Pitfall 3: CRLF Line Endings Break Shell Scripts Inside the Container

**What goes wrong:** When the repo is cloned on Windows, Git's default `core.autocrlf=true` setting converts LF to CRLF in all text files. If `install.sh` or `nemoclaw-start.sh` is bind-mounted or copied into the Ubuntu container with CRLF line endings, bash fails with `/bin/bash^M: bad interpreter: No such file or directory` or similar errors. The scripts are syntactically valid but contain invisible `\r` characters that break execution.

**Why it happens:** Git on Windows defaults to checking out files with Windows-style line endings. The existing `install.sh` and `scripts/nemoclaw-start.sh` use shebangs (`#!/usr/bin/env bash`) that become `#!/usr/bin/env bash\r` after CRLF conversion.

**Consequences:** The container starts but the entrypoint script fails immediately. Error messages about "bad interpreter" are confusing to non-technical users. This is especially insidious because the files look correct when opened in any Windows editor.

**Prevention:**
- Add a `.gitattributes` file to the repo: `*.sh text eol=lf` and `*.bash text eol=lf`
- In the PowerShell installer, run `dos2unix` or a PowerShell equivalent on any script files before copying them into the container
- When building the container image (not bind-mounting), use `RUN sed -i 's/\r$//'` on copied scripts as a safety net
- Do NOT rely on users having correct Git settings

**Detection:** Clone the repo on Windows with default Git settings, build/run the container, verify scripts execute.

**Phase:** Phase 1 -- this will silently break every Linux script the container tries to run.

---

### Pitfall 4: Docker Desktop Not Running (Daemon Not Started)

**What goes wrong:** Docker Desktop on Windows is a GUI application that must be explicitly started. Unlike Linux where `dockerd` runs as a system service, Docker Desktop does not auto-start by default. The script calls `docker run` and gets `error during connect: ... Is the docker daemon running?`.

**Why it happens:** After installing Docker Desktop (especially via silent install), the daemon does not start automatically until the user opens Docker Desktop GUI at least once. Even after first launch, auto-start is a setting that may be off.

**Consequences:** User sees a generic Docker connection error and doesn't know they need to open Docker Desktop first. The error message from Docker CLI is not user-friendly.

**Prevention:**
- Check if Docker daemon is responsive before attempting container operations: `docker info` or `docker ps`
- If daemon is not running, attempt to start Docker Desktop: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`
- Wait with a polling loop (with timeout) for the daemon to become responsive -- Docker Desktop can take 30-60 seconds to start on first launch
- Enable auto-start during silent install with the `--always-run-service` flag if available, or configure it post-install
- Provide a clear, specific error message: "Docker Desktop is not running. Starting it now... please wait."

**Detection:** Test the script after a fresh Docker Desktop install without manually opening Docker Desktop.

**Phase:** Phase 1 -- every Docker operation depends on the daemon being available.

---

### Pitfall 5: User Not in docker-users Group

**What goes wrong:** After Docker Desktop installation, only the installing user is added to the `docker-users` Windows group. If the script is installed by an admin but used by a regular user, or if the user logs in as a different account, Docker commands fail with "Access Denied" or "You are not allowed to use Docker."

**Why it happens:** Docker Desktop protects its named pipe, requiring group membership. The installer adds the current user, but a reboot/re-login is required for the group membership to take effect.

**Consequences:** Docker commands fail with a permission error that does not clearly explain the fix. Even if the user is added to the group, they must sign out and sign back in.

**Prevention:**
- After Docker Desktop install, explicitly verify group membership: `(Get-LocalGroupMember -Group "docker-users").Name`
- If current user is not in the group, add them: `Add-LocalGroupMember -Group "docker-users" -Member $env:USERNAME` (requires elevation)
- Warn the user that a sign-out/sign-in is required for group membership to take effect
- Combine this with the WSL2 reboot requirement to minimize the number of restarts

**Detection:** Install Docker Desktop as admin, then try to run the NemoClaw setup as a standard user.

**Phase:** Phase 1 -- prerequisite validation.

## Moderate Pitfalls

### Pitfall 6: Volume Mount Path Format Differences

**What goes wrong:** Windows paths (`C:\Users\Jane\Desktop\NemoClaw`) must be translated for Docker. The correct format depends on whether you are using WSL2 backend (which accepts `/mnt/c/Users/Jane/Desktop/NemoClaw`) or the Docker CLI on Windows (which accepts `C:\Users\Jane\Desktop\NemoClaw` directly but with quoting caveats). Using the wrong format results in an empty mount or a "no such file or directory" error inside the container.

**Why it happens:** Docker on Windows has gone through multiple path-handling generations. WSL2 backend behavior differs from the legacy Hyper-V backend. PowerShell string interpolation with backslashes adds another layer of confusion.

**Prevention:**
- Use PowerShell to construct the path and let Docker Desktop handle the translation: `-v "${desktopPath}:/home/sandbox/shared"`
- Always use double quotes around volume mount arguments in PowerShell to handle paths with spaces (e.g., `C:\Users\Jane Doe\Desktop\NemoClaw`)
- Verify the mount is working by checking for a known test file inside the container after creation
- Avoid hardcoding paths -- use `[Environment]::GetFolderPath('Desktop')` to get the actual Desktop path (which varies by locale and OneDrive redirection)

**Detection:** Test with a username containing spaces and on a system with OneDrive Desktop redirection.

**Phase:** Phase 2 (container setup and volume mounts).

---

### Pitfall 7: Port 18789 Already in Use or Blocked by Firewall

**What goes wrong:** The `-p 18789:18789` port mapping fails because another process is using port 18789 on the host, or Windows Firewall blocks the connection so the user cannot access `http://127.0.0.1:18789` in their browser even though the container is running.

**Why it happens:** Windows Defender Firewall prompts are easy to dismiss or deny. Corporate environments may have strict firewall policies. Other development tools or services may occupy the port.

**Prevention:**
- Before creating the container, check if the port is available: `Test-NetConnection -ComputerName 127.0.0.1 -Port 18789` or `Get-NetTCPConnection -LocalPort 18789`
- If the port is occupied, offer to use an alternative port and configure `PUBLIC_PORT` accordingly
- After container starts, add a Windows Firewall rule programmatically: `New-NetFirewallRule -DisplayName "NemoClaw Dashboard" -Direction Inbound -LocalPort 18789 -Protocol TCP -Action Allow`
- Bind to `0.0.0.0` not `127.0.0.1` in the Docker port mapping to avoid WSL2 networking quirks (use `-p 18789:18789` not `-p 127.0.0.1:18789:18789`)
- After container starts, poll `http://127.0.0.1:18789` to verify the dashboard is actually reachable and report success/failure clearly

**Detection:** Test with Windows Firewall enabled (default), and test with port 18789 pre-occupied by another process.

**Phase:** Phase 2 (container setup), Phase 3 (management commands -- status should check port health).

---

### Pitfall 8: Docker Desktop WSL2 Mirrored Networking Mode Breaks Port Forwarding

**What goes wrong:** WSL2 version 2.0+ introduced a `networkingMode=mirrored` option in `.wslconfig`. When this is enabled, Docker Desktop's port forwarding behavior changes and containers may not be accessible on `localhost` as expected. Some users enable this for other WSL2 workflows, breaking Docker port mappings silently.

**Why it happens:** WSL2's networking architecture changed significantly. The mirrored mode shares the Windows network stack with WSL2, which conflicts with Docker Desktop's own network management. GitHub issue microsoft/WSL#10494 documents this extensively.

**Prevention:**
- Check for `.wslconfig` with `networkingMode=mirrored` and warn the user
- Document that NemoClaw requires the default NAT networking mode
- In status/diagnostic output, include the WSL2 networking mode
- Consider adding a `--diagnose` flag that checks all networking prerequisites

**Detection:** Test with `networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`.

**Phase:** Phase 3 (diagnostics and status commands).

---

### Pitfall 9: Interactive Onboarding Inside Container Fails

**What goes wrong:** The existing `install.sh` calls `nemoclaw onboard` which is interactive (prompts for API key, preferences). When run inside a Docker container created by a PowerShell script, stdin may not be properly attached, causing the onboard process to hang or fail with "Interactive onboarding requires a TTY."

**Why it happens:** The Linux installer (`install.sh`) is designed to run directly in a user's terminal. The code at line 278-292 of `install.sh` shows it already handles piped stdin by trying `/dev/tty`, but inside a container created non-interactively, there may be no TTY at all.

**Prevention:**
- Collect the NVIDIA API key in the PowerShell script BEFORE creating the container (the PROJECT.md already specifies this)
- Pass the API key as an environment variable (`-e NVIDIA_API_KEY=...`) when creating the container
- Run `install.sh --non-interactive` inside the container (the flag exists at line 331)
- Set `NEMOCLAW_NON_INTERACTIVE=1` environment variable in the container
- Use the `nemoclaw-start.sh` entrypoint which handles config writing without interactive prompts

**Detection:** Run the container creation without `-it` flags and verify the full setup completes.

**Phase:** Phase 2 (container creation and NemoClaw setup).

---

### Pitfall 10: Antivirus Software Interferes with Docker Operations

**What goes wrong:** Windows Defender real-time protection or third-party antivirus (McAfee, Norton, etc.) scans files used by Docker, causing hangs, slowdowns, or outright blocks. Docker image pulls timeout, container filesystem operations crawl, or the Docker daemon process itself gets flagged as suspicious.

**Why it happens:** Docker's filesystem operations (layer extraction, volume mounts) create and modify many files rapidly, triggering real-time scanning. Some antivirus tools flag Docker's network operations (downloading image layers) as suspicious.

**Prevention:**
- Document that users may need to add Docker's data directory to antivirus exclusions
- In the installer, detect if common antivirus products are running and warn the user
- Add a timeout with a helpful message when Docker operations take longer than expected: "This is taking longer than usual. If you have antivirus software, it may be scanning Docker files."
- Do NOT programmatically disable antivirus -- just warn and document

**Detection:** Test with Windows Defender real-time protection enabled (which is the default).

**Phase:** Phase 1 (prerequisites check), Phase 3 (troubleshooting/diagnostics).

## Minor Pitfalls

### Pitfall 11: Desktop Folder Path Varies with OneDrive and Locale

**What goes wrong:** The PowerShell script assumes `$HOME\Desktop` is the Desktop path, but OneDrive may redirect it to `$HOME\OneDrive\Desktop` or `$HOME\OneDrive - CompanyName\Desktop`. Non-English Windows installations may use localized folder names.

**Prevention:**
- Use `[Environment]::GetFolderPath('Desktop')` which returns the actual Desktop path regardless of OneDrive redirection or locale
- Create the `NemoClaw` folder and verify it exists before passing it to Docker

**Phase:** Phase 2 (volume mount setup).

---

### Pitfall 12: Container Survives Script But NemoClaw Install Fails Silently

**What goes wrong:** The Docker container is created and running, but `install.sh` or `npm install -g` inside it fails (network timeout, npm registry issue, Node.js version mismatch). The container exists but NemoClaw is not functional. The user thinks setup succeeded because the PowerShell script finished.

**Prevention:**
- After running install inside the container, verify the installation: `docker exec <container> nemoclaw --version`
- Check the exit code of every `docker exec` command
- If installation fails, stop and remove the broken container, display the error, and suggest retry
- Consider building a pre-baked Docker image (via Dockerfile) instead of running `install.sh` inside a bare Ubuntu container -- this catches build failures at image-build time, not at user-install time

**Phase:** Phase 2 (container setup -- verification step).

---

### Pitfall 13: Container State Lost on Docker Desktop Update or Reset

**What goes wrong:** Docker Desktop updates can reset WSL2 distros or require re-accepting the license agreement. Users who click "Reset to factory defaults" in Docker Desktop settings lose all containers and images, including the NemoClaw setup.

**Prevention:**
- Store persistent data (API keys, configuration) in the bind-mounted Desktop folder, not only inside the container
- The start/stop/restart commands should detect if the container no longer exists and offer to re-create it
- Document that Docker Desktop updates may require re-running the installer

**Phase:** Phase 3 (management commands -- resilient start/stop/status).

---

### Pitfall 14: PowerShell Version Incompatibility

**What goes wrong:** Windows PowerShell 5.1 (ships with Windows 10/11) and PowerShell 7+ (installed separately) have subtle differences. Cmdlets like `Test-NetConnection`, `Get-LocalGroupMember`, and `Invoke-WebRequest` behave differently between versions. A script tested on PowerShell 7 may fail on 5.1.

**Prevention:**
- Target PowerShell 5.1 as the minimum (it is guaranteed to be present on Windows 10/11)
- Avoid PowerShell 7+ only features (ternary operators, null-coalescing, `&&`/`||` pipeline chaining)
- Test on both Windows PowerShell 5.1 and PowerShell 7
- Add `#Requires -Version 5.1` at the top of the script

**Phase:** Phase 1 -- affects every line of the script.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Prerequisites & Docker install | Multi-reboot WSL2 setup (#1) | State machine with resume-after-reboot |
| Prerequisites & Docker install | Execution policy blocks script (#2) | `.bat` wrapper with `-ExecutionPolicy Bypass` |
| Prerequisites & Docker install | User not in docker-users group (#5) | Explicit group check and add |
| Prerequisites & Docker install | PowerShell version differences (#14) | Target 5.1, test on both versions |
| Container creation & setup | CRLF line endings (#3) | `.gitattributes` with `eol=lf` for shell scripts |
| Container creation & setup | Docker daemon not running (#4) | Auto-start Docker Desktop with polling wait |
| Container creation & setup | Volume mount path format (#6) | Use `[Environment]::GetFolderPath()`, quote paths |
| Container creation & setup | Interactive onboard in container (#9) | `--non-interactive` flag, pass API key as env var |
| Container creation & setup | Silent install failure (#12) | Verify `nemoclaw --version` after setup |
| Management commands | Port blocked or occupied (#7) | Pre-check port, add firewall rule |
| Management commands | WSL2 mirrored networking (#8) | Detect and warn about `.wslconfig` |
| Management commands | Container lost on DD update (#13) | Detect missing container, offer re-create |
| All phases | Antivirus interference (#10) | Detect, warn, document exclusions |
| All phases | Desktop path varies (#11) | Use .NET API for Desktop path resolution |

## Sources

- [Docker Desktop Windows Install Docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Windows Permission Requirements](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)
- [Docker Antivirus Guidance](https://docs.docker.com/engine/security/antivirus/)
- [Microsoft: PowerShell Execution Policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)
- [Docker Desktop WSL2 Backend Docs](https://docs.docker.com/desktop/features/wsl/)
- [WSL2 Mirrored Networking Issue (microsoft/WSL#10494)](https://github.com/microsoft/WSL/issues/10494)
- [Docker for Windows: CRLF Line Endings](https://willi.am/blog/2016/08/11/docker-for-windows-dealing-with-windows-line-endings/)
- [Resolving Git Line Ending Issues in Docker Containers](https://gist.github.com/jonlabelle/70a87e6871a1138ac3031f5e8e39f294)
- [Docker Desktop Silent Install (SILENT INSTALL HQ)](https://silentinstallhq.com/docker-desktop-install-and-uninstall-powershell/)
- [Docker Desktop docker-users Group Issue (docker/for-win#868)](https://github.com/docker/for-win/issues/868)
- [WSL2 Port Forwarding Issues (docker/for-win#13182)](https://github.com/docker/for-win/issues/13182)
- [Windows Firewall and Docker Desktop (Docker Forums)](https://forums.docker.com/t/windows-defender-firewall-has-blocked-some-features-of-this-app/96881)
