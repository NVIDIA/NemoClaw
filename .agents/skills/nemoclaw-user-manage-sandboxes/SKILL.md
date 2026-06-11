---
name: "nemoclaw-user-manage-sandboxes"
description: "Explains operational tasks after the quickstart: listing sandboxes, status and health checks, logs, diagnostics, port forwards, multiple sandboxes, credential reset, rebuilds, network presets, upgrades, and uninstall. Trigger keywords - manage nemoclaw sandboxes, nemoclaw status, nemoclaw list, nemoclaw dashboard port, nemoclaw rebuild, nemoclaw upgrade sandboxes, nemoclaw uninstall, sandbox mutability, sandbox runtime configuration, sandbox rebuild, nemoclaw backup, nemoclaw restore, workspace backup, openshell sandbox download upload, nemoclaw messaging channels, nemoclaw telegram, nemoclaw discord, nemoclaw slack, nemoclaw wechat, nemoclaw whatsapp, openshell channel messaging, install hermes plugins, hermes plugins nemoclaw, nemoclaw hermes plugins, nemohermes dockerignore, nemoclaw workspace files, soul.md, user.md, identity.md, agents.md, sandbox persistence."
license: "Apache-2.0"
---

# Manage Sandbox Lifecycle

import { AgentOnly } from "../_components/AgentGuide";

<AgentOnly variant="openclaw">
Use this guide after you finish the OpenClaw quickstart (use the `nemoclaw-user-get-started` skill).
</AgentOnly>
<AgentOnly variant="hermes">
Use this guide after you finish Quickstart with Hermes (use the `nemoclaw-user-get-started` skill).
</AgentOnly>
It covers day-two sandbox operations such as listing sandboxes, checking health, managing ports, rebuilding safely, upgrading, and uninstalling.
<AgentOnly variant="openclaw">
When a workflow uses the lower-level OpenShell CLI, see CLI Selection Guide (use the `nemoclaw-user-reference` skill) for the boundary between `nemoclaw` and `openshell`.
</AgentOnly>
<AgentOnly variant="hermes">
When a workflow uses the lower-level OpenShell CLI, see CLI Selection Guide (use the `nemoclaw-user-reference` skill) for the boundary between `nemoclaw`, `nemoclaw`, and `openshell`.
</AgentOnly>

## List Sandboxes

List every sandbox registered on this host:

```bash
nemoclaw list
```

The list shows each sandbox's model, provider, policy presets, active SSH session indicator, and dashboard URL when NemoClaw records a dashboard port.
Use JSON output for scripts:

```bash
nemoclaw list --json
```

## Check Sandbox Health

Check a specific sandbox's health, inference route, active connections, live policy, update status, and messaging-channel overlap warnings:

```bash
nemoclaw my-assistant status
```

Use the host-level status command when you want the sandbox inventory plus host auxiliary service state, such as cloudflared:

```bash
nemoclaw status
```

## Inspect Logs

View recent sandbox logs:

```bash
nemoclaw my-assistant logs
```

Stream logs while you reproduce a problem:

```bash
nemoclaw my-assistant logs --follow
```

<AgentOnly variant="openclaw">
The log command reads both OpenClaw gateway output and OpenShell audit events, so policy denials appear beside gateway logs.
</AgentOnly>
<AgentOnly variant="hermes">
The log command reads both Hermes gateway output and OpenShell audit events, so policy denials appear beside gateway logs.
</AgentOnly>

## Collect Diagnostics

Collect diagnostics for bug reports or support handoff:

```bash
nemoclaw debug --sandbox my-assistant --output nemoclaw-debug.tar.gz
```

Use `--quick` for a smaller local summary:

```bash
nemoclaw debug --quick --sandbox my-assistant
```

The debug command gathers system information, Docker state, gateway logs, and sandbox status.

## Manage Dashboard Ports

If the forward stopped, or the installer reported that no active forward was found and the URL does not load, restart it manually with the port from the install summary.

```bash
openshell forward start --background <dashboard-port> my-gpt-claw
```

To list active forwards across all sandboxes, run the following command.

```bash
openshell forward list
```

## Run Multiple Sandboxes

