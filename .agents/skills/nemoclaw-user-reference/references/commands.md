# NemoClaw CLI Commands Reference

import { AgentOnly } from "../_components/AgentGuide";

<AgentOnly variant="openclaw">

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes.
It is installed automatically by the installer (`curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`).
For guidance on when to use `nemoclaw` versus the underlying `openshell` CLI, see [CLI Selection Guide](cli-selection-guide.md).

</AgentOnly>
<AgentOnly variant="hermes">

The `nemohermes` alias is the primary interface for managing Hermes sandboxes through NemoClaw.
It is installed automatically by the installer (`curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_AGENT=hermes bash`).
Most commands in this reference use the same arguments and subcommands across agent variants.
Use `nemohermes` when you want Hermes selected by default.
For guidance on choosing between the agent CLIs and the underlying `openshell` CLI, see [CLI Selection Guide](cli-selection-guide.md).

</AgentOnly>

## Agent Selection

<AgentOnly variant="openclaw">

Use `nemoclaw` for the OpenClaw variant.
OpenClaw is the default agent for `nemoclaw onboard` unless you pass `--agent hermes` or set `NEMOCLAW_AGENT=hermes`.
OpenClaw-specific sections below describe the `/nemoclaw` slash command, the OpenClaw dashboard URL, the OpenClaw gateway token, and OpenClaw config paths under `/sandbox/.openclaw`.

</AgentOnly>
<AgentOnly variant="hermes">

Use `nemohermes` for the Hermes variant.
It selects Hermes by default during onboarding and for other commands.
Use `--agent hermes` during onboarding or set `NEMOCLAW_AGENT=hermes` when you need the same selection through another entry point.
Hermes-specific sections below describe the OpenAI-compatible API endpoint, optional Hermes dashboard, Hermes config under `/sandbox/.hermes`, and provider updates that patch `config.yaml`.

```bash
nemohermes onboard              # selects Hermes by default
nemohermes my-sandbox connect   # connects to a Hermes sandbox
```

</AgentOnly>

## In-Sandbox Commands

<AgentOnly variant="openclaw">

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw` | Show slash-command help and host CLI pointers |
| `/nemoclaw status` | Show sandbox and inference state |
| `/nemoclaw onboard` | Show onboarding status and reconfiguration guidance |
| `/nemoclaw eject` | Show rollback instructions for returning to the host installation |

</AgentOnly>
<AgentOnly variant="hermes">

Hermes does not use the OpenClaw chat slash command.
Use the host-side `nemohermes` commands for lifecycle, status, policy, and inference operations.
The in-sandbox Hermes integration installs the NemoClaw Hermes plugin, which exposes tools for status, environment information, and skill reload support, plus an `on_session_start` hook.

</AgentOnly>

## Standalone Host Commands

The CLI handles host-side operations that run outside the selected agent runtime.

### `nemoclaw help`, `nemoclaw --help`, `nemoclaw -h`

Show the top-level usage summary and command groups.
Running `nemoclaw` with no arguments shows the same help output.

```bash
nemoclaw help
```

### `nemoclaw --version`, `nemoclaw -v`

Print the installed NemoClaw CLI version.

```bash
nemoclaw --version
```

### `nemoclaw resources`

Display host hardware inventory and configured sandbox resource profiles.
Use `--json` for machine-readable CPU, memory, GPU, Kubernetes allocatable-capacity, and profile data.

```bash
nemoclaw resources [--json]
```

If the gateway is not running, Kubernetes allocatable fields are omitted and host CPU/RAM totals are still shown.

### `nemoclaw onboard`

Run the interactive setup wizard (recommended for new installs).
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```bash
nemoclaw onboard [--non-interactive] [--resume | --fresh] [--recreate-sandbox] [--gpu | --no-gpu] [--from <Dockerfile>] [--name <sandbox>] [--sandbox-gpu | --no-sandbox-gpu] [--sandbox-gpu-device <device>] [--agent <name>] [--control-ui-port <N>] [--yes | -y] [--no-ollama-autostart] [--yes-i-accept-third-party-software]
```

<AgentOnly variant="hermes">

For Hermes, use the alias or pass the agent explicitly:

```bash
nemohermes onboard [options]
nemoclaw onboard --agent hermes [options]
```

</AgentOnly>

#### `--resume` and `--fresh`

NemoClaw records onboarding progress so interrupted runs can continue.
Use `--resume` to continue a resumable onboarding session with the provider, model, sandbox name, agent, and custom Dockerfile path recorded by the original run.
If the recorded session conflicts with flags you pass on the recovery run, NemoClaw exits and tells you to either rerun with the original settings or start over.

Use `--fresh` to discard the saved onboarding session and start the wizard from the beginning.
This clears stale or failed session state before NemoClaw creates a new session record.
The installer also accepts `--fresh` and forwards it to `nemoclaw onboard`, which skips automatic resume detection.
`--resume` and `--fresh` are mutually exclusive.

**Warning:**

For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.

Use `--fresh` to ignore any saved onboarding session and restart the wizard from scratch. This is useful after an interrupted `nemoclaw onboard` run when you want to discard saved state instead of continuing it with `--resume`.

The installer detects existing sandbox sessions before onboarding and prints a warning if any are found.
To make the installer abort instead of continuing, set `NEMOCLAW_SINGLE_SESSION=1`:

```bash
NEMOCLAW_SINGLE_SESSION=1 curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

When existing sandboxes were created with OpenShell earlier than `0.0.37`, the installer prompts before running the new automatic gateway upgrade path.
For scripted installs, set `NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE=1` to allow the installer to back up registered sandbox state, retire the old gateway, install the current supported OpenShell release, and restore state during onboarding.
The automatic path is disabled if the existing `nemoclaw` CLI does not advertise `backup-all`; preserve sandbox state manually before retiring the old gateway in that case.
To perform those steps manually, run `nemoclaw backup-all`, retire the old gateway registration with `openshell gateway remove nemoclaw || openshell gateway destroy -g nemoclaw || openshell gateway destroy` (both verbs are tried so the right one runs on either OpenShell release), stop any remaining privileged host gateway with `sudo pkill -f openshell-gateway`, then rerun the installer as `curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 bash`.

The wizard prompts for a provider first, then collects the provider credential if needed.
Supported non-experimental choices include NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and compatible OpenAI or Anthropic endpoints.
Credentials are registered with the OpenShell gateway and never persisted to host disk. See Credential Storage (use the `nemoclaw-user-configure-security` skill) for details on inspection, rotation, and migration from earlier releases.
The legacy `nemoclaw setup` command is deprecated; use `nemoclaw onboard` instead.

After provider selection, the wizard reviews the provider, model, credential state, and sandbox name before registering inference.
It then prompts for optional web search and messaging channels, builds and starts the sandbox, and asks for a **policy tier** that controls the default set of network policy presets applied to the sandbox.
Three tiers are available:

| Tier | Description |
|------|-------------|
| Restricted | Base sandbox only. No third-party network access beyond inference and core agent tooling. |
| Balanced (default) | Full dev tooling and web search when the active agent supports web search. Package installs, model downloads, and inference. No messaging platform access. |
| Open | Broad access across third-party services including messaging and productivity. Agent-specific unsupported presets are filtered out. |

