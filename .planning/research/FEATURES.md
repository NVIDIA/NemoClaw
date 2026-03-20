# Feature Landscape

**Domain:** Windows PowerShell Docker installer for NemoClaw
**Researched:** 2026-03-20

## Table Stakes

Features users expect. Missing = product feels incomplete or broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Administrator privilege check and self-elevation | PowerShell scripts that install system software must run elevated; users expect automatic re-launch rather than a cryptic "access denied" | Low | Use `Start-Process -Verb RunAs` to self-elevate; detect with `[Security.Principal.WindowsPrincipal]` |
| WSL2 prerequisite detection and installation | Docker Desktop requires WSL2; if missing, the user is stuck with no clear path forward | Medium | `wsl --install` handles both the Windows feature and the kernel update on modern Win10/11; older builds need `dism.exe /online /enable-feature` for `Microsoft-Windows-Subsystem-Linux` and `VirtualMachinePlatform` separately, plus a kernel MSI |
| Docker Desktop detection, download, and silent install | The entire point of the script; users should not be redirected to a browser to download an EXE | Medium | Use `Invoke-WebRequest` to fetch installer, then `Start-Process -Wait -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2'`; handle the reboot-required case |
| Reboot handling with resume guidance | Enabling WSL2 or Hyper-V requires a reboot; if the script just dies, users think it failed | Medium | Detect when a reboot is pending (`Get-WindowsOptionalFeature` returns `RestartNeeded`), tell user to reboot and re-run, or use a RunOnce registry key for auto-resume |
| Docker daemon readiness polling | Docker Desktop takes 30-120 seconds to start after install; running `docker run` too early fails | Low | Poll `docker info` in a loop with timeout and progress dots; 120s timeout is reasonable |
| Container creation with port forwarding | Core requirement: OpenClaw dashboard on port 18789 must be accessible from host browser | Low | `docker run -d -p 18789:18789 ...`; straightforward Docker flag |
| Shared folder mount (Desktop/NemoClaw) | PROJECT.md explicitly requires this; users need a way to pass files into the container | Low | `docker run -v "$env:USERPROFILE\Desktop\NemoClaw:/home/sandbox/shared" ...`; create the host folder first with `New-Item -ItemType Directory -Force` |
| NVIDIA API key prompt during setup | Required for inference; without it the dashboard is useless | Low | `Read-Host -Prompt` or `Read-Host -AsSecureString` for the key; pass as `-e NVIDIA_API_KEY=...` to the container |
| Start / stop / restart / status commands | PROJECT.md requirement; users should not learn Docker CLI | Low | Subcommands in the same .ps1: `.\nemoclaw.ps1 start`, `stop`, `restart`, `status`; thin wrappers around `docker start/stop/restart/inspect` |
| Colored, prefixed console output | The existing install.sh uses `[INFO]`, `[WARN]`, `[ERROR]` with ANSI colors; Windows users expect the same clarity | Low | `Write-Host -ForegroundColor Cyan "[INFO]"` etc.; PowerShell supports this natively |
| Error handling with clear messages | If Docker fails to start or the network is down, users need actionable guidance, not a stack trace | Medium | `try/catch` around every external call; map common failures to plain-English messages with next steps |
| Idempotent re-runs | Users will run the script multiple times (after reboot, after errors, "just to be sure"); it must not break anything or duplicate work | Medium | Check each prerequisite before installing: `Get-Command docker`, `wsl --status`, `docker ps -a --filter name=nemoclaw`; skip steps that are already done |

## Differentiators

