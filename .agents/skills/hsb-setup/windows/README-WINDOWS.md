# Windows wrapper for SSH-native HSB Claude skill

This wrapper is for running Claude Code on Windows while executing the actual Holoscan Sensor Bridge workflow on a remote devkit over SSH.

## Files

- `profiles/example-env.ps1` - example environment settings
- `set-hsb-env.ps1` - loads your SSH settings into the current PowerShell session
- `run-hsb.cmd` - launches Claude Code with the environment preloaded from PowerShell
- `test-hsb-thor-ssh.ps1` - validates SSH reachability, sudo mode, Docker access, and remote workspace path

## Quick start

1. Copy `profiles/example-env.ps1` to `profiles/AgxThor-env.ps1`
2. Edit the variables for your host
3. In PowerShell:

```powershell
. .\set-hsb-env.ps1 -Profile AgxThor
.\test-hsb-thor-ssh.ps1
claude
```

Or use:

```cmd
run-hsb.cmd AgxThor
```

## Environment variables used by the skill

- `SSH_TARGET` - remote user and host, for example `nvidia@192.168.1.55`
- `REMOTE_ROOT` - directory on the remote machine where the repo will be cloned
- `REMOTE_SUDO` - `sudo`, `sudo -n`, or empty string
- `REMOTE_SSH_OPTS` - optional SSH options such as key path or strict host key settings
- `HSB_PLATFORM` - optional preset platform hint such as `AGX Thor`, `AGX Orin`, `DGX Spark`
- `HSB_REPO` - optional custom GitHub repository URL to clone. Defaults to `https://github.com/nvidia-holoscan/holoscan-sensor-bridge.git` if not set

## Authentication

The skill uses **key-based SSH authentication**. Your SSH key must be loaded in the agent or specified via `REMOTE_SSH_OPTS` (e.g., `-i ~/.ssh/my_key`).

## Notes

- The skill still prompts when required, but these variables reduce repetitive setup.
- `sudo -n` is best when passwordless sudo is already configured on the remote host.
- Keep `REMOTE_ROOT` on the remote host's local filesystem, not on a mounted network drive.
