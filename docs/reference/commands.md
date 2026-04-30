---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description:
  main: "Full CLI reference for slash commands and standalone NemoClaw commands."
  agent: "Includes the full CLI reference for slash commands and standalone NemoClaw commands. Use when looking up a specific `nemoclaw` or `/nemoclaw` subcommand, flag, argument, or exit code."
keywords: ["nemoclaw cli commands", "nemoclaw command reference"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Commands

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes.
It is installed automatically by the installer (`curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`).

## `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw` | Show slash-command help and host CLI pointers |
| `/nemoclaw status` | Show sandbox and inference state |
| `/nemoclaw onboard` | Show onboarding status and reconfiguration guidance |
| `/nemoclaw eject` | Show rollback instructions for returning to the host installation |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw help`, `nemoclaw --help`, `nemoclaw -h`

Show the top-level usage summary and command groups.
Running `nemoclaw` with no arguments shows the same help output.

```console
$ nemoclaw help
```

### `nemoclaw --version`, `nemoclaw -v`

Print the installed NemoClaw CLI version.

```console
$ nemoclaw --version
```

### `nemoclaw onboard`

Run the interactive setup wizard (recommended for new installs).
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard [--non-interactive] [--resume] [--recreate-sandbox] [--from <Dockerfile>] [--name <sandbox>] [--agent <name>] [--control-ui-port <N>] [--yes-i-accept-third-party-software]
```

:::{warning}
For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.
:::

The installer detects existing sandbox sessions before onboarding and prints a warning if any are found.
To make the installer abort instead of continuing, set `NEMOCLAW_SINGLE_SESSION=1`:

```console
$ NEMOCLAW_SINGLE_SESSION=1 curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

The wizard prompts for a provider first, then collects the provider credential if needed.
Supported non-experimental choices include NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and compatible OpenAI or Anthropic endpoints.
Credentials are registered with the OpenShell gateway and never persisted to host disk. See [Credential Storage](../security/credential-storage.md) for details on inspection, rotation, and migration from earlier releases.
The legacy `nemoclaw setup` command is deprecated; use `nemoclaw onboard` instead.

After provider selection, the wizard prompts for a **policy tier** that controls the default set of network policy presets applied to the sandbox.
Three tiers are available:

| Tier | Description |
|------|-------------|
| Restricted | Base sandbox only. No third-party network access beyond inference and core agent tooling. |
| Balanced (default) | Full dev tooling and web search. Package installs, model downloads, and inference. No messaging platform access. |
| Open | Broad access across third-party services including messaging and productivity. |

After selecting a tier, the wizard shows a combined preset and access-mode screen where you can include or exclude individual presets and toggle each between read and read-write access.
For details on tiers and the presets each includes, see [Network Policies](network-policies.md#policy-tiers).

In non-interactive mode, set the tier with `NEMOCLAW_POLICY_TIER` (default: `balanced`):

```console
$ NEMOCLAW_POLICY_TIER=restricted nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

If you enable Brave Search during onboarding, NemoClaw currently stores the Brave API key in the sandbox's OpenClaw configuration.
That means the OpenClaw agent can read the key.
NemoClaw explores an OpenShell-hosted credential path first, but the current OpenClaw Brave runtime does not consume that path end to end yet.
Treat Brave Search as an explicit opt-in and use a dedicated low-privilege Brave key.

For non-interactive onboarding, you must explicitly accept the third-party software notice:

```console
$ nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

or:

```console
$ NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 nemoclaw onboard --non-interactive
```

To enable Brave Search in non-interactive mode, set:

```console
$ BRAVE_API_KEY=... \
  nemoclaw onboard --non-interactive
```

`BRAVE_API_KEY` enables Brave Search in non-interactive mode and also enables `web_fetch`.
If Brave Search key validation fails in non-interactive mode, onboarding prints a warning, skips web search setup, and continues with the rest of the sandbox setup.
After fixing the key, re-enable web search with `nemoclaw config web-search`.

The wizard prompts for a sandbox name.
Names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.
Names that match global CLI commands (`status`, `list`, `debug`, etc.) are rejected to avoid routing conflicts.
Use `--agent <name>` to target a specific installed agent profile during onboarding.

Use `--control-ui-port <N>` to choose the host dashboard port for a sandbox.
The value must be an integer from `1024` through `65535`.
This flag takes precedence over `CHAT_UI_URL`, `NEMOCLAW_DASHBOARD_PORT`, the previous registry value, and the default port.

If you enable Slack during onboarding, the wizard collects both the Bot Token (`SLACK_BOT_TOKEN`) and the App-Level Token (`SLACK_APP_TOKEN`).
Socket Mode requires both tokens.
The app-level token is stored in a dedicated `slack-app` OpenShell provider and forwarded to the sandbox alongside the bot token.

If you enable Discord during onboarding, the wizard can also prompt for a Discord Server ID, whether the bot should reply only to `@mentions` or to all messages in that server, and an optional Discord User ID.
NemoClaw bakes those values into the sandbox image as Discord guild workspace config so the bot can respond in the selected server, not just in DMs.
If you leave the Discord User ID blank, the guild config omits the user allowlist and any member of the configured server can message the bot.
Guild responses remain mention-gated by default unless you opt into all-message replies.

If you run onboarding again with the same sandbox name and choose a different inference provider or model, NemoClaw detects the drift and recreates the sandbox so the running OpenClaw UI matches your selection.
In interactive mode, the wizard asks for confirmation before delete and recreate.
In non-interactive mode, NemoClaw recreates automatically when the stored selection is readable and differs; if NemoClaw cannot read the stored selection, NemoClaw reuses by default.
Set `NEMOCLAW_RECREATE_SANDBOX=1` to force recreation even when no drift is detected.

Before creating the gateway, the wizard runs preflight checks.
It verifies that Docker is reachable, warns on untested runtimes such as Podman, and prints host remediation guidance when prerequisites are missing.
The preflight also enforces the OpenShell version range declared in the blueprint (`min_openshell_version` and `max_openshell_version`).
If the installed OpenShell version falls outside this range, onboarding exits with an actionable error and a link to compatible releases.

#### `--from <Dockerfile>`

Build the sandbox image from a custom Dockerfile instead of the stock NemoClaw image.
The entire parent directory of the specified file is used as the Docker build context, so any files your Dockerfile references (scripts, config, etc.) must live alongside it.
Onboarding skips common large directories (`node_modules`, `.git`, `.venv`, and `__pycache__`) while staging this context.
It also skips credential-style files and directories such as `.env*`, `.ssh/`, `.aws/`, `.netrc`, `.npmrc`, `secrets/`, `*.pem`, and `*.key`.
Other build outputs such as `dist/`, `target/`, or `build/` are still included.
If the staged context is larger than 100 MB, onboarding prints a warning before the Docker build starts.
If the directory contains unreadable files (for example, Windows system files visible in WSL), onboarding exits with an error suggesting you move the Dockerfile to a dedicated directory.

```console
$ nemoclaw onboard --from path/to/Dockerfile
```

The Dockerfile path must exist.
Missing paths fail during command parsing before preflight, gateway setup, inference setup, or sandbox creation starts.

The file can have any name; if it is not already named `Dockerfile`, onboard copies it to `Dockerfile` inside the staged build context automatically.
To create an isolated build context, create a dedicated directory that contains only the Dockerfile and the files it needs:

```text
build-dir/
├── Dockerfile
└── files-used-by-COPY/
```

All NemoClaw build arguments (`NEMOCLAW_MODEL`, `NEMOCLAW_PROVIDER_KEY`, `NEMOCLAW_INFERENCE_BASE_URL`, etc.) are injected as `ARG` overrides at build time, so declare them in your Dockerfile if you need to reference them.

In non-interactive mode, the path can also be supplied via the `NEMOCLAW_FROM_DOCKERFILE` environment variable.
You must also supply a sandbox name via `--name <sandbox>` or `NEMOCLAW_SANDBOX_NAME` so a `--from` build cannot silently clobber the default `my-assistant` sandbox.

```console
$ NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_FROM_DOCKERFILE=path/to/Dockerfile NEMOCLAW_SANDBOX_NAME=my-build nemoclaw onboard
```

If a `--resume` is attempted with a different `--from` path than the original session, onboarding exits with a conflict error rather than silently building from the wrong image.

#### `--name <sandbox>`

Set the sandbox name without going through the interactive prompt.
The same RFC 1123 and reserved-name rules that the wizard enforces apply here too — names that match a NemoClaw CLI command (`status`, `list`, `debug`, etc.) are rejected up front.

```console
$ nemoclaw onboard --non-interactive --name my-build --from path/to/Dockerfile
```

The flag wins over `NEMOCLAW_SANDBOX_NAME`.
When prompting is impossible (no TTY or `--non-interactive`), the env var is also honoured so existing CI scripts keep working.
Combining `--from <Dockerfile>` with non-interactive onboarding requires one of `--name` or `NEMOCLAW_SANDBOX_NAME`; otherwise onboarding exits rather than silently defaulting to `my-assistant` and clobbering the default sandbox.

### `nemoclaw onboard --from`

Use a custom Dockerfile for the sandbox image.
This variant of `nemoclaw onboard` accepts a `--from <Dockerfile>` argument to build the sandbox from a user-supplied Dockerfile instead of the default NemoClaw image.

```console
$ nemoclaw onboard --from ./Dockerfile.custom
```

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.
Sandboxes with an active SSH session are marked with a `●` indicator so you can tell at a glance which sandbox you are already connected to in another terminal.
When a sandbox has a recorded dashboard port, the output includes its local dashboard URL.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

:::{warning}
The `nemoclaw deploy` command is deprecated.
Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.
:::

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
This command remains as a compatibility wrapper for the older Brev-specific bootstrap flow.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.
If the sandbox is not yet in the `Ready` phase, `connect` polls `openshell sandbox list` every few seconds and prints the current phase. This gives you progress output right after onboarding, when the 2.4 GB image is still pulling, instead of a silent hang.
Control the wait budget with `NEMOCLAW_CONNECT_TIMEOUT` (integer seconds, default `120`). When the deadline expires, `connect` exits non-zero with the last-seen phase.

On a TTY, a one-shot hint prints before dropping into the sandbox shell.
The hint is agent-aware. It names the correct TUI command for the sandbox's agent and reminds you to use `/exit` to leave the chat before `exit` returns you to the host shell.
Set `NEMOCLAW_NO_CONNECT_HINT=1` to suppress the hint in scripted workflows.
If the sandbox is running an outdated agent version, a non-blocking warning prints before connecting with a `nemoclaw <name> rebuild` hint.
If another terminal is already connected to the sandbox, `connect` prints a note with the number of existing sessions before proceeding. Multiple concurrent sessions are allowed.

After a host reboot, the OpenShell gateway rotates its SSH host keys.
`connect` detects the resulting identity drift, prunes stale `openshell-*` entries from `~/.ssh/known_hosts`, and retries automatically.
You no longer need to re-run `nemoclaw onboard` after a reboot in this case.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

The command probes every inference provider and reports one of three states on the `Inference` line:

| State | Meaning |
|-------|---------|
| `healthy` | The provider endpoint returned a reachable response. |
| `unreachable` | The probe failed. The output includes the endpoint URL and a remediation hint. |
| `not probed` | The endpoint URL is not known (for example, `compatible-*` providers). |

Local providers (Ollama, vLLM) probe the host-side health endpoint.
Remote providers (NVIDIA Endpoints, OpenAI, Anthropic, Gemini) use a lightweight reachability check; any HTTP response, including `401` or `403`, counts as reachable.
No API keys are sent.
For cloud-only providers, the output omits the NIM status line unless a NIM container is registered or an unexpected NIM container is running.

A `Connected` line reports whether the sandbox has any active SSH sessions and, if so, how many.
The sandbox list in the status output includes the dashboard port suffix for sandboxes with a recorded dashboard port.

The Policy section displays the live enforced policy (fetched via `openshell policy get --full`), which reflects presets added or removed after sandbox creation.
If the sandbox is running an outdated agent version, the output includes an `Update` line with the available version and a `nemoclaw <name> rebuild` hint.

When other sandboxes have the same messaging channel enabled (Telegram, Discord, or Slack) with the same bot token, the output includes a cross-sandbox overlap warning so you can resolve the conflict before messages start dropping.
The command also tails `/tmp/gateway.log` inside the default sandbox and flags Telegram `409 Conflict` errors that indicate a duplicate consumer for the bot token.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.
The command reads both OpenClaw gateway output and OpenShell audit events, so policy denials appear alongside the gateway log stream.
If one log source is unavailable, NemoClaw prints a warning and keeps reading the remaining source.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> gateway-token`

Print the OpenClaw gateway auth token for a running sandbox to stdout.
The token is required by `openclaw tui` and the OpenClaw dashboard URL, but onboarding only prints it once.
Pipe it into automation or capture it into an environment variable:

```console
$ TOKEN=$(nemoclaw my-assistant gateway-token --quiet)
$ export OPENCLAW_GATEWAY_TOKEN="$TOKEN"
```

The token is written to stdout with no surrounding text.
A one-line security warning is written to stderr; pass `--quiet` (or `-q`) to suppress it.
The command exits non-zero with a diagnostic on stderr when the sandbox is not registered or when the token cannot be retrieved (for example, if the sandbox is not running).

:::{warning}
Treat the gateway token like a password.
Do not log it, share it, or commit it to version control.
:::

### `nemoclaw <name> destroy`

Stop the NIM container, remove the host-side Docker image built during onboard, and delete the sandbox.
This removes the sandbox from the registry.

:::{warning}
This command permanently deletes the sandbox **and its persistent volume**.
All [workspace files](../workspace/workspace-files.md) (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes) are lost.
Back up your workspace first with `nemoclaw <name> snapshot create` or see [Backup and Restore](../workspace/backup-restore.md).
If you want to upgrade the sandbox while preserving state, use `nemoclaw <name> rebuild` instead.
:::

If another terminal has an active SSH session to the sandbox, `destroy` prints an active-session warning and requires a second confirmation before it proceeds.
Pass `--yes` or `--force` to skip the prompt in scripted workflows.

```console
$ nemoclaw my-assistant destroy
```

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.
Before applying, the command shows which endpoints the preset would open and prompts for confirmation.

```console
$ nemoclaw my-assistant policy-add
```

To apply a specific preset without the interactive picker, pass its name as a positional argument:

```console
$ nemoclaw my-assistant policy-add pypi --yes
```

The positional form is required in scripted workflows.
Set `NEMOCLAW_NON_INTERACTIVE=1` instead of `--yes` if you want the same behavior from an environment variable.
If the preset name is unknown or already applied, the command exits non-zero with a clear error.

| Flag | Description |
|------|-------------|
| `--from-file <path>` | Apply a custom preset YAML file instead of a built-in preset |
| `--from-dir <path>` | Apply every custom preset YAML file in a directory in lexicographic order |
| `--yes`, `--force` | Skip the confirmation prompt (requires a preset name, `--from-file`, or `--from-dir`) |
| `--dry-run` | Preview the endpoints a preset would open without applying changes |

Use `--dry-run` to audit a preset before applying it:

```console
$ nemoclaw my-assistant policy-add --dry-run
```

Apply a custom preset file when you need to grant access to an endpoint that is not covered by a built-in preset:

```console
$ nemoclaw my-assistant policy-add --from-file ./presets/my-internal-api.yaml
```

For batch workflows, apply all preset files from a directory:

```console
$ nemoclaw my-assistant policy-add --from-dir ./presets/ --yes
```

Review every host in custom preset files before applying them.
Custom presets bypass the built-in preset review process and can widen sandbox egress.

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.
The command cross-references the local registry against the live gateway state (via `openshell policy get`), so it flags presets that are applied in one place but not the other.
This catches desync caused by external edits to the gateway policy or stale registry entries after a manual rollback.

```console
$ nemoclaw my-assistant policy-list
```

### `nemoclaw <name> policy-remove`

Remove a previously applied policy preset from a sandbox.
The command lists only the presets currently applied, prompts you to select one, shows the endpoints that would be removed, and asks for confirmation before narrowing egress.

```console
$ nemoclaw my-assistant policy-remove
```

To remove a specific preset non-interactively, pass its name as a positional argument:

```console
$ nemoclaw my-assistant policy-remove pypi --yes
```

Set `NEMOCLAW_NON_INTERACTIVE=1` as an alternative to `--yes`.
If the preset is unknown or not currently applied, the command exits non-zero with a clear error.

| Flag | Description |
|------|-------------|
| `--yes`, `--force` | Skip the confirmation prompt (requires a preset name) |
| `--dry-run` | Preview which endpoints would be removed without applying changes |

Unchecking a preset in the onboard TUI checkbox also removes it from the sandbox.

### `nemoclaw <name> channels list`

List the messaging channels NemoClaw knows about (`telegram`, `discord`, `slack`) with a short description.
The command is a static reference; it does not consult credentials or the running sandbox.

```console
$ nemoclaw my-assistant channels list
```

### `nemoclaw <name> channels add <channel>`

Store credentials for a messaging channel (`telegram`, `discord`, or `slack`) and rebuild the sandbox so the image picks up the new channel.
The command prompts for any missing token, registers it with the OpenShell gateway, then asks whether to rebuild immediately.
Running `add` for an already-configured channel simply overwrites the stored tokens — the operation is idempotent.

```console
$ nemoclaw my-assistant channels add telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Validate the channel and token inputs without saving credentials or rebuilding |

Slack requires both `SLACK_BOT_TOKEN` (bot user OAuth) and `SLACK_APP_TOKEN` (app-level Socket Mode token); the command prompts for each in turn.
When `NEMOCLAW_NON_INTERACTIVE=1` is set, any missing token fails fast and no rebuild prompt is shown — instead, the change is queued and you are told to run `nemoclaw <name> rebuild` manually.

### `nemoclaw <name> channels remove <channel>`

Clear the stored credentials for a messaging channel and rebuild the sandbox so the image drops the channel.
Running `remove` for a channel that was never configured is a no-op against the credentials file and still triggers the rebuild prompt.

```console
$ nemoclaw my-assistant channels remove telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be removed without clearing credentials or rebuilding |

As with `channels add`, `NEMOCLAW_NON_INTERACTIVE=1` skips the rebuild prompt and queues the change for a manual `nemoclaw <name> rebuild`.

Host-side removal is the supported path because `/sandbox/.openclaw/openclaw.json` is baked into the container image at build time; `openclaw channels remove` inside the sandbox would modify the running config but not persist changes across rebuilds.

### `nemoclaw <name> channels stop <channel>`

Pause a single messaging bridge (`telegram`, `discord`, or `slack`) without clearing its credentials.
The channel is marked disabled in the per-sandbox registry, and the sandbox is rebuilt so the onboard step skips registering the bridge with the gateway.
The provider stays registered with the OpenShell gateway, so a later `channels start` brings the bridge back without re-entering tokens.

```console
$ nemoclaw my-assistant channels stop telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be disabled without updating the registry or rebuilding |

Use `channels stop` instead of `channels remove` when you want to pause a bridge temporarily. `channels remove` is destructive to credentials; `channels stop` is not.

### `nemoclaw <name> channels start <channel>`

Re-enable a channel previously paused with `channels stop`. The channel is removed from the disabled list, the sandbox is rebuilt, and the bridge registers with the gateway again using the stored credentials.

```console
$ nemoclaw my-assistant channels start telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be re-enabled without updating the registry or rebuilding |

### `nemoclaw <name> skill install <path>`

Deploy a skill directory to a running sandbox.
The command validates the `SKILL.md` frontmatter (a `name` field is required), uploads all non-dot files preserving subdirectory structure, and performs agent-specific post-install steps.

```console
$ nemoclaw my-assistant skill install ./my-skill/
```

The skill directory must contain a `SKILL.md` file with YAML frontmatter that includes a `name` field.
Skill names must contain only alphanumeric characters, dots, hyphens, and underscores.
OpenClaw plugins are a different kind of extension. To install an OpenClaw plugin, see [Install OpenClaw Plugins](../deployment/install-openclaw-plugins.md).
Run `nemoclaw <name> skill install --help` to print usage for this subcommand.
If you pass a plugin-shaped directory to `skill install`, the CLI prints a plugin-specific hint instead of treating it as a missing skill file.

Files with names starting with `.` (dotfiles) are skipped and listed in the output.
Files with unsafe path characters are rejected to prevent shell injection.

If the skill already exists on the sandbox, the command updates it in place and preserves chat history.
For new installs, the agent session index is refreshed so the agent discovers the skill on the next session.

### `nemoclaw <name> rebuild`

Upgrade a sandbox to the current agent version while preserving workspace state.
The command backs up workspace state, destroys the old sandbox (including its host-side Docker image), recreates it with the current image via `onboard --resume`, and restores workspace state into the new sandbox.
Credentials are stripped from backups before storage.
Policy presets applied to the old sandbox are reapplied to the new one so your egress rules survive the rebuild.

```console
$ nemoclaw my-assistant rebuild [--yes] [--verbose]
```

| Flag | Description |
|------|-------------|
| `--yes`, `--force` | Skip the confirmation prompt |
| `--verbose` | Log SSH commands, exit codes, and session state (also enabled by `NEMOCLAW_REBUILD_VERBOSE=1`) |

If another terminal has an active SSH session to the sandbox, `rebuild` prints an active-session warning and requires confirmation before destroying the sandbox.
Pass `--yes` or `--force` to skip the prompt in scripted workflows.

The sandbox must be running for the backup step to succeed.
After restore, the command runs `openclaw doctor --fix` for cross-version structure repair.

### `nemoclaw upgrade-sandboxes`

Rebuild sandboxes whose base image is older than the one currently pinned by NemoClaw.
NemoClaw resolves the digest of `ghcr.io/nvidia/nemoclaw/sandbox-base:latest` from the registry, then compares it against the digest each sandbox was created with.
Sandboxes that match the current digest are left alone.

```console
$ nemoclaw upgrade-sandboxes [--check] [--auto] [--yes]
```

| Flag | Description |
|------|-------------|
| `--check` | List stale sandboxes without rebuilding any of them. Exits non-zero if any are stale. |
| `--auto` | Rebuild every stale sandbox without prompting. Used by the installer to upgrade in place. |
| `--yes` | Skip the confirmation prompt for the rebuild plan. |

Each rebuild reuses the same workspace backup-and-restore flow as `nemoclaw <name> rebuild`, so workspace files survive the upgrade.
If the registry is unreachable (offline or firewalled hosts), NemoClaw falls back to the unpinned `:latest` tag and reports that the digest could not be resolved instead of failing.

### `nemoclaw backup-all`

Back up all registered running sandboxes to `~/.nemoclaw/rebuild-backups/`.
Sandboxes that are not running are skipped.

```console
$ nemoclaw backup-all
```

The installer calls `backup-all` automatically before onboarding to protect against data loss during OpenShell upgrades.

### `nemoclaw <name> snapshot create`

Create a timestamped snapshot of sandbox state.
Snapshots are stored in `~/.nemoclaw/rebuild-backups/<name>/`.

```console
$ nemoclaw my-assistant snapshot create
```

| Flag | Description |
|------|-------------|
| `--name <label>` | Attach a human-readable label to the snapshot so you can restore by name later |

Names must be 1 to 63 characters from `[A-Za-z0-9._-]`, start with an alphanumeric character, and cannot look like a version selector (`v1`, `v2`, ...). Duplicate names per sandbox are rejected; pick a different name or delete the existing snapshot first.

```console
$ nemoclaw my-assistant snapshot create --name before-upgrade
```

### `nemoclaw <name> snapshot list`

List available snapshots for a sandbox as a table of version, name, timestamp, and path.
Versions (`v1`, `v2`, ...) are computed on read from timestamp-ascending order, so `v1` is the oldest snapshot and `vN` is the newest. Snapshots created before this feature landed are numbered retroactively.

```console
$ nemoclaw my-assistant snapshot list
```

### `nemoclaw <name> snapshot restore [selector] [--to <dst>]`

Restore sandbox state from a snapshot.
The sandbox must be running before you restore.
If no selector is provided, the latest snapshot is used.
Restore performs a clean replacement of each state directory, removing files that were added after the snapshot was taken.

The selector accepts any of:

- A version (`v1`, `v2`, ..., `vN`) from `snapshot list`.
- An exact name passed to `snapshot create --name`.
- An exact or prefix timestamp (partial prefixes are accepted when they match exactly one snapshot).

Pass `--to <dst>` to restore the snapshot into a different sandbox instead of the source.
When `dst` does not exist, it is auto-created by reusing the source sandbox's container image — no re-onboarding needed.

```console
# restore latest snapshot in-place
$ nemoclaw my-assistant snapshot restore

# restore by version
$ nemoclaw my-assistant snapshot restore v3

# restore by user-assigned name
$ nemoclaw my-assistant snapshot restore before-upgrade

# restore by exact timestamp
$ nemoclaw my-assistant snapshot restore 2026-04-21T07-35-55-987Z

# clone v3 into another sandbox
$ nemoclaw my-assistant snapshot restore v3 --to my-assistant-clone
```

## `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw tunnel start`

Start optional host auxiliary services. This is the cloudflared tunnel when `cloudflared` is installed (for a public URL to the dashboard). Channel messaging (Telegram, Discord, Slack) is not started here; it is configured during `nemoclaw onboard` and runs through OpenShell-managed constructs.

```console
$ nemoclaw tunnel start
```

`nemoclaw start` remains as a deprecated alias that prints a warning and delegates to `tunnel start`.

### `nemoclaw tunnel stop`

Stop host auxiliary services started by `nemoclaw tunnel start` (for example cloudflared). This does not affect messaging channels running inside the sandbox; use `nemoclaw <name> channels stop <channel>` to pause a specific bridge without destroying the sandbox.

```console
$ nemoclaw tunnel stop
```

`nemoclaw stop` remains as a deprecated alias that prints a warning and delegates to `tunnel stop`.

### `nemoclaw start`

:::{warning}
Deprecated. Use `nemoclaw tunnel start` instead.
:::

This command remains as a compatibility alias to `nemoclaw tunnel start`.

### `nemoclaw stop`

:::{warning}
Deprecated. Use `nemoclaw tunnel stop` instead.
:::

This command remains as a compatibility alias to `nemoclaw tunnel stop`.

### `nemoclaw status`

Show the sandbox list and the status of host auxiliary services (for example cloudflared).

```console
$ nemoclaw status
```

### `nemoclaw setup`

:::{warning}
The `nemoclaw setup` command is deprecated.
Use `nemoclaw onboard` instead.
:::

This command remains as a compatibility alias to `nemoclaw onboard`.

```console
$ nemoclaw setup
```

### `nemoclaw setup-spark`

:::{warning}
The `nemoclaw setup-spark` command is deprecated.
Use the standard installer and run `nemoclaw onboard` instead, because current OpenShell releases handle the older DGX Spark cgroup behavior.
:::

This command remains as a compatibility alias to `nemoclaw onboard`.

```console
$ nemoclaw setup-spark
```

### `nemoclaw debug`

Collect diagnostics for bug reports.
Gathers system info, Docker state, gateway logs, and sandbox status into a summary or tarball.
Use `--sandbox <name>` to target a specific sandbox, `--quick` for a smaller snapshot, or `--output <path>` to save a tarball that you can attach to an issue.

```console
$ nemoclaw debug [--quick] [--sandbox NAME] [--output PATH]
```

| Flag | Description |
|------|-------------|
| `--quick` | Collect minimal diagnostics only |
| `--sandbox NAME` | Target a specific sandbox (default: auto-detect) |
| `--output PATH` | Write diagnostics tarball to the given path |

If `--output` is set and the tarball cannot be written (for example, the destination directory is missing or read-only), the command exits non-zero so scripts can detect the failure.

### `nemoclaw credentials list`

List the provider credentials registered with the OpenShell gateway.
Values are not printed.

```console
$ nemoclaw credentials list
```

### `nemoclaw credentials reset <PROVIDER>`

Remove a provider credential from the OpenShell gateway by provider name.
After removal, re-running `nemoclaw onboard` re-prompts for that provider's credential.
Run `nemoclaw credentials list` first if you are not sure of the provider name.

```console
$ nemoclaw credentials reset nvidia-prod
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Skip the confirmation prompt |

### `nemoclaw gc`

Remove orphaned sandbox Docker images from the host.
Each `nemoclaw onboard` builds an `openshell/sandbox-from:<timestamp>` image (~765 MB).
The `destroy` and `rebuild` commands clean up the image automatically, but images from older NemoClaw versions or interrupted operations may remain.
This command lists all `openshell/sandbox-from:*` images, cross-references the sandbox registry, and removes any that are no longer associated with a registered sandbox.

```console
$ nemoclaw gc [--dry-run] [--yes|--force]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | List orphaned images without removing them |
| `--yes`, `--force` | Skip the confirmation prompt |

### `nemoclaw uninstall`

Run `uninstall.sh` to remove NemoClaw sandboxes, gateway resources, related images and containers, and local state.
The CLI runs the local `uninstall.sh` shipped with the installed npm package.
If that local script is missing, the CLI does not auto-fetch a remote copy.
It prints the versioned URL of the matching `uninstall.sh` so you can download, review, and run it manually.

Uninstall also stops any orphaned `openshell` host processes left behind by previous onboard or destroy cycles, including `openshell sandbox create`, `openshell ssh-proxy`, and SSH sessions spawned by OpenShell.
Earlier releases only stopped `openshell forward` processes, so those orphans accumulated across runs.

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |

```console
$ nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models]
```

#### `nemoclaw uninstall` vs. the hosted `uninstall.sh`

Both forms execute the same `uninstall.sh` with the same flags, but differ in where the script comes from and how much they trust the network.
Use `nemoclaw uninstall` by default.
Use the hosted `curl … | bash` form only when the CLI is broken or already partially removed.

|  | `nemoclaw uninstall` | `curl … \| bash` (Quickstart) |
|---|---|---|
| **Source of the script** | Local `uninstall.sh` shipped with the installed npm package. | Pulled live from `refs/heads/main` on GitHub. |
| **Version pinning** | Pinned to the version of NemoClaw you installed. | Whatever is on `main` right now; may be newer than your installed CLI. |
| **Network trust** | No network fetch at uninstall time; runs a vetted local file via `bash`. | Pipes a remote script straight to `bash` with no review step. |
| **Robustness** | Requires the npm package to be discoverable so the CLI can find the local script. | Works even if the `nemoclaw` CLI is missing, broken, or partially uninstalled. |
| **Recommended for** | Routine uninstalls. | Recovery when the CLI is unavailable. |

## Environment Variables

NemoClaw reads the following environment variables to configure service ports.
Set them before running `nemoclaw onboard` or any command that starts services.
All ports must be non-privileged integers between 1024 and 65535.

| Variable | Default | Service |
|----------|---------|---------|
| `NEMOCLAW_GATEWAY_PORT` | 8080 | OpenShell gateway |
| `NEMOCLAW_DASHBOARD_PORT` | 18789 (auto-derived from `CHAT_UI_URL` port if set) | Dashboard UI |
| `NEMOCLAW_VLLM_PORT` | 8000 | vLLM / NIM inference |
| `NEMOCLAW_OLLAMA_PORT` | 11434 | Ollama inference |
| `NEMOCLAW_OLLAMA_PROXY_PORT` | 11435 | Ollama auth proxy |

If a port value is not a valid integer or falls outside the allowed range, the CLI exits with an error.
On non-WSL hosts, `NEMOCLAW_OLLAMA_PORT` and `NEMOCLAW_OLLAMA_PROXY_PORT` must be different.
If you run Ollama on port 11435, set `NEMOCLAW_OLLAMA_PROXY_PORT` to another free port before onboarding.

```console
$ export NEMOCLAW_DASHBOARD_PORT=19000
$ nemoclaw onboard
```

These overrides apply to onboarding, status checks, health probes, and the uninstaller.
Defaults are unchanged when no variable is set.
If `NEMOCLAW_DASHBOARD_PORT` or the port from `CHAT_UI_URL` is already occupied by another sandbox, onboarding scans `18789` through `18799` and uses the next free dashboard port.
Pass `--control-ui-port <N>` to require a specific port.

### Legacy `nemoclaw setup`

Deprecated. Use `nemoclaw onboard` instead.
Running `nemoclaw setup` now delegates directly to `nemoclaw onboard`.

```console
$ nemoclaw setup
```