Features that set product apart. Not expected from a typical installer script, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Automatic browser launch to dashboard | After setup completes, open `http://localhost:18789` in the default browser; eliminates "now what?" moment | Low | `Start-Process "http://localhost:18789"` after confirming the gateway is responding |
| Desktop shortcut for management | Double-click to open a management menu (start/stop/status/open dashboard) without finding the script | Medium | Create a `.lnk` via `WScript.Shell` COM object pointing to `powershell.exe -File nemoclaw.ps1 menu`; place in `$env:USERPROFILE\Desktop` |
| Health check with dashboard URL output | `.\nemoclaw.ps1 status` shows running/stopped AND prints the dashboard URL with auth token if running | Low | Parse `docker inspect` for state + exec into container to read the gateway token from `openclaw.json` |
| Progress indicators during long operations | Docker Desktop download (~600MB) and container image pull are slow; show a progress bar or percentage | Low | `Invoke-WebRequest` supports `-OutFile` with `Write-Progress`; `docker pull` already streams progress |
| Automatic docker-users group membership | Docker Desktop requires the user to be in `docker-users` local group; most scripts miss this and users get permission errors | Low | `Add-LocalGroupMember -Group "docker-users" -Member $env:USERNAME -ErrorAction SilentlyContinue`; requires elevation |
| Log file for troubleshooting | Write all output to a log file alongside the script so users can share it when asking for help | Low | `Start-Transcript -Path "nemoclaw-install.log"` at the top; `Stop-Transcript` at the end |
| Container auto-start on boot | NemoClaw container starts when Docker Desktop starts (which can auto-start on login) | Low | `docker update --restart unless-stopped nemoclaw`; plus configure Docker Desktop auto-start via registry |
| Version check and update command | `.\nemoclaw.ps1 update` pulls latest container image and recreates the container | Medium | `docker pull` new image, `docker stop/rm` old container, `docker run` with same config; preserve the shared folder and API key |
| Uninstall command | Clean removal of container, image, and optionally the shared folder | Low | `.\nemoclaw.ps1 uninstall` runs `docker rm -f`, `docker rmi`, prompts before deleting Desktop folder |
| System requirements pre-check | Before doing anything, verify Windows version, RAM, disk space, virtualization support | Medium | `Get-ComputerInfo` for OS version, `Get-CimInstance Win32_ComputerSystem` for RAM, check `systeminfo` for virtualization; fail fast with clear message |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| GUI installer (WPF/WinForms) | Massive complexity increase for marginal benefit; PowerShell terminal is the right UX for a developer tool | Keep it as a single .ps1 file; add a desktop shortcut for post-install management |
| GPU passthrough / CUDA support | PROJECT.md explicitly marks this out of scope; WSL2 GPU passthrough is fragile and NemoClaw uses cloud inference via NVIDIA API key | Document that inference runs on NVIDIA cloud, not local GPU |
| Automatic Windows Updates or BIOS changes | Enabling virtualization in BIOS cannot be automated; Windows Update is dangerous to trigger from a script | Detect missing virtualization and print clear instructions for the user to enable it manually |
| Bundled Docker Desktop EXE in the repo | 600MB+ binary bloats the repo and goes stale immediately | Download at install time with checksum verification |
| WSL distro management beyond Docker | Installing/managing Ubuntu WSL distros directly; Docker Desktop handles its own WSL integration | Let Docker Desktop manage its own `docker-desktop` and `docker-desktop-data` WSL distros |
| Multi-container orchestration (docker-compose) | PROJECT.md specifies a single container; compose adds unnecessary complexity | Use plain `docker run`; single container is sufficient |
| Automatic NemoClaw updates inside the container | Explicitly out of scope per PROJECT.md; container should be immutable | Provide an `update` command that rebuilds the container from a fresh image |
| Interactive shell into the container | Users should not need to SSH/exec into the container for normal use | Expose everything through the dashboard and the management commands |
| Support for Windows Server | Docker Desktop does not support Windows Server; Docker Engine on Server is a different product with different semantics | Document Windows 10/11 Pro/Enterprise/Education as supported; Home edition for Linux containers only |

## Feature Dependencies

```
Administrator elevation → WSL2 installation → Docker Desktop installation
Docker Desktop installation → Docker daemon readiness polling → Container creation
Container creation → Port forwarding (18789)
Container creation → Shared folder mount (Desktop/NemoClaw)
Container creation → NVIDIA API key injection
Container creation → Start/stop/restart/status commands
Docker daemon readiness → Health check with URL output
Container creation → Automatic browser launch
Container creation → Desktop shortcut (needs container name)
Container creation → Auto-start on boot config
Container creation → Update command
Container creation → Uninstall command
```

## MVP Recommendation

Prioritize (Phase 1 - Core installer):
1. **Administrator privilege check and self-elevation** - gate everything else
2. **WSL2 prerequisite detection and installation** - Docker depends on it
3. **Docker Desktop detection, download, and silent install** - core dependency
4. **Reboot handling with resume guidance** - WSL2/Hyper-V enabling requires it
5. **Docker daemon readiness polling** - must wait before creating container
6. **Container creation with port forwarding + shared folder + API key** - the actual deliverable
7. **Start/stop/restart/status commands** - basic lifecycle management
8. **Idempotent re-runs** - users will re-run after reboot
9. **Error handling with clear messages** - without this, support burden is enormous
10. **Colored console output** - low effort, high polish

Prioritize (Phase 2 - Polish):
1. **Automatic browser launch to dashboard** - low effort, big UX win
2. **Health check with dashboard URL + token output** - makes status useful
3. **Automatic docker-users group membership** - prevents a common failure mode
4. **Log file for troubleshooting** - one line of PowerShell, huge support value
5. **System requirements pre-check** - fail fast before wasting user time
6. **Desktop shortcut** - discoverability for non-terminal users

Defer:
- **Container auto-start on boot**: nice-to-have, not essential for first release
- **Version check and update command**: needs a container image versioning strategy first
- **Uninstall command**: can be documented as manual Docker commands initially
- **Progress indicators**: `docker pull` already shows progress; `Invoke-WebRequest` progress is cosmetic

## Sources

- [Docker Desktop Windows Install Docs](https://docs.docker.com/desktop/setup/install/windows-install/)
- [Docker Desktop Silent Install Guide](https://silentinstallhq.com/docker-desktop-silent-install-how-to-guide/)
- [Automated Docker Desktop + WSL2 PowerShell Script (Gist)](https://gist.github.com/chamindac/6045561f84f8548b052f523114583d41)
- [Docker Desktop Unattended Install Discussion](https://forums.docker.com/t/unattended-install/46617)
- [Docker Desktop MSI Installer Docs](https://docs.docker.com/enterprise/enterprise-deployment/msi-install-and-configure/)
- [WSL Installation Guide (Microsoft)](https://learn.microsoft.com/en-us/windows/wsl/install)
- [Docker for Windows Unattended Install Issues](https://github.com/docker/for-win/issues/1322)
- [PowerShell Docker Module (Microsoft)](https://github.com/Microsoft/Docker-PowerShell)