Each sandbox needs its own dashboard port, since `openshell forward` refuses to bind a port that another sandbox is already using.
<AgentOnly variant="openclaw">
When the default port is already held by another sandbox, `nemoclaw onboard` scans ports `18789` through `18799` and uses the next free port.
</AgentOnly>
<AgentOnly variant="hermes">
When the default API port is already held by another sandbox, `nemoclaw onboard` scans for the next free port and records it for the sandbox.
</AgentOnly>
If you intentionally run separate OpenShell gateways on the same host, set a different `NEMOCLAW_GATEWAY_PORT` before each onboarding run.
NemoClaw isolates the gateway name and local state by port so one port-specific gateway does not replace another.
Gateway and dashboard cleanup is scoped by sandbox name and port.
A later onboarding run that uses a different `NEMOCLAW_GATEWAY_PORT` or `--control-ui-port` does not tear down the first sandbox's gateway or dashboard forward.

```bash
nemoclaw onboard                                      # first sandbox uses 18789
nemoclaw onboard                                      # second sandbox uses the next free port, such as 18790
```

To choose a specific port, pass `--control-ui-port`:

```bash
nemoclaw onboard --control-ui-port 19000
```

You can also set `CHAT_UI_URL` or `NEMOCLAW_DASHBOARD_PORT` before onboarding:

```bash
CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard
NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

For full details on port conflicts and overrides, refer to Port already in use (use the `nemoclaw-user-reference` skill).

## Reconfigure or Recover

Recover from a misconfigured sandbox without re-running the full onboard wizard or destroying workspace state.

### Change Inference Model or API

Change the active model or provider at runtime without rebuilding the sandbox:

```bash
nemoclaw inference set --model <model> --provider <provider>
```

Refer to Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) for provider-specific model IDs and API compatibility notes.

### Restart the Gateway and Port Forward

<AgentOnly variant="openclaw">
If `nemoclaw <name> status` reports the sandbox is alive but the gateway is not running, run the recover command instead of opening a shell.
</AgentOnly>
<AgentOnly variant="hermes">
If `nemoclaw <name> status` reports the sandbox is alive but the Hermes gateway is not running, run the recover command instead of opening a shell.
</AgentOnly>

```bash
nemoclaw <sandbox-name> recover
```

The command restarts the in-sandbox gateway and re-establishes the dashboard port-forward in one step.
It is idempotent and safe to script.
Refer to `nemoclaw <name> recover` (use the `nemoclaw-user-reference` skill) for details.

### Reset a Stored Credential

If you entered a provider credential incorrectly during onboarding, clear the gateway-registered value and re-enter it on the next onboard run:

```bash
nemoclaw credentials list                # see which providers are registered
nemoclaw credentials reset <PROVIDER>    # clear a single provider, for example nvidia-prod
nemoclaw onboard                         # re-run to re-enter the cleared provider
```

The command reference documents `nemoclaw credentials reset <PROVIDER>` (use the `nemoclaw-user-reference` skill) in full.

### Rebuild a Sandbox While Preserving Workspace State

<AgentOnly variant="openclaw">
If you changed the underlying Dockerfile, upgraded OpenClaw, or want to pick up a new base image without losing your sandbox's workspace files, use `rebuild` instead of destroying and recreating:
</AgentOnly>
<AgentOnly variant="hermes">
If you changed the underlying Dockerfile, upgraded Hermes, or want to pick up a new base image without losing your sandbox's state files, use `rebuild` instead of destroying and recreating:
</AgentOnly>

```bash
nemoclaw <sandbox-name> rebuild
```

Rebuild preserves the mounted workspace and registered policies while recreating the container.
If NemoClaw cannot archive any requested state path, it reports the backup failure and stops before deleting the original sandbox.
Refer to `nemoclaw <name> rebuild` (use the `nemoclaw-user-reference` skill) for flag details.

### Add a Network Preset After Onboarding

Apply an additional preset, such as Telegram or GitHub, to a running sandbox without re-onboarding:

```bash
nemoclaw <sandbox-name> policy-add
```

Refer to `nemoclaw <name> policy-add` (use the `nemoclaw-user-reference` skill) for usage details and flags.

Non-interactive re-onboards in the default `suggested` policy mode preserve presets added this way.
To make a re-onboard authoritative, set `NEMOCLAW_POLICY_MODE=custom` and provide `NEMOCLAW_POLICY_PRESETS` with the exact list to apply; onboarding removes anything else.
See `NEMOCLAW_POLICY_MODE` (use the `nemoclaw-user-reference` skill) for the full table.

## Update to the Maintained Version

When a maintained NemoClaw release becomes available, update the host CLI and then check whether existing sandboxes need rebuilds.
The standard installer follows the admin-promoted `lkg` release tag by default.
If you need a specific release, set `NEMOCLAW_INSTALL_TAG` on the `bash` side of the install pipeline.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_INSTALL_TAG=v0.0.63 bash
nemoclaw upgrade-sandboxes --check
```