After selecting a tier, the wizard shows a combined preset and access-mode screen where you can include or exclude individual presets and toggle each between read and read-write access.
For details on tiers and the presets each includes, see [Network Policies](network-policies.md#policy-tiers).
When you finish the policy step, NemoClaw records the finalized built-in preset selection for that sandbox.
Later re-onboard runs seed from that finalized selection, so presets you intentionally removed stay removed unless you select them again or override the policy mode.

In non-interactive mode, set the tier with `NEMOCLAW_POLICY_TIER` (default: `balanced`):

```bash
NEMOCLAW_POLICY_TIER=restricted nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

`NEMOCLAW_POLICY_MODE` controls how non-interactive onboarding reconciles the tier-derived suggestions against the sandbox's currently-applied presets.
The default is `suggested`, which is *additive*.
Onboarding applies tier defaults and preserves any presets you previously added with [`nemoclaw <name> policy-add`](#nemoclaw-name-policy-add) across re-onboards.
Use `custom` with `NEMOCLAW_POLICY_PRESETS` when you want the explicit list to be authoritative.
Onboarding removes any preset that is not in the list.
`skip` leaves the applied set untouched and does not apply tier defaults.
NemoClaw filters tier suggestions and resume selections by active agent support, so unsupported presets such as Brave Search are not reapplied to agents that do not support them.

| Value | Behaviour |
|-------|-----------|
| `suggested` (default) | Apply tier defaults and preserve any extra presets already applied. Aliases: `default`, `auto`. |
| `custom` | Apply exactly `NEMOCLAW_POLICY_PRESETS`. Previously-applied presets not in the list are removed. Alias: `list`. |
| `skip` | Skip the policy step entirely. Aliases: `none`, `no`. |

<AgentOnly variant="openclaw">

If you enable Brave Search during onboarding, NemoClaw registers a Brave Search OpenShell provider and keeps `openclaw.json` on an OpenShell credential placeholder.
At egress, OpenShell rewrites Brave's `X-Subscription-Token` header with the real `BRAVE_API_KEY`.
Treat Brave Search as an explicit opt-in and use a dedicated low-privilege Brave key.

</AgentOnly>
For non-interactive onboarding, you must explicitly accept the third-party software notice:

```bash
nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

or:

```bash
NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 nemoclaw onboard --non-interactive
```

For scripted installer runs, pass explicit acceptance to the `bash` side of the installer pipe:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

If the installer cannot prompt for the notice in a terminal and no explicit acceptance is set, it exits before installing Node.js or the NemoClaw CLI.

To enable Brave Search in non-interactive mode, set:

```bash
BRAVE_API_KEY=... \
  nemoclaw onboard --non-interactive
```

`BRAVE_API_KEY` enables Brave Search in non-interactive mode and also enables `web_fetch`.
If Brave Search key validation fails in non-interactive mode, onboarding prints a warning, skips web search setup, and continues with the rest of the sandbox setup.
After fixing the key, re-enable web search with `nemoclaw config web-search`.

The wizard prompts for a sandbox name.
Names must be 1 to 63 characters, lowercase, start with a letter, contain only letters, numbers, and internal hyphens, and end with a letter or number.
The CLI rejects names that do not match these rules.
It also prints a `Try: <suggested-slug>` recovery line whenever it can derive a valid lowercase, hyphen-separated form from the input, so passing `--name MyAssistant` reports `Try: myassistant`.
Names that match global CLI commands (`status`, `list`, `debug`, etc.) are rejected to avoid routing conflicts.
Use `--agent <name>` to target a specific installed agent profile during onboarding.

Use `--control-ui-port <N>` to choose the host dashboard port for a sandbox.
The value must be an integer from `1024` through `65535`.
This flag takes precedence over `CHAT_UI_URL`, `NEMOCLAW_DASHBOARD_PORT`, the previous registry value, and the default port.

If you enable Slack during onboarding, the wizard collects both the Bot Token (`SLACK_BOT_TOKEN`) and the App-Level Token (`SLACK_APP_TOKEN`).
Socket Mode requires both tokens.
The app-level token is stored in a dedicated `slack-app` OpenShell provider and forwarded to the sandbox alongside the bot token.
The wizard also accepts optional `SLACK_ALLOWED_USERS` and `SLACK_ALLOWED_CHANNELS` values so you can restrict Slack DMs, channel `@mention` users, and channel IDs before the sandbox image is built.

If you enable Discord during onboarding, the wizard can also prompt for a Discord Server ID, whether the bot should reply only to `@mentions` or to all messages in that server, and an optional Discord User ID.
NemoClaw bakes those values into the sandbox image as Discord guild workspace config so the bot can respond in the selected server, not just in DMs.
If you leave the Discord User ID blank, the guild config omits the user allowlist and any member of the configured server can message the bot.
Guild responses remain mention-gated by default unless you opt into all-message replies.

If you enable Telegram during onboarding, the wizard can also prompt for whether group chats should reply only to `@mentions` or to all group messages.
Set `TELEGRAM_REQUIRE_MENTION=1` for non-interactive onboarding when you want mention-only group replies.
Pairing and `TELEGRAM_ALLOWED_IDS` still govern direct messages.

If you cancel a brand-new onboarding run at the policy preset step, NemoClaw rolls back the sandbox, registry entry, and onboarding session instead of leaving a default sandbox with unfinished policy state.
Existing live sandboxes are not deleted by this cancel rollback path.

If you run onboarding again with the same sandbox name and choose a different inference provider or model, NemoClaw detects the drift and recreates the sandbox so the running agent config matches your selection.
In interactive mode, the wizard asks for confirmation before delete and recreate.
In non-interactive mode, NemoClaw recreates automatically when the stored selection is readable and differs; if NemoClaw cannot read the stored selection, NemoClaw reuses by default.
Set `NEMOCLAW_RECREATE_SANDBOX=1` to force recreation even when no drift is detected.

Before deleting an existing sandbox during recreation, NemoClaw backs up the workspace state declared by the selected agent profile and restores it into the new sandbox once it is live.
This applies whether the existing sandbox is ready or marked not-ready, so cross-version upgrades that pass `NEMOCLAW_RECREATE_SANDBOX=1` no longer drop user files from the selected agent workspace.
The behaviour matches `nemoclaw <name> rebuild --force`.
NemoClaw aborts the recreate when the backup cannot complete in full — including when individual state directories or files fail mid-backup — so failed entries are not silently dropped on delete.
Set `NEMOCLAW_RECREATE_WITHOUT_BACKUP=1` to skip the pre-recreate backup.
The destination sandbox starts with a fresh workspace.

<AgentOnly variant="openclaw">

For OpenClaw, the backed-up paths include agents, extensions, workspace, skills, hooks, identity, devices, canvas, cron, memory, telegram, wechat, credentials, and `/sandbox/.openclaw/workspace/`.

</AgentOnly>
<AgentOnly variant="hermes">

For Hermes, the backed-up paths come from `agents/hermes/manifest.yaml`, including `/sandbox/.hermes` state such as memories, sessions, skills, plugins, cron, logs, plans, workspace, messaging platform state, and `runtime/state.db`.

</AgentOnly>

Before creating the gateway, the wizard runs preflight checks.
It verifies that Docker is reachable, warns on untested runtimes such as Podman, and prints host remediation guidance when prerequisites are missing.
The preflight also enforces the OpenShell version range declared in the blueprint (`min_openshell_version` and `max_openshell_version`).
If the installed OpenShell version falls outside this range, onboarding exits with an actionable error and a link to compatible releases.
For fresh OpenShell installs, NemoClaw queries published OpenShell releases and asks the installer to use a release that fits the blueprint range.
If release metadata is unavailable, the installer uses its bundled fallback pin and the post-install version gate still enforces the range.

When NemoClaw finds an existing gateway to reuse, it probes the host gateway HTTP endpoint before declaring the gateway reusable.
If the container is running but the upstream is still warming up (for example, immediately after a Docker daemon restart), NemoClaw rebuilds the gateway instead of trusting stale metadata.
On the Docker-driver gateway path, preflight stays read-only when it detects a stale gateway (for example, a Docker-driver runtime env hash drift).
It prints a `⚠ Gateway will be recreated when sandbox creation starts` notice and defers the actual teardown to step `[2/8] Starting OpenShell gateway`.
This means pressing `Ctrl+C` between preflight and step `[2/8]` leaves the running gateway and existing sandbox containers untouched, so `nemoclaw onboard` is safe to run just to check preflight output.
For Linux Docker-driver gateways, onboarding also checks that a helper container on the OpenShell Docker network can reach `host.openshell.internal:<gateway-port>`.
If a host firewall blocks that sandbox path, onboarding exits with a `sudo ufw allow from <subnet> to <gateway-ip> port <gateway-port> proto tcp` command before it reports the gateway healthy.
Set `NEMOCLAW_AUTO_FIX_FIREWALL=1` to opt in to automatic UFW remediation for this specific failure: NemoClaw uses `sudo -n` only, validates the Docker bridge subnet/gateway/port, applies the narrow UFW rule only after a proven TCP reachability failure, and re-probes before continuing.
If passwordless sudo, UFW, or active UFW is unavailable, NemoClaw falls back to the manual guidance path without prompting for a password.
Tune the wait via `NEMOCLAW_REUSE_HEALTH_POLL_COUNT` (default `6`) and `NEMOCLAW_REUSE_HEALTH_POLL_INTERVAL` (default `5` seconds).
The poll count is clamped to a minimum of `1` so the probe always runs at least once, and the interval is clamped to a minimum of `0` (no sleep between attempts).

#### `--from <Dockerfile>`

Build the sandbox image from a custom Dockerfile instead of the stock NemoClaw image.
The entire parent directory of the specified file is used as the Docker build context, so any files your Dockerfile references (scripts, config, etc.) must live alongside it.
Onboarding skips common large directories (`node_modules`, `.git`, `.venv`, and `__pycache__`) while staging this context.
It also skips credential-style files and directories such as `.env*`, `.ssh/`, `.aws/`, `.netrc`, `.npmrc`, `secrets/`, `*.pem`, and `*.key`.
Other build outputs such as `dist/`, `target/`, or `build/` are still included.
If the staged context is larger than 100 MB, onboarding prints a warning before the Docker build starts.
If the directory contains unreadable files (for example, Windows system files visible in WSL), onboarding exits with an error suggesting you move the Dockerfile to a dedicated directory.

```bash
nemoclaw onboard --from path/to/Dockerfile
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

```bash
NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_FROM_DOCKERFILE=path/to/Dockerfile NEMOCLAW_SANDBOX_NAME=my-build nemoclaw onboard
```

If a `--resume` is attempted with a different `--from` path than the original session, onboarding exits with a conflict error rather than silently building from the wrong image.

#### `--name <sandbox>`

Set the sandbox name without going through the interactive prompt.
The same name format and reserved-name rules that the wizard enforces apply here too. Names must be 1 to 63 characters, lowercase, start with a letter, contain only letters, numbers, and internal hyphens, and end with a letter or number.
Names that match a NemoClaw CLI command (`status`, `list`, `debug`, etc.) are rejected up front.

```bash
nemoclaw onboard --non-interactive --name my-build --from path/to/Dockerfile
```

The flag wins over `NEMOCLAW_SANDBOX_NAME`.
When prompting is possible, `NEMOCLAW_SANDBOX_NAME` fills the interactive default so you can press Enter to accept it.
When prompting is impossible (no TTY or `--non-interactive`), the env var is also honoured so existing CI scripts keep working.
Combining `--from <Dockerfile>` with non-interactive onboarding requires one of `--name` or `NEMOCLAW_SANDBOX_NAME`; otherwise onboarding exits rather than silently defaulting to `my-assistant` and clobbering the default sandbox.

### `nemoclaw onboard --from`

Use a custom Dockerfile for the sandbox image.
This variant of `nemoclaw onboard` accepts a `--from <Dockerfile>` argument to build the sandbox from a user-supplied Dockerfile instead of the default NemoClaw image.

```bash
nemoclaw onboard --from ./Dockerfile.custom
```

### GPU passthrough

When `nemoclaw onboard` detects an NVIDIA GPU on the host, it enables OpenShell GPU passthrough at both the gateway and sandbox level by default.
Detection proceeds along two paths. The `nvidia-smi`-based paths (the primary `--query-gpu=name,memory.total,memory.free` probe and the unified-memory `--query-gpu=name` fallback) require `nvidia-smi` to succeed and, on hosts whose firmware does not classify as a known NVIDIA platform (DGX Spark, DGX Station, Jetson, or Tegra), additionally require that the GPU name does not match the placeholder family observed on the Windows-on-ARM WSL2 nvidia-smi shim (`JMJWOA-Generic-*`) and that either the host is not ARM64 Linux (the observed shim is Windows-on-ARM only) or the NVIDIA kernel driver is bound (`/proc/driver/nvidia/` present), so that placeholder shims on non-NVIDIA hardware are not mistaken for real GPUs.
Jetson/Tegra hosts that ship without `nvidia-smi` continue to be detected via the devicetree firmware fallback (`/sys/firmware/devicetree/base/model`) or the Tegra device-node fallback (`/dev/nvhost-gpu`, `/dev/nvhost-ctrl-gpu`, `/dev/nvhost-ctrl`, or `/dev/nvmap`); both bypass the trust-tier gate above.
Use `--no-gpu` to opt out when you want host-side inference providers only and do not need direct GPU access inside the sandbox.
Use `--gpu` to require GPU passthrough and fail fast if an NVIDIA GPU is not detected.
Use `--sandbox-gpu` or `--no-sandbox-gpu` to control only direct NVIDIA GPU access inside the sandbox.
Use `--sandbox-gpu --sandbox-gpu-device <device>` to pass a specific OpenShell GPU device selector to `openshell sandbox create`; device selectors require explicit sandbox GPU enablement.
On Linux Docker-driver gateways, NemoClaw can create the sandbox first and then recreate the OpenShell-managed Docker container with NVIDIA GPU access when that compatibility path is needed.
If the patch fails, onboarding keeps diagnostics and prints a manual cleanup command rather than deleting the failed sandbox automatically.

Prerequisites:

- Ensure NVIDIA GPU drivers are installed and working.
  - On generic NVIDIA hosts, `nvidia-smi` must succeed.
  - On Jetson/Tegra hosts shipping without `nvidia-smi`, the devicetree firmware fallback substitutes.
- NVIDIA Container Toolkit configured for Docker.

When GPU passthrough is enabled and a gateway already exists without it, onboarding first checks whether replacing the CPU-only gateway is safe.
If no other registered sandbox depends on that gateway, or if `--recreate-sandbox` is recreating the only registered sandbox with the same name, onboarding cleans up the stale gateway and continues.
If other sandboxes depend on the gateway or Docker state is unclear, onboarding exits without cleanup and prints targeted destroy or gateway-removal guidance.
To add GPU to an existing sandbox, rerun with `--recreate-sandbox`.
Set `NEMOCLAW_DOCKER_GPU_PATCH=0` only when you need to bypass the Linux Docker-driver compatibility patch during troubleshooting.

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.
Pass `--json` for machine-readable output that includes a `schemaVersion`, the default sandbox, recovery metadata, and the sandbox inventory.
Sandboxes with an active SSH session are marked with a `●` indicator so you can tell at a glance which sandbox you are already connected to in another terminal.
When a sandbox has a recorded dashboard port, the output includes its local dashboard URL.

```bash
nemoclaw list [--json]
nemoclaw list --json
```

### `nemoclaw deploy`

**Warning:**

The `nemoclaw deploy` command is deprecated.
Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
This command remains as a compatibility wrapper for the older Brev-specific bootstrap flow.
The Brev instance name is the positional argument.
The sandbox name comes from `NEMOCLAW_SANDBOX_NAME` and defaults to `my-assistant`; invalid sandbox names fail before Brev provisioning starts.

```bash
nemoclaw deploy <instance-name>
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

`connect` does not pull or serve a model itself, but it does inspect `NEMOCLAW_VLLM_MODEL` if you exported it for the managed-vLLM install path.
An unknown slug or a gated model (for example `deepseek-r1-distill-70b`) with no `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN` exits non-zero with the same error the installer would emit, before any sandbox readiness probe or SSH attach.
Unset the variable, or supply the missing token, before retrying.

When the live OpenShell gateway inference route differs from the route recorded in the NemoClaw registry, `connect` prints an explicit warning and realigns the shared gateway to the recorded route.
Use `nemoclaw inference set --provider <provider> --model <model>` to make an intentional route change.
If the sandbox is registered locally but missing from a healthy gateway, `connect` preserves the registry entry and points you to `rebuild --yes`, `onboard`, or `destroy` instead of deleting the metadata needed for recovery.

After a host reboot, the OpenShell gateway rotates its SSH host keys.
`connect` detects the resulting identity drift, prunes stale `openshell-*` entries from `~/.ssh/known_hosts`, and retries automatically.
You no longer need to re-run `nemoclaw onboard` after a reboot in this case.

```bash
nemoclaw my-assistant connect [--probe-only]
```

The `--probe-only` flag verifies the sandbox is reachable over SSH and exits without opening a shell.
Use it for health checks and scripted readiness probes.

### `nemoclaw <name> exec`

Run a single command non-interactively in a running sandbox via the OpenShell exec endpoint.
The command runs as the sandbox user with `HOME=/sandbox`, so in-sandbox tooling resolves NemoClaw-provisioned config the same way it does for `connect` and `openshell sandbox connect`.
This is the supported substitute for `docker exec` on the sandbox container; raw `docker exec` runs as root and lands on `HOME=/root`, where the selected agent config is not present.

<AgentOnly variant="openclaw">

OpenClaw config resolves under `/sandbox/.openclaw`.

```bash
nemoclaw my-assistant exec -- openclaw agent -m "What is 2+2?"
nemoclaw my-assistant exec --workdir /sandbox/workspace -- ls -la
```

</AgentOnly>
<AgentOnly variant="hermes">

Hermes config resolves under `/sandbox/.hermes`.

```bash
nemohermes my-assistant exec -- hermes --version
nemohermes my-assistant exec --workdir /sandbox/workspace -- ls -la
```

</AgentOnly>

Everything after `--` is forwarded verbatim to the sandbox command, including flags the inner command needs.
The exit code is the remote command's exit code.

| Flag | Description |
|------|-------------|
| `--workdir <dir>` | Working directory inside the sandbox |
| `--tty` / `--no-tty` | Allocate a pseudo-terminal; defaults to auto-detection (on when stdin and stdout are terminals) |
| `--timeout <seconds>` | Timeout in seconds (`0` means no timeout) |

### `nemoclaw <name> recover`

Restart the in-sandbox gateway and re-establish the host-side dashboard port-forward without opening an SSH session.
Use this after a sandbox pod restart, a sandbox crash, or whenever `nemoclaw <name> status` reports the gateway is not running but the sandbox is alive.

`recover` runs the same recovery the `connect` command performs as a side effect, but without dropping into a shell, so it is safe to call from scripts and automation.
It is idempotent.
If the gateway is already running, the command exits zero with a probe message and makes no changes.

```bash
nemoclaw my-assistant recover
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

Pass `--json` to emit a structured per-sandbox report instead of the text renderer.
The JSON output includes at least `schemaVersion`, `name`, `found`, `model`, `provider`, `phase`, `gatewayState`, `inferenceHealth`, `rpcIssue`, `hostGpuDetected`, `sandboxGpuEnabled`, `sandboxGpuMode`, `sandboxGpuDevice`, `openshellDriver`, `openshellVersion`, `policies`, `failureLayer`, and `dockerPaused`.
`openshellDriver` and `openshellVersion` are always strings (falling back to `"unknown"` when the registry has no value), so consumers can rely on `typeof` checks.
`failureLayer` is `null` when no preflight failure was detected and otherwise one of `docker_unreachable`, `sandbox_container_stopped`, or `sandbox_dashboard_port_conflict`; when set, `inferenceHealth` is suppressed to `null` so automation does not see a stale remote-provider healthy status during a local outage.
`dockerPaused` is `true` when NemoClaw detects that the Docker-driver sandbox container is paused.
In that case, text output keeps OpenShell's authoritative phase but prints a `docker unpause <container>` recovery hint instead of sending you directly to rebuild.
The command exits non-zero when the sandbox is missing locally, the gateway state is not `present`, the gateway reports a schema/protobuf mismatch (mirrored as `rpcIssue`), or `failureLayer` is non-null.
The alias form `nemoclaw <name> status --json` requires the sandbox to be registered locally; the canonical form `nemoclaw sandbox status <name> --json` is the one to use from automation that may run against an unknown sandbox name, since it still emits a JSON document with `found: false` instead of a text error.

```bash
nemoclaw my-assistant status
nemoclaw my-assistant status --json
nemoclaw sandbox status my-assistant --json
```

The command probes every inference provider and reports one of three states on the `Inference` line:

| State | Meaning |
|-------|---------|
| `healthy` | The provider endpoint returned a reachable response. |
| `unreachable` | The probe failed. The output includes the endpoint URL and a remediation hint. |
| `not probed` | The endpoint URL is not known (for example, `compatible-*` providers). |
| `not verified` | NemoClaw could not verify the sandbox or gateway state, so it skips inference probing. |

Local providers (Ollama, vLLM) probe the host-side health endpoint.
Remote providers (NVIDIA Endpoints, OpenAI, Anthropic, Gemini) use a lightweight reachability check; any HTTP response, including `401` or `403`, counts as reachable.
No API keys are sent.

For Local Ollama, the command also probes the authenticated proxy and prints an `Inference (auth proxy)` line when a proxy token is available.
Use that line to distinguish a healthy backend from a broken proxy path that the sandbox uses for inference.

For cloud-only providers, the output omits the NIM status line unless a NIM container is registered or an unexpected NIM container is running.

When the sandbox's recorded driver is `docker` and the host Docker daemon is not reachable, the command prints `Failure layer: docker_unreachable — Docker daemon is not reachable.` as the first line of stdout, suppresses the host-side `Inference` probe (which otherwise hits the remote provider directly and is misleading when the local stack is down), and exits with a non-zero status.

When the host Docker daemon is reachable but the per-sandbox container is stopped, the command prints `Failure layer: sandbox_container_stopped — sandbox container exists but is not running.` as the first line of stdout, suppresses the host-side `Inference` probe, and exits with a non-zero status.
If the sandbox's recorded dashboard port is also held by a foreign listener, the header escalates to `Failure layer: sandbox_dashboard_port_conflict — sandbox container is stopped and the dashboard port is held by a foreign listener.` so the operator can recover the port before restarting the sandbox.

If the sandbox or gateway cannot be verified, the command exits non-zero instead of reporting healthy inference from stale registry state.
When a locally registered sandbox is missing from the live gateway, status preserves the registry entry so the suggested `rebuild --yes` recovery can still find the sandbox metadata.
Gateway and dashboard health checks treat HTTP `401` from device auth as a live service, not as an offline gateway.

When sandbox GPU passthrough is enabled, the `Sandbox GPU` line includes the last CUDA usability proof state.
It reports `(CUDA verified)`, `(CUDA unverified)`, or `(last CUDA proof failed: <label>)` so automation and operators can distinguish configured GPU passthrough from proven CUDA access.
Failed proofs include remediation guidance for the detected platform.

A `Connected` line reports whether the sandbox has any active SSH sessions and, if so, how many.
The sandbox list in the status output includes the dashboard port suffix for sandboxes with a recorded dashboard port.

The Policy section displays the live enforced policy (fetched via `openshell policy get --full`), which reflects presets added or removed after sandbox creation.
When OpenShell reports an active policy version, the displayed YAML `version` line uses that active version instead of the static schema version.
If the sandbox is running an outdated agent version, the output includes an `Update` line with the available version and a `nemoclaw <name> rebuild` hint.

When other sandboxes have the same messaging channel enabled (Telegram, Discord, or Slack) with the same bot token, the output includes a cross-sandbox overlap warning so you can resolve the conflict before messages start dropping.
The command also tails `/tmp/gateway.log` inside the default sandbox and flags Telegram `409 Conflict` errors that indicate a duplicate consumer for the bot token.

```bash
nemoclaw my-assistant status
```

<AgentOnly variant="openclaw">

#### Checking the OpenClaw version

NemoClaw pins the OpenClaw version inside the sandbox at build time, not at runtime.
The NemoClaw runtime build target is declared by `OPENCLAW_VERSION` in the NemoClaw Dockerfiles.
The `min_openclaw_version` field in `nemoclaw-blueprint/blueprint.yaml` remains the compatibility floor for direct blueprint consumers, so it can be lower than the Dockerfile target.
Existing sandboxes do not auto-upgrade when a newer NemoClaw release ships a newer pin — you upgrade by rebuilding the sandbox.

`nemoclaw <name> status` prints the running OpenClaw version on the `Agent` line:

```console
$ nemoclaw my-assistant status
...
    Agent:    OpenClaw v2026.5.27
...
```

If the sandbox is running an OpenClaw older than the version this NemoClaw release pins, `status` and `connect` add an `Update` line pointing at `nemoclaw <name> rebuild` to pick up the newer version.
The rebuild reuses the existing sandbox name and persisted credentials, so messaging tokens and provider keys carry over.

</AgentOnly>
<AgentOnly variant="hermes">

#### Checking the Hermes version

NemoClaw pins the Hermes version inside the sandbox image at build time, not at runtime.
The Hermes agent manifest declares the expected version and the `hermes --version` probe command.
Existing sandboxes do not auto-upgrade when a newer NemoClaw release ships a newer Hermes pin; you upgrade by rebuilding the sandbox.

`nemohermes <name> status` prints the running Hermes version on the `Agent` line:

```console
$ nemohermes my-assistant status
...
    Agent:    Hermes v2026.5.16
...
```

If the sandbox is running an older Hermes version than this NemoClaw release expects, `status` and `connect` add an `Update` line pointing at `nemohermes <name> rebuild` to pick up the newer version.
The rebuild reuses the existing sandbox name and persisted credentials, so messaging tokens and provider keys carry over.

</AgentOnly>

### `nemoclaw <name> doctor`

Run a focused health check for one sandbox and the host services it depends on.
The command checks the local CLI build, Docker daemon, OpenShell CLI, NemoClaw gateway container, gateway port mapping, live sandbox state, inference route, provider reachability, messaging channel conflicts, Ollama reachability, and the cloudflared tunnel state.

Warnings do not make the command fail.
Failed checks exit non-zero so scripts can use `doctor` as a readiness gate.
Use `--json` for machine-readable output.

```bash
nemoclaw my-assistant doctor [--json]
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.
Use `--tail <lines>` or `-n <lines>` to limit the number of returned lines.
Use `--since <duration>` to show recent logs only, such as `5m`, `1h`, or `30s`.
The command reads both agent gateway output and OpenShell audit events, so policy denials appear alongside the gateway log stream.
If one log source is unavailable, NemoClaw prints a warning and keeps reading the remaining source.
NemoClaw's `--tail <lines>` flag is a line-count flag; the lower-level `openshell logs --tail` flag means follow live output, so use `openshell logs <sandbox> -n <lines>` when running OpenShell directly for a fixed line count.

```bash
nemoclaw my-assistant logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]
```

### `nemoclaw <name> dashboard-url`

<AgentOnly variant="openclaw">

Print the authenticated OpenClaw dashboard URL for a running sandbox.
Use this when you are on a remote machine, using an SSH or reverse tunnel, or need a complete URL for a browser session.

```bash
nemoclaw my-assistant dashboard-url
nemoclaw my-assistant dashboard-url --quiet
```

The default output includes a label and a warning.
Pass `--quiet` or `-q` to print only the URL to stdout so scripts can capture it:

```bash
URL=$(nemoclaw my-assistant dashboard-url --quiet)
```

**Warning:**

Treat the authenticated dashboard URL like a password.
Do not log it, share it, or commit it to version control.

</AgentOnly>
<AgentOnly variant="hermes">

`dashboard-url` is not applicable to Hermes sandboxes because Hermes exposes an OpenAI-compatible API endpoint instead of the OpenClaw dashboard URL.
Use `nemohermes my-assistant status` to find the forwarded API endpoint.
The Hermes API remains on port `8642` and uses `/v1` for OpenAI-compatible clients.
If you enabled `NEMOCLAW_HERMES_DASHBOARD=1`, use the optional Hermes dashboard port from the status output instead.

</AgentOnly>

### `nemoclaw <name> gateway-token`

<AgentOnly variant="openclaw">

Print the OpenClaw gateway auth token for a running sandbox to stdout.
The token is required by `openclaw tui` and the OpenClaw dashboard URL.
Use `dashboard-url` for browser access; use `gateway-token` only when automation needs the raw token.
Pipe it into automation or capture it into an environment variable:

```bash
TOKEN=$(nemoclaw my-assistant gateway-token --quiet)
export OPENCLAW_GATEWAY_TOKEN="$TOKEN"
```

The token is written to stdout with no surrounding text.
A one-line security warning is written to stderr; pass `--quiet` (or `-q`) to suppress it.
The command exits non-zero with a diagnostic on stderr when the sandbox is not registered or when the token cannot be retrieved (for example, if the sandbox is not running).

**Warning:**

Treat the gateway token like a password.
Do not log it, share it, or commit it to version control.

</AgentOnly>
<AgentOnly variant="hermes">

`gateway-token` is not applicable to Hermes sandboxes.
Hermes API access uses bearer-token authentication configured through the Hermes runtime, not the OpenClaw gateway token.
If you need the endpoint for an OpenAI-compatible client, use `nemohermes my-assistant status` and the API URL it reports.

</AgentOnly>

### `nemoclaw <name> destroy`

Stop the NIM container, remove the host-side Docker image built during onboard, and delete the sandbox.
This removes the sandbox from the registry.
For Ollama-backed sandboxes, `destroy` also asks Ollama to unload currently loaded models and clears stale auth proxy state on a best-effort basis.

**Warning:**

This command permanently deletes the sandbox **and its persistent volume**.
All workspace files (use the `nemoclaw-user-manage-sandboxes` skill) (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes) are lost.
Back up your workspace first with `nemoclaw <name> snapshot create` or see Backup and Restore (use the `nemoclaw-user-manage-sandboxes` skill).
If you want to upgrade the sandbox while preserving state, use `nemoclaw <name> rebuild` instead.

If another terminal has an active SSH session to the sandbox, `destroy` prints an active-session warning and requires a second confirmation before it proceeds.
Pass `--yes`, `-y`, or `--force` to skip the prompt in scripted workflows.
By default, `destroy` preserves the shared NemoClaw gateway.
Pass `--cleanup-gateway` to remove the shared gateway when destroying the last sandbox, or `--no-cleanup-gateway` to force preservation when environment defaults request cleanup.

```bash
nemoclaw my-assistant destroy [--yes|-y|--force] [--cleanup-gateway|--no-cleanup-gateway]
```

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.
Before applying, the command shows which endpoints the preset would open and prompts for confirmation.

```bash
nemoclaw my-assistant policy-add
```

To apply a specific preset without the interactive picker, pass its name as a positional argument:

```bash
nemoclaw my-assistant policy-add pypi --yes
```

The positional form is required in scripted workflows.
Set `NEMOCLAW_NON_INTERACTIVE=1` instead of `--yes` if you want the same behavior from an environment variable.
If the preset name is unknown or already applied, the command exits non-zero with a clear error.
Custom preset files are tracked with the sandbox that applied them.
`policy-list`, `policy-add`, and `policy-remove` compare the local registry and live gateway state using that sandbox-scoped preset metadata, so custom presets do not appear missing just because they are not part of the built-in preset catalog.
Before `policy-add` writes a merged policy, it reads and parses the current live policy from OpenShell.
If the live policy read returns non-empty output that NemoClaw cannot parse, the command exits non-zero instead of overwriting the live policy with only the new preset.
Fix the gateway or policy read problem, then rerun the command.
For custom presets, the command also reports when the preset reached the gateway but NemoClaw could not record it in the local sandbox registry, because unrecorded custom presets will not appear in `policy-list` or `status`.
Recover or re-onboard the sandbox, then re-apply the custom preset.

| Flag | Description |
|------|-------------|
| `--from-file <path>` | Apply a custom preset YAML file instead of a built-in preset |
| `--from-dir <path>` | Apply every custom preset YAML file in a directory in lexicographic order |
| `--yes`, `--force` | Skip the confirmation prompt (requires a preset name, `--from-file`, or `--from-dir`) |
| `--dry-run` | Preview the endpoints a preset would open without applying changes |

Use `--dry-run` to audit a preset before applying it:

```bash
nemoclaw my-assistant policy-add --dry-run
```

Apply a custom preset file when you need to grant access to an endpoint that is not covered by a built-in preset:

```bash
nemoclaw my-assistant policy-add --from-file ./presets/my-internal-api.yaml
```

For batch workflows, apply all preset files from a directory:

```bash
nemoclaw my-assistant policy-add --from-dir ./presets/ --yes
```

Review every host in custom preset files before applying them.
Custom presets bypass the built-in preset review process and can widen sandbox egress.

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.
The command cross-references the local registry against the live gateway state (via `openshell policy get`), so it flags presets that are applied in one place but not the other.
This catches desync caused by external edits to the gateway policy or stale registry entries after a manual rollback.

```bash
nemoclaw my-assistant policy-list
```

### `nemoclaw <name> policy-remove`

Remove a previously applied policy preset from a sandbox.
The command lists only the presets currently applied, prompts you to select one, shows the endpoints that would be removed, and asks for confirmation before narrowing egress.

```bash
nemoclaw my-assistant policy-remove
```

To remove a specific preset non-interactively, pass its name as a positional argument:

```bash
nemoclaw my-assistant policy-remove pypi --yes
```

Set `NEMOCLAW_NON_INTERACTIVE=1` as an alternative to `--yes`.
If the preset is unknown or not currently applied, the command exits non-zero with a clear error.

| Flag | Description |
|------|-------------|
| `--yes`, `--force` | Skip the confirmation prompt (requires a preset name) |
| `--dry-run` | Preview which endpoints would be removed without applying changes |

Unchecking a preset in the onboard TUI checkbox also removes it from the sandbox.

### `nemoclaw <name> hosts-add`

Add a host alias to the sandbox pod template.
Use this when a sandbox needs a stable LAN-only name, such as a local SearXNG or internal model endpoint, without dropping to `docker exec` and `kubectl patch`.
Host alias commands use the legacy Kubernetes gateway `Sandbox` resource path.
They are not supported on Docker-driver or VM-driver sandboxes because those drivers do not run the gateway cluster container that owns this resource.

```bash
nemoclaw my-assistant hosts-add searxng.local 192.168.1.105
```

The command validates the hostname and IP address, rejects duplicate hostnames, and patches `spec.podTemplate.spec.hostAliases` on the sandbox resource.

| Flag | Description |
|------|-------------|
| `--dry-run` | Print the JSON patch for the resulting `hostAliases` list without applying it |

### `nemoclaw <name> hosts-list`

List host aliases configured on the sandbox resource.

```bash
nemoclaw my-assistant hosts-list
```

### `nemoclaw <name> hosts-remove`

Remove a hostname from the sandbox `hostAliases` list.

```bash
nemoclaw my-assistant hosts-remove searxng.local
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Print the JSON patch for the resulting `hostAliases` list without applying it |

### `nemoclaw <name> channels list`

List the messaging channels NemoClaw knows about (`telegram`, `discord`, `slack`, `wechat`, `whatsapp`) with a short description.
The command is a static reference; it does not consult credentials or the running sandbox.
WeChat and WhatsApp are experimental.

```bash
nemoclaw my-assistant channels list
```

### `nemoclaw <name> channels add <channel>`

Register a messaging channel with the sandbox and rebuild so the image picks up the new channel.
Channels fall into three login modes:

- **Token paste** (`telegram`, `discord`, `slack`): the command prompts for any missing token and registers it with the OpenShell gateway.
- **Host-side QR** (`wechat`, experimental): the command renders an iLink QR code on the host and you scan it from WeChat on your phone.
  On confirm, NemoClaw captures the bot token, registers it with the OpenShell gateway, and stores non-secret per-account metadata (`WECHAT_ACCOUNT_ID`, `WECHAT_BASE_URL`, `WECHAT_USER_ID`) for the in-sandbox bridge.
  NemoClaw automatically adds the scanning operator's WeChat user ID to `WECHAT_ALLOWED_IDS`.
  Supply additional comma-separated IDs to authorize more DM senders.
  NemoClaw advertises WeChat for both OpenClaw (the `@tencent-weixin/openclaw-weixin` plugin) and Hermes (the built-in iLink WeChat adapter).
- **In-sandbox QR** (`whatsapp`, experimental): the command records the channel without a host-side token or OpenShell credential provider.
  NemoClaw advertises WhatsApp for OpenClaw and Hermes sandboxes; after rebuild, run `openclaw channels login --channel whatsapp` for OpenClaw or `hermes whatsapp` for Hermes.
  This intentionally leaves QR-created mutable session state in the sandbox until you unpair it or clear the durable agent state.

After registering the channel, NemoClaw asks whether to rebuild immediately.
Running `add` for an already-configured channel simply overwrites the stored credentials where applicable — the operation is idempotent.
Channel names are trimmed and lowercased before NemoClaw stores credentials, names bridge providers, or prints rebuild messages.
NemoClaw requires the matching built-in network policy preset YAML to be present.
A missing or malformed preset YAML (no `network_policies:` section) aborts `channels add` before any token prompt, registry write, or rebuild prompt.
With the preset file in place, NemoClaw applies it to the sandbox before the rebuild so the bridge has egress to its upstream API.
When the apply step itself fails after the registry write on a fresh add, NemoClaw attempts to roll back the bridge providers, the `messagingChannels` entry, and any staged environment credentials, then exits without prompting for a rebuild; if any gateway-side step (provider detach or delete) fails the rollback continues and prints a `Rollback could not fully clean <surfaces>` warning so the operator can clean up manually.
When the same failure happens on a re-add of an already-enabled channel, NemoClaw restores the prior `messagingChannels` entry, restores staged environment credentials when available, restores registry credential hashes, and attempts to re-upsert the prior bridge providers, but flags `gateway-providers` as residual because the in-flight upsert may have left the gateway with the new token; verify the gateway bridge before relying on the channel.
Restore the preset YAML and re-run `nemoclaw <name> channels add <channel>`.
For Telegram, Discord, and Slack, a rebuild triggered by `channels add` also verifies that the selected bridge starts and reports credential, startup, or plugin discovery warnings.

```bash
nemoclaw my-assistant channels add telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Validate the channel name and matching policy preset without prompting for credentials, contacting the gateway, or rebuilding |
| `--force` | Add the channel even when another sandbox already uses the same messaging credential, bypassing the cross-sandbox conflict warning (otherwise `channels add` warns and, when non-interactive, aborts) |

Slack requires both `SLACK_BOT_TOKEN` (bot user OAuth) and `SLACK_APP_TOKEN` (app-level Socket Mode token); the command prompts for each in turn.
Optional Slack allowlists come from `SLACK_ALLOWED_USERS` and `SLACK_ALLOWED_CHANNELS` at rebuild time.
When `NEMOCLAW_NON_INTERACTIVE=1` is set, any missing token fails fast and no rebuild prompt is shown — instead, the change is queued and you are told to run `nemoclaw <name> rebuild` manually.
If you omit the required `<channel>` argument, the CLI prints the `channels add <channel>` usage with the supported channel list instead of falling back to top-level help.

### `nemoclaw <name> channels remove <channel>`

Clear the stored credentials for a messaging channel and rebuild the sandbox so the image drops the channel.
Running `remove` for a channel that was never configured is a no-op against the credentials file and still triggers the rebuild prompt.
When the bridge provider is attached to a live sandbox, NemoClaw detaches it before deleting the provider from the OpenShell gateway.
If the matching built-in policy preset is applied, such as `telegram`, `discord`, `slack`, `wechat`, or `whatsapp`, NemoClaw also removes that preset so the upstream API is no longer allow-listed after the channel is gone.
NemoClaw also strips the channel from `session.policyPresets` so a subsequent `onboard --resume` does not re-apply the preset on the next rebuild.

For QR-paired channels (today: WhatsApp), NemoClaw destructively clears the in-sandbox session directory before the rebuild so the `state_dirs` backup does not restore the auth blob and let the channel reconnect:

- OpenClaw: `/sandbox/.openclaw/<channel>/` (for example `/sandbox/.openclaw/whatsapp/`).
- Hermes: `/sandbox/.hermes/platforms/<channel>/` (for example `/sandbox/.hermes/platforms/whatsapp/`).

The cleanup tries `openshell sandbox exec` first and falls back to SSH if the exec wrapper does not return the success sentinel. If both transports fail (the sandbox is stopped, the gateway is down, or SSH cannot reach it) the command refuses to proceed to the rebuild and asks you to start the sandbox and re-run, so a half-removed state cannot leave stale Baileys auth files behind for the next rebuild to restore.

```bash
nemoclaw my-assistant channels remove telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be removed without clearing credentials or rebuilding |

As with `channels add`, `NEMOCLAW_NON_INTERACTIVE=1` skips the rebuild prompt and queues the change for a manual `nemoclaw <name> rebuild`.
If you omit the required `<channel>` argument, the CLI prints the `channels remove <channel>` usage with the supported channel list.

Host-side removal is the supported path because agent channel config is baked into the container image at build time (`/sandbox/.openclaw/openclaw.json` for OpenClaw and `/sandbox/.hermes/.env` for Hermes); agent-specific channel removals inside the sandbox would modify the running config but not persist changes across rebuilds.

### `nemoclaw <name> channels stop <channel>`

Pause a single messaging bridge (`telegram`, `discord`, `slack`, `wechat`, or `whatsapp`) without clearing its credentials.
The channel is marked disabled in the per-sandbox registry, and the sandbox is rebuilt so the onboard step skips registering the bridge with the gateway.
The provider stays registered with the OpenShell gateway, so a later `channels start` brings the bridge back without re-entering tokens.

```bash
nemoclaw my-assistant channels stop telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be disabled without updating the registry or rebuilding |

Use `channels stop` instead of `channels remove` when you want to pause a bridge temporarily. `channels remove` is destructive to credentials; `channels stop` is not.

### `nemoclaw <name> channels start <channel>`

Re-enable a channel previously paused with `channels stop`. The channel is removed from the disabled list, the sandbox is rebuilt, and the bridge registers with the gateway again using the stored credentials.

```bash
nemoclaw my-assistant channels start telegram
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Report the channel that would be re-enabled without updating the registry or rebuilding |

### `nemoclaw <name> channels status`

Run channel-specific runtime diagnostics. For WhatsApp the command probes the sandbox to separately report pairing/session state, the Noise WebSocket connection, inbound event delivery, and policy/config coverage; a paired channel with no observed inbound delivery exits non-zero with verdict `idle` so an unhealthy bridge cannot pass as healthy.

```bash
nemoclaw my-assistant channels status --channel whatsapp
```

| Flag | Description |
|------|-------------|
| `--channel <channel>` | Channel to inspect; defaults to `whatsapp` when registered |
| `--json` | Emit the diagnostic report as JSON (exit non-zero when the verdict is not `healthy` or `unknown`) |

The probe is bounded by an in-sandbox `openshell sandbox exec` with a hard timeout, captures only short matched bridge log signals (e.g. `connection.open`, `401 unauthorized`, `qr expired`), and never forwards message bodies to the host diagnostic output.

### `nemoclaw <name> skill install <path>`

Deploy a skill directory to a running sandbox.
The command validates the `SKILL.md` frontmatter (a `name` field is required), uploads all non-dot files preserving subdirectory structure, and performs agent-specific post-install steps.

```bash
nemoclaw my-assistant skill install ./my-skill/
```

The skill directory must contain a `SKILL.md` file with YAML frontmatter that includes a `name` field.
Skill names must contain only alphanumeric characters, dots, hyphens, and underscores.

<AgentOnly variant="openclaw">

OpenClaw plugins are a different kind of extension. To install an OpenClaw plugin, see Install OpenClaw Plugins.

</AgentOnly>
<AgentOnly variant="hermes">

Hermes plugins are different from NemoClaw skills.
`skill install` uploads agent skills, while Hermes plugin configuration is managed by the Hermes runtime and the NemoClaw Hermes plugin baked into the sandbox image.

</AgentOnly>

Run `nemoclaw <name> skill install --help` to print usage for this subcommand.
If you pass a plugin-shaped directory to `skill install`, the CLI prints a plugin-specific hint instead of treating it as a missing skill file.

Files with names starting with `.` (dotfiles) are skipped and listed in the output.
Files with unsafe path characters are rejected to prevent shell injection.

If the skill already exists on the sandbox, the command updates it in place and preserves chat history.
For new installs, the agent session index is refreshed so the agent discovers the skill on the next session.

### `nemoclaw <name> skill remove <skill>`

Remove an installed skill from a running sandbox by skill name.
The command validates the skill name, removes the sandbox upload directory, and refreshes the agent session index so the remaining skills are rediscovered on the next session.

<AgentOnly variant="openclaw">

For OpenClaw, the command also removes the OpenClaw home-directory mirror when present.

</AgentOnly>
<AgentOnly variant="hermes">

For Hermes, restart the Hermes gateway if prompted so the removal takes effect.

</AgentOnly>

```bash
nemoclaw my-assistant skill remove my-skill
```

Use the skill name from the `SKILL.md` frontmatter, not the local directory name.
Skill names must contain only alphanumeric characters, dots, hyphens, and underscores, and cannot be `.` or `..`.

### `nemoclaw <name> agents add`

Run the OpenClaw interactive add wizard inside the sandbox.
This is a thin pass-through to `openclaw agents add` via `openshell sandbox exec`; flags accepted by the in-sandbox CLI are forwarded verbatim.

```bash
nemoclaw my-assistant agents add
nemoclaw my-assistant agents add work --model gpt-4o
```

### `nemoclaw <name> agents delete <agent-id>`

Remove an OpenClaw agent from the sandbox.
This is a thin pass-through to `openclaw agents delete <id>` via `openshell sandbox exec`; the OpenClaw CLI owns gateway dispatch (`agents.delete`), host-side workspace removal, and config edits.
Flags accepted by the in-sandbox CLI (`--force`, `--json`) are forwarded verbatim.

```bash
nemoclaw my-assistant agents delete work
nemoclaw my-assistant agents delete work --force --json
```

### `nemoclaw <name> sessions`

List OpenClaw conversation sessions in the sandbox.
With no subcommand the in-sandbox CLI lists stored sessions for the configured default agent.
This is a thin pass-through to `openclaw sessions` via `openshell sandbox exec`; flags accepted by the in-sandbox CLI are forwarded verbatim.

```bash
nemoclaw my-assistant sessions
nemoclaw my-assistant sessions --all-agents --json
```

### `nemoclaw <name> sessions list`

Pass-through to `openclaw sessions list` inside the sandbox.
Accepts every flag the in-sandbox CLI does (`--agent`, `--all-agents`, `--active`, `--limit`, `--json`, `--store`, `--verbose`).

```bash
nemoclaw my-assistant sessions list
nemoclaw my-assistant sessions list --agent work --json
```

### `nemoclaw <name> sessions reset <key>`

Archive a session and rebind its key to a fresh `sessionId` by invoking the OpenClaw gateway `sessions.reset` RPC inside the sandbox.
Goes through `openshell sandbox exec` -> `openclaw gateway call sessions.reset`, so the gateway owns archival, lock handling, and lifecycle events; the host never edits `sessions.json` directly.

```bash
nemoclaw my-assistant sessions reset main
nemoclaw my-assistant sessions reset agent:work:telegram:t-1
nemoclaw my-assistant sessions reset telegram:t-1 --agent work --reason new
nemoclaw my-assistant sessions reset agent:main:main --json
```

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent id when `<key>` is an alias rather than the canonical `agent:<id>:<rest>` form. |
| `--reason new\|reset` | `reset` (default) archives the prior transcript; `new` rebinds without preserving the archive trail. |
| `--json` | Print the reset result as JSON. |
| `--verbose` | Print the gateway entry payload after a successful reset. |

The `<key>` argument accepts an alias (e.g. `main`, `telegram:t-1`) or the canonical `agent:<id>:<rest>` form.
Mismatched `--agent` plus canonical-key combinations are refused before the gateway is invoked.

### `nemoclaw <name> sessions delete <key>`

Remove a session entry by invoking the OpenClaw gateway `sessions.delete` RPC inside the sandbox.
The gateway refuses to remove the agent's main session.
The transcript on disk is removed by default; pass `--keep-transcript` to retain it.

```bash
nemoclaw my-assistant sessions delete telegram:t-1
nemoclaw my-assistant sessions delete agent:work:telegram:t-1
nemoclaw my-assistant sessions delete telegram:t-1 --agent work --keep-transcript
nemoclaw my-assistant sessions delete agent:main:slack:c-9 --json
```

| Flag | Description |
|------|-------------|
| `--agent <id>` | Agent id when `<key>` is an alias rather than the canonical `agent:<id>:<rest>` form. |
| `--keep-transcript` | Retain the session transcript on disk after the entry is removed. |
| `--json` | Print the delete result as JSON. |
| `--verbose` | Print the gateway entry payload after a successful delete. |

### `nemoclaw <name> rebuild`

Upgrade a sandbox to the current agent version while preserving workspace state.
The command backs up workspace state, destroys the old sandbox (including its host-side Docker image), recreates it with the current image via `onboard --resume`, and restores workspace state into the new sandbox.
Credentials are stripped from backups before storage.
Policy presets applied to the old sandbox are reapplied to the new one so your egress rules survive the rebuild.
The recorded sandbox GPU mode is preserved across rebuild.
A sandbox onboarded with an explicit GPU opt-out (stored as `sandboxGpuMode: "0"`, plus legacy registry entries that only record `gpuEnabled: false`) is recreated with the same opt-out, so the inner `onboard --resume` skips the Docker CDI GPU preflight on hosts without an NVIDIA GPU.
Auto-mode sandboxes remain auto.

```bash
nemoclaw my-assistant rebuild [--yes|-y|--force] [--verbose|-v]
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y`, `--force` | Skip the confirmation prompt |
| `--verbose`, `-v` | Log SSH commands, exit codes, and session state (also enabled by `NEMOCLAW_REBUILD_VERBOSE=1`) |

If another terminal has an active SSH session to the sandbox, `rebuild` prints an active-session warning and requires confirmation before destroying the sandbox.
Pass `--yes`, `-y`, or `--force` to skip the prompt in scripted workflows.

The sandbox must be running for the backup step to succeed.
If an archive command reports partial output while still producing usable data, `rebuild` keeps the captured backup entries and reports only the manifest-defined paths that could not be archived.
If any required state path still cannot be backed up, `rebuild` exits before destroying the original sandbox.

<AgentOnly variant="openclaw">

After restore, the command runs `openclaw doctor --fix` for cross-version structure repair.

</AgentOnly>
<AgentOnly variant="hermes">

After restore, the command restores Hermes manifest-defined state and starts the rebuilt Hermes gateway with the regenerated `/sandbox/.hermes` config.

</AgentOnly>

### `nemoclaw update`

Check for a NemoClaw CLI update and, when requested, run the maintained installer flow.
This command is a discoverable CLI wrapper around the supported installer path:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

```bash
nemoclaw update [--check] [--yes|-y]
```

| Flag | Description |
|------|-------------|
| `--check` | Show the current version, latest maintained version, install type, and maintained update command without changing anything |
| `--yes`, `-y` | Skip the confirmation prompt and run the maintained installer flow |

`nemoclaw update` updates the host-side NemoClaw installation.
The maintained installer flow follows the admin-promoted `lkg` release tag by default, so it may trail the newest semver or `latest` tag while validation completes.
It does not replace `nemoclaw upgrade-sandboxes`; use that command to inspect or rebuild existing sandboxes after the CLI has been updated.
When the command is running from a source checkout, it reports that state and does not replace the checkout with a global package install.

### `nemoclaw upgrade-sandboxes`

Rebuild sandboxes whose base image is older than the one currently pinned by NemoClaw.
NemoClaw resolves the digest of `ghcr.io/nvidia/nemoclaw/sandbox-base:latest` from the registry, then compares it against the digest each sandbox was created with.
Sandboxes that match the current digest are left alone.

```bash
nemoclaw upgrade-sandboxes [--check] [--auto] [--yes|-y]
```

| Flag | Description |
|------|-------------|
| `--check` | List stale sandboxes without rebuilding any of them. Exits non-zero if any are stale. |
| `--auto` | Rebuild every stale sandbox without prompting. Used by the installer to upgrade in place. |
| `--yes`, `-y` | Skip the confirmation prompt for the rebuild plan. |

Each rebuild reuses the same workspace backup-and-restore flow as `nemoclaw <name> rebuild`, so workspace files survive the upgrade.
If the registry is unreachable (offline or firewalled hosts), NemoClaw falls back to the unpinned `:latest` tag and reports that the digest could not be resolved instead of failing.

### `nemoclaw backup-all`

Back up all registered running sandboxes to `~/.nemoclaw/rebuild-backups/`.
Sandboxes that are not running are skipped.

```bash
nemoclaw backup-all
```

The installer calls `backup-all` automatically before onboarding to protect against data loss during OpenShell upgrades.

### `nemoclaw <name> snapshot create`

Create a timestamped snapshot of sandbox state.
Snapshots are stored in `~/.nemoclaw/rebuild-backups/<name>/`.

```bash
nemoclaw my-assistant snapshot create
```

| Flag | Description |
|------|-------------|
| `--name <label>` | Attach a human-readable label to the snapshot so you can restore by name later |

Names must be 1 to 63 characters from `[A-Za-z0-9._-]`, start with an alphanumeric character, and cannot look like a version selector (`v1`, `v2`, ...). Duplicate names per sandbox are rejected; pick a different name or delete the existing snapshot first.

```bash
nemoclaw my-assistant snapshot create --name before-upgrade
```

### `nemoclaw <name> snapshot list`

List available snapshots for a sandbox as a table of version, name, timestamp, and path.
Versions (`v1`, `v2`, ...) are computed on read from timestamp-ascending order, so `v1` is the oldest snapshot and `vN` is the newest. Snapshots created before this feature landed are numbered retroactively.

```bash
nemoclaw my-assistant snapshot list
```

### `nemoclaw <name> snapshot restore [selector] [--to <dst>] [--force] [--yes|-y]`

Restore sandbox state from a snapshot.
The sandbox must be running before you restore.
If no selector is provided, the latest snapshot is used.
Restore performs a clean replacement of each state directory, removing files that were added after the snapshot was taken.

The selector accepts any of:

- A version (`v1`, `v2`, ..., `vN`) from `snapshot list`.
- An exact name passed to `snapshot create --name`.
- An exact timestamp.

Pass `--to <dst>` to restore the snapshot into a different sandbox instead of the source.
When `dst` does not exist, it is auto-created by reusing the source sandbox's container image — no re-onboarding needed.
When `dst` already exists, `snapshot restore --to <dst>` refuses by default to avoid silently mutating the destination's filesystem.
To overwrite an existing destination, pass `--force`: the command deletes `dst`, then recreates it from the source's image and restores the snapshot into the fresh copy.
The `--force` path prompts interactively to confirm the destination name before deleting.
Pass `--yes` (or set `NEMOCLAW_NON_INTERACTIVE=1`) to skip the prompt.
The snapshot selector and source pod image are both validated before any deletion, so a bad selector or unresolvable image cannot destroy `dst` and only fail afterwards.

```bash
# restore latest snapshot in-place
nemoclaw my-assistant snapshot restore

# restore by version
nemoclaw my-assistant snapshot restore v3

# restore by user-assigned name
nemoclaw my-assistant snapshot restore before-upgrade

# restore by exact timestamp
nemoclaw my-assistant snapshot restore 2026-04-21T07-35-55-987Z

# clone v3 into a new sandbox
nemoclaw my-assistant snapshot restore v3 --to my-assistant-clone

# overwrite an existing destination with v3, non-interactively
nemoclaw my-assistant snapshot restore v3 --to my-assistant-clone --force --yes
```

When `--to` names an existing sandbox, restore refuses to overwrite it unless you pass `--force`.
With `--force`, NemoClaw confirms the destructive restore unless you also pass `--yes` or run with `NEMOCLAW_NON_INTERACTIVE=1`.
Use this path only when the destination sandbox can be replaced by the selected snapshot.

## `nemoclaw <name> share mount`

Mount the sandbox filesystem on the host machine via SSHFS for bidirectional file sharing.
Files edited on the host appear instantly inside the sandbox, and vice versa.

```console
$ nemoclaw my-assistant share mount
✓ Mounted /sandbox → ~/.nemoclaw/mounts/my-assistant
```

| Argument | Default | Description |
|----------|---------|-------------|
| `sandbox-path` | `/sandbox` | Remote path inside the sandbox to mount |
| `local-mount-point` | `~/.nemoclaw/mounts/<name>` | Local directory to mount onto (auto-created) |

Prerequisites:

- `sshfs` must be installed on the host (`sudo apt-get install sshfs` on Linux, `brew install macfuse && brew install sshfs` on macOS).
- The sandbox must be running.
- The remote sandbox path must exist. NemoClaw verifies it against the target sandbox before invoking `sshfs` and prints a `connect`, then `ls <path>` check when the probe fails.
- Sandboxes created before the `openssh-sftp-server` base image update must be rebuilt with `nemoclaw <name> rebuild`.
- The local mount path must be on a writable filesystem; FUSE creates the mount on the host side.
  If the default `~/.nemoclaw/mounts/<name>` lives on a read-only filesystem, pass an explicit writable path as the second positional argument.

```bash
# mount a specific path to a custom local directory
nemoclaw my-assistant share mount /sandbox/workspace ~/my-workspace
```

## `nemoclaw <name> share unmount`

Unmount a previously mounted sandbox filesystem.

```bash
nemoclaw my-assistant share unmount
```

| Argument | Default | Description |
|----------|---------|-------------|
| `local-mount-point` | `~/.nemoclaw/mounts/<name>` | Local directory to unmount |

### `nemoclaw <name> share status`

Check whether the sandbox filesystem is currently mounted.

```console
$ nemoclaw my-assistant share status
● Mounted at ~/.nemoclaw/mounts/my-assistant
```

| Argument | Default | Description |
|----------|---------|-------------|
| `local-mount-point` | `~/.nemoclaw/mounts/<name>` | Local directory to check |

## `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```bash
openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw tunnel start`

Start optional host auxiliary services.
This is the cloudflared tunnel when `cloudflared` is installed, which exposes the dashboard with a public URL.
Channel messaging (Telegram, Discord, Slack) is not started here; it is configured during `nemoclaw onboard` and runs through OpenShell-managed constructs.

```bash
nemoclaw tunnel start
```

By default, NemoClaw starts a Cloudflare quick tunnel and prints the generated `*.trycloudflare.com` URL when `cloudflared` reports it.
Set `CLOUDFLARE_TUNNEL_TOKEN` to start a Cloudflare named tunnel instead.
The named tunnel hostname and `localhost:<dashboard-port>` route must already be configured in the Cloudflare dashboard.
NemoClaw passes the token to `cloudflared` through the `TUNNEL_TOKEN` environment variable, so the token does not appear in the `cloudflared` command-line arguments.

```bash
export CLOUDFLARE_TUNNEL_TOKEN=<cloudflare-tunnel-token>
nemoclaw tunnel start
```

`nemoclaw start` remains as a deprecated alias that prints a warning and delegates to `tunnel start`.

### `nemoclaw tunnel stop`

Stop host auxiliary services that `nemoclaw tunnel start` started (for example cloudflared).

<AgentOnly variant="openclaw">

NemoClaw also tries to stop the OpenClaw gateway inside the selected or default sandbox, which stops in-sandbox messaging channel polling for that sandbox.

</AgentOnly>
<AgentOnly variant="hermes">

For Hermes sandboxes, use channel lifecycle commands when you only want to pause messaging without interrupting the Hermes gateway.

</AgentOnly>

Use `nemoclaw <name> channels stop <channel>` when you only want to pause one bridge without stopping the gateway.

```bash
nemoclaw tunnel stop
```

`nemoclaw stop` remains as a deprecated alias that prints a warning and delegates to `tunnel stop`.

### `nemoclaw start`

**Warning:**

Deprecated. Use `nemoclaw tunnel start` instead.

This command remains as a compatibility alias to `nemoclaw tunnel start`.

### `nemoclaw stop`

**Warning:**

Deprecated. Use `nemoclaw tunnel stop` instead.

This command remains as a compatibility alias to `nemoclaw tunnel stop`.

### `nemoclaw status`

Show the sandbox list and the status of host auxiliary services (for example cloudflared).
Pass `--json` for machine-readable output with registered sandboxes, service state, inference routes, and messaging health.
For each listed sandbox, the text output includes the configured inference provider and model plus whether an active SSH session is connected.

```bash
nemoclaw status
nemoclaw status --json
```

When at least one sandbox is registered and the named NemoClaw gateway is unreachable, unhealthy, or attached to a different sandbox, the command prints a `gateway: down [state] (reason)` line between the sandbox list and the host-service list.
The command classifies the failing layer when possible: the named gateway port is not accepting connections, the named gateway is running but not Connected, the active OpenShell gateway points at a different name, or the named gateway is not configured at all.
It then suggests `openshell gateway start --name nemoclaw` or `nemoclaw onboard --resume` to recover.
It exits with code `1` so shell scripts and CI can detect the degraded state from `$?`.
For `--json`, the structured output includes `gatewayHealth`, and the exit code is set after the report is generated.
A clean machine with no registered sandboxes keeps the legacy `0` exit because no gateway is expected to be configured yet.
If cloudflared is installed but not running, the host-service section reports whether the PID file is missing, invalid, or points at a dead process, then suggests `nemoclaw tunnel start` as the recovery command.

### `nemoclaw inference get`

Show the active live inference provider and model from the NemoClaw-managed OpenShell gateway.
Use this command when you want the direct runtime route without the rest of the sandbox status output.

```bash
nemoclaw inference get
nemoclaw inference get --json
```

### `nemoclaw inference set`

Switch the active inference provider or model for a NemoClaw-managed OpenClaw or Hermes sandbox.
The command updates the OpenShell gateway route, patches the selected running agent config so it matches the route, recomputes the config hash, and updates the NemoClaw registry.

<AgentOnly variant="openclaw">

For OpenClaw, the patch updates the OpenClaw config provider namespace and selected model.

</AgentOnly>
<AgentOnly variant="hermes">

For Hermes, the patch updates `/sandbox/.hermes/config.yaml` (`model.default`, `model.base_url`, and `model.provider: custom`) and does not rebuild or restart the gateway.
Under the `nemohermes` alias, it uses the registered Hermes sandbox when exactly one exists; otherwise pass `--sandbox <name>` to target one explicitly.

</AgentOnly>

By default, the command syncs the default registered sandbox.

```bash
nemoclaw inference set --provider <provider> --model <model> [--sandbox <name>] [--no-verify]
```

Pass both `--provider` and `--model` when you want NemoClaw to update the OpenShell inference route and sync the selected sandbox's agent config.
If you only want the lower-level OpenShell route operation, run `openshell inference set -g nemoclaw --model <model> --provider <provider>` directly.
When either flag is missing, `nemoclaw inference set` prints that OpenShell command instead of an oclif flag-validation error.
The command updates the host registry immediately after the gateway route changes.
If the in-sandbox config sync fails, NemoClaw keeps the gateway and registry aligned, warns that the running image may still need a rebuild, and points you to `nemoclaw <name> rebuild`.

Supported provider names are `nvidia-prod`, `nvidia-nim`, `nvidia-router`, `openai-api`, `anthropic-prod`, `compatible-anthropic-endpoint`, `gemini-api`, `compatible-endpoint`, `hermes-provider`, `ollama-local`, and `vllm-local`.
Use `--no-verify` only when OpenShell cannot verify the provider at switch time but you have already confirmed the provider and credential.

### `nemoclaw setup`

**Warning:**

The `nemoclaw setup` command is deprecated.
Use `nemoclaw onboard` instead.

This command remains as a compatibility alias to `nemoclaw onboard` and accepts the same flags: `--non-interactive`, `--resume`, `--fresh`, `--recreate-sandbox`, `--gpu` / `--no-gpu`, `--from`, `--name`, `--sandbox-gpu` / `--no-sandbox-gpu`, `--sandbox-gpu-device`, `--agent`, `--control-ui-port`, `--yes` / `-y`, `--no-ollama-autostart`, `--yes-i-accept-third-party-software`.

```bash
nemoclaw setup
```

### `nemoclaw setup-spark`

**Warning:**

The `nemoclaw setup-spark` command is deprecated.
Use the standard installer and run `nemoclaw onboard` instead, because current OpenShell releases handle the older DGX Spark cgroup behavior.

This command remains as a compatibility alias to `nemoclaw onboard` and accepts the same flags: `--non-interactive`, `--resume`, `--fresh`, `--recreate-sandbox`, `--gpu` / `--no-gpu`, `--from`, `--name`, `--sandbox-gpu` / `--no-sandbox-gpu`, `--sandbox-gpu-device`, `--agent`, `--control-ui-port`, `--yes` / `-y`, `--no-ollama-autostart`, `--yes-i-accept-third-party-software`.

```bash
nemoclaw setup-spark
```

### `nemoclaw debug`

Collect diagnostics for bug reports.
Gathers system info, Docker state, gateway logs, and sandbox status into a summary or tarball.
Use `--sandbox <name>` to target a specific sandbox, `--quick` for a smaller snapshot, or `--output <path>` to save a tarball that you can attach to an issue.

```bash
nemoclaw debug [--quick|-q] [--sandbox NAME] [--output PATH|-o PATH]
```

| Flag | Description |
|------|-------------|
| `--quick`, `-q` | Collect minimal diagnostics only |
| `--sandbox NAME` | Target a specific sandbox (default: auto-detect) |
| `--output PATH`, `-o PATH` | Write diagnostics tarball to the given path |

If `--output` is set and the tarball cannot be written (for example, the destination directory is missing or read-only), the command exits non-zero so scripts can detect the failure.
The tarball is written to a temporary sibling and renamed on success, so a pre-existing file at `--output` is preserved when `tar` fails.

When `--sandbox` is supplied explicitly (via flag or one of `NEMOCLAW_SANDBOX_NAME`, `NEMOCLAW_SANDBOX`, `SANDBOX_NAME` — flag wins, then the env vars in that order), the name must match a registered sandbox; if `openshell sandbox list` succeeds it must also appear in the live gateway. An unknown or stale name exits non-zero with an actionable error that names the sandbox and reports the source env var when applicable, and no tarball is written. Without an explicit name, `nemoclaw debug` falls back to the registry's default sandbox (and warns if that default is stale).

### `nemoclaw credentials list`

List the provider credentials registered with the OpenShell gateway.
Values are not printed.

```bash
nemoclaw credentials list
```

### `nemoclaw credentials reset <PROVIDER>`

Remove a provider credential from the OpenShell gateway by provider name.
After removal, re-running `nemoclaw onboard` re-prompts for that provider's credential.
Run `nemoclaw credentials list` first if you are not sure of the provider name.

```bash
nemoclaw credentials reset nvidia-prod
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Skip the confirmation prompt |

### `nemoclaw gc`

Remove orphaned sandbox Docker images from the host.
Each `nemoclaw onboard` builds an `openshell/sandbox-from:<timestamp>` image (~765 MB).
The `destroy` and `rebuild` commands clean up the image automatically, but images from older NemoClaw versions or interrupted operations may remain.
This command lists all `openshell/sandbox-from:*` images, cross-references the sandbox registry, and removes any that are no longer associated with a registered sandbox.

```bash
nemoclaw gc [--dry-run] [--yes|-y|--force]
```

| Flag | Description |
|------|-------------|
| `--dry-run` | List orphaned images without removing them |
| `--yes`, `-y`, `--force` | Skip the confirmation prompt |

### `nemoclaw uninstall`

Run `uninstall.sh` to remove NemoClaw sandboxes, gateway resources, related images and containers, and local state.
The CLI runs the local `uninstall.sh` shipped with the installed npm package.
If that local script is missing, the CLI does not auto-fetch a remote copy.
It prints the versioned URL of the matching `uninstall.sh` so you can download, review, and run it manually.

Uninstall also stops any orphaned `openshell` host processes left behind by previous onboard or destroy cycles, including `openshell sandbox create`, `openshell ssh-proxy`, and SSH sessions spawned by OpenShell.
Earlier releases only stopped `openshell forward` processes, so those orphans accumulated across runs.

For Local Ollama setups, uninstall also stops matching Ollama auth proxy processes before deleting `~/.nemoclaw` state so stale proxy listeners do not block a later reinstall.

On Linux, uninstall removes `~/.local/state/nemoclaw`, which contains Docker-driver gateway PID files, SQLite data, audit logs, and VM-driver state.

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave OpenShell binaries installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |
| `--gateway <name>` | Override the gateway name to remove (default: `nemoclaw`) |

```bash
nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models] [--gateway <name>]
```

#### User-data preservation under `~/.nemoclaw/`

To avoid uninstall destroying host-side user data, uninstall preserves the following entries under `~/.nemoclaw/` by default:

| Entry | What it holds |
|---|---|
| `rebuild-backups/` | Host-side snapshots that `nemoclaw <name> snapshot create` and `nemoclaw backup-all` write. `nemoclaw <name> snapshot restore` reads them back after you reinstall. |
| `backups/` | Host-side workspace backups that `scripts/backup-workspace.sh` writes (see Backup and Restore (use the `nemoclaw-user-manage-sandboxes` skill)). |
| `sandboxes.json` | Host-side sandbox registry. NemoClaw uses it to map sandbox names back to their persistence directories when you reinstall. |

Uninstall removes every other entry under `~/.nemoclaw/` (gateway source, runtime state, the Ollama auth proxy PID file, etc.).

Decision matrix:

| Context | Behaviour |
|---|---|
| Interactive TTY, preserved entries present, no env override | Prompts `Also remove them? [y/N]`. Default `N` keeps the entries. |
| Interactive TTY, user answers `y` | Removes everything under `~/.nemoclaw/` (the previous full-removal behaviour). |
| Non-interactive (`--yes`, `NEMOCLAW_NON_INTERACTIVE=1`, or non-TTY shell) | Preserves the entries and prints a one-line notice. |
| Any context with `NEMOCLAW_UNINSTALL_DESTROY_USER_DATA=1` | Skips the prompt and removes everything under `~/.nemoclaw/`. |

The preserved entries survive uninstall as inert files on disk.
Reinstall NemoClaw and re-onboard the sandbox before `nemoclaw <name> snapshot restore` can use them.

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

## Internal Commands

NemoClaw registers a hidden `internal` command namespace. These commands are
compatibility entrypoints for repo-owned scripts, such as the installer, the
uninstaller, DNS setup, and developer tooling. They are not part of the
supported public CLI surface.

Each command class sets `hidden = true`, so the commands stay out of
`nemoclaw --help`. They remain registered and routable, which is why they are
listed here for reference. Treat their names, flags, and output as
implementation details. They exist to back `install.sh`, `uninstall.sh`, and
related automation, and they may change or be removed without notice. Most run
indirectly through those scripts rather than being typed by hand.

For contributor guidance on how these command files are structured, see
`src/commands/internal/README.md`.

| Command | Owning script context | Purpose |
|---------|-----------------------|---------|
| `nemoclaw internal installer plan` | `install.sh` | Build a deterministic installer plan from environment and probe inputs without applying it. |
| `nemoclaw internal installer normalize-env` | `install.sh` | Normalize installer ref and provider environment values without applying installation changes. |
| `nemoclaw internal installer resolve-release-tag` | `install.sh` | Resolve the installer ref using the same precedence as `install.sh`. |
| `nemoclaw internal uninstall plan` | `uninstall.sh` / `nemoclaw uninstall` | Build a deterministic uninstall plan without applying it. |
| `nemoclaw internal uninstall run-plan` | `uninstall.sh` / `nemoclaw uninstall` | Remove host-side NemoClaw resources from a previously built plan. |
| `nemoclaw internal uninstall classify-shim` | `uninstall.sh` / `nemoclaw uninstall` | Classify whether a shim path is safe for the uninstaller to remove. |
| `nemoclaw internal dns setup-proxy` | onboarding / sandbox setup | Configure the DNS forwarder bridge inside a sandbox pod. |
| `nemoclaw internal dns fix-coredns` | onboarding / sandbox setup | Patch CoreDNS to use a non-loopback upstream resolver. |
| `nemoclaw internal dev npm-link-or-shim` | `scripts/npm-link-or-shim.sh` (development) | Run `npm link`, falling back to a user-local NemoClaw development shim. |

These commands do not appear in the command-level parity check, which compares
`nemoclaw --help` against the public command headings in this reference; hidden
commands are excluded from both. The table above is the canonical reference for
the family.

## Environment Variables

NemoClaw reads the following environment variables to configure service ports, onboarding behavior, and lifecycle defaults.
Set them before running `nemoclaw onboard` or any command that starts services.
All ports must be non-privileged integers between 1024 and 65535.

| Variable | Default | Service |
|----------|---------|---------|
| `NEMOCLAW_GATEWAY_PORT` | 8080 | OpenShell gateway port |
| `NEMOCLAW_GATEWAY_BIND_ADDRESS` | 127.0.0.1 | OpenShell gateway bind address (`127.0.0.1` or `0.0.0.0`) |
| `NEMOCLAW_DASHBOARD_PORT` | 18789 (auto-derived from `CHAT_UI_URL` port if set) | Dashboard or API forward |
| `NEMOCLAW_VLLM_PORT` | 8000 | vLLM / NIM inference |
| `NEMOCLAW_OLLAMA_PORT` | 11434 | Ollama inference |
| `NEMOCLAW_OLLAMA_PROXY_PORT` | 11435 | Ollama auth proxy |
| `NEMOCLAW_DASHBOARD_BIND` | *unset* (loopback) | Dashboard or API forward bind address. Set to `0.0.0.0` to opt in to remote bind for SSH-deployed hosts. |

If a port value is not a valid integer or falls outside the allowed range, the CLI exits with an error.
`NEMOCLAW_GATEWAY_PORT` also cannot overlap the configured dashboard, vLLM, Ollama, or Ollama proxy ports, and cannot use the dashboard auto-allocation range `18789` through `18799` or the default inference/proxy ports `8000`, `11434`, and `11435`.
When you run multiple NemoClaw gateways with different `NEMOCLAW_GATEWAY_PORT` values, NemoClaw derives a separate gateway name, state directory, and compatibility container name from the port so one gateway does not tear down another.
On non-WSL hosts, `NEMOCLAW_OLLAMA_PORT` and `NEMOCLAW_OLLAMA_PROXY_PORT` must be different.
If you run Ollama on port 11435, set `NEMOCLAW_OLLAMA_PROXY_PORT` to another free port before onboarding.

`NEMOCLAW_GATEWAY_BIND_ADDRESS` accepts only `127.0.0.1` and `0.0.0.0`.
Binding the OpenShell gateway to `0.0.0.0` may make it reachable from other hosts on the network.

`NEMOCLAW_DASHBOARD_BIND` controls the dashboard or API port forward bind address.
By default the forward stays on `127.0.0.1` (loopback only).
Set `NEMOCLAW_DASHBOARD_BIND=0.0.0.0` before `nemoclaw onboard` (or `nemoclaw <sandbox> connect`) to bind the forward on all interfaces, which is useful when the host is reached over SSH or a cloud workstation.
Only `0.0.0.0` enables the remote bind; other values are ignored.

<AgentOnly variant="openclaw">

When the remote bind is opted in, the dashboard auth flow accepts non-loopback origins.

</AgentOnly>

```bash
export NEMOCLAW_DASHBOARD_PORT=19000
nemoclaw onboard
```

```bash
NEMOCLAW_GATEWAY_BIND_ADDRESS=0.0.0.0 NEMOCLAW_GATEWAY_PORT=8990 nemoclaw onboard
```

These overrides apply to onboarding, status checks, health probes, and the uninstaller.
Defaults are unchanged when no variable is set.
If `NEMOCLAW_DASHBOARD_PORT` or the port from `CHAT_UI_URL` is already occupied by another sandbox, onboarding scans `18789` through `18799` and uses the next free dashboard port.
Pass `--control-ui-port <N>` to require a specific port.

<AgentOnly variant="openclaw">

For OpenClaw, `NEMOCLAW_DASHBOARD_PORT` controls the OpenClaw dashboard forward.

</AgentOnly>
<AgentOnly variant="hermes">

For Hermes, `NEMOCLAW_DASHBOARD_PORT` controls the OpenAI-compatible API forward.
For Hermes sandboxes, `NEMOCLAW_HERMES_DASHBOARD=1` starts the native Hermes dashboard separately from the OpenAI-compatible API.
The Hermes API remains on port `8642`; the optional browser dashboard uses `NEMOCLAW_HERMES_DASHBOARD_PORT`.

| Variable | Default | Service |
|----------|---------|---------|
| `NEMOCLAW_HERMES_DASHBOARD` | 0 | Optional Hermes native web dashboard (`1`, `true`, `yes`, or `on` enables it) |
| `NEMOCLAW_HERMES_DASHBOARD_PORT` | 9119 | Optional Hermes native web dashboard forward port |
| `NEMOCLAW_HERMES_DASHBOARD_TUI` | 0 | Optional Hermes in-browser TUI tab when the dashboard is enabled |

</AgentOnly>

### Onboarding Configuration

These variables let you tune onboarding without editing the Dockerfile or passing repeated flags.
Set them before running `nemoclaw onboard`.

| Variable | Format | Effect |
|----------|--------|--------|
| `NEMOCLAW_PROVIDER` | provider key (e.g. `build`, `openai`, `anthropic`, `anthropicCompatible`, `gemini`, `ollama`, `custom`, `vllm`, `nim-local`, `routed`, `hermes-provider`, `install-vllm`, `install-ollama`, `install-windows-ollama`, `start-windows-ollama`) | Selects the inference provider during onboarding. The wizard skips the provider menu in both interactive and non-interactive runs when this is set. Aliases: `cloud` → `build`, `nim` → `nim-local`, `hermes` / `nous` / `nous-portal` → `hermes-provider`, `anthropiccompatible` → `anthropicCompatible`. Invalid values fail fast with the list of accepted keys. |
| `NEMOCLAW_ENDPOINT_URL` | URL | Custom endpoint URL. Used together with `NEMOCLAW_PROVIDER=custom` for OpenAI-compatible endpoints or `NEMOCLAW_PROVIDER=anthropicCompatible` for Anthropic-compatible endpoints. |
| `NEMOCLAW_PREFERRED_API` | `completions` (currently the only honored value) | Forces the validation probe to use the `/v1/chat/completions` API path instead of the newer `/v1/responses` API. |
| `NEMOCLAW_INFERENCE_INPUTS` | comma-separated list of `text` and/or `image` | Declares model input modalities for vision-capable models. Validated strictly; unknown tokens are ignored. |
| `NEMOCLAW_OLLAMA_REQUIRE_TOOLS` | `0` to disable, anything else to keep the default | When set to `0`, skips the Ollama tool-calling capability check during local-inference onboarding. |
| `NEMOCLAW_OLLAMA_INSTALL_MODE` | `system`, `user`, or empty/unset | Pins the Linux Ollama install location; see the Linux Ollama install mode details below. |
| `NEMOCLAW_PROXY_HOST` | hostname or IP | Overrides the sandbox-side outbound HTTP proxy host. Defaults to `10.200.0.1`. |
| `NEMOCLAW_PROXY_PORT` | integer port | Overrides the sandbox-side outbound HTTP proxy port. Defaults to `3128`. |
| `NEMOCLAW_OPENCLAW_OTEL` | `1` to enable | Enables OpenClaw conversation diagnostics export through the `diagnostics-otel` plugin. Disabled by default. |
| `NEMOCLAW_OPENCLAW_OTEL_ENDPOINT` | OTLP/HTTP URL | Sets the OpenTelemetry collector endpoint for OpenClaw diagnostics. Defaults to `http://host.openshell.internal:4318` when `NEMOCLAW_OPENCLAW_OTEL=1`. |
| `NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME` | service name | Sets the OTEL `service.name` for OpenClaw gateway spans. Defaults to `openclaw-gateway`. |
| `NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE` | `0.0` to `1.0` | Sets OpenClaw's root-span sample rate for conversation diagnostics. Defaults to `1.0`. |
| `NEMOCLAW_OPENSHELL_BIN` | path | Overrides the `openshell` binary the CLI invokes. Defaults to `openshell` (resolved via `PATH`). |
| `NEMOCLAW_SANDBOX` | sandbox name | Alternate spelling of `NEMOCLAW_SANDBOX_NAME`; used by `services` and `debug` lookups when neither a flag nor `NEMOCLAW_SANDBOX_NAME` is set. |
| `NEMOCLAW_INSTALL_REF` | git ref | For internal installer commands: the git ref to install from. Overridden by the `--install-ref` flag. |
| `NEMOCLAW_INSTALL_TAG` | release tag | For internal installer commands: the release tag to install. Defaults to the admin-promoted `lkg` tag when unset. Overridden by the `--install-tag` flag. |
| `NEMOCLAW_VLLM_MODEL` | registry slug or Hugging Face model id | Selects the model the managed-vLLM install path serves. Recognised slugs: `qwen3.6-27b`, `qwen3.6-35b-a3b-nvfp4`, `nemotron-3-nano-4b`, `deepseek-r1-distill-70b`. Unset uses the per-platform profile default. Gated models (e.g. `deepseek-r1-distill-70b`) require `HF_TOKEN` or `HUGGING_FACE_HUB_TOKEN`. |
| `NEMOCLAW_MODEL_ROUTER_PYTHON` | absolute path | Pins the host Python interpreter used to create the Model Router virtual environment. Strict. NemoClaw probes only that interpreter and aborts with the failure reason if it does not qualify, rather than silently falling back to another python. Relative command names such as `python3.12` are rejected. When unset, NemoClaw probes `python3.13`, `python3.12`, `python3.11`, `python3.10`, and bare `python3`, retains every interpreter whose version is in `[3.10, 3.14)` and whose `ensurepip`, `pyexpat`, `ssl`, and `venv` stdlib modules import cleanly, and tries `python -m venv` on each in priority order until one succeeds. Set the pin when the auto-discovered interpreter is broken (for example, Homebrew `python@3.14` with a `pyexpat` dlopen mismatch on macOS). |

