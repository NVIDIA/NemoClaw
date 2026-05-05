<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Troubleshooting

This page covers common issues you may encounter when installing, onboarding, or running NemoClaw, along with their resolution steps.

> **Get Help:** If your issue is not listed here, join the [NemoClaw Discord channel](https://discord.gg/XFpfPv9Uvx) to ask questions and get help from the community. You can also [file an issue on GitHub](https://github.com/NVIDIA/NemoClaw/issues/new).

## Installation

### `nemoclaw` not found after install

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
The `nemoclaw` binary is installed but the shell session does not know where to find it.

Run `source ~/.bashrc` (or `source ~/.zshrc` for zsh), or open a new terminal window.

When installing from a source checkout with `npm install`, NemoClaw first tries `npm link`.
If the global npm prefix is not writable, it writes a managed shim to `~/.local/bin/nemoclaw` instead.
Add `~/.local/bin` to your `PATH` if the command is still not found.

### Installer fails on unsupported platform

The installer checks for a supported OS and architecture before proceeding.
If you see an unsupported platform error, verify that you are running on a tested platform listed in the Container Runtimes table in the quickstart guide.

### Node.js version is too old

NemoClaw requires Node.js 22.16 or later.
If the installer exits with a Node.js version error, check your current version:

```console
$ node --version
```

If the version is below 22.16, install a supported release.
If you use nvm, run:

```console
$ nvm install 22
$ nvm use 22
```

Then re-run the installer.

### Image push fails with out-of-memory errors

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline, which buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer.

If you cannot add memory, configure at least 8 GB of swap to work around the issue at the cost of slower performance.

### Docker is not running

The installer and onboard wizard require Docker to be running.
If you see a Docker connection error, start the Docker daemon:

```console
$ sudo systemctl start docker
```

On macOS with Docker Desktop, open the Docker Desktop application and wait for it to finish starting before retrying.

### Docker permission denied on Linux

On Linux, if the Docker daemon is running but you see "permission denied" errors, your user may not be in the `docker` group.
Add your user and activate the group in the current shell:

```console
$ sudo usermod -aG docker $USER
$ newgrp docker
```

Then retry `nemoclaw onboard`.

### macOS first-run failures

The two most common first-run failures on macOS are missing developer tools and Docker connection errors.

To avoid these issues, install the prerequisites in the following order before running the NemoClaw installer:

1. Install Xcode Command Line Tools (`xcode-select --install`). These are needed by the installer and Node.js toolchain.
2. Install and start a supported container runtime (Docker Desktop or Colima). Without a running runtime, the installer cannot connect to Docker.

### Permission errors during installation

The NemoClaw installer does not require `sudo` or root.
It installs Node.js via nvm and NemoClaw via npm, both into user-local directories.
The installer also handles OpenShell installation automatically using a pinned release.

If you see permission errors during installation, they typically come from Docker, not the NemoClaw installer itself.
Docker must be installed and running before you run the installer, and installing Docker may require elevated privileges on Linux.

### npm install fails with permission errors

If `npm install` fails with an `EACCES` permission error, do not run npm with `sudo`.
Instead, configure npm to use a directory you own:

```console
$ mkdir -p ~/.npm-global
$ npm config set prefix ~/.npm-global
$ export PATH=~/.npm-global/bin:$PATH
```

Add the `export` line to your `~/.bashrc` or `~/.zshrc` to make it permanent, then re-run the installer.

### Installer fails on NVIDIA Jetson

The installer auto-detects NVIDIA Jetson devices (Orin and Thor) and applies required host configuration before the normal install flow.
If the Jetson setup step fails, verify that you have `sudo` access and that Docker is installed and running.

For JetPack 6 (L4T 36.x), the setup switches iptables to legacy mode and adjusts the Docker daemon configuration.
For JetPack 7 (L4T 38.x / Thor), only bridge netfilter and sysctl settings are applied.
For JetPack 7 (L4T 39.x), bridge netfilter is loaded only when the host is missing it. Some R39 images already ship with `br_netfilter` configured and are left untouched. On affected R39 hosts, the installer prints `loading br_netfilter (required by k3s inside the OpenShell gateway)`. Without this fix, sandbox pods fail DNS resolution against the in-cluster service and the onboard `Setting up OpenClaw inside sandbox` step times out.

If the L4T version is not recognized, the setup step is skipped and the installer continues normally.

### DNS resolution from inside docker fails (corporate firewall)

Some corporate networks block outbound UDP port 53 to public DNS servers and force all host name resolution through DNS over TLS on TCP port 853. Containers do not inherit the host's DNS-over-TLS configuration, so the sandbox build's `npm ci` step times out trying to resolve `registry.npmjs.org` against `1.1.1.1` or `8.8.8.8`.

NemoClaw's preflight runs a short `docker run --rm busybox nslookup registry.npmjs.org` probe before starting the sandbox build. When the probe confirms a DNS failure, onboarding stops with platform-specific remediation instead of hanging for ~15 minutes and printing a cryptic `Exit handler never called`.

The fix depends on your platform and runtime. Pick the matching path from the preflight output, apply it, then re-run `nemoclaw onboard`.

- **Linux with systemd-resolved.** Add a `DNSStubListenerExtra` drop-in pointing at the docker bridge gateway IP (the preflight prints the detected IP), then add the same IP to `/etc/docker/daemon.json` under `dns`. Restart `systemd-resolved` and `docker`.
- **macOS with Colima.** Restart Colima with the corporate DNS address, for example `colima stop && colima start --dns <corp-dns-ip>`.
- **macOS with Docker Desktop.** Add the corporate DNS address to `~/.docker/daemon.json` under `dns`, then restart Docker Desktop.
- **Windows or WSL.** Configure DNS in the Docker Desktop settings GUI, or apply the Linux fix above when running native docker inside WSL.

Verify the fix worked:

```console
$ docker run --rm busybox nslookup registry.npmjs.org
```

When the lookup returns an answer, retry onboarding.

### Port already in use

The NemoClaw dashboard uses port `18789` by default and the gateway uses port `8080`.
If another sandbox already owns the dashboard port, onboarding scans ports `18789` through `18799` and uses the next free port.
If all ports in that range are occupied, the error lists the owner for each port and suggests using `--control-ui-port` with a port outside the range.

If a non-NemoClaw process is already bound to the dashboard port or the gateway port, identify the conflicting process, verify it is safe to stop, and terminate it:

```console
$ sudo lsof -i :18789
$ kill <PID>
```

If the process does not exit, use `kill -9 <PID>` to force-terminate it.
Then retry onboarding.

Alternatively, override the conflicting port instead of stopping the other process.
Pass `--control-ui-port` with the desired dashboard port:

```console
$ nemoclaw onboard --control-ui-port 19000
```

You can also set `CHAT_UI_URL` with the desired port:

```console
$ CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard
```

Or set the port directly:

```console
$ NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw onboard
```

See Environment Variables (use the `nemoclaw-user-reference` skill) for the full list of port overrides.

### Running multiple sandboxes simultaneously

Each sandbox requires its own dashboard port.
If you onboard a second sandbox without overriding the port, onboarding uses the next free port in the `18789` to `18799` range.
`onboard` checks `openshell forward list` before starting a new forward, so a second onboard cannot silently take over the first sandbox's port.

Assign a distinct port only when you want a specific value:

```console
$ nemoclaw onboard                                                   # first sandbox uses default 18789
$ nemoclaw onboard                                                   # second sandbox uses the next free port
$ nemoclaw onboard --control-ui-port 19000                          # explicit port override
```

Each sandbox then has its own SSH tunnel and its own dashboard URL:

```text
http://localhost:18789   ← first sandbox
http://localhost:19000   ← second sandbox
```

You can verify which tunnel belongs to which sandbox with:

```console
$ openshell forward list
$ nemoclaw list
```

`nemoclaw list` prints the recorded dashboard URL for each sandbox.

## Onboarding

### Cgroup v2 errors during onboard

Older NemoClaw releases relied on a Docker cgroup workaround on Ubuntu 24.04, DGX Spark, and WSL2.
Current OpenShell releases handle that behavior themselves, so NemoClaw no longer requires a Spark-specific setup step.

If onboarding reports that Docker is missing or unreachable, fix Docker first and retry onboarding:

```console
$ nemoclaw onboard
```

Podman is not a tested runtime.
If onboarding or sandbox lifecycle fails, switch to a tested runtime (Docker Desktop, Colima, or Docker Engine) and rerun onboarding.

### Cluster fails with `overlayfs snapshotter cannot be enabled` on Docker 26+

Docker Engine 26 and later default fresh installations to the [containerd image store](https://docs.docker.com/engine/storage/containerd/), which exposes its layers via the `overlayfs` snapshotter rather than the legacy `overlay2` graph driver.
The k3s server inside the OpenShell cluster image needs to mount its own overlay filesystem on top, and the kernel rejects nesting two non-trivial overlay mounts.
The cluster container then loops with:

```text
"overlayfs" snapshotter cannot be enabled for "/var/lib/rancher/k3s/agent/containerd",
try using "fuse-overlayfs" or "native":
failed to mount overlay: ... err: invalid argument
```

This is a Docker default-driver change, not a NemoClaw or OpenShell regression.
The same hardware running Docker 25 or earlier — or any Docker version with the containerd image store disabled — uses the legacy `overlay2` driver and is unaffected.

NemoClaw detects the Docker 26+ containerd-snapshotter overlayfs configuration during onboarding and transparently builds a small drop-in replacement for the cluster image on the local Docker engine.
The patched image installs `fuse-overlayfs` and selects it as the k3s snapshotter, bypassing the kernel-level nested-overlay limitation.
No host configuration changes, sudo, or Docker restart required.

The auto-fix runs once per OpenShell version on the affected host.
Subsequent onboarding runs reuse the cached patched image.
Hosts without the conflict (`Driver: overlay2` in `docker info`, macOS Docker Desktop, or Linux installations that disable the containerd image store) see no change in behavior.

Override knobs:

- `NEMOCLAW_DISABLE_OVERLAY_FIX=1` — skip the auto-fix and run against the unmodified upstream cluster image.
  Useful for diagnosis or when you have already applied the manual workaround below.
- `NEMOCLAW_OVERLAY_SNAPSHOTTER=native` — build the patched image with k3s's `native` snapshotter instead of `fuse-overlayfs`.
  The `native` snapshotter copies image layers instead of overlaying them, so it uses more disk but does not depend on FUSE.
  Default is `fuse-overlayfs`.

If you prefer to disable the new Docker storage driver instead of running the patched image, edit `/etc/docker/daemon.json`:

```json
{
  "storage-driver": "overlay2",
  "features": { "containerd-snapshotter": false }
}
```

Then restart Docker (`sudo systemctl restart docker`) and re-run `nemoclaw onboard`.
This restores the legacy `overlay2` driver host-wide, which kills any other running containers — prefer the auto-fix unless you need the change for unrelated reasons.
Switching storage drivers also rebuilds the entire local image graph: previously-pulled images become unusable and Docker re-pulls them on first reference, so expect a cold cache and additional disk usage right after the restart.

### OpenShell version above maximum

Each NemoClaw release validates against a range of tested OpenShell versions.
If the installed OpenShell version exceeds the configured maximum, `nemoclaw onboard` exits with an error:

```text
✗ openshell <version> is above the maximum supported by this NemoClaw release.
  blueprint.yaml max_openshell_version: <max>
```

Upgrade NemoClaw to a version that supports your OpenShell release, or install a supported OpenShell version from the [OpenShell releases page](https://github.com/NVIDIA/OpenShell/releases).

The `install-openshell.sh` script also enforces this constraint and pins fresh installs to the validated maximum version.

### Invalid sandbox name

Sandbox names must be lowercase, start with a letter, contain only letters, numbers, and internal hyphens, and end with a letter or number.
Uppercase letters are automatically lowercased.

Names that collide with global CLI commands are also rejected.
Reserved names include `onboard`, `list`, `deploy`, `setup`, `start`, `stop`, `status`, `debug`, `uninstall`, `credentials`, and `help`.
Using a reserved name would cause the CLI to route to the global command instead of the sandbox.

If the name does not match these rules or is reserved, the wizard exits with an error.
Choose a name such as `my-assistant` or `dev1`.

### Sandbox creation fails on DGX

On DGX machines, sandbox creation can fail if the gateway's DNS has not finished propagating or if a stale port forward from a previous onboard run is still active.

Run `nemoclaw onboard` to retry.
The wizard cleans up stale port forwards and waits for gateway readiness automatically.

### Colima socket not detected (macOS)

Newer Colima versions use the XDG base directory (`~/.config/colima/default/docker.sock`) instead of the legacy path (`~/.colima/default/docker.sock`).
NemoClaw checks both paths.
If neither is found, verify that Colima is running:

```console
$ colima status
```

### Re-onboard fails because port 18789 is held by SSH

After destroying a sandbox and gateway, the SSH port-forward process for the
dashboard can be left running.
Re-running onboard then fails preflight with `Port 18789 is not available.
Blocked by: ssh`.

Current NemoClaw detects this case and kills the orphaned SSH process
automatically before retrying the port check.
If you see the error on an older release, identify the SSH process and
terminate it manually:

```console
$ sudo lsof -i :18789
$ kill <PID>
```

Then re-run `nemoclaw onboard`.

### Updated messaging token is not picked up

Re-running `nemoclaw onboard --non-interactive` with a new
`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, or `SLACK_BOT_TOKEN` previously
reported success while the sandbox kept polling with the old credential.
Current NemoClaw stores SHA-256 hashes of messaging credentials in the
sandbox registry at creation time and detects when a token has changed.
When rotation is detected, NemoClaw automatically backs up workspace state,
deletes the sandbox, recreates it with the new credential, and restores the
backup.

If you suspect a sandbox is still using a stale token, re-run onboarding so
the credential check runs:

```console
$ nemoclaw onboard --non-interactive
```

### Sandbox creation killed by OOM (exit 137)

On systems with 8 GB RAM or less and no swap configured, the sandbox image push can exhaust available memory and get killed by the Linux OOM killer (exit code 137).

NemoClaw automatically detects low memory during onboarding and prompts to create a 4 GB swap file.
If this automatic step fails or you are using a custom setup flow, create swap manually before running `nemoclaw onboard`:

```console
$ sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
$ sudo chmod 600 /swapfile
$ sudo mkswap /swapfile
$ sudo swapon /swapfile
$ echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
$ nemoclaw onboard
```

### Previous onboarding session failed

If a previous `nemoclaw onboard` attempt fails partway through (for example, a provider or inference-setup step reporting an error), NemoClaw records the failure in `~/.nemoclaw/onboard-session.json`.

When you re-run the installer, it detects the failed session and does not silently retry it.
Silent retry would loop on the same failure if your original choice, such as an unreachable provider, was the cause.

- In an interactive terminal, the installer prompts whether to resume the failed session or start fresh.
  Press `R` (or Enter) to retry the same session, or `f` to discard it and make fresh choices.
- In non-interactive mode (piped `curl | bash` with `NEMOCLAW_NON_INTERACTIVE=1`, CI, scripts), the installer refuses and exits with a non-zero status so a scripted re-run cannot loop.
  You must opt in to one of two paths explicitly:

  Start over with new choices (discards the recorded session and provider/model selection):

  ```console
  $ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --fresh
  ```

  Or equivalently, via env var.
  The variable must be set on the `bash` side of the pipe, not on `curl`, since only the right-hand process inherits it:

  ```console
  $ curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_FRESH=1 bash
  ```

  Retry the same session without re-prompting.
  This is only useful if the original failure was transient, for example a network blip or a stopped Docker daemon, and not a wrong provider choice:

  ```console
  $ nemoclaw onboard --resume
  ```

As a last resort, you can also delete the session file directly and re-run the installer:

```console
$ rm ~/.nemoclaw/onboard-session.json
```

## Runtime

### Reconnect after a host reboot

After a host reboot, the container runtime, OpenShell gateway, and sandbox may not be running.
Follow these steps to reconnect.

1. Start the container runtime.

   - **Linux:** start Docker if it is not already running (`sudo systemctl start docker`)
   - **macOS:** open Docker Desktop or start Colima (`colima start`)

1. Check sandbox state.

   ```console
   $ openshell sandbox list
   ```

   If the sandbox shows `Ready`, skip to step 4.

1. Restart the gateway (if needed).

   If the sandbox is not listed or the command fails, restart the OpenShell gateway:

   ```console
   $ openshell gateway start --name nemoclaw
   ```

   Wait a few seconds, then re-check with `openshell sandbox list`.

1. Reconnect.

   ```console
   $ nemoclaw <name> connect
   ```

   The gateway usually rotates its SSH host keys across a reboot.
   `connect` detects the resulting identity drift, prunes the stale `openshell-*` entries from `~/.ssh/known_hosts`, and retries automatically.
   You do not need to edit `known_hosts` by hand or re-run `nemoclaw onboard` in this case.

1. Start host auxiliary services (if needed).

   If you use the cloudflared tunnel started by `nemoclaw tunnel start`, start it again:

   ```console
   $ nemoclaw tunnel start
   ```

   Telegram, Discord, and Slack are handled by OpenShell-managed channel messaging configured at onboarding, not by a separate bridge process from `nemoclaw tunnel start`. To pause a single bridge without destroying the sandbox, use `nemoclaw <name> channels stop <channel>`.

> **If the sandbox does not recover:** If the sandbox remains missing after restarting the gateway, run `nemoclaw onboard` to recreate it.
> The wizard prompts for confirmation before destroying an existing sandbox. If you confirm, it **destroys and recreates** the sandbox. Workspace files (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes) are lost.
> Back up your workspace first by following the instructions at Back Up and Restore (use the `nemoclaw-user-manage-sandboxes` skill).

### Sandbox is running an outdated agent version

After upgrading NemoClaw, `nemoclaw <name> connect` and `nemoclaw <name> status` warn if the sandbox is running an older agent version than the current image.

To upgrade the sandbox while preserving workspace state, run:

```console
$ nemoclaw <name> rebuild
```

The rebuild command backs up state, destroys the old sandbox, recreates it with the current image, and restores state.
Create a snapshot before rebuilding if you want an additional safety net:

```console
$ nemoclaw <name> snapshot create
$ nemoclaw <name> rebuild
```

### Sandbox shows as stopped

The sandbox may have been stopped or deleted.
Run `nemoclaw onboard` to recreate the sandbox from the same blueprint and policy definitions.

### Status shows "not running" inside the sandbox

This is expected behavior.
When checking status inside an active sandbox, host-side sandbox state and inference configuration are not inspectable.
The status command detects the sandbox context and reports "active (inside sandbox)" instead.

Run `openshell sandbox list` on the host to check the underlying sandbox state.

### Git clone fails with a certificate verification error

In networks that inspect TLS, OpenShell injects a proxy CA bundle into the sandbox.
Current NemoClaw exports that bundle as `GIT_SSL_CAINFO` during sandbox startup and persists it for `nemoclaw <name> connect` sessions, so Git can trust the proxy CA.
It also forwards standard CA bundle variables for subprocesses, including `GIT_SSL_CAPATH`, `CURL_CA_BUNDLE`, and `REQUESTS_CA_BUNDLE`.

If Git still reports `server certificate verification failed`, reconnect to the sandbox and check that the CA variables are present:

```console
$ env | grep -E 'SSL_CERT_FILE|GIT_SSL_CAINFO|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE'
```

If they are missing on an older sandbox, upgrade NemoClaw and run:

```console
$ nemoclaw <name> rebuild
```

### Sandbox creation reports a TLS certificate mismatch

If sandbox creation reports a TLS or certificate mismatch, the OpenShell gateway certificate may have changed since the CLI last trusted it.
Refresh the gateway trust and then resume onboarding:

```console
$ openshell gateway trust -g nemoclaw
$ nemoclaw onboard --resume
```

### `openclaw update` hangs or times out inside the sandbox

This is expected for the current NemoClaw deployment model.
NemoClaw installs `openclaw` into the sandbox image at build time, so the CLI is image-pinned rather than updated in place inside a running sandbox.

Do not run `openclaw update` inside the sandbox.
Instead:

1. Upgrade to a NemoClaw release that includes the newer `openclaw` version.
2. If you build NemoClaw from source, bump the pinned `openclaw` version in `Dockerfile.base` and rebuild the sandbox base image.
3. Run `nemoclaw <name> rebuild` to recreate the sandbox with the updated image. The rebuild command automatically backs up workspace state before destroying the old sandbox and restores it afterward.

### Inference requests time out

Verify that the inference provider endpoint is reachable from the host.
Check the active provider and endpoint:

```console
$ nemoclaw <name> status
```

For local Ollama and local vLLM, `nemoclaw <name> status` also prints an `Inference` line that probes the host-side health endpoint directly.
If that line shows `unreachable`, start the local backend first and then retry the request.

If the endpoint is correct but requests still fail, check for network policy rules that may block the connection.
Then verify the credential and base URL for the provider you selected during onboarding.

For Ollama, vLLM, NIM, and compatible-endpoint setup, the default timeout is 180 seconds.
If large prompts still cause timeouts, increase it with `NEMOCLAW_LOCAL_INFERENCE_TIMEOUT` before re-running onboard:

```console
$ export NEMOCLAW_LOCAL_INFERENCE_TIMEOUT=300
$ nemoclaw onboard
```

For local Ollama and vLLM, onboarding retries the container reachability check and can fall back to the host-side health check when the local backend is healthy.
If all attempts fail, the error includes container reachability diagnostics such as HTTP status and host gateway resolution.

### Agent fails at runtime after onboarding succeeds with a compatible endpoint

Some OpenAI-compatible servers (such as SGLang) expose `/v1/responses` but their
streaming mode is incomplete.
OpenClaw requires granular streaming events like `response.output_text.delta`
that these backends do not emit.

For the compatible-endpoint provider, NemoClaw now defaults to
`/v1/chat/completions` and skips the Responses API probe entirely unless you
opt in.
If you onboarded an older release that selected `/v1/responses`, re-run
onboarding so the wizard rebuilds the image with chat completions:

```console
$ nemoclaw onboard
```

If you previously set `NEMOCLAW_PREFERRED_API=openai-responses` to force the
Responses API, unset it before re-running onboard.

When you enable Telegram messaging with an OpenAI-compatible endpoint, onboarding also checks `inference.local` from inside the sandbox.
If that smoke check fails, fix the compatible-endpoint base URL, credentials, model, or network route before testing the Telegram bot again.

Do not rely on `NEMOCLAW_INFERENCE_API_OVERRIDE` alone — it patches the config
at container startup but does not update the Dockerfile ARG baked into the
image.
A fresh `nemoclaw onboard` is the reliable fix.

### `NEMOCLAW_DISABLE_DEVICE_AUTH=1` does not change an existing sandbox

This is expected behavior.
`NEMOCLAW_DISABLE_DEVICE_AUTH` is a build-time setting used when NemoClaw creates the sandbox image.
Changing or exporting it later does not rewrite the baked `openclaw.json` inside an existing sandbox.

If you need a different device-auth setting, rerun onboarding so NemoClaw rebuilds the sandbox image with the desired configuration.
For the security trade-offs, refer to Security Best Practices (use the `nemoclaw-user-configure-security` skill).

### `openclaw channels add` or `remove` is blocked inside the sandbox

This is expected.
The messaging channel list is frozen into the sandbox's container image when the image is built during `nemoclaw onboard` or `nemoclaw rebuild` (the selected channel names are passed to the `docker build` as `NEMOCLAW_MESSAGING_CHANNELS_B64` and written into `/sandbox/.openclaw/openclaw.json` as part of the image).
Changes made inside the running sandbox do not persist across rebuilds, so `openclaw channels` commands that mutate the config are intercepted.
NemoClaw's sandbox entrypoint installs a guard that intercepts `openclaw channels <add|remove>` and prints an actionable error pointing at the host-side commands below, instead of letting the call fail deep in the binary with a raw `EACCES` trace.

Run the equivalent host-side command instead:

```console
$ nemoclaw <sandbox> channels list
$ nemoclaw <sandbox> channels add <telegram|discord|slack>
$ nemoclaw <sandbox> channels remove <telegram|discord|slack>
```

`channels add` registers credentials with the OpenShell gateway and `channels remove` clears them; both offer to rebuild the sandbox so the image reflects the new channel set.
In non-interactive mode (`NEMOCLAW_NON_INTERACTIVE=1`), the commands stage the change and leave the rebuild to a follow-up `nemoclaw <sandbox> rebuild`.

### `openclaw config set` or `unset` is blocked inside the sandbox

This is expected.
The sandbox's OpenClaw configuration (`/sandbox/.openclaw/openclaw.json`) is baked into the container image at build time.
NemoClaw's sandbox entrypoint installs a guard that intercepts `openclaw config set` and `openclaw config unset` and prints an actionable error, because changes made inside the running sandbox do not persist across rebuilds.

To change your configuration, exit the sandbox and rerun onboarding:

```console
$ nemoclaw onboard
```

If NemoClaw reports a resumable failed onboarding session, run `nemoclaw onboard --resume` instead.
This rebuilds the sandbox with your updated settings.

### `openclaw doctor --fix` cannot repair Discord channel config inside the sandbox

This is expected in NemoClaw-managed sandboxes.
NemoClaw bakes channel entries into `/sandbox/.openclaw/openclaw.json` at image build time.

As a result, commands that try to rewrite the baked config from inside the sandbox, including `openclaw doctor --fix`, cannot repair Discord, Telegram, or Slack channel entries in place.

If your Discord channel config is wrong, rerun onboarding so NemoClaw rebuilds the sandbox image with the correct messaging selection.
Do not treat a failed `doctor --fix` run as proof that the Discord gateway path itself is broken.

If `openclaw doctor` reports that it moved Telegram single-account values under `channels.telegram.accounts.default`, rerun onboarding and rebuild the sandbox rather than trying to patch `openclaw.json` in place.
Current NemoClaw rebuilds bake Telegram in the account-based layout and set Telegram group chats to `groupPolicy: open`, which avoids the empty `groupAllowFrom` warning path for default group-chat access.

### Discord bot logs in, but the channel still does not work

Separate the problem into two parts:

1. Baked config and provider wiring

   Check that onboarding selected Discord and that the sandbox was created with the Discord messaging provider attached.
   If Discord was skipped during onboarding, rerun onboarding and select Discord again.

1. Native Discord gateway path

   Successful login alone does not prove that Discord works end to end.
   Discord also needs a working gateway connection to `gateway.discord.gg`.
   If logs show errors such as `getaddrinfo EAI_AGAIN gateway.discord.gg`, repeated reconnect loops, or a `400` response while probing the gateway path, the problem is usually in the native gateway/proxy path rather than in the baked config.

Common signs of a native gateway-path failure:

- REST calls to `discord.com` succeed, but the Discord channel never becomes healthy
- `gateway.discord.gg` fails with DNS resolution errors
- the WebSocket path returns `400` instead of opening a tunnel
- native command deployment fails even though the bot token itself is valid

In that case:

- keep the Discord policy preset applied
- verify the sandbox was created with the Discord provider attached
- inspect gateway logs and blocked requests with `openshell term`
- treat the failure as a native Discord gateway problem, not as a bridge startup problem

### Messaging bridge appears running but no messages arrive

Bot tokens for Telegram (`getUpdates`), Discord (gateway), and Slack (Socket Mode) only allow one active consumer per token. If two NemoClaw sandboxes are configured with the same bot token, each one kicks the other off its polling connection and neither delivers messages. `nemoclaw status` still reports the bridge as running because the gateway process itself is alive.

To diagnose, open a shell in the sandbox and inspect the gateway log:

```console
$ nemoclaw <sandbox-name> connect
$ tail -f /tmp/gateway.log
```

A repeating line like the following confirms the conflict:

```text
[telegram] getUpdates conflict: 409: Conflict: terminated by other getUpdates request; retrying in 30s.
```

To fix, run `nemoclaw <other-sandbox> destroy` on whichever sandbox should stop polling, or rerun onboarding on it with the channel disabled. Current NemoClaw warns at `nemoclaw onboard` time when another sandbox already has the same channel enabled, but sandboxes created before that check was added may still be in a conflict loop.

### Landlock filesystem restrictions silently degraded

After sandbox creation, NemoClaw checks whether the host kernel supports Landlock (Linux 5.13+).
If the kernel is too old or you are running on macOS (where the Docker VM kernel may lack Landlock), a warning prints:

```text
⚠ Landlock: Docker VM kernel <version> does not support Landlock (requires ≥5.13).
  Sandbox filesystem restrictions will silently degrade (best_effort mode).
```

This warning is informational and does not block sandbox creation.
The sandbox runs without kernel-level filesystem restrictions, relying on container mount configuration instead.
For full filesystem enforcement, run on a Linux kernel 5.13 or later (Ubuntu 22.04 LTS and later include Landlock support).

### Sandbox lost after gateway restart

Sandboxes created with OpenShell versions older than 0.0.24 can become unreachable after a gateway restart because SSH secrets were not persisted.
Running `nemoclaw onboard` automatically upgrades OpenShell to 0.0.24 or later during the preflight check.
After the upgrade, recreate the sandbox with `nemoclaw onboard`.

### Agent cannot reach external hosts through a proxy

NemoClaw uses a default proxy address of `10.200.0.1:3128` (the OpenShell-injected gateway).
If your environment uses a different proxy, set `NEMOCLAW_PROXY_HOST` and `NEMOCLAW_PROXY_PORT` before onboarding:

```console
$ export NEMOCLAW_PROXY_HOST=proxy.example.com
$ export NEMOCLAW_PROXY_PORT=8080
$ nemoclaw onboard
```

These are build-time settings baked into the sandbox image.
Changing them after onboarding requires re-running `nemoclaw onboard` to rebuild the image.

When `HTTP_PROXY` or `HTTPS_PROXY` is set on the host, NemoClaw adds `localhost` and `127.0.0.1` to `NO_PROXY` for managed subprocesses.
This keeps local Ollama health checks and model pulls from being routed through a corporate or desktop proxy while preserving the proxy for external hosts.

### Agent cannot reach a host-side HTTP service

When a sandbox needs to call an HTTP service running on the host, use the normal OpenShell network policy path.
Expose the service on a host IP address that the OpenShell gateway can reach, create a custom NemoClaw policy preset for that IP and port, and apply it with `nemoclaw <sandbox> policy-add --from-file`.
The sandbox request then flows through the OpenShell proxy while NemoClaw preserves the existing live policy entries.

Do not rely on `host.docker.internal` or `host.openshell.internal` as a general-purpose host-service path.
Those names may appear in the sandbox's `/etc/hosts`, but in OpenShell's sandbox network they are not guaranteed to point at a reachable host gateway.
Bypassing the proxy with `--noproxy '*'` also bypasses network policy enforcement and audit.

First, make sure the host-side service listens on a non-loopback address.
For example, a health endpoint on port `50001` should be reachable from the host IP, not only from `127.0.0.1`:

```console
$ curl -s http://10.0.0.5:50001/health
{"status":"ok"}
```

Then create a custom NemoClaw preset for the host-side service.
Replace `10.0.0.5`, `50001`, paths, methods, and binaries with the service you want the sandbox to reach:

```yaml
preset:
  name: host-memory-api
  description: "Host memory API"
network_policies:
  host_memory_api:
    name: host_memory_api
    endpoints:
      - host: 10.0.0.5
        port: 50001
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/health" }
    binaries:
      - { path: /usr/bin/curl }
```

Apply the preset to the running sandbox with the NemoClaw CLI:

```console
$ nemoclaw my-assistant policy-add --from-file ./host-memory-api.yaml
```

After you apply the policy, retry the request from inside the sandbox without disabling the proxy:

```console
$ curl -s http://10.0.0.5:50001/health
{"status":"ok"}
```

If the request is still denied, check the blocked request in `openshell term`.
The policy `binaries` list must include the executable path that actually made the request.
If the response changes from `policy_denied` to `upstream_unreachable`, the policy matched, but the OpenShell gateway could not reach the host IP and port.

### Agent cannot reach an external host

OpenShell blocks outbound connections to hosts not listed in the network policy.
Open the TUI to see blocked requests and approve them:

```console
$ openshell term
```

To permanently allow an endpoint, add it to the network policy.
Refer to Customize the Network Policy (use the `nemoclaw-user-manage-policy` skill) for details.

### Dashboard not reachable after setting a custom port

If you ran `nemoclaw onboard` with a custom dashboard port and onboarding completed
but the dashboard URL is unreachable (browser shows connection refused or the page fails
to load), the sandbox was most likely created with an older NemoClaw version that did not
pass the dashboard port into the sandbox at startup. The gateway inside the sandbox
continued listening on the default port 18789 while the SSH tunnel forwarded the custom
port — leaving nothing at the other end of the tunnel.

Re-run onboarding on the current NemoClaw release with the desired port. Current versions
derive the dashboard port from `CHAT_UI_URL` automatically and inject it into the sandbox:

```console
$ CHAT_UI_URL=http://127.0.0.1:19000 nemoclaw onboard
```

If you need to run multiple sandboxes at different ports at the same time, see
[Running multiple sandboxes simultaneously](#running-multiple-sandboxes-simultaneously).

### Ollama auth proxy did not start

NemoClaw keeps Ollama bound to `127.0.0.1:11434` and starts a token-gated
reverse proxy on `0.0.0.0:11435` so the sandbox can reach Ollama without
exposing it to the local network.
If the proxy fails to start, onboarding exits before configuring inference.

Check whether the proxy port is occupied by another process:

```console
$ sudo lsof -i :11435
```

Stop the conflicting process and re-run `nemoclaw onboard`.
The wizard cleans up stale proxy processes from previous runs automatically,
so most failures resolve by retrying.

The proxy token is persisted to `~/.nemoclaw/ollama-proxy-token` with `0600`
permissions.
If the file is missing or unreadable after a host reboot, re-running
`nemoclaw onboard` regenerates it.

### Local inference health check resolves to IPv6

Local inference health checks now use `127.0.0.1` instead of `localhost`.
On systems where `localhost` resolves to `::1` first, older NemoClaw releases
could probe the wrong address and report the local backend as unreachable
even when it was running.
If you see this on a current NemoClaw release, verify that the local backend
binds an IPv4 address and not only `::1`.

### Blueprint run failed

View the error output for the failed blueprint run:

```console
$ nemoclaw <name> logs
```

Use `--follow` to stream logs in real time while debugging.

(dgx-spark)=

## DGX Spark

For an end-to-end Ollama walkthrough on DGX Spark, refer to the [NVIDIA Spark playbook](https://build.nvidia.com/spark/nemoclaw).

### CoreDNS CrashLoop after onboarding

If CoreDNS in the embedded k3s cluster crashes shortly after setup, it is usually because it resolves against `127.0.0.11`, which does not route inside the gateway container.
Run `fix-coredns.sh` to point CoreDNS at the container gateway IP instead, then recreate the sandbox.

### `k3s` cannot find a freshly built image

After building a new sandbox image, `k3s` inside the gateway container sometimes fails to pull it even though the image exists on the host.
Destroy and restart the gateway, then re-run setup.

```console
$ openshell gateway destroy
$ openshell gateway start
```

### GPU passthrough on Spark

GPU passthrough is not CI-tested on DGX Spark.
It is expected to work when you pass `--gpu` and the NVIDIA Container Toolkit is configured.
Verify the toolkit is configured by running `docker run --rm --runtime=nvidia --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi` from the host.

### `pip install` fails with a system-packages error

Recent Ubuntu releases (including DGX Spark's Ubuntu 24.04) mark the system Python install as externally managed, so `pip install` without a virtual environment fails.
Use a venv instead.
Avoid `--break-system-packages` unless you understand the risk, since it can break host tooling.

```console
$ python3 -m venv ~/.venvs/nemoclaw
$ source ~/.venvs/nemoclaw/bin/activate
$ pip install ...
```

### Port 3000 conflict with AI Workbench

NVIDIA AI Workbench's Traefik proxy binds ports 3000 and 10000.
If you run other services on Spark that expect port 3000, bind them to a different port.

(windows-wsl-2)=

## Windows Subsystem for Linux

For environment setup steps, see Windows Prerequisites (use the `nemoclaw-user-get-started` skill).

### `wsl --install --no-distribution` returns Forbidden (403)

Check your network connectivity.
If you are behind a VPN, try reconnecting or switching to a different network.

### `wsl -d Ubuntu` says "There is no distribution with the supplied name"

The Ubuntu package was installed with `--no-launch` but never registered.
Run `ubuntu.exe install --root` from PowerShell to register it, or reinstall without `--no-launch`:

```console
$ wsl --unregister Ubuntu
$ wsl --install -d Ubuntu
```

### `docker info` fails inside WSL

Confirm that Docker Desktop is running and that WSL integration is enabled for Ubuntu (Settings > Resources > WSL integration).
Then restart WSL:

```console
$ wsl --shutdown
$ wsl -d Ubuntu
$ docker info
```

### Ollama inference fails or hangs in WSL

Ollama configures context length based on your hardware.
On some GPUs (for example RTX 3500), the default context length is not sufficient for OpenClaw.
Force a larger context length:

```console
$ pkill -f 'ollama serve'
$ OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

Verify that Ollama inference works:

```console
$ echo "Hello" | ollama run <model-id>
```

Replace `<model-id>` with the model you selected during onboarding (for example `qwen3.5:4b`).

If `ollama serve` fails with `Error: listen tcp 127.0.0.1:11434: bind: address already in use`, check whether Ollama is configured for automatic startup:

```console
$ sudo systemctl status ollama
```

If it is active, stop it first, then start with the custom context length:

```console
$ sudo systemctl stop ollama
$ OLLAMA_CONTEXT_LENGTH=16384 ollama serve
```

For additional troubleshooting, see the Quickstart (use the `nemoclaw-user-get-started` skill) and Windows Setup (use the `nemoclaw-user-get-started` skill) pages.

## Podman

Podman is not a tested runtime.
OpenShell officially documents Docker-based runtimes only.
If you encounter issues with Podman, switch to a tested runtime (Docker Engine, Docker Desktop, or Colima) and rerun onboarding.