Before upgrade work, the installer runs `nemoclaw backup-all` when the installed CLI supports it.
For manual upgrade flows, create a snapshot first and then run the update or rebuild command you need:

```bash
nemoclaw <sandbox-name> snapshot create --name pre-upgrade
nemoclaw update --yes
nemoclaw upgrade-sandboxes --check
```

Each rebuild destroys the old container and creates a new one, while preserving the manifest-defined workspace or agent state that NemoClaw knows how to snapshot.
`upgrade-sandboxes --check` can report a sandbox as stale because the running agent version is behind, because the managed NemoClaw image fingerprint differs from the current CLI, or both.
Custom-image sandboxes created with `--from <Dockerfile>` are not marked stale solely by image fingerprint, so an upgrade check does not accidentally replace them with the default image.
Runtime changes outside those state paths, such as packages installed manually in the running container, are not preserved.
For the full state-preservation contract, snapshot restore behavior, and manual backup workflow, refer to [Backup and Restore](references/backup-restore.md).
For command flags, refer to `nemoclaw update` (use the `nemoclaw-user-reference` skill), `nemoclaw upgrade-sandboxes` (use the `nemoclaw-user-reference` skill), and `nemoclaw <name> rebuild` (use the `nemoclaw-user-reference` skill).

## Uninstall

To remove NemoClaw and all resources created during setup, run the CLI's built-in uninstall command:

```bash
nemoclaw uninstall
```

| Flag               | Effect                                               |
|--------------------|------------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                        |
| `--keep-openshell` | Leave OpenShell binaries installed.                  |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

**Note:**

The uninstall command preserves `~/.nemoclaw/rebuild-backups/` (host-side snapshots that snapshot and `backup-all` commands write), `~/.nemoclaw/backups/` (workspace backups that `scripts/backup-workspace.sh` writes), and `~/.nemoclaw/sandboxes.json` (the sandbox registry) by default.
Uninstall removes every other entry under `~/.nemoclaw/`.
Interactive runs prompt before they remove the preserved entries; the default answer keeps them.
For non-interactive runs (`--yes`, `NEMOCLAW_NON_INTERACTIVE=1`, or a non-TTY shell), set `NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1` to acknowledge data loss and remove the preserved entries as well.
See the Commands reference (use the `nemoclaw-user-reference` skill) for the full preservation contract.

The CLI uninstall command runs the version-pinned `uninstall.sh` that shipped with your installed CLI, so it does not fetch anything over the network at uninstall time.

If the CLI is missing or broken, fall back to the hosted script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

The same `--yes`, `--keep-openshell`, and `--delete-models` flags listed above also apply to the hosted script. Pass them after `bash -s --`.

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash -s -- --yes --delete-models
```

For a full comparison of the two forms, including what they fetch, what they trust, and when to prefer each, refer to `nemoclaw uninstall` vs. the hosted `uninstall.sh` (use the `nemoclaw-user-reference` skill).

## References

- **[references/runtime-controls.md](references/runtime-controls.md)** — Single page that answers what can change at runtime versus what requires a rebuild for NemoClaw sandboxes.
- **Load [references/backup-restore.md](references/backup-restore.md)** when downloading workspace files from a sandbox, uploading restored files into a new sandbox, or preserving sandbox state across rebuilds. Backs up and restores OpenClaw workspace files before destructive operations such as sandbox rebuilds.
- **Load [references/messaging-channels.md](references/messaging-channels.md)** when setting up messaging channels, chat interfaces, or integrations without relying on nemoclaw tunnel start for bridges. Explains how Telegram, Discord, Slack, WeChat, and WhatsApp reach sandboxed OpenClaw and Hermes agents through OpenShell-managed processes and NemoClaw channel commands.
- **Load [references/install-plugins-hermes.md](references/install-plugins-hermes.md)** when users ask how to install, build, or configure Hermes plugins under NemoClaw. Explains how to install Hermes plugins in NemoClaw-managed sandboxes, including custom Dockerfile build-directory layout and `.dockerignore` handling.
- **Load [references/workspace-files.md](references/workspace-files.md)** when users ask about `SOUL.md`, `USER.md`, `IDENTITY.md`, `AGENTS.md`, or other workspace files, or when preparing to back up or restore workspace state. Explains what workspace personality and configuration files are, where they live, and how they persist across sandbox restarts.

## Related Skills

- [Set Up Messaging Channels](references/messaging-channels.md) to connect Telegram, Discord, or Slack.
- [Workspace Files](references/workspace-files.md) for persistent OpenClaw files inside the sandbox.
- [Backup and Restore](references/backup-restore.md) for snapshot and restore workflows.
- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) for observability tools
