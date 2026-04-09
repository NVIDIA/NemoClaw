# Commands

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes. It is installed when you run `npm install -g nemoclaw`.

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
$ nemoclaw onboard [--non-interactive] [--resume] [--from <Dockerfile>]
```

> **Warning:** For NemoClaw-managed environments, use `nemoclaw onboard` when you need to create or recreate the OpenShell gateway or sandbox.
> Avoid `openshell self-update`, `npm update -g openshell`, `openshell gateway start --recreate`, or `openshell sandbox create` directly unless you intend to manage OpenShell separately and then rerun `nemoclaw onboard`.

The wizard prompts for a provider first, then collects the provider credential if needed.
Supported non-experimental choices include NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and compatible OpenAI or Anthropic endpoints.
Credentials are stored in `~/.nemoclaw/credentials.json`. For file permissions, plaintext storage behavior, and hardening guidance, see Credential Storage (see the `nemoclaw-user-configure-security` skill).
The legacy `nemoclaw setup` command is deprecated; use `nemoclaw onboard` instead.

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

The wizard prompts for a sandbox name.
Names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

Before creating the gateway, the wizard runs preflight checks.
It verifies that Docker is reachable, warns on untested runtimes such as Podman, and prints host remediation guidance when prerequisites are missing.

#### `--from <Dockerfile>`

Build the sandbox image from a custom Dockerfile instead of the stock NemoClaw image.
The entire parent directory of the specified file is used as the Docker build context, so any files your Dockerfile references (scripts, config, etc.) must live alongside it.

```console
$ nemoclaw onboard --from path/to/Dockerfile
```

The file can have any name; if it is not already named `Dockerfile`, onboard copies it to `Dockerfile` inside the staged build context automatically.
All NemoClaw build arguments (`NEMOCLAW_MODEL`, `NEMOCLAW_PROVIDER_KEY`, `NEMOCLAW_INFERENCE_BASE_URL`, etc.) are injected as `ARG` overrides at build time, so declare them in your Dockerfile if you need to reference them.

In non-interactive mode, the path can also be supplied via the `NEMOCLAW_FROM_DOCKERFILE` environment variable:

```console
$ NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_FROM_DOCKERFILE=path/to/Dockerfile nemoclaw onboard
```

If a `--resume` is attempted with a different `--from` path than the original session, onboarding exits with a conflict error rather than silently building from the wrong image.

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

> **Warning:** The `nemoclaw deploy` command is deprecated.
> Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
This command remains as a compatibility wrapper for the older Brev-specific bootstrap flow.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> destroy`

Stop the NIM container and delete the sandbox.
This removes the sandbox from the registry.

> **Warning:** Destroying a sandbox permanently deletes all files inside it, including
> workspace files (see the `nemoclaw-user-workspace` skill) (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes).
> Back up your workspace first by following the instructions at Back Up and Restore (see the `nemoclaw-user-workspace` skill).

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

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview the endpoints a preset would open without applying changes |

Use `--dry-run` to audit a preset before applying it:

```console
$ nemoclaw my-assistant policy-add --dry-run
```

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw start`

Start optional host auxiliary services. This is the cloudflared tunnel when `cloudflared` is installed (for a public URL to the dashboard). Channel messaging (Telegram, Discord, Slack) is not started here; it is configured during `nemoclaw onboard` and runs through OpenShell-managed constructs.

```console
$ nemoclaw start
```

### `nemoclaw stop`

Stop host auxiliary services started by `nemoclaw start` (for example cloudflared).

```console
$ nemoclaw stop
```

### `nemoclaw status`

Show the sandbox list and the status of host auxiliary services (for example cloudflared).

```console
$ nemoclaw status
```

### `nemoclaw setup-spark`

> **Warning:** The `nemoclaw setup-spark` command is deprecated.
> Use the standard installer and run `nemoclaw onboard` instead, because current OpenShell releases handle the older DGX Spark cgroup behavior.

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

### `nemoclaw credentials list`

List the names of all credentials stored in `~/.nemoclaw/credentials.json`.
Values are not printed.

```console
$ nemoclaw credentials list
```

### `nemoclaw credentials reset <KEY>`

Remove a stored credential by name.
After removal, re-running `nemoclaw onboard` re-prompts for that key.

```console
$ nemoclaw credentials reset NVIDIA_API_KEY
```

| Flag | Description |
|------|-------------|
| `--yes`, `-y` | Skip the confirmation prompt |

### `nemoclaw uninstall`

Run `uninstall.sh` to remove NemoClaw sandboxes, gateway resources, related images and containers, and local state.
The CLI uses the local `uninstall.sh` first and falls back to the hosted script if the local file is unavailable.

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |

```console
$ nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models]
```

### Legacy `nemoclaw setup`

Deprecated. Use `nemoclaw onboard` instead.
Running `nemoclaw setup` now delegates directly to `nemoclaw onboard`.

```console
$ nemoclaw setup
```