<AgentOnly variant="openclaw">

OpenClaw-specific build-time agent configuration:

| Variable | Format | Effect |
|----------|--------|--------|
| `NEMOCLAW_AGENT_TIMEOUT` | positive integer (seconds) | Overrides `agents.defaults.timeoutSeconds` in the built OpenClaw config. Raise for slow inference. |
| `NEMOCLAW_CONTEXT_WINDOW` | positive integer (tokens) | Overrides the model's context-window value in the built OpenClaw config. |
| `NEMOCLAW_MAX_TOKENS` | positive integer (tokens) | Overrides the model's `maxTokens` in the built OpenClaw config. |
| `NEMOCLAW_REASONING` | `true` or `false` | Overrides the model's reasoning-mode flag in the built OpenClaw config. |
| `NEMOCLAW_AGENT_HEARTBEAT_EVERY` | duration with `s`, `m`, or `h` suffix (for example `30m`, `1h`, or `0m`) | Overrides `agents.defaults.heartbeat.every` in the built OpenClaw config. Set `0m` to disable periodic agent turns. |
| `NEMOCLAW_EXTRA_AGENTS_JSON` | JSON array of OpenClaw secondary-agent entries | Adds secondary agents to `agents.list`; see [Extra OpenClaw agents](#extra-openclaw-agents) for the entry schema, path constraints, and validation rules. |

</AgentOnly>
<AgentOnly variant="hermes">

Hermes-specific provider authentication:

| Variable | Format | Effect |
|----------|--------|--------|
| `NEMOCLAW_HERMES_AUTH_METHOD` | `oauth` | Selects Hermes Provider authentication in non-interactive onboarding. Valid values: `oauth`, `nous-portal-oauth`, `api-key`, `nous-api-key`. |
| `NEMOCLAW_HERMES_AUTH` | same as `NEMOCLAW_HERMES_AUTH_METHOD` | Back-compatible alias for Hermes Provider authentication selection. |
| `NEMOCLAW_NOUS_AUTH_METHOD` | same as `NEMOCLAW_HERMES_AUTH_METHOD` | Nous-specific alias for Hermes Provider authentication selection. |

</AgentOnly>

<AgentOnly variant="openclaw">

#### Extra OpenClaw agents

Set `NEMOCLAW_EXTRA_AGENTS_JSON` to a JSON array of secondary-agent entries to bake them into `agents.list[]` at image build time.
Each entry must declare `id`, `workspace`, `agentDir`, `tools`, and `subagents.maxSpawnDepth`.
The canonical `main` entry is always written first with `default: true`, so secondary agents cannot displace the primary agent.
Malformed JSON or invalid entries fail the image build with a structured error.

Field rules:

- `id` must match `^[a-z][a-z0-9_-]{0,31}$` and must not be `main`.
- `workspace` must equal `/sandbox/.openclaw/workspace-<id>` exactly.
- `agentDir` must equal `/sandbox/.openclaw/agents/<id>` exactly.
- `tools` must declare a non-empty `allow[]` or `deny[]`; nothing is implicitly granted.
- `subagents.maxSpawnDepth` must be a non-negative integer; set to `0` to forbid further spawning.
- `default: true` is rejected because the primary agent is the only default.
- Allowed entry fields: `id`, `workspace`, `agentDir`, `tools`, `subagents`, `description`. Any other key fails the image build (no implicit credential or env pass-through).
- Allowed `tools` fields: `profile`, `allow`, `deny`. Allowed `subagents` fields: `maxSpawnDepth`. Any other nested key fails the image build.

Example:

```json
[
  {
    "id": "research",
    "workspace": "/sandbox/.openclaw/workspace-research",
    "agentDir": "/sandbox/.openclaw/agents/research",
    "tools": {
      "profile": "minimal",
      "allow": ["web_search", "web_fetch", "read", "write"],
      "deny": ["exec", "gateway"]
    },
    "subagents": { "maxSpawnDepth": 0 }
  }
]
```

</AgentOnly>

#### Linux Ollama install mode details

Set `NEMOCLAW_OLLAMA_INSTALL_MODE=system` to run the official `https://ollama.com/install.sh` installer, which uses sudo, writes to `/usr/local`, and configures systemd.
Set `NEMOCLAW_OLLAMA_INSTALL_MODE=user` to extract the release tarball to `${HOME}/.local` without sudo and launch the daemon manually without systemd persistence.
Leave `NEMOCLAW_OLLAMA_INSTALL_MODE` empty or unset to let NemoClaw auto-detect the mode.
Auto-detection selects `system` when the current user is root or passwordless `sudo` works.
Auto-detection selects `user` in non-interactive runs without passwordless `sudo`.
An interactive shell falls back to `system` so the official installer can prompt for the password.
NemoClaw rejects any other value.
On upgrades, NemoClaw rejects `user` because a user-local install cannot replace the system daemon on `:11434`.
On upgrades, NemoClaw also rejects `system` under `NEMOCLAW_NON_INTERACTIVE=1` when passwordless `sudo` is unavailable because the installer would hang on a hidden sudo prompt.
The run exits with an actionable diagnostic instead.

### Onboarding Behavior Flags

These flags toggle optional behaviors during onboarding; set them before running `nemoclaw onboard`.

| Variable | Format | Effect |
|----------|--------|--------|
| `NEMOCLAW_YES` | `1` to enable | Auto-accepts confirmation prompts (`--yes` equivalent) including in helpers like the Ollama proxy auth setup. |
| `NEMOCLAW_OLLAMA_NO_AUTOSTART` | `1` to enable | Skips the wizard's eager Ollama auto-start during inference-provider selection (equivalent to passing `--no-ollama-autostart`). When set and Ollama is not running on `localhost:11434`, the `nemoclaw onboard` Local Ollama path prints a warning and selects the default fallback model instead of spawning `ollama serve`. The flag covers only the provider-selection step; later setup steps (auth proxy, validation, model warm) still expect a reachable Ollama. On Linux hosts with a systemd Ollama unit, the loopback-override path may still restart the daemon before this gate runs. |
| `NEMOCLAW_NON_INTERACTIVE_SUDO_MODE` | `prompt` or empty/unset | When set to `prompt`, allows non-interactive onboarding to use prompt-capable `sudo` for host setup steps that require elevation, which can ask for a password. Empty/unset is the default and uses `sudo -n`, which fails instead of asking for a password. Any other value is rejected. |
| `NEMOCLAW_NO_EXPRESS` | `1` to enable | Installer-only. Skips the DGX Spark, DGX Station, and Windows WSL express install prompt and continues with the normal interactive onboarding flow. |
| `NEMOCLAW_EXPERIMENTAL` | `1` to enable | Surfaces experimental providers and flows in onboarding. |
| `NEMOCLAW_IGNORE_RUNTIME_RESOURCES` | `1` to enable | Suppresses the under-provisioned runtime warning during preflight. Use only when you know the sandbox host meets the minimums. |
| `NEMOCLAW_DISABLE_OVERLAY_FIX` | `1` to enable | Skips the Docker overlay-fix step during sandbox build. For environments where the fix is incompatible. |
| `NEMOCLAW_OVERLAY_SNAPSHOTTER` | snapshotter name | Selects the containerd overlay snapshotter for sandbox builds. Empty (default) preserves containerd's choice. |
| `NEMOCLAW_SKIP_TELEGRAM_REACHABILITY` | `1` to enable | Skips the Telegram bot reachability probe during onboard (useful in restricted networks). |
| `NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION` | `1`, `true`, `yes`, or `on` to enable | Skips the live Slack `auth.test` and `apps.connections.open` credential probes during onboard and `channels add slack`. Use only in restricted networks or hermetic test environments; Slack token format checks still apply. |
| `NEMOCLAW_CONFIG_ACCEPT_NEW_PATH` | `1` to enable | Accepts a new sandbox config path without an interactive prompt when the stored path differs from the discovered one. |
| `NEMOCLAW_RESOURCE_PROFILE` | profile name or `default` | Selects a sandbox CPU/RAM resource profile from the blueprint during onboarding. `default` means no resource preference, so NemoClaw passes no OpenShell CPU or memory flags. Unknown names fail fast. |
| `NEMOCLAW_CPU` | percentage or Kubernetes CPU quantity | Overrides the selected profile's CPU size passed to OpenShell `--cpu`. Percentages resolve against detected capacity. |
| `NEMOCLAW_RAM` | percentage or Kubernetes memory quantity | Overrides the selected profile's memory size passed to OpenShell `--memory`. Percentages resolve against detected capacity. |
| `NEMOCLAW_SANDBOX_GPU` | `auto`, `1`, or `0` | Controls sandbox GPU passthrough during onboarding. `auto` enables GPU passthrough when an NVIDIA GPU is detected, `1` requires GPU passthrough, and `0` forces CPU-only sandbox creation. |
| `NEMOCLAW_SANDBOX_GPU_DEVICE` | OpenShell GPU device selector | Selects the GPU device passed with `openshell sandbox create --gpu-device`. Requires explicit sandbox GPU enablement with `NEMOCLAW_SANDBOX_GPU=1` (or `--sandbox-gpu` for CLI-driven onboarding); otherwise onboarding rejects the selector instead of treating it as an implicit opt-in. |
| `NEMOCLAW_DOCKER_GPU_PATCH` | `0` to disable, anything else to keep the default | Controls the Linux Docker-driver GPU sandbox compatibility patch. Set to `0` only as an escape hatch when the patch fails and you need onboarding to continue without patching the GPU sandbox container. |
| `NEMOCLAW_OPENSHELL_GATEWAY_BIN` | path | Advanced override for the `openshell-gateway` binary used by the Linux Docker-driver gateway. Defaults to the binary next to `openshell`, then common install paths. |
| `NEMOCLAW_OPENSHELL_SANDBOX_BIN` | path | Advanced override for the `openshell-sandbox` binary passed to the Linux Docker-driver gateway supervisor. Defaults to the binary next to `openshell`, then common install paths. |
| `NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR` | path | Advanced override for the Linux Docker-driver gateway pid file and SQLite state directory. Defaults to `~/.local/state/nemoclaw/openshell-docker-gateway`. |
| `NEMOCLAW_AUTO_FIX_FIREWALL` | `1` to enable | Opts in to automatic UFW remediation when Linux Docker-driver sandbox containers cannot reach the host gateway after a proven TCP failure. NemoClaw runs `sudo -n` only, validates the narrow Docker bridge subnet → gateway IP:port rule before invoking UFW, re-probes after applying it, and otherwise falls back to the printed manual command. |
| `NEMOCLAW_WECHAT_QUIET` | `1` to enable | Silences the `[wechat]` diagnostic lines printed during the host-side WeChat QR login (poll status, IDC redirects, swallowed gateway errors), which are visible by default while the experimental WeChat path stabilizes; set `1` once the flow is reliable in your environment. |

### Onboard Profiling Traces

Set `NEMOCLAW_TRACE=1` before `nemoclaw onboard` to write an OpenTelemetry-style JSON trace for the run.
When no explicit path is provided, NemoClaw writes a timestamped file under `.e2e/traces/` in the current working directory.
Use `NEMOCLAW_TRACE_DIR` to choose the output directory, or `NEMOCLAW_TRACE_FILE` to choose the exact output file.

```bash
NEMOCLAW_TRACE=1 nemoclaw onboard
NEMOCLAW_TRACE_DIR=/tmp/nemoclaw-traces nemoclaw onboard
NEMOCLAW_TRACE_FILE=/tmp/nemoclaw-onboard-trace.json nemoclaw onboard
```

Trace artifacts include onboard phase timing, sandbox and dashboard readiness waits, policy application, inference validation probes, curl probe results, and sandbox build progress events.
Secret-like metadata such as API keys, bearer tokens, cookies, and credentials is redacted before the file is written.

### OpenClaw Conversation OTEL Diagnostics

Set `NEMOCLAW_OPENCLAW_OTEL=1` before onboarding or rebuilding an OpenClaw sandbox to enable runtime conversation traces through OpenClaw's `diagnostics-otel` plugin.
This is separate from `NEMOCLAW_TRACE`, which records NemoClaw onboarding phases to a local JSON file.
NemoClaw configures OpenClaw for OTLP/HTTP protobuf traces only by default: metrics and logs are disabled, and prompt/tool content capture is not enabled.

For a local Jaeger collector:

```bash
docker run --rm --name nemoclaw-jaeger \
    -e COLLECTOR_OTLP_ENABLED=true \
    -p 16686:16686 \
    -p 4318:4318 \
    jaegertracing/all-in-one:1.57
NEMOCLAW_OPENCLAW_OTEL=1 nemoclaw onboard
```

Onboarding automatically applies the `openclaw-diagnostics-otel-local` preset at sandbox create and again during the policy step when `NEMOCLAW_OPENCLAW_OTEL=1`, so OTLP export is allowed before the gateway's first trace flush. If you enabled OTEL after an existing sandbox was created, run `nemoclaw <sandbox-name> policy-add openclaw-diagnostics-otel-local --yes` or recreate the sandbox with OTEL enabled at build time.

Then open `http://localhost:16686` and select the `openclaw-gateway` service.
The built-in `openclaw-diagnostics-otel-local` preset allows only `POST /v1/traces` (and subpaths) to `host.openshell.internal:4318` from `openclaw` and `node`.
For a remote collector, create a custom preset for the collector host and port instead of using the local host-gateway preset.

### Probe Timeouts

These tune how long internal probes wait before giving up.
Defaults are sized for typical hardware; override only if you see false-positive timeouts.

| Variable | Default | Effect |
|----------|---------|--------|
| `NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS` | per call site (typically `15000`) | Overrides the default timeout for `openshell sandbox exec` calls issued by recovery and lifecycle helpers. Integer milliseconds; non-positive or non-numeric values fall back to the per-call-site default. |
| `NEMOCLAW_STATUS_PROBE_TIMEOUT_MS` | built-in default | Overrides the timeout for the OpenShell status probe used by `nemoclaw <name> status`. Integer milliseconds; non-positive or non-numeric values fall back to the default. |

### Onboard Timeouts

The following environment variables tune onboard-time wall-clock limits.
Set them before running `nemoclaw onboard` if a slow connection or large model pull risks tripping the default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEMOCLAW_OLLAMA_PULL_TIMEOUT` | `1800` (30 minutes) | Wall-clock timeout for `ollama pull` during onboard, in seconds. Accepts integer or float values. Already-downloaded layers are kept; re-running the pull resumes them. |
| `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` | `180` | Wall-clock timeout for the inference-server validation probe during onboard, in seconds. Raise on slow networks or for very large prompts. |
| `NEMOCLAW_SANDBOX_READY_TIMEOUT` | `180` | Wall-clock timeout for the post-create readiness wait, in seconds. Raise when the sandbox image build, gateway upload, or in-sandbox boot exceeds the default (typical on 70B+ models, first-time gateway uploads over slow links, or DGX Station / remote-VM first runs). When the deadline expires onboarding deletes the orphaned sandbox and prints the retry hint. |

```bash
export NEMOCLAW_OLLAMA_PULL_TIMEOUT=3600
export NEMOCLAW_SANDBOX_READY_TIMEOUT=600
nemoclaw onboard
```

If a timeout fires, onboarding emits the elapsed budget plus a hint to raise the relevant variable.
The Ollama pull preserves its partial download for the next attempt.
The readiness wait deletes the orphaned sandbox first so the next `nemoclaw onboard` starts clean.

### Lifecycle Behavior Flags

These flags change defaults for commands that manage existing sandboxes.

| Variable | Format | Effect |
|----------|--------|--------|
| `NEMOCLAW_CLEANUP_GATEWAY` | `1`, `true`, or `yes` to enable; `0`, `false`, or `no` to disable | Sets the default for whether `nemoclaw <name> destroy` removes the shared gateway when destroying the last sandbox. Command-line `--cleanup-gateway` and `--no-cleanup-gateway` still take precedence. |
| `NEMOCLAW_DISABLE_INFERENCE_ROUTE_REPAIR` | `1` to enable | Skips the automatic DNS-proxy repair for stale `inference.local` routes during `nemoclaw <name> connect` and `nemoclaw <name> connect --probe-only`. Use only as a troubleshooting escape hatch. |
| `NEMOCLAW_SHIELDS_ACCEPT_LEGACY_BASELINE` | `1` to opt in | Allows advanced immutable-config verification to trust the current on-disk bytes for older or partial content baselines. Use only after you have rebuilt or manually inspected the sandbox state and accepted that the baseline is operator-approved. |

<AgentOnly variant="openclaw">
### Remote Deployment

These variables seed defaults for `nemoclaw deploy` and `nemoclaw onboard --remote`, which provision a sandbox on a Brev instance.
Each has a flag equivalent on `deploy`; the env var lets non-interactive runs skip the prompt.
For narrative how-to coverage of `NEMOCLAW_BREV_PROVIDER` and `NEMOCLAW_GPU`, see Deploy to Remote GPU (use the `nemoclaw-user-deploy-remote` skill).

| Variable | Default | Effect |
|----------|---------|--------|
| `NEMOCLAW_BREV_PROVIDER` | `gcp` | Cloud provider for Brev instance creation. |
| `NEMOCLAW_GPU` | `a2-highgpu-1g:nvidia-tesla-a100:1` | GPU specification (instance type and GPU model) for the Brev instance. |
| `NEMOCLAW_DEPLOY_NO_CONNECT` | unset | When set to `1`, skips the automatic `connect` step after the remote deploy completes. |
| `NEMOCLAW_DEPLOY_NO_START_SERVICES` | unset | When set to `1`, skips starting services automatically after the remote deploy. |

</AgentOnly>

### Legacy `nemoclaw setup`

Deprecated. Use `nemoclaw onboard` instead.
Running `nemoclaw setup` now delegates directly to `nemoclaw onboard`.

```bash
nemoclaw setup
```
